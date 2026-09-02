import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { type Config, parseConfig, type Target } from "../src/config.ts";
import { freeBytes } from "../src/guards.ts";
import { checkBuild, DEFAULT_RSYNC } from "../src/rsync.ts";
import { SENTINEL_NAME, writeSentinel } from "../src/sentinel.ts";
import { App } from "../src/tui/App.tsx";
import { Confirm, replaceLine } from "../src/tui/Confirm.tsx";
import { Job } from "../src/tui/Job.tsx";
import { THEMES } from "../src/tui/theme.ts";
import { makeFixtureDir, removeFixtureDir, waitFor } from "./helpers.ts";

const build = await checkBuild(DEFAULT_RSYNC);
const describeRsync = build.ok ? describe : describe.skip;

const ESC = "\u001B";
const ENTER = "\r";
const settle = (ms = 150): Promise<void> => new Promise((r) => setTimeout(r, ms));
const plain = (s: string | undefined): string => (s ?? "").replace(/\[[0-9;]*m/g, "");

let root: string;
let config: Config;
let prevStateHome: string | undefined;

const write = (p: string, body: string): void => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
};

beforeEach(async () => {
  root = makeFixtureDir("syncy-confirm");
  mkdirSync(join(root, "dst"), { recursive: true });
  write(join(root, "src/photos-2019/a.txt"), "aaa");
  write(join(root, "src/photos-2019/b.txt"), "bbbb");
  prevStateHome = process.env["XDG_STATE_HOME"];
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
  if (prevStateHome === undefined) delete process.env["XDG_STATE_HOME"];
  else process.env["XDG_STATE_HOME"] = prevStateHome;
  removeFixtureDir(root);
});

const target = (): Target => config.targets[0]!;

function mountConfirm(
  bytesPending = 7,
  over: { readonly nChanges?: number; readonly nNew?: number; readonly needsChecksum?: boolean } = {},
) {
  let ran = false;
  let cancelled = false;
  const r = render(
    <Confirm
      config={config}
      unit="photos-2019"
      target={target()}
      nChanges={over.nChanges ?? 2}
      {...(over.nNew === undefined ? {} : { nNew: over.nNew })}
      {...(over.needsChecksum === undefined ? {} : { needsChecksum: over.needsChecksum })}
      nExtra={3}
      bytesPending={bytesPending}
      theme={THEMES.ansi}
      width={76}
      onRun={() => {
        ran = true;
      }}
      onCancel={() => {
        cancelled = true;
      }}
    />,
  );
  return { ...r, frame: () => plain(r.lastFrame()), ran: () => ran, cancelled: () => cancelled };
}

describeRsync("the confirm page states what will happen", () => {
  test("names the unit and the target", async () => {
    const s = mountConfirm();
    await settle();
    expect(s.frame()).toContain("photos-2019");
    expect(s.frame()).toContain("dst");
  });

  test("says plainly that this is not a dry run", async () => {
    // The single most important line on the page.
    const s = mountConfirm();
    await settle();
    expect(s.frame()).toContain("this writes to the target");
  });

  test("states that extras at the target are left alone", async () => {
    const s = mountConfirm();
    await settle();
    expect(s.frame()).toContain("remain untouched");
  });

  test("shows the literal argv, including --partial-dir", async () => {
    // Nothing runs that is not shown here first.
    const s = mountConfirm();
    await settle();
    const f = s.frame();
    expect(f).toContain("--partial-dir=.syncy-partial");
    expect(f).not.toContain("--delete");
  });

  test("shows every guard check by name", async () => {
    const s = mountConfirm();
    await settle();
    for (const name of ["rsync", "source", "volume", "space", "dry run"]) {
      expect(s.frame()).toContain(name);
    }
  });
});

describeRsync("the confirm page refuses to launch when a check fails", () => {
  test("enter starts the sync when every check passes", async () => {
    const s = mountConfirm();
    await settle();
    s.stdin.write(ENTER);
    await settle(50);
    expect(s.ran()).toBe(true);
  });

  test("enter does NOTHING when the sentinel is gone", async () => {
    unlinkSync(join(target().path, SENTINEL_NAME));
    const s = mountConfirm();
    await settle();
    expect(s.frame()).toContain("blocked");
    s.stdin.write(ENTER);
    await settle(50);
    expect(s.ran()).toBe(false);
  });

  test("enter does nothing when there is not enough space", async () => {
    const s = mountConfirm(freeBytes(target().path)! * 2);
    await settle();
    expect(s.frame()).toContain("blocked");
    s.stdin.write(ENTER);
    await settle(50);
    expect(s.ran()).toBe(false);
  });

  test("escape always cancels", async () => {
    const s = mountConfirm();
    await settle();
    s.stdin.write(ESC);
    await settle(50);
    expect(s.cancelled()).toBe(true);
    expect(s.ran()).toBe(false);
  });

  test("enter before the checks finish does not start a sync", () => {
    // The window between mount and preflight resolving must not be a way in.
    const s = mountConfirm();
    s.stdin.write(ENTER);
    expect(s.ran()).toBe(false);
  });
});

describe("new versus replaced", () => {
  test("says nothing is replaced when every file is a creation", () => {
    expect(replaceLine(504, 504)).toBe("nothing — all 504 are new at the destination");
  });

  test("says all of them when every file is already there", () => {
    expect(replaceLine(12, 0)).toBe("all 12 — every one is already there and differs");
  });

  test("splits a mixed transfer both ways", () => {
    expect(replaceLine(504, 492)).toBe("12 of them · the other 492 are new at the destination");
  });

  test("offers no breakdown for a check written before nNew was tracked", () => {
    expect(replaceLine(504, undefined)).toBeNull();
  });
});

describeRsync("the confirm page separates creations from replacements", () => {
  test("shows the split beside the transfer total", async () => {
    const s = mountConfirm(7, { nChanges: 504, nNew: 492 });
    await settle();
    expect(s.frame()).toContain("will replace");
    expect(s.frame()).toContain("12 of them");
  });

  test("omits the row entirely when there is no breakdown to show", async () => {
    const s = mountConfirm();
    await settle();
    expect(s.frame()).not.toContain("will replace");
  });

  test("repair mode counts the files that actually differ", async () => {
    // Not `nChanges`: announcing 504 files as differing by content, when 492
    // of them are simply not there yet, is the reading this page had.
    const s = mountConfirm(7, { nChanges: 504, nNew: 492, needsChecksum: true });
    await settle();
    expect(s.frame()).toContain("12 differ by content");
    expect(s.frame()).not.toContain("504 differ by content");
  });
});

function mountJob(opts: { readonly bin?: string } = {}) {
  let result: { exitCode: number | null; cancelled: boolean; transferred: number } | null = null;
  let closed = false;
  const r = render(
    <Job
      config={config}
      unit="photos-2019"
      target={target()}
      nChanges={2}
      bytesPending={7}
      theme={THEMES.ansi}
      width={76}
      onDone={(res) => {
        result = res;
      }}
      onClose={() => {
        closed = true;
      }}
      {...(opts.bin !== undefined ? { bin: opts.bin } : {})}
    />,
  );
  return { ...r, frame: () => plain(r.lastFrame()), result: () => result, closed: () => closed };
}

/**
 * A script standing in for rsync: sleeps `seconds`, so a test can act while a
 * transfer is deterministically still in flight, then exits 0. `proc.kill()`
 * (`cancel()`) sends SIGTERM, which `sleep`'s default disposition honours
 * immediately, so a test that cancels does not have to wait out the sleep.
 */
function slowRsync(seconds: number): string {
  const bin = join(root, "slow-rsync.sh");
  writeFileSync(bin, `#!/bin/sh\nsleep ${seconds}\nexit 0\n`);
  chmodSync(bin, 0o755);
  return bin;
}

/**
 * Like `slowRsync`, but ignores the first SIGTERM for two seconds before
 * exiting. `sleep` dies the instant `cancel()` signals it, so the
 * "cancelling…" state between the keypress and the process actually exiting
 * has no observable width with a plain `slowRsync` — asserting on it would be
 * exactly the kind of race AGENTS.md warns against. This holds that window
 * open on purpose.
 *
 * The wait is broken into short bursts rather than one long `sleep`: on this
 * shell, a trap set on a script blocked in one long foreground `sleep` is not
 * run until that `sleep` itself returns — measured at a full extra 5s of
 * delay, not the 2s the trap asks for — because the shell does not revisit
 * pending traps until it regains control between commands. Short bursts give
 * it a chance to do that roughly every 100ms instead.
 */
function stubbornRsync(): string {
  const bin = join(root, "stubborn-rsync.sh");
  // Prints TRAP_READY *after* installing the trap, so a test can wait on the
  // trap actually being in place rather than on a duration. Without this the
  // cancel races the shell's own startup: a SIGTERM that arrives before the
  // `trap` line has run gets the default disposition and kills the stub
  // instantly, so the window this stub exists to hold open never opens and
  // the assertion fails against a transfer that already finished.
  writeFileSync(
    bin,
    "#!/bin/sh\ntrap 'sleep 2; exit 143' TERM\necho TRAP_READY\ni=0\nwhile [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done\nexit 0\n",
  );
  chmodSync(bin, 0o755);
  return bin;
}

/** The marker `stubbornRsync` prints once its TERM trap is installed. */
const TRAP_READY = "TRAP_READY";

describeRsync("the job view", () => {
  test("actually transfers the files", async () => {
    const s = mountJob();
    await settle(1200);
    expect(readFileSync(join(target().path, "photos-2019/a.txt"), "utf8")).toBe("aaa");
    expect(s.result()).not.toBeNull();
  });

  test("reports completion with a count", async () => {
    const s = mountJob();
    await settle(1200);
    expect(s.frame()).toContain("done");
    expect(s.frame()).toContain("files transferred");
  });

  test("does not claim the target is verified afterwards", async () => {
    // A transfer proves a copy happened, never that it matches.
    const s = mountJob();
    await settle(1200);
    expect(s.frame()).toContain("copying is not verifying");
    expect(s.frame()).not.toContain("✓ verified");
  });

  test("escape closes once finished, with no leftover refusal", async () => {
    const s = mountJob();
    await settle(1200);
    s.stdin.write(ESC);
    await settle(50);
    expect(s.closed()).toBe(true);
    expect(s.frame()).not.toContain("[esc] ignored");
  });

  test("writes a log for the run", async () => {
    mountJob();
    await settle(1200);
    const logs = join(root, "state/syncy/logs");
    expect(existsSync(logs)).toBe(true);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(logs).length).toBeGreaterThan(0);
  });
});

describe("esc while a transfer is running", () => {
  /**
   * esc used to call onClose() while a transfer was in flight: the screen
   * unmounted, the rsync child kept writing to the destination with nothing
   * attached to it, and App.tsx unlocked [s]/[q] the moment the screen
   * closed — a second sync could then start against the same tree the first
   * was still writing to. A slow, fake rsync holds the transfer open for the
   * whole test, so "still running" is a fact, not a race against real I/O.
   */
  test("does not close the screen", async () => {
    const s = mountJob({ bin: slowRsync(5) });
    s.stdin.write(ESC);
    await settle(100);
    expect(s.closed()).toBe(false);
    s.stdin.write("\x03"); // ctrl-c: let the fake process exit rather than leak it
    await settle(300);
  });

  test("shows a refusal naming ctrl-c, not a silent no-op", async () => {
    const s = mountJob({ bin: slowRsync(5) });
    s.stdin.write(ESC);
    await settle(100);
    expect(s.frame()).toContain("[esc] ignored");
    expect(s.frame()).toContain("ctrl-c");
    s.stdin.write("\x03");
    await settle(300);
  });

  test("ctrl-c still cancels after an esc was refused", async () => {
    // esc's refusal must not swallow or disturb the key that actually works.
    const s = mountJob({ bin: slowRsync(5) });
    s.stdin.write(ESC);
    await settle(100);
    s.stdin.write("\x03");
    await settle(500);
    expect(s.result()?.cancelled).toBe(true);
  });

  test("the footer names the second press once cancelling has started", async () => {
    // App.tsx's own ctrl-c handler eats the first press too (it lets Job act
    // on it and only exits on a second), so the second press has to be
    // discoverable here rather than something the user has to guess.
    const s = mountJob({ bin: stubbornRsync() });
    expect(s.frame()).toContain("running · [ctrl-c] cancel");
    await waitFor(() => s.frame().includes(TRAP_READY), { what: "the stub's TERM trap" });
    s.stdin.write("\x03");
    await settle(200);
    expect(s.frame()).toContain("cancelling");
    expect(s.frame()).toContain("[ctrl-c] again to quit");
    // Let the stubborn fake process actually die rather than leak it.
    await waitFor(() => s.frame().includes("[esc] back"), {
      what: "the delayed cancellation to finish",
    });
  }, 10_000);

  test("a cancellation says where the partial file is, not that nothing was left", async () => {
    // buildArgv passes --partial-dir=.syncy-partial on purpose (rsync.ts:~98)
    // so an interrupted transfer's fragment IS kept, quarantined out of the
    // archive's namespace so rsync can resume it. "nothing partial was left
    // behind" told a user who later found .syncy-partial that it should not
    // exist.
    const s = mountJob({ bin: slowRsync(5) });
    await settle(100);
    s.stdin.write("\x03");
    await settle(500);
    expect(s.frame()).toContain("cancelled after");
    expect(s.frame()).toContain(".syncy-partial");
    expect(s.frame()).not.toContain("nothing partial was left behind");
  });
});

/**
 * Ink calls every mounted `useInput` handler, so a ctrl-c during a transfer
 * used to reach both App.tsx and Job.tsx at once: Job cancelled rsync, and
 * App's own handler exited unconditionally in the same keystroke — the
 * process was gone before Job's screen could render the cancelled state or
 * its [esc] back. Driven through the real App, with a slow fake rsync so the
 * transfer is deterministically still in flight when ctrl-c lands.
 */
describe("ctrl-c during a transfer, from the app", () => {
  function mountApp(bin: string) {
    const r = render(<App config={config} bin={bin} />);
    return { ...r, frame: () => plain(r.lastFrame()) };
  }

  /** True once Ink's App component has torn down its stdin listener. */
  const mounted = (r: { stdin: { listenerCount(e: string): number } }): boolean =>
    r.stdin.listenerCount("readable") > 0;

  /** Opens the confirm page from the ledger and runs it, on an already-mounted app. */
  async function runFromLedger(d: ReturnType<typeof mountApp>): Promise<void> {
    // [s] offers a destination only when a cell reads `behind` or `missing`,
    // and both come from a recorded scan — a folder that has never been
    // checked reads `unchecked`, which [s] does not act on. So the check has
    // to run first, exactly as a person would have to run it.
    //
    // Wait on the run's own completion marker rather than on the scan landing
    // in state.json: `runCheck` saves each scan before it clears `running`,
    // and React clears it a tick later still, so a state-file condition goes
    // true while the ledger is still refusing keys. That is the race that made
    // the end-to-end test flaky (see test/e2e-flow.test.tsx and d01a55b).
    // A previous run's "check finished" can still be on screen — the ledger
    // holds that message for a couple of seconds. Waiting for it while it is
    // stale is satisfied instantly, and the [s] that follows then lands
    // mid-check and is refused: the same trap d01a55b fixed in the end-to-end
    // test, reintroduced by waiting on text instead of on this run's own
    // marker. Wait for the ledger to be idle first, so the marker below can
    // only be this run's.
    await waitFor(() => d.frame().includes("[s] sync"), { what: "the ledger to be idle" });
    d.stdin.write("q");
    await waitFor(() => d.frame().includes("check finished"), {
      what: "the quick check to finish",
    });
    d.stdin.write("s"); // opens the confirm page
    await waitFor(() => d.frame().includes("confirm sync") && !d.frame().includes("running…"), {
      what: "the confirm page preflight",
    });
    d.stdin.write(ENTER); // runs it
    await waitFor(() => d.frame().includes("running · [ctrl-c] cancel"), {
      what: "the transfer to start",
    });
  }

  async function startTransfer(bin: string) {
    const d = mountApp(bin);
    await settle();
    await runFromLedger(d);
    return d;
  }

  /**
   * Waits until the stubborn stub has installed its TERM trap.
   *
   * Cancelling before then races the shell's own startup: the signal lands
   * with its default disposition and the stub dies at once, closing the very
   * window the stub exists to hold open.
   */
  const trapReady = (d: { frame(): string }): Promise<void> =>
    waitFor(() => d.frame().includes(TRAP_READY), { what: "the stub's TERM trap" });

  test("the first ctrl-c cancels the transfer without quitting the app", async () => {
    const d = await startTransfer(stubbornRsync());
    await trapReady(d);
    d.stdin.write("\x03");
    await settle(200);
    // Still mounted: the job screen is still reading input and shows it is
    // cancelling, rather than the process having vanished mid-keystroke.
    expect(mounted(d)).toBe(true);
    expect(d.frame()).toContain("cancelling");
    // Let the stubborn fake process actually exit before the test moves on,
    // rather than leaking a child and a pending state write.
    await waitFor(() => d.frame().includes("[esc] back"), {
      what: "the cancelled transfer to finish",
    });
  }, 10_000);

  test("a second ctrl-c exits", async () => {
    const d = await startTransfer(slowRsync(5));
    d.stdin.write("\x03"); // cancels — Job's to act on, App must not exit yet
    await settle(200);
    expect(mounted(d)).toBe(true);
    d.stdin.write("\x03"); // ignores SIGTERM or not, this one must always quit
    await settle(200);
    expect(mounted(d)).toBe(false);
  });

  test("the count resets once the job screen closes, for the next transfer", async () => {
    // If the count carried over, this second transfer's very first ctrl-c
    // would be silently taken as the "second" press of the first transfer
    // and the app would exit instead of cancelling. Both transfers use the
    // stubborn fake so the mid-cancel window is observable for real, not by
    // racing a process that dies the instant it is signalled.
    const bin = stubbornRsync();
    const d = await startTransfer(bin);
    await trapReady(d);
    d.stdin.write("\x03"); // first press of transfer #1: cancels
    await waitFor(() => d.frame().includes("[esc] back"), {
      what: "transfer #1 to finish cancelling",
    });
    d.stdin.write(ESC); // back to the ledger; runningSync clears, resetting the count
    await waitFor(() => d.frame().includes("folder"), { what: "the ledger to come back" });

    await runFromLedger(d); // transfer #2
    await trapReady(d);
    d.stdin.write("\x03"); // first press of transfer #2: must cancel, not exit
    await settle(200);
    expect(mounted(d)).toBe(true);
    expect(d.frame()).toContain("cancelling");
    // Let transfer #2's cancellation finish rather than leaking the process.
    await waitFor(() => d.frame().includes("[esc] back"), {
      what: "transfer #2 to finish cancelling",
    });
  }, 20_000);
});
