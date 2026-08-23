import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeFixtureDir, removeFixtureDir, waitFor } from "./helpers.ts";
import { render } from "ink-testing-library";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { EMPTY_CONFIG } from "../src/configio.ts";
import { configFile, stateFile } from "../src/paths.ts";
import { loadState, type Method } from "../src/state.ts";
import { checkBuild, DEFAULT_RSYNC } from "../src/rsync.ts";
import { SENTINEL_NAME } from "../src/sentinel.ts";
import { App } from "../src/tui/App.tsx";

/**
 * The whole application as one flow, driven by keystrokes only.
 *
 * Every other test covers a part. This covers the path a person actually
 * takes: first run with nothing configured, through to a unit reading
 * `verified` — which is the only claim the tool exists to make.
 */

const build = await checkBuild(DEFAULT_RSYNC);
const describeRsync = build.ok ? describe : describe.skip;

const ESC = "\u001B";
const ENTER = "\r";
const BACKSPACE = "\u007F";

let root: string;
let prevConfigHome: string | undefined;
let prevStateHome: string | undefined;

beforeEach(() => {
  root = makeFixtureDir("syncy-flow");
  mkdirSync(join(root, "src/photos-2019"), { recursive: true });
  mkdirSync(join(root, "src/photos-2024"), { recursive: true });
  mkdirSync(join(root, "ext"), { recursive: true });
  mkdirSync(join(root, "nas"), { recursive: true });
  for (let i = 0; i < 3; i++) {
    writeFileSync(join(root, "src/photos-2019", `p${i}.jpg`), `photo-2019-${i}`);
    writeFileSync(join(root, "src/photos-2024", `q${i}.jpg`), `photo-2024-${i}`);
  }
  prevConfigHome = process.env["XDG_CONFIG_HOME"];
  prevStateHome = process.env["XDG_STATE_HOME"];
  process.env["XDG_CONFIG_HOME"] = join(root, "cfg");
  process.env["XDG_STATE_HOME"] = join(root, "state");
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

const plain = (s: string | undefined): string => (s ?? "").replace(/\[[0-9;]*m/g, "");

/**
 * One unit's ledger row.
 *
 * Asserting against the whole frame is wrong: the legend line always contains
 * every state word, so `frame.includes("verified")` is true even when nothing
 * is verified. Leader dots identify a data row.
 */
function rowFor(frame: string, unit: string): string {
  const line = frame.split("\n").find((l) => l.includes(unit) && l.includes("....."));
  if (line === undefined) throw new Error(`no ledger row for ${unit} in:\n${frame}`);
  return line;
}
const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Driver {
  frame(): string;
  press(input: string): Promise<void>;
  type(text: string): Promise<void>;
  clear(): Promise<void>;
  unmount(): void;
}

function drive(): Driver {
  const r = render(<App config={EMPTY_CONFIG()} />);
  const press = async (input: string): Promise<void> => {
    r.stdin.write(input);
    await settle(60);
  };
  return {
    frame: () => plain(r.lastFrame()),
    press,
    type: async (text: string) => {
      r.stdin.write(text);
      await settle(60);
    },
    clear: async () => {
      for (let i = 0; i < 240; i++) r.stdin.write(BACKSPACE);
      await settle(60);
    },
    unmount: () => r.unmount(),
  };
}

/** Setup: set the source root, then add one target. */
async function configure(d: Driver, targetDir: string, name: string): Promise<void> {
  await d.press("s");
  await d.clear();
  await d.type(join(root, "src"));
  await d.press(ENTER);

  await d.press("a");
  await d.clear();
  await d.type(targetDir);
  await d.press(ENTER); // path accepted, now naming
  await d.clear();
  await d.type(name);
  await d.press(ENTER);
  // Adding a target writes a sentinel, detects the filesystem and probes it.
  await waitFor(
    () => existsSync(configFile()) && loadConfig(configFile()).targets.some((t) => t.name === name),
    // Adding a target spawns mount, diskutil and rsync; under a full-suite run
    // that is slower than the default budget.
    { what: `the ${name} target to be saved`, timeout: 40_000 },
  );
  await settle(300);
}

describeRsync("first run through to a verified unit", () => {
  test("setup configures the source root and a target, and persists both", async () => {
    const d = drive();
    expect(d.frame()).toContain("syncy · setup");

    await configure(d, join(root, "ext"), "ext");

    // Written to disk, not just held in memory.
    expect(existsSync(configFile())).toBe(true);
    const saved = loadConfig(configFile());
    expect(saved.source).toBe(join(root, "src"));
    expect(saved.targets).toHaveLength(1);
    expect(saved.targets[0]!.name).toBe("ext");

    // Nothing is written to the destination: the volume is identified by
    // asking the OS, and the identity is recorded in the config.
    expect(existsSync(join(root, "ext", SENTINEL_NAME))).toBe(false);
    expect(saved.targets[0]!.identity).toBeTruthy();
    d.unmount();
  }, 30_000);

  test("leaving setup shows the ledger, listing the source subfolders as units", async () => {
    const d = drive();
    await configure(d, join(root, "ext"), "ext");
    await d.press(ESC);
    await settle(300);

    const f = d.frame();
    expect(f).toContain("folder");
    expect(f).toContain("photos-2019");
    expect(f).toContain("photos-2024");
    d.unmount();
  }, 30_000);

  test("a freshly configured unit reads missing, never verified", async () => {
    // Nothing has been copied yet; the tool must not imply otherwise.
    const d = drive();
    await configure(d, join(root, "ext"), "ext");
    await d.press(ESC);
    await settle(300);
    await d.press("q"); // quick check
    await settle(2000);

    const row = rowFor(d.frame(), "photos-2019");
    expect(row).toContain("missing");
    expect(row).not.toContain("verified");
    d.unmount();
  }, 30_000);

  test("sync then deep verify takes a unit all the way to verified", async () => {
    const d = drive();
    await configure(d, join(root, "ext"), "ext");
    await configure2(d, join(root, "nas"), "nas");
    await d.press(ESC);
    await settle(300);

    // Two targets are required by default, so both must be synced.
    //
    // Every wait here is on an observable condition rather than a duration.
    // Fixed sleeps made this test a bet on how busy the machine is: it spawns
    // real rsync twice per iteration, and under a full-suite run the bet lost
    // often enough to look like a product bug.
    const targetNames = ["ext", "nas"] as const;
    for (let i = 0; i < 2; i++) {
      const quickBefore = new Map(targetNames.map((t) => [t, scanTsFor("quick", t)]));
      await d.press("q");
      // Waits on the recorded scan, not on the row's text.
      //
      // The row still shows the *previous* pass's verdict while a new check
      // runs, so a text condition was satisfied instantly and the next
      // keypress landed mid-check. `runCheck` begins `if (running !== null)
      // return;`, so that keypress was discarded in silence and the test hung
      // to its full timeout — which reads as slowness and is not.
      //
      // One target recording is not the run finishing. `runCheck` writes
      // state after each job but only clears `running` after every job in
      // the batch completes — with two targets configured, the first
      // destination's scan lands while the second is still being checked.
      // Waiting on any single scan's timestamp caught that half-finished
      // moment: measured with the state file polled at 1ms, the first
      // destination recorded at +324ms while the run did not actually end
      // until +680ms, a window wide enough to land the next keypress (`s`,
      // opening confirm) while `running` was still set — which App.tsx
      // refuses in silence, and the confirm page never opened. Requiring
      // every configured target's quick scan to advance waits for the batch,
      // not for its first member.
      await waitFor(() => targetNames.every((t) => scanTsFor("quick", t) > quickBefore.get(t)!), {
        what: `the quick check on pass ${i + 1} to be recorded for every target`,
        timeout: 45_000,
      });
      // A second, smaller gap remains between the state file and the
      // render: the last target's scan is written synchronously just before
      // `setRunning(null)`, but React's own re-render is a separate, later
      // tick — so the state-file condition above can go true a beat before
      // `running` actually clears in the component the `s` handler reads.
      // Measured: one run in a ten-run full-suite loop failed at the confirm
      // page preflight wait below, and rerunning this file alone reproduced
      // the same failure again a run later — both consistent with `s`
      // landing in that beat, not with the first-target race the scan-file
      // wait above already closes. The row's own "… check running …" text is
      // driven by the same `running` prop the `s` handler reads, so waiting
      // for it to leave the frame observes that guard directly rather than a
      // proxy for it.
      await waitFor(() => !d.frame().includes("check running"), {
        what: `pass ${i + 1}'s check to stop showing as running`,
        timeout: 45_000,
      });
      await d.press("s"); // opens the confirm page
      // The title appears before the preflight finishes, and the page ignores
      // [enter] until it does — so waiting on the title alone pressed enter
      // into a page that discarded it, and the run never started. "running…"
      // is the page's own not-ready marker.
      await waitFor(
        () => d.frame().includes("confirm sync") && !d.frame().includes("running…"),
        { what: "the confirm page preflight", timeout: 45_000 },
      );
      await d.press(ENTER); // runs it
      await waitFor(() => !d.frame().includes("confirm sync"), {
        what: `the sync on pass ${i + 1} to start`,
        timeout: 45_000,
      });
      // The Job screen swaps its footer from "running · [ctrl-c] cancel" to a
      // terminal line the moment rsync exits; [esc] back only appears then.
      await waitFor(() => d.frame().includes("[esc] back"), {
        what: `the sync on pass ${i + 1} to finish`,
        timeout: 60_000,
      });
      await d.press(ESC); // back to the ledger
      await waitFor(() => d.frame().includes("folder"), {
        what: "the ledger to come back",
        timeout: 10_000,
      });
    }

    // A transfer proves a copy happened, never that it matches.
    const deepBefore = scanTs("deep");
    await d.press("d");
    await waitFor(() => scanTs("deep") > deepBefore, {
      what: "the deep verify to be recorded",
      timeout: 60_000,
    });
    // Then, separately, for the ledger to show it. Two conditions, because a
    // single one could not tell "the check never ran" from "the check ran and
    // the row disagrees" — and those are a flaky test and a real bug.
    await waitFor(() => /verified/.test(rowFor(d.frame(), "photos-2019")), {
      what: "the ledger to show the recorded deep verify",
      timeout: 15_000,
    });

    const row = rowFor(d.frame(), "photos-2019");
    expect(row).toContain("verified");
    expect(row).not.toContain("unverified");
    d.unmount();
  }, 180_000);
});

/** Adds a second target to an App already showing the ledger or setup. */
/** The newest recorded scan of photos-2019 by this method, 0 if none. */
function scanTs(method: Method): number {
  try {
    return loadState(stateFile())
      .scans.filter((s) => s.unit === "photos-2019" && s.method === method)
      .reduce((a, s) => Math.max(a, s.ts), 0);
  } catch {
    return 0;
  }
}

/** The newest recorded scan of photos-2019 against one named target, 0 if none. */
function scanTsFor(method: Method, target: string): number {
  try {
    return loadState(stateFile())
      .scans.filter((s) => s.unit === "photos-2019" && s.method === method && s.target === target)
      .reduce((a, s) => Math.max(a, s.ts), 0);
  } catch {
    return 0;
  }
}

async function configure2(d: Driver, targetDir: string, name: string): Promise<void> {
  await d.press("a");
  await d.clear();
  await d.type(targetDir);
  await d.press(ENTER);
  await d.clear();
  await d.type(name);
  await d.press(ENTER);
  await waitFor(
    () => existsSync(configFile()) && loadConfig(configFile()).targets.some((t) => t.name === name),
    // Adding a target spawns mount, diskutil and rsync; under a full-suite run
    // that is slower than the default budget.
    { what: `the ${name} target to be saved`, timeout: 40_000 },
  );
  await settle(300);
}
