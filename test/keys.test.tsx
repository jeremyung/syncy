import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { type Config, parseConfig } from "../src/config.ts";
import { SENTINEL_NAME, writeSentinel } from "../src/sentinel.ts";
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
    async press(s: string) {
      r.stdin.write(s);
      await tick();
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
    await tick();
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
    await tick();
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
      await tick();
      const before = s.frame();
      await s.press(key);
      expect(s.frame(), `[${key}] did nothing`).not.toBe(before);
      s.unmount();
    });
  }

  test("[f] cycles the filter", async () => {
    const s = mount();
    await tick();
    await s.press("f");
    expect(s.frame()).toContain("filter:");
    s.unmount();
  });
});

describe("the screens each key opens", () => {
  test("p opens the command list for the selected folder", async () => {
    const s = mount();
    await tick();
    await s.press("p");
    const f = s.frame();
    expect(f).toContain("what each key runs");
    expect(f).toContain("photos-2019");
    expect(f).toContain("quick check");
    s.unmount();
  });

  test("p shows the real rsync binary and flags, not a description", async () => {
    const s = mount();
    await tick();
    await s.press("p");
    expect(s.frame()).toContain("--partial-dir=.syncy-partial");
    s.unmount();
  });

  test("escape closes the command list", async () => {
    const s = mount();
    await tick();
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
    await tick();
    await s.press("p");
    await s.press(ESC);
    await s.press("?");
    expect(s.frame()).toContain("syncy · keys");
    s.unmount();
  });

  test("? lists the keys, and names which one writes", async () => {
    const s = mount();
    await tick();
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
    await tick();
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
    await tick();
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
    await tick();
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
      await tick();
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
      await tick();
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
