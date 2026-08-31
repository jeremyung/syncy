import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { type Config, parseConfig } from "../src/config.ts";
import { configFile, stateFile } from "../src/paths.ts";
import { checkBuild, DEFAULT_RSYNC } from "../src/rsync.ts";
import { checkUnit } from "../src/scan.ts";
import { writeSentinel } from "../src/sentinel.ts";
import { loadState } from "../src/state.ts";
import { App } from "../src/tui/App.tsx";
import { makeFixtureDir, PROJECT_ROOT, removeFixtureDir, waitFor } from "./helpers.ts";

/**
 * What happens to the work when the interface goes away.
 *
 * `runCheck` is a plain async loop with no connection to React's lifecycle, so
 * quitting mid-run unmounted the interface and left the loop running: it
 * finished the check in flight, then spawned rsync for every remaining folder,
 * recording scans for tens of minutes with nothing on screen. The alternate
 * screen had already been handed back, so what the user saw was their shell,
 * no prompt, and both disks working.
 */

const build = await checkBuild(DEFAULT_RSYNC);
const describeRsync = build.ok ? describe : describe.skip;

/**
 * Six folders, replicated, each with enough files that a check is real work.
 *
 * The count matters in both directions. Too few files and every check finishes
 * before anything can be observed about interrupting one — the fixture would
 * pass these tests without the behaviour they exist to guard. Too many and the
 * suite pays for it on every run. Six hundred puts one check at roughly 30 ms
 * and the whole queue at a fifth of a second, which is long enough to catch in
 * the act and short enough to be worth the fixture.
 */
const UNITS = 6;
const FILES_PER_UNIT = 600;

let root: string;
let config: Config;
let prevConfigHome: string | undefined;
let prevStateHome: string | undefined;

beforeEach(async () => {
  root = makeFixtureDir("syncy-teardown");
  prevConfigHome = process.env["XDG_CONFIG_HOME"];
  prevStateHome = process.env["XDG_STATE_HOME"];
  process.env["XDG_CONFIG_HOME"] = join(root, "cfg");
  process.env["XDG_STATE_HOME"] = join(root, "state");

  const src = join(root, "src");
  const dst = join(root, "nas");
  for (let u = 0; u < UNITS; u++) {
    const dir = join(src, `photos-${2019 + u}`);
    mkdirSync(dir, { recursive: true });
    for (let f = 0; f < FILES_PER_UNIT; f++)
      writeFileSync(join(dir, `f${f}.jpg`), `frame-${u}-${f}`);
  }
  mkdirSync(dst, { recursive: true });
  // Replicated, so a check spawns rsync rather than reporting `missing` and
  // returning without one — an unspawned check measures nothing here.
  await Bun.spawn([DEFAULT_RSYNC, "-a", src + "/", dst + "/"], { stdout: "ignore" }).exited;

  const id = await writeSentinel(dst);
  mkdirSync(join(root, "cfg", "syncy"), { recursive: true });
  const toml = `
source = "${src}"
exclude = [".DS_Store"]

[status]
max_verify_age_days = 30
max_quick_age_days  = 7
min_targets         = 1

[[target]]
name = "nas"
path = "${dst}"
required = true
sentinel = "${id}"
`;
  writeFileSync(configFile(), toml);
  config = parseConfig(toml);
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

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describeRsync("a check can be called off", () => {
  test("aborting kills rsync instead of waiting for it", async () => {
    const ctrl = new AbortController();
    const started = Date.now();
    const promise = checkUnit(config, "photos-2019", config.targets[0]!, "quick", {
      signal: ctrl.signal,
    });
    // On the next turn of the loop: rsync is spawned and walking by then.
    setTimeout(() => ctrl.abort(), 0);
    const result = await promise;

    // Both codes mean the same thing and which one appears is a race with
    // rsync's own startup: 20 is rsync reporting "received SIGINT, SIGTERM, or
    // SIGHUP" itself, 143 is the shell convention for a process killed by
    // SIGTERM before it got that far. Either is proof the signal arrived,
    // rather than an inference from the timing. A fixture too small to
    // interrupt would report 0 here and fail, which is the point: this cannot
    // pass by finishing before the abort lands.
    expect([20, 143] as Array<number | null>).toContain(result.exitCode);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("the killed check reports an error, which is why a quit must not record it", async () => {
    const ctrl = new AbortController();
    const promise = checkUnit(config, "photos-2019", config.targets[0]!, "quick", {
      signal: ctrl.signal,
    });
    setTimeout(() => ctrl.abort(), 0);
    const result = await promise;

    // The verdict is about the kill, not about the folder. Recorded, it would
    // leave the ledger claiming a check had failed on a folder nobody checked.
    expect(result.scan.outcome).toBe("error");
    expect(result.exitCode).not.toBe(0);
  });
});

describeRsync("quitting stops the run it started", () => {
  test("the rest of the queue is abandoned, not drained", async () => {
    const r = render(<App config={config} />);
    // The opening read has to land first: until it does the ledger has no rows
    // and a check key reaches a run with nothing to run on.
    await waitFor(() => (r.lastFrame() ?? "").includes("photos-2019"), {
      what: "the ledger to have rows",
      timeout: 30_000,
    });
    r.stdin.write("Q"); // quick check, every folder

    // Wait on the recorded scan rather than on a duration: it cannot be stale,
    // and it means the run is genuinely under way.
    await waitFor(() => loadState().scans.length >= 1, {
      what: "the first folder to be checked",
      timeout: 30_000,
    });
    r.unmount();

    // Long enough that the whole queue — a fifth of a second of rsync — would
    // have finished several times over had anything still been driving it.
    await settle(2_000);
    const scans = loadState().scans.length;
    expect(
      scans,
      `the queue drained after the interface was gone: ${scans} of ${UNITS}`,
    ).toBeLessThan(UNITS);
  }, 60_000);
});

describeRsync("quitting ends the process", () => {
  /**
   * Measured from outside, because that is where it is visible.
   *
   * Everything holding the loop open here is invisible from within the same
   * loop: the rsync child, and the timer that clears the closing message —
   * eight seconds for the one naming a destination the run had to skip. The
   * process exits when they are gone, and until it does the user is looking at
   * a restored terminal with no prompt in it.
   */
  /** Runs the harness to the given quit point and reports how long the process outlived it. */
  async function lingerAfterQuitting(when: "mid-run" | "after-run"): Promise<number> {
    const proc = Bun.spawn(
      ["bun", "run", join(PROJECT_ROOT, "test", "teardown-harness.tsx"), when],
      {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          XDG_CONFIG_HOME: join(root, "cfg"),
          XDG_STATE_HOME: join(root, "state"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    const ended = Date.now();

    const unmountedAt = Number(/UNMOUNTED (\d+)/.exec(out)?.[1]);
    expect(unmountedAt, `the harness never reached the unmount:\n${out}\n${err}`).toBeGreaterThan(
      0,
    );
    return ended - unmountedAt;
  }

  test("quitting with rsync working does not wait for rsync", async () => {
    const lingered = await lingerAfterQuitting("mid-run");
    expect(
      lingered,
      `the process outlived the interface by ${lingered}ms — the check was still running`,
    ).toBeLessThan(1_000);
  }, 60_000);

  test("quitting after a run does not wait for the message to time out", async () => {
    // The message the run leaves on screen clears itself on a timer. Quitting
    // while it is pending used to hold the process open for the rest of it.
    const lingered = await lingerAfterQuitting("after-run");
    expect(
      lingered,
      `the process outlived the interface by ${lingered}ms — a message timer was still pending`,
    ).toBeLessThan(1_000);
  }, 60_000);
});

describeRsync("the fixture is capable of showing what these tests claim", () => {
  test("a check on one folder is real work, not an instant no-op", async () => {
    const started = Date.now();
    const result = await checkUnit(config, "photos-2019", config.targets[0]!, "quick");
    // Not a duration bound: an rsync that ran at all reports 0 here, and one
    // that never spawned reports null.
    expect(result.exitCode).toBe(0);
    expect(result.argv.length).toBeGreaterThan(0);
    expect(Date.now() - started).toBeGreaterThan(0);
  });

  test("the state file is where the queue's progress is visible", () => {
    expect(stateFile().startsWith(join(root, "state"))).toBe(true);
  });
});
