import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type Config, parseConfig, type Target } from "../src/config.ts";
import type { Fingerprint } from "../src/fingerprint.ts";
import { deleteCheck, freeBytes, preflight, SPACE_MARGIN } from "../src/guards.ts";
import { buildArgv, checkBuild, DEFAULT_RSYNC, RsyncError } from "../src/rsync.ts";
import { checkUnit } from "../src/scan.ts";
import { SENTINEL_NAME, writeSentinel } from "../src/sentinel.ts";
import type { Scan } from "../src/state.ts";
import { cellState } from "../src/status.ts";
import { startSync, syncLogPath } from "../src/sync.ts";
import { makeFixtureDir, removeFixtureDir } from "./helpers.ts";

const build = await checkBuild(DEFAULT_RSYNC);
const describeRsync = build.ok ? describe : describe.skip;

let root: string;
let config: Config;
let prevStateHome: string | undefined;

const write = (p: string, body: string): void => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
};

beforeEach(async () => {
  root = makeFixtureDir("syncy-sync");
  mkdirSync(join(root, "dst"), { recursive: true });
  write(join(root, "src/photos-2019/a.txt"), "aaa");
  write(join(root, "src/photos-2019/b.txt"), "bbbb");
  write(join(root, "src/photos-2019/.DS_Store"), "junk");

  // History and logs must land in the fixture, not the real state directory.
  prevStateHome = process.env["XDG_STATE_HOME"];
  process.env["XDG_STATE_HOME"] = join(root, "state");

  const id = await writeSentinel(join(root, "dst"));
  config = parseConfig(`
source = "${join(root, "src")}"
exclude = [".DS_Store"]

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

describe("the dry-run check, restated for the user", () => {
  test("a sync argv is reported as writing, and flagged to be read", () => {
    const c = deleteCheck(buildArgv("sync", "/a", target(), []));
    expect(c.ok).toBe(true);
    expect(c.warn).toBe(true);
    expect(c.detail).toContain("this writes to the target");
  });

  test("a quick check argv is reported as writing nothing", () => {
    const c = deleteCheck(buildArgv("quick", "/a", target(), []));
    expect(c.ok).toBe(true);
    expect(c.warn).toBeUndefined();
    expect(c.detail).toContain("nothing will be written");
  });

  test("--delete without a dry run FAILS the check, it does not merely warn", () => {
    const c = deleteCheck(["-a", "--delete", "/a/", "/b/"]);
    expect(c.ok).toBe(false);
  });

  test("--delete-during without a dry run fails too", () => {
    expect(deleteCheck(["-a", "--delete-during", "/a/", "/b/"]).ok).toBe(false);
  });
});

describe("free space", () => {
  test("reads a real number for a real path", () => {
    const free = freeBytes(root);
    expect(free).not.toBeNull();
    expect(free!).toBeGreaterThan(0);
  });

  test("returns null rather than guessing for a path that does not exist", () => {
    expect(freeBytes(join(root, "absent"))).toBeNull();
  });
});

describeRsync("preflight", () => {
  test("passes on a healthy target", async () => {
    const p = await preflight(config, target(), buildArgv("sync", "/a", target(), []), 100);
    expect(p.ok).toBe(true);
    expect(p.checks.map((c) => c.name)).toEqual(["rsync", "source", "volume", "space", "dry run"]);
  });

  test("blocks when the sentinel is gone, though the directory still exists", async () => {
    // The disaster this prevents: writing gigabytes onto the boot disk at an
    // unmounted mount point.
    unlinkSync(join(target().path, SENTINEL_NAME));
    const p = await preflight(config, target(), buildArgv("sync", "/a", target(), []), 100);
    expect(p.ok).toBe(false);
    const sentinel = p.checks.find((c) => c.name === "volume")!;
    expect(sentinel.ok).toBe(false);
    expect(sentinel.detail).toContain("refusing to write");
  });

  test("blocks when a different volume is mounted at the path", async () => {
    writeFileSync(join(target().path, SENTINEL_NAME), "a-different-uuid\n");
    const p = await preflight(config, target(), buildArgv("sync", "/a", target(), []), 100);
    expect(p.checks.find((c) => c.name === "volume")!.ok).toBe(false);
  });

  test("blocks when the pending bytes exceed free space", async () => {
    const free = freeBytes(target().path)!;
    const p = await preflight(config, target(), buildArgv("sync", "/a", target(), []), free * 2);
    expect(p.ok).toBe(false);
    expect(p.checks.find((c) => c.name === "space")!.ok).toBe(false);
  });

  test("requires headroom above the exact pending size", async () => {
    // Filling the target to the last byte is not success.
    const free = freeBytes(target().path)!;
    const justOver = Math.floor(free / SPACE_MARGIN) + 1024;
    const p = await preflight(config, target(), buildArgv("sync", "/a", target(), []), justOver);
    expect(p.checks.find((c) => c.name === "space")!.ok).toBe(false);
  });

  test("blocks when the source root has gone", async () => {
    const gone = parseConfig(
      `source = "${join(root, "absent")}"\n[[target]]\nname="dst"\npath="${target().path}"\nsentinel="${target().sentinel ?? ""}"\n`,
    );
    const p = await preflight(gone, target(), buildArgv("sync", "/a", target(), []), 10);
    expect(p.checks.find((c) => c.name === "source")!.ok).toBe(false);
  });

  test("blocks a --delete argv outright", async () => {
    const p = await preflight(config, target(), ["-a", "--delete", "/a/", "/b/"], 10);
    expect(p.ok).toBe(false);
  });
});

describeRsync("a first copy states what it will actually move", () => {
  /**
   * A `missing` cell was built from `base`, which sets bytesPending: 0 — true
   * of a check that itemised nothing, wrong as the figure everything
   * downstream consumes. preflight's `needed = ceil(bytesPending *
   * SPACE_MARGIN)` came out to 0, so `free >= needed` passed for any free
   * space including none — the free-space guard was disabled for exactly the
   * case it exists to catch: the first full copy of an archive onto a new
   * drive. Before the fix this test's preflight call would pass.
   */
  test("preflight fails for a missing cell whose source outsizes the destination's free space", async () => {
    const free = freeBytes(target().path)!;
    const tooBig: Fingerprint = { nfiles: 10, bytes: Math.ceil(free * 2), maxMtimeNs: "1" };
    const missingScan: Scan = {
      unit: "photos-2019",
      target: "dst",
      ts: Date.now(),
      method: "quick",
      outcome: "missing",
      nChanges: 0,
      nExtra: 0,
      bytesPending: 0,
      fingerprint: tooBig,
      sentinel: target().sentinel ?? "",
    };
    const c = cellState({
      target: target(),
      sentinel: "ok",
      fingerprintNow: tooBig,
      deep: undefined,
      quick: missingScan,
      latest: missingScan,
      now: Date.now(),
      maxVerifyAgeDays: 30,
      maxQuickAgeDays: 7,
    });
    expect(c.state).toBe("missing");
    // The figure a copy will actually move, not the 0 an itemize-nothing
    // check produced.
    expect(c.bytesPending).toBe(tooBig.bytes);

    const p = await preflight(
      config,
      target(),
      buildArgv("sync", "/a", target(), []),
      c.bytesPending,
    );
    expect(p.ok).toBe(false);
    expect(p.checks.find((ch) => ch.name === "space")!.ok).toBe(false);
  });
});

describeRsync("startSync", () => {
  test("encodes unit and target names before building a log path", () => {
    const path = syncLogPath("../unit/with spaces", "../../target", Date.now());
    expect(path).toContain("/state/syncy/logs/");
    expect(path).not.toContain("../");
    expect(path.endsWith(".log")).toBe(true);
  });

  test("rejects a caller-provided log path outside syncy's state", () => {
    expect(() =>
      startSync(config, "photos-2019", target(), { logPath: join(root, "outside.log") }),
    ).toThrow(/outside/);
  });

  test("copies the unit to the target", async () => {
    const h = startSync(config, "photos-2019", target());
    const r = await h.done;
    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(target().path, "photos-2019/a.txt"), "utf8")).toBe("aaa");
    expect(readFileSync(join(target().path, "photos-2019/b.txt"), "utf8")).toBe("bbbb");
  });

  test("honours excludes", async () => {
    await startSync(config, "photos-2019", target()).done;
    expect(existsSync(join(target().path, "photos-2019/.DS_Store"))).toBe(false);
  });

  test("never carries --delete", async () => {
    // A sync must not be able to remove anything at the target, ever.
    const h = startSync(config, "photos-2019", target());
    expect(h.argv).not.toContain("--delete");
    await h.done;
  });

  test("uses --partial-dir so an interruption leaves no half-file at the final path", async () => {
    const h = startSync(config, "photos-2019", target());
    expect(h.argv).toContain("--partial-dir=.syncy-partial");
    expect(h.argv).not.toContain("--partial");
    await h.done;
  });

  test("leaves files already at the target that are not at the source", async () => {
    write(join(target().path, "photos-2019/orphan.txt"), "keep me");
    await startSync(config, "photos-2019", target()).done;
    expect(readFileSync(join(target().path, "photos-2019/orphan.txt"), "utf8")).toBe("keep me");
  });

  test("writes the argv to history BEFORE the process finishes", async () => {
    const h = startSync(config, "photos-2019", target());
    const historyPath = join(root, "state/syncy/history.jsonl");
    // The record exists while the transfer is still in flight.
    expect(existsSync(historyPath)).toBe(true);
    const first = JSON.parse(readFileSync(historyPath, "utf8").trim().split("\n")[0]!);
    expect(first.exitCode).toBeNull();
    expect(first.argv).toEqual(h.argv);
    await h.done;
  });

  test("records the exit code once it finishes", async () => {
    await startSync(config, "photos-2019", target()).done;
    const lines = readFileSync(join(root, "state/syncy/history.jsonl"), "utf8").trim().split("\n");
    expect(JSON.parse(lines[lines.length - 1]!).exitCode).toBe(0);
  });

  test("writes a log naming the literal command that ran", async () => {
    const h = startSync(config, "photos-2019", target());
    await h.done;
    const log = readFileSync(h.logPath, "utf8");
    expect(log).toContain(DEFAULT_RSYNC);
    expect(log).toContain("--partial-dir");
  });

  test("reports how many files it transferred", async () => {
    const r = await startSync(config, "photos-2019", target()).done;
    expect(r.transferred).toBeGreaterThanOrEqual(2);
  });

  test("refuses a unit that is not at the source", () => {
    expect(() => startSync(config, "no-such-unit", target())).toThrow(RsyncError);
  });

  test("cancel stops the transfer and says so", async () => {
    const h = startSync(config, "photos-2019", target());
    h.cancel();
    const r = await h.done;
    expect(r.cancelled).toBe(true);
    expect(r.exitCode).not.toBe(0);
  });

  test("a cancelled transfer leaves no partial file at a final path", async () => {
    // --partial-dir is what makes this true; a bare --partial would leave a
    // truncated file that a later quick check would compare by size and mtime.
    const h = startSync(config, "photos-2019", target());
    h.cancel();
    await h.done;
    const dir = join(target().path, "photos-2019");
    const stray = existsSync(dir)
      ? readdirSync(dir).filter((n) => !n.startsWith(".syncy-partial"))
      : [];
    for (const name of stray) {
      const full = join(dir, name);
      const expected = readFileSync(join(config.source, "photos-2019", name), "utf8");
      expect(readFileSync(full, "utf8"), `${name} is truncated`).toBe(expected);
    }
  });
});

describeRsync("repairing what a deep verify found", () => {
  /** Corrupts a file at the target, preserving size and mtime — bit rot. */
  const rot = (rel: string, replacement: string): void => {
    const p = join(target().path, rel);
    const before = statSync(p);
    writeFileSync(p, replacement);
    expect(statSync(p).size, "the corruption must be the same size").toBe(before.size);
    utimesSync(p, before.atime, before.mtime);
  };

  test("a quick check cannot see it, but a deep verify can", async () => {
    await startSync(config, "photos-2019", target()).done;
    rot("photos-2019/b.txt", "xxxx");

    const quick = await checkUnit(config, "photos-2019", target(), "quick");
    expect(quick.scan.outcome).toBe("clean");

    const deep = await checkUnit(config, "photos-2019", target(), "deep");
    expect(deep.scan.outcome).toBe("behind");
  });

  test("a plain sync does NOT repair it", async () => {
    // The gap this exists to close: rsync's default check compares size and
    // date, so it skips exactly the file the deep verify flagged.
    await startSync(config, "photos-2019", target()).done;
    rot("photos-2019/b.txt", "xxxx");
    await startSync(config, "photos-2019", target()).done;
    expect(readFileSync(join(target().path, "photos-2019/b.txt"), "utf8")).toBe("xxxx");
  });

  test("a checksum sync repairs it", async () => {
    await startSync(config, "photos-2019", target()).done;
    rot("photos-2019/b.txt", "xxxx");
    const h = startSync(config, "photos-2019", target(), { checksum: true });
    expect(h.argv).toContain("-c");
    await h.done;
    expect(readFileSync(join(target().path, "photos-2019/b.txt"), "utf8")).toBe("bbbb");
  });

  test("and the folder then verifies clean", async () => {
    await startSync(config, "photos-2019", target()).done;
    rot("photos-2019/b.txt", "xxxx");
    await startSync(config, "photos-2019", target(), { checksum: true }).done;
    const deep = await checkUnit(config, "photos-2019", target(), "deep");
    expect(deep.scan.outcome).toBe("clean");
  });

  test("a plain sync carries no -c, so the cost is only paid when needed", () => {
    expect(buildArgv("sync", "/s", target(), [])).not.toContain("-c");
    expect(buildArgv("sync", "/s", target(), [], { checksum: true })).toContain("-c");
  });

  test("repair mode still uses --partial-dir and still never deletes", () => {
    const argv = buildArgv("sync", "/s", target(), [], { checksum: true });
    expect(argv).toContain("--partial-dir=.syncy-partial");
    expect(argv).not.toContain("--delete");
  });
});
