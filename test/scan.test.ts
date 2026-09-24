import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Config, parseConfig, type Target } from "../src/config.ts";
import { MAX_ENTRIES } from "../src/diff.ts";
import { checkBuild, DEFAULT_RSYNC } from "../src/rsync.ts";
import { checkUnit, observeTargetSync } from "../src/scan.ts";
import { SENTINEL_NAME } from "../src/sentinel.ts";
import { appendHistory, type Scan } from "../src/state.ts";
import { type SyncResult, startSync } from "../src/sync.ts";
import { forgetMountTable, identifySync, mountTableReads } from "../src/volume.ts";
import { makeFixtureDir, removeFixtureDir } from "./helpers.ts";

/**
 * `checkUnit` records the exit code rsync actually returned, not a code
 * invented from syncy's own verdict, and treats rsync's exit 24 — "some
 * files vanished before they could be transferred" — as routine on a live
 * archive rather than as an error.
 *
 * A fake "rsync" stands in for the real one: the exit code has to be exactly
 * what the test says, and a small, static fixture cannot be relied on to make
 * the real binary return 23 or 24 on demand.
 */

const build = await checkBuild(DEFAULT_RSYNC);
const describeRsync = build.ok ? describe : describe.skip;

let root: string;
beforeEach(() => {
  root = makeFixtureDir("syncy-scan");
});
afterEach(() => {
  removeFixtureDir(root);
});

/** A script standing in for rsync: ignores its argv, prints `lines`, exits `code`. */
function fakeRsync(code: number, lines: readonly string[] = []): string {
  const bin = join(root, `fake-rsync-${code}-${Math.random().toString(36).slice(2)}.sh`);
  const body =
    "#!/bin/sh\n" + lines.map((l) => `printf '%s\\n' '${l}'\n`).join("") + `exit ${code}\n`;
  writeFileSync(bin, body);
  chmodSync(bin, 0o755);
  return bin;
}

function makeConfig(): Config {
  return parseConfig(`
source = "${join(root, "src")}"

[[target]]
name = "ext"
path = "${join(root, "ext")}"
sentinel = "s1"
`);
}

/** A unit that already exists at both the source and the destination. */
function setUpUnit(config: Config): Target {
  mkdirSync(join(config.source, "photos"), { recursive: true });
  const target = config.targets[0]!;
  mkdirSync(join(target.path, "photos"), { recursive: true });
  writeFileSync(join(target.path, SENTINEL_NAME), `${target.sentinel}\n`);
  return target;
}

describe("checkUnit records the exit code rsync actually returned", () => {
  test("a non-zero code is recorded literally, not folded to 1", async () => {
    const config = makeConfig();
    const target = setUpUnit(config);
    const { exitCode, scan } = await checkUnit(config, "photos", target, "quick", {
      bin: fakeRsync(5),
    });
    expect(exitCode).toBe(5);
    expect(scan.outcome).toBe("error");
  });

  test("the code reaches history.jsonl unchanged", async () => {
    // The bug: App.tsx and cli.ts wrote `scan.outcome === "error" ? 1 : 0` —
    // syncy's own verdict, not the number rsync returned.
    const config = makeConfig();
    const target = setUpUnit(config);
    const { exitCode, argv, scan } = await checkUnit(config, "photos", target, "quick", {
      bin: fakeRsync(5),
    });
    const file = join(root, "history.jsonl");
    appendHistory({ ts: scan.ts, unit: "photos", target: target.name, argv, exitCode }, file);
    const written = JSON.parse(readFileSync(file, "utf8").trim());
    expect(written.exitCode).toBe(5);
  });

  test("exit 0 is unaffected", async () => {
    const config = makeConfig();
    const target = setUpUnit(config);
    const { exitCode, scan } = await checkUnit(config, "photos", target, "quick", {
      bin: fakeRsync(0),
    });
    expect(exitCode).toBe(0);
    expect(scan.outcome).toBe("clean");
  });

  test("exit 23 — partial transfer — is still an error", async () => {
    // Distinguished on purpose from 24: 23 means rsync could not finish
    // sending some files, which is a real problem the run should surface.
    const config = makeConfig();
    const target = setUpUnit(config);
    const { exitCode, scan } = await checkUnit(config, "photos", target, "quick", {
      bin: fakeRsync(23),
    });
    expect(exitCode).toBe(23);
    expect(scan.outcome).toBe("error");
  });
});

describe("exit 24 — files vanished mid-walk — is not an error", () => {
  /**
   * rsync returns 24 when a file it saw while building its list is gone by
   * the time it gets to it — routine on an archive that is still being
   * written to while a check reads it. Counting every non-zero exit as an
   * error made a perfectly healthy folder read as broken on any check that
   * raced an ordinary write.
   */
  test("a clean result under exit 24 is reported clean, not error", async () => {
    const config = makeConfig();
    const target = setUpUnit(config);
    const { exitCode, scan } = await checkUnit(config, "photos", target, "quick", {
      bin: fakeRsync(24),
    });
    expect(exitCode).toBe(24);
    expect(scan.outcome).toBe("clean");
  });

  test("itemized changes under exit 24 still report behind, not error", async () => {
    const config = makeConfig();
    const target = setUpUnit(config);
    const { scan } = await checkUnit(config, "photos", target, "quick", {
      bin: fakeRsync(24, [">f+++++++++|5|new.txt"]),
    });
    expect(scan.outcome).toBe("behind");
    expect(scan.nChanges).toBe(1);
  });
});

describe("itemize output is accumulated with bounded memory", () => {
  test("retains only the display cap while keeping exact totals", async () => {
    const config = makeConfig();
    const target = setUpUnit(config);
    const total = MAX_ENTRIES + 250;
    const lines = Array.from({ length: total }, (_, i) => `>f+++++++++|1|file-${i}.txt`);
    const result = await checkUnit(config, "photos", target, "quick", {
      bin: fakeRsync(0, lines),
    });
    expect(result.diff.entries).toHaveLength(MAX_ENTRIES);
    expect(result.diff.truncated).toBe(250);
    expect(result.diff.totals?.new).toBe(total);
    expect(result.scan.nChanges).toBe(total);
    expect(result).not.toHaveProperty("items");
  });
});

/** How many times `fn` caused the mount table to be read from the system. */
async function reads(fn: () => Promise<unknown>): Promise<number> {
  const before = mountTableReads();
  await fn();
  return mountTableReads() - before;
}

/**
 * A destination wired the way a real one is: the identity the OS actually
 * reports for the fixture path, resolved at test time rather than invented,
 * plus a sentinel at the target root for machines whose identity is only a
 * device path.
 *
 * Both matters. A wrong identity makes the observation come back `mismatch`
 * and the check throw; and a target that carries only a sentinel takes the
 * readSentinel branch and reads no mount table at all, so a test built on one
 * would count zero reads and pass vacuously.
 */
function realTarget(): { config: Config; target: Target; id: string } {
  const src = join(root, "src");
  const dst = join(root, "dst");
  mkdirSync(join(src, "photos"), { recursive: true });
  writeFileSync(join(src, "photos/a.txt"), "aaa");
  mkdirSync(dst, { recursive: true });
  writeFileSync(join(dst, SENTINEL_NAME), "s1\n");

  const found = identifySync(dst);
  if (found === null || found.id === "") {
    throw new Error("cannot identify the fixture volume");
  }

  const config = parseConfig(`
source = "${src}"

[[target]]
name = "ext"
path = "${dst}"
identity = "${found.id}"
identity_kind = "${found.kind}"
sentinel = "s1"
`);
  return { config, target: config.targets[0]!, id: found.id };
}

/** Copies a unit to the destination with real rsync, the way a sync would. */
async function replicate(config: Config, target: Target, unit: string): Promise<void> {
  const dst = join(target.path, unit);
  mkdirSync(dst, { recursive: true });
  const proc = Bun.spawn([DEFAULT_RSYNC, "-a", join(config.source, unit) + "/", dst + "/"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
}

/**
 * One uncached destination observation per decision point, and nowhere else.
 *
 * checkUnit used to take two — one at entry, one at its real decision point.
 * The entry one was strictly older than the observation that decided, so it
 * bought nothing, and it cost a synchronous mount-table read (measured at
 * 1380 ms per /sbin/mount with a share mounted) for every unit-destination
 * pair of a job that writes nothing. It was removed: the missing-folder path
 * now observes right after the existence check, and the rsync path observes
 * as the last destination operation before runRsync. startSync still takes
 * its own observation immediately before the only spawn that can write.
 *
 * The count is mount-table reads, not spawns: on Linux the table is a file,
 * so a spawn count says 1 on macOS and 0 here for the same correct behaviour.
 *
 * Every assertion below runs against a destination that carries the identity
 * the OS reports for the fixture path (realTarget): a destination carrying
 * only a sentinel reads no mount table at all, and a test built on one would
 * assert 0 === 1, or pass vacuously.
 */
describeRsync("every decision point pays for exactly one destination observation", () => {
  test("one uncached observation is exactly one mount-table read", async () => {
    // The arithmetic the toBe(1) below rests on: before the change a job took
    // an entry observation in addition to the one at its decision point, so
    // the same job read the table twice and toBe(1) would have been red.
    const { target } = realTarget();
    forgetMountTable();
    const n = await reads(() => Promise.resolve(observeTargetSync(target)));
    expect(n).toBe(1);
  });

  test("the missing-folder path reads the table once", async () => {
    const { config, target, id } = realTarget();
    forgetMountTable();
    let scan: Scan | undefined;
    const n = await reads(async () => {
      scan = (await checkUnit(config, "photos", target, "quick")).scan;
    });
    expect(n).toBe(1);
    expect(scan?.outcome).toBe("missing");
    // The field is named sentinel, but on an identity target it carries the
    // identity actually observed for this invocation — the OS's answer for
    // the fixture path, not a value read back from the config.
    expect(scan?.sentinel).toBe(id);
  });

  test("the rsync path reads the table once", async () => {
    const { config, target, id } = realTarget();
    await replicate(config, target, "photos");
    forgetMountTable();
    let scan: Scan | undefined;
    const n = await reads(async () => {
      scan = (await checkUnit(config, "photos", target, "quick")).scan;
    });
    expect(n).toBe(1);
    expect(scan?.outcome).toBe("clean");
    expect(scan?.sentinel).toBe(id);
  });

  test("startSync takes its own read at the write boundary", async () => {
    // Without the observation this call would read the table zero times and
    // the assertion below would go red: that read is what stands between the
    // spawn and the destination.
    const { config, target } = realTarget();
    const prev = process.env["XDG_STATE_HOME"];
    process.env["XDG_STATE_HOME"] = join(root, "state");
    let result: SyncResult | undefined;
    try {
      forgetMountTable();
      const n = await reads(async () => {
        result = await startSync(config, "photos", target).done;
      });
      expect(n).toBeGreaterThanOrEqual(1);
      expect(result?.exitCode).toBe(0);
      expect(readFileSync(join(target.path, "photos/a.txt"), "utf8")).toBe("aaa");
    } finally {
      if (prev === undefined) delete process.env["XDG_STATE_HOME"];
      else process.env["XDG_STATE_HOME"] = prev;
    }
  });
});
