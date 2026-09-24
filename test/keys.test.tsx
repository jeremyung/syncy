import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { type Config, parseConfig } from "../src/config.ts";
import { fingerprint } from "../src/fingerprint.ts";
import { acquireJobOwner } from "../src/job-owner.ts";
import { stateFile } from "../src/paths.ts";
import { SENTINEL_NAME, writeSentinel } from "../src/sentinel.ts";
import {
  EMPTY_STATE,
  findScan,
  loadState,
  type Scan,
  saveState,
  upsertScan,
} from "../src/state.ts";
import { App } from "../src/tui/App.tsx";
import { makeFixtureDir, removeFixtureDir, waitFor } from "./helpers.ts";

/**
 * Every key the interface advertises must actually do something.
 *
 * `p` shipped advertised in the footer and the help screen but never wired to a
 * dispatch branch — a string replacement that silently did not match. Prose
 * about the keys is not evidence that they work; pressing them is.
 */

const ESC = "\u001B";
const plain = (s: string | undefined): string => (s ?? "").replace(/\[[0-9;]*m/g, "");
const tick = (ms = 120): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * One unit's ledger row.
 *
 * Asserting against the whole frame is wrong: the legend line always contains
 * every state word, and the footer phrases its own count of verified bytes, so
 * `frame.includes("verified")` is true even when nothing is verified. Leader
 * dots identify a data row.
 */
function rowFor(frame: string, unit: string): string {
  const line = frame.split("\n").find((l) => l.includes(unit) && l.includes("....."));
  if (line === undefined) throw new Error(`no ledger row for ${unit} in:\n${frame}`);
  return line;
}

let root: string;
let config: Config;
let prevConfigHome: string | undefined;
let prevStateHome: string | undefined;

beforeEach(async () => {
  root = makeFixtureDir("syncy-keys");
  mkdirSync(join(root, "src/photos-2019"), { recursive: true });
  mkdirSync(join(root, "src/photos-2024"), { recursive: true });
  mkdirSync(join(root, "dst"), { recursive: true });
  writeFileSync(join(root, "src/photos-2019/a.txt"), "aaa");
  writeFileSync(join(root, "src/photos-2024/b.txt"), "bbb");

  prevConfigHome = process.env["XDG_CONFIG_HOME"];
  prevStateHome = process.env["XDG_STATE_HOME"];
  process.env["XDG_CONFIG_HOME"] = join(root, "cfg");
  process.env["XDG_STATE_HOME"] = join(root, "state");

  const id = await writeSentinel(join(root, "dst"));
  config = parseConfig(`
source = "${join(root, "src")}"
[[target]]
name = "dst"
path = "${join(root, "dst")}"
required = true
sentinel = "${id}"
`);
});

afterEach(() => {
  for (const [k, v] of [
    ["XDG_CONFIG_HOME", prevConfigHome],
    ["XDG_STATE_HOME", prevStateHome],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  removeFixtureDir(root);
});

function mount() {
  const r = render(<App config={config} />);
  return {
    ...r,
    frame: () => plain(r.lastFrame()),
    /**
     * The ledger's first real frame.
     *
     * The opening frame is empty: there are no rows until the first scan
     * resolves, and that is genuine work — a fingerprint of every unit and a
     * reachability check per target. Every test here used to bet a fixed
     * 120ms sleep on that finishing, which measured ~87ms on a laptop: a
     * quarter of a second of headroom, and none at all on a loaded CI runner,
     * where the footer assertion failed outright and two others flaked. What
     * these tests are about is what the interface does with a key, never how
     * quickly it got on screen, so they wait for the screen instead of
     * guessing at it.
     */
    async ready() {
      await waitFor(() => plain(r.lastFrame()).includes("[q]"), {
        what: "the ledger's first frame",
      });
    },
    /**
     * Press a key and let the screen catch up.
     *
     * Also not a fixed sleep, and for the same reason: the two tests that
     * flaked on CI — twice, on different runs of identical code — were a
     * press followed by an assertion about what the press opened. This
     * returns the moment the screen moves, which is a few milliseconds even
     * on a busy machine, so the assertion is never racing a timer.
     *
     * The wait has to end somewhere, because a key that legitimately changes
     * nothing is a real case: `j` at the bottom of the list moves no cursor,
     * and one test presses it five times. So it gives up after a limit set to
     * be generous against a slow runner and cheap to pay five times over, and
     * gives up quietly — whether the key did its job is the test's assertion
     * to make, not this helper's.
     */
    async press(s: string) {
      const before = plain(r.lastFrame());
      r.stdin.write(s);
      const deadline = Date.now() + 400;
      while (Date.now() < deadline) {
        await tick(5);
        if (plain(r.lastFrame()) !== before) return;
      }
    },
  };
}

/** The keys the footer advertises, parsed from what is actually rendered. */
function advertisedKeys(frame: string): string[] {
  const footer = frame.split("\n").find((l) => l.includes("[q]")) ?? "";
  return [...footer.matchAll(/\[([a-z?,])\]/g)].map((m) => m[1]!);
}

describe("the help screen lists each key once", () => {
  test("no key is listed twice", async () => {
    // A duplicated React key makes the renderer free to omit one of the pair,
    // so a key can disappear from help with nothing failing.
    const s = mount();
    await s.ready();
    await s.press("?");
    const listed = [...s.frame().matchAll(/^\s{2}(\S[^\s]*(?:\s\/\s\S+)?)\s{2,}\S/gm)].map(
      (m) => m[1]!,
    );
    const seen = new Set<string>();
    const dupes = listed.filter((k) => {
      if (seen.has(k)) return true;
      seen.add(k);
      return false;
    });
    expect(dupes, `duplicated in help: ${dupes.join(", ")}`).toEqual([]);
    s.unmount();
  });
});

describe("the footer advertises only keys that work", () => {
  test("it advertises a plausible set", async () => {
    const s = mount();
    await s.ready();
    const keys = advertisedKeys(s.frame());
    expect(keys.length).toBeGreaterThanOrEqual(4);
    // [?] is the disclosure for everything the line had no room for, so it is
    // the one hint that must never be dropped.
    expect(keys).toContain("?");
    s.unmount();
  });

  for (const key of ["p", "e", "?"]) {
    test(`[${key}] changes the screen`, async () => {
      // The regression: a key can be advertised in the footer and in help while
      // never reaching a dispatch branch, so pressing it does nothing at all.
      const s = mount();
      await s.ready();
      const before = s.frame();
      await s.press(key);
      expect(s.frame(), `[${key}] did nothing`).not.toBe(before);
      s.unmount();
    });
  }

  test("[f] cycles the filter", async () => {
    const s = mount();
    await s.ready();
    await s.press("f");
    expect(s.frame()).toContain("filter:");
    s.unmount();
  });
});

describe("the screens each key opens", () => {
  test("p opens the command list for the selected folder", async () => {
    const s = mount();
    await s.ready();
    await s.press("p");
    const f = s.frame();
    expect(f).toContain("what each key runs");
    expect(f).toContain("photos-2019");
    expect(f).toContain("quick check");
    s.unmount();
  });

  test("p shows the real rsync binary and flags, not a description", async () => {
    const s = mount();
    await s.ready();
    await s.press("p");
    expect(s.frame()).toContain("--partial-dir=.syncy-partial");
    s.unmount();
  });

  test("escape closes the command list", async () => {
    const s = mount();
    await s.ready();
    await s.press("p");
    expect(s.frame()).toContain("what each key runs");
    await s.press(ESC);
    expect(s.frame()).not.toContain("what each key runs");
    expect(s.frame()).toContain("folder");
    s.unmount();
  });

  test("the keyboard is not left dead after closing", async () => {
    // The soft-lock risk: a screen that owns the keyboard but never renders.
    const s = mount();
    await s.ready();
    await s.press("p");
    await s.press(ESC);
    await s.press("?");
    expect(s.frame()).toContain("syncy · keys");
    s.unmount();
  });

  test("? lists the keys, and names which one writes", async () => {
    const s = mount();
    await s.ready();
    await s.press("?");
    const f = s.frame();
    expect(f).toContain("the only key that writes");
    expect(f).toContain("writes nothing");
    s.unmount();
  });
});

describe("a key that cannot act says so", () => {
  /**
   * Only one rsync runs at a time, and `runCheck` opens with
   * `if (running !== null) return;` — so every key that would start another
   * was discarded in silence. It cost four failing test runs to notice, which
   * is the point: the interface knew something the person watching did not.
   */
  test("pressing a check key mid-run reports the refusal instead of ignoring it", async () => {
    const s = mount();
    await s.ready();
    await s.press("d"); // starts a deep verify
    await s.press("d"); // arrives while the first is still running
    await tick(200);
    const frame = s.frame();
    // Either the second press was refused out loud, or the first finished
    // before it landed — both are honest; silence is not.
    const refused = /ignored/.test(frame);
    const finished = !/deep .*→/.test(frame);
    expect(refused || finished, `neither refused nor finished:\n${frame}`).toBe(true);
    s.unmount();
  });

  test("the refusal names the key and what is holding it up", async () => {
    const s = mount();
    await s.ready();
    await s.press("q");
    await s.press("d");
    await tick(200);
    const frame = s.frame();
    if (/ignored/.test(frame)) {
      const line = frame.split("\n").find((l) => l.includes("ignored"))!;
      expect(line).toContain("[d]");
      expect(line).toMatch(/quick|deep/);
    }
    s.unmount();
  });

  test("[s] refuses to open confirm while another process holds the job-owner lease", async () => {
    const s = mount();
    await s.ready();
    // Give the selected folder something to sync, so pressing [s] would open
    // confirm if nothing stopped it — otherwise the test could pass for the
    // wrong reason (no destination behind, rather than the lease check).
    await s.press("q");
    await waitFor(() => !s.frame().includes("check running"), {
      what: "the quick check to finish",
    });

    // A sync writes; opening confirm on top of work another process already
    // owns would let [enter] race that write. This never acquires the lease
    // itself — Job.tsx does, once the sync is actually confirmed — it only
    // peeks, the same way [d]/[q] refuse a check already owned elsewhere.
    const owned = acquireJobOwner("mac", "deep");
    expect(owned.acquired).toBe(true);

    await s.press("s");
    await tick(200);
    expect(s.frame()).not.toContain("confirm sync");
    // The refusal is said on screen, in the hint line, since nothing is
    // running here to carry it.
    expect(s.frame()).toContain("sync ignored — mac deep is still running");
    s.unmount();
  });
});

describe("a check that could not run says so", () => {
  /**
   * An unreachable destination was skipped in silence: the loop incremented its
   * counter, continued, and the run then reported "deep check finished". That
   * is indistinguishable from a check that never started, which is exactly how
   * it was reported — verifications that "don't seem to be completing" when in
   * fact they never ran.
   */
  test("an unreachable destination is reported, not skipped quietly", async () => {
    const s = mount();
    await s.ready();
    // Break reachability by removing the sentinel the config was built around.
    rmSync(join(root, "dst", SENTINEL_NAME), { force: true });
    await s.press("r"); // re-read reachability
    await tick(400);
    await s.press("d");
    await waitFor(() => /nothing checked|skipped/.test(s.frame()), {
      what: "the run to report that it checked nothing",
      timeout: 15_000,
    });
    const frame = s.frame();
    expect(frame).toMatch(/nothing checked|skipped/);
    // And it must not claim to have finished a check it never ran.
    expect(frame).not.toMatch(/deep check finished · \d+ folders/);
    s.unmount();
  });
});

describe("a finished check does not resurrect superseded evidence", () => {
  /**
   * The ledger used to hold state.json in a useState initializer, and a check
   * run accumulated onto that copy, writing the whole thing back after every
   * job. An overnight deep `behind` recorded on disk was silently replaced by
   * the morning's quick `clean` applied to the stale copy, and the row read
   * `verified`. Losing evidence would be conservative; resurrecting
   * superseded evidence is not.
   *
   * So: the pre-state is a deep `clean` the row reads as `verified`; the
   * newer deep `behind` is then written into state.json behind the
   * interface's back, the way another session's overnight check would have;
   * and the morning's quick check is driven with `q`. The wait is on the
   * recorded scan in state.json, which cannot be stale — the row still shows
   * the previous pass's verdict while a check runs, so a text condition
   * would be satisfied instantly and the next keypress could land mid-check.
   */
  test("an overnight deep behind survives the morning's quick check", async () => {
    // The destination matches the source, timestamps preserved so rsync's
    // size-and-date comparison finds nothing to do: the quick check is a
    // real `clean` — exactly the record that used to clobber the deep one.
    cpSync(join(root, "src/photos-2019"), join(root, "dst/photos-2019"), {
      recursive: true,
      preserveTimestamps: true,
    });

    // On disk before the interface opens: a deep verify an hour ago that
    // found the unit clean. The fingerprint is the source's real one, so the
    // row reading `verified` is legitimate evidence, not a lie to be caught.
    const deepClean: Scan = {
      unit: "photos-2019",
      target: "dst",
      ts: Date.now() - 3_600_000,
      method: "deep",
      outcome: "clean",
      nChanges: 0,
      nExtra: 0,
      bytesPending: 0,
      fingerprint: fingerprint(join(root, "src/photos-2019"), config.exclude),
      sentinel: config.targets[0]!.sentinel!,
    };
    saveState(upsertScan(EMPTY_STATE, deepClean), stateFile());

    const s = mount();
    await s.ready();
    await waitFor(() => /\bverified\b/.test(rowFor(s.frame(), "photos-2019")), {
      what: "the row to read verified from the pre-seeded deep verify",
    });

    // Behind the interface's back: the overnight deep check, recorded by
    // another session, found the unit behind and replaced the clean record.
    // The interface still holds the clean one in memory.
    saveState(
      upsertScan(loadState(stateFile()), {
        ...deepClean,
        ts: Date.now(),
        outcome: "behind",
        nChanges: 1,
        nNew: 1,
        bytesPending: 3,
      }),
      stateFile(),
    );

    const quickTs = (): number =>
      loadState(stateFile())
        .scans.filter(
          (sc) => sc.unit === "photos-2019" && sc.target === "dst" && sc.method === "quick",
        )
        .reduce((a, sc) => Math.max(a, sc.ts), 0);
    const quickBefore = quickTs();
    await s.press("q");
    await waitFor(() => quickTs() > quickBefore, {
      what: "the quick check to be recorded in state.json",
      timeout: 45_000,
    });
    // Then, separately, for the render to reflect the merge: the first frame
    // after the record is the recorded verdict, and in the code this guards
    // against it would stay `verified` — so the wait is what turns that into
    // a failure rather than a flake.
    await waitFor(
      () => {
        const row = rowFor(s.frame(), "photos-2019");
        return !row.includes("check running") && !/\bverified\b/.test(row);
      },
      {
        what: "the row to stop reading verified for a folder a deep check found behind",
        timeout: 15_000,
      },
    );

    // The row does not read verified: the surviving deep record is `behind`,
    // and a quick clean cannot verify what a deep check just found changed.
    const row = rowFor(s.frame(), "photos-2019");
    expect(row).not.toMatch(/\bverified\b/);

    // And the deep record is still in state.json, next to the quick record
    // that superseded nothing.
    const onDisk = loadState(stateFile());
    const deepOnDisk = findScan(onDisk, "photos-2019", "dst", "deep", config.targets[0]!.sentinel!);
    expect(deepOnDisk?.outcome).toBe("behind");
    expect(
      onDisk.scans.some(
        (sc) => sc.unit === "photos-2019" && sc.target === "dst" && sc.method === "quick",
      ),
    ).toBe(true);
    s.unmount();
  });
});

describe("the debug log is readable", () => {
  /**
   * It once ran to 38,025 lines of which 38,006 were a per-render trace — the
   * useful 19 had to be grepped out. A diagnostic channel that has to be
   * filtered before it can be read is not one, so nothing may log per render.
   */
  test("nothing is written on every render", async () => {
    const log = join(root, "state", "syncy", "debug.log");
    process.env["SYNCY_DEBUG"] = "1";
    try {
      const s = mount();
      await s.ready();
      const after = existsSync(log) ? readFileSync(log, "utf8").split("\n").length : 0;
      // Move the cursor a few times: renders, and nothing worth logging.
      for (const _ of [0, 1, 2, 3, 4]) await s.press("j");
      await tick(200);
      const later = existsSync(log) ? readFileSync(log, "utf8").split("\n").length : 0;
      expect(later - after, "lines added by five keypresses").toBeLessThan(5);
      s.unmount();
    } finally {
      delete process.env["SYNCY_DEBUG"];
    }
  });

  test("a check records what it did and how long it took", async () => {
    // The one thing being diagnosed emitted nothing: only preflight, refresh
    // and sync were instrumented, so a deep verify was invisible.
    const log = join(root, "state", "syncy", "debug.log");
    process.env["SYNCY_DEBUG"] = "1";
    try {
      const s = mount();
      await s.ready();
      await s.press("q");
      await waitFor(
        () => existsSync(log) && /check\.(done|skipped)/.test(readFileSync(log, "utf8")),
        {
          what: "the check to record itself",
          timeout: 20_000,
        },
      );
      const text = readFileSync(log, "utf8");
      expect(text).toMatch(/check\.(start|skipped)/);
      s.unmount();
    } finally {
      delete process.env["SYNCY_DEBUG"];
    }
  });
});
