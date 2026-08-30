import { render } from "ink-testing-library";
import { loadConfig } from "../src/config.ts";
import { configFile } from "../src/paths.ts";
import { loadState } from "../src/state.ts";
import { App } from "../src/tui/App.tsx";

/**
 * Quits the interface mid-run, in a process of its own, and reports when.
 *
 * How long syncy takes to quit is a property of the process, not of the
 * component: it ends when the event loop drains, and both a running rsync and
 * a pending message timer hold it open. Neither is visible from inside a test
 * that shares the loop — `process.getActiveResourcesInfo()` returns nothing
 * under Bun — so the measurement has to be made from outside, on a process
 * that exits when it is genuinely finished.
 *
 * Prints `UNMOUNTED <epoch ms>` and returns. Whoever spawned it subtracts that
 * from the moment the process actually ends: that difference is the stretch
 * where the terminal has been handed back and the shell prompt has not
 * returned. Deliberately never calls `process.exit`, which is the whole point
 * — an exit call would mask exactly what is being measured.
 *
 * Two moments to quit at, because two different things hold the loop open and
 * the first hides the second. `mid-run` quits with rsync working, which is the
 * child process. `after-run` quits once the run has reported, which is the
 * timer that clears that report — up to eight seconds of it. A run quit
 * midway never schedules that timer, so measuring only the first would leave
 * the second untested while looking thorough.
 */

const when = process.argv[2] ?? "mid-run";
if (when !== "mid-run" && when !== "after-run") throw new Error(`unknown quit point: ${when}`);

const config = loadConfig(configFile());
const r = render(<App config={config} />);

const until = async (what: string, ready: () => boolean): Promise<void> => {
  const deadline = Date.now() + 30_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

// The first read has to finish before the ledger has rows to check: a key
// arriving while the source is still being walked reaches a run with nothing
// to run on, and is dropped.
await until("the ledger to have rows", () => (r.lastFrame() ?? "").includes("photos-2019"));

// Quick check, every folder: the run whose queue and closing message are what
// used to outlive the interface.
r.stdin.write("Q");

if (when === "mid-run") {
  // The recorded scan, not a duration: it cannot be stale, and it means rsync
  // is genuinely working rather than about to.
  await until("the first folder to be checked", () => loadState().scans.length > 0);
} else {
  // The report on screen is the observable that its timer is now pending.
  await until("the run to report", () => (r.lastFrame() ?? "").includes("check finished"));
}

r.unmount();
process.stdout.write(`UNMOUNTED ${Date.now()}\n`);
