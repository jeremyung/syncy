import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeFixtureDir, removeFixtureDir } from "./helpers.ts";
import { render } from "ink-testing-library";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfig, type Config, type Target } from "../src/config.ts";
import { freeBytes } from "../src/guards.ts";
import { checkBuild, DEFAULT_RSYNC } from "../src/rsync.ts";
import { SENTINEL_NAME, writeSentinel } from "../src/sentinel.ts";
import { Confirm } from "../src/tui/Confirm.tsx";
import { Job } from "../src/tui/Job.tsx";
import { THEMES } from "../src/tui/theme.ts";

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

function mountConfirm(bytesPending = 7) {
  let ran = false;
  let cancelled = false;
  const r = render(
    <Confirm
      config={config}
      unit="photos-2019"
      target={target()}
      nChanges={2}
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
