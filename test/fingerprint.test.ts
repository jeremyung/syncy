import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  type Dirent,
  lstat,
  lstatSync,
  mkdirSync,
  opendir,
  opendirSync,
  readlink,
  readlinkSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type Config, parseConfig, type Target } from "../src/config.ts";
import {
  EMPTY,
  type Fingerprint,
  type FingerprintIo,
  type FingerprintIoAsync,
  fingerprint,
  fingerprintAsync,
  matchesAny,
  sameFingerprint,
} from "../src/fingerprint.ts";
import { checkBuild, DEFAULT_RSYNC } from "../src/rsync.ts";
import { checkUnit } from "../src/scan.ts";
import { SENTINEL_NAME } from "../src/sentinel.ts";
import { makeFixtureDir, removeFixtureDir } from "./helpers.ts";

let dir: string;
beforeEach(() => {
  dir = makeFixtureDir("syncy-fp");
});
afterEach(() => {
  removeFixtureDir(dir);
});

const write = (rel: string, body: string): string => {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
  return p;
};

describe("fingerprint", () => {
  test("counts files and bytes across nested directories", () => {
    write("a.txt", "12345");
    write("sub/b.txt", "123");
    write("sub/deep/c.txt", "1");
    const fp = fingerprint(dir);
    expect(fp.nfiles).toBe(3);
    expect(fp.bytes).toBe(9);
  });

  test("an empty directory fingerprints as empty", () => {
    expect(fingerprint(dir)).toEqual(EMPTY);
  });

  test("a missing root does not throw", () => {
    expect(fingerprint(join(dir, "nope"))).toEqual(EMPTY);
  });

  test("detects an added file", () => {
    write("a.txt", "x");
    const before = fingerprint(dir);
    write("b.txt", "y");
    expect(sameFingerprint(before, fingerprint(dir))).toBe(false);
  });

  test("detects a size change", () => {
    write("a.txt", "x");
    const before = fingerprint(dir);
    write("a.txt", "xxxxx");
    expect(sameFingerprint(before, fingerprint(dir))).toBe(false);
  });

  test("detects a touch that leaves size unchanged", () => {
    const p = write("a.txt", "xxx");
    const before = fingerprint(dir);
    const future = new Date(Date.now() + 60_000);
    utimesSync(p, future, future);
    expect(sameFingerprint(before, fingerprint(dir))).toBe(false);
  });

  test("is stable across repeated walks of unchanged content", () => {
    write("a.txt", "x");
    write("sub/b.txt", "yy");
    expect(fingerprint(dir)).toEqual(fingerprint(dir));
  });

  test("honours excludes so it agrees with what rsync transfers", () => {
    write("a.txt", "x");
    write(".DS_Store", "junk");
    expect(fingerprint(dir, [".DS_Store"]).nfiles).toBe(1);
    expect(fingerprint(dir).nfiles).toBe(2);
  });

  test("excludes apply at every depth", () => {
    write("a.txt", "x");
    write("sub/.DS_Store", "junk");
    expect(fingerprint(dir, [".DS_Store"]).nfiles).toBe(1);
  });

  test("mtime is carried at nanosecond precision as a string", () => {
    write("a.txt", "x");
    const fp = fingerprint(dir);
    expect(typeof fp.maxMtimeNs).toBe("string");
    expect(BigInt(fp.maxMtimeNs) > 0n).toBe(true);
  });

  test("distinguishes different paths with the same legacy tuple", () => {
    const first = write("first/a.txt", "x");
    const second = write("second/b.txt", "x");
    const fixed = new Date(Date.now() + 60_000);
    utimesSync(first, fixed, fixed);
    utimesSync(second, fixed, fixed);
    utimesSync(join(dir, "first"), fixed, fixed);
    utimesSync(join(dir, "second"), fixed, fixed);
    const a = fingerprint(join(dir, "first"));
    const b = fingerprint(join(dir, "second"));
    expect([a.nfiles, a.bytes, a.maxMtimeNs]).toEqual([b.nfiles, b.bytes, b.maxMtimeNs]);
    expect(a.digest).not.toBe(b.digest);
    expect(sameFingerprint(a, b)).toBe(false);
  });

  test("includes symlinks in the tree evidence", () => {
    write("with/target.txt", "x");
    symlinkSync("target.txt", join(dir, "with/link"));
    write("without/target.txt", "x");
    const fixed = new Date(Date.now() + 60_000);
    utimesSync(join(dir, "with/target.txt"), fixed, fixed);
    utimesSync(join(dir, "without/target.txt"), fixed, fixed);
    utimesSync(join(dir, "with"), fixed, fixed);
    utimesSync(join(dir, "without"), fixed, fixed);
    const withLink = fingerprint(join(dir, "with"));
    const withoutLink = fingerprint(join(dir, "without"));
    expect(withLink.nfiles).toBe(withoutLink.nfiles);
    expect(withLink.bytes).toBe(withoutLink.bytes);
    expect(sameFingerprint(withLink, withoutLink)).toBe(false);
  });

  test("an incomplete walk can never count as unchanged evidence", () => {
    const good = fingerprint(dir);
    expect(sameFingerprint({ ...good, complete: false }, good)).toBe(false);
  });

  test("an unreadable directory is marked incomplete through the filesystem seam", () => {
    write("visible.txt", "x");
    write("blocked/hidden.txt", "y");
    const io: FingerprintIo = {
      lstat: (path) => lstatSync(path, { bigint: true }),
      open: (path) => {
        if (path === join(dir, "blocked")) throw new Error("simulated read failure");
        return opendirSync(path);
      },
      readlink: (path) => readlinkSync(path),
    };
    const incomplete = fingerprint(dir, [], io);
    expect(incomplete.complete).toBe(false);
    expect(incomplete.nfiles).toBe(1);
    expect(sameFingerprint(incomplete, fingerprint(dir))).toBe(false);
  });
});

describe("matchesAny", () => {
  test("exact names", () => {
    expect(matchesAny(".DS_Store", [".DS_Store"])).toBe(true);
    expect(matchesAny("a.txt", [".DS_Store"])).toBe(false);
  });
  test("leading star", () => {
    expect(matchesAny("photo.tmp", ["*.tmp"])).toBe(true);
    expect(matchesAny("photo.txt", ["*.tmp"])).toBe(false);
  });
  test("trailing star", () => {
    expect(matchesAny("._resource", ["._*"])).toBe(true);
    expect(matchesAny("regular", ["._*"])).toBe(false);
  });
  test("does not overlap head and tail on short names", () => {
    expect(matchesAny("ab", ["a*b"])).toBe(true);
    expect(matchesAny("a", ["a*b"])).toBe(false);
  });
  test("an empty pattern list matches nothing", () => {
    expect(matchesAny("anything", [])).toBe(false);
  });
});

/**
 * A tree that exercises every branch a walk has: nested subdirectories and an
 * empty one, files of different sizes with staggered mtimes, a symlink to a
 * file, a symlink to a directory, a broken symlink, excluded names (exact and
 * starred), a creation order that is not the sort order, and a multibyte name.
 *
 * The anti-drift equality below rests on this actually being all of that — a
 * thinner tree could let two walks "agree" while sharing a hole.
 */
function buildRichTree(): void {
  // Created in a different order than the names sort, so a missing or wrong
  // sort changes the record order rather than passing by luck.
  const zeta = write("zeta.txt", "12345");
  const fjol = write("fjøl-写真.txt", "6789");
  write(".DS_Store", "junk");
  write("photo.tmp", "scratch");
  const mid = write("mid.txt", "123");
  const alpha = write("alpha.txt", "1");
  mkdirSync(join(dir, "empty"));
  const targetFile = write("with/target.txt", "x");
  const bbin = write("sub/b.bin", "1234567");
  const ctext = write("sub/deep/c.txt", "1234567890123");
  symlinkSync("target.txt", join(dir, "with", "link"));
  symlinkSync("sub", join(dir, "link-to-sub"));
  symlinkSync("nowhere-missing", join(dir, "broken"));

  // Staggered mtimes; c.txt is the newest, so maxMtimeNs comes from a file
  // the walk recorded, not from a directory or a link.
  const at = (ms: number) => new Date(Date.now() + ms);
  utimesSync(zeta, at(1_000), at(1_000));
  utimesSync(fjol, at(2_000), at(2_000));
  utimesSync(mid, at(3_000), at(3_000));
  utimesSync(alpha, at(4_000), at(4_000));
  utimesSync(targetFile, at(5_000), at(5_000));
  utimesSync(bbin, at(6_000), at(6_000));
  utimesSync(ctext, at(9_000), at(9_000));
}

/**
 * The callback form of node:fs, promisified — the same trick the real async
 * seam in src/fingerprint.ts uses. The tests below wrap these to inject
 * behaviour the real filesystem would not give: a slow lookup, a refused
 * directory, an abort.
 */
const asyncLstat = (path: string): Promise<{ readonly size: bigint; readonly mtimeNs: bigint }> =>
  new Promise((resolve, reject) =>
    lstat(path, { bigint: true }, (err, st) => (err !== null ? reject(err) : resolve(st))),
  );

const asyncOpendir = (path: string): Promise<AsyncIterable<Dirent>> =>
  new Promise((resolve, reject) =>
    opendir(path, (err, d) => (err !== null ? reject(err) : resolve(d))),
  );

const asyncReadlink = (path: string): Promise<string> =>
  new Promise((resolve, reject) =>
    readlink(path, (err, target) => (err !== null ? reject(err) : resolve(target))),
  );

/** The real filesystem through the async seam, for a seam that patches one call. */
const realAsyncIo: FingerprintIoAsync = {
  lstat: asyncLstat,
  opendir: asyncOpendir,
  readlink: asyncReadlink,
};

describe("the sync and async walks cannot drift apart", () => {
  const exclude = [".DS_Store", "*.tmp"];

  test("fingerprint and fingerprintAsync are deeply equal on a rich tree", async () => {
    buildRichTree();
    const syncFp = fingerprint(dir, exclude);
    const asyncFp = await fingerprintAsync(dir, exclude);
    expect(asyncFp).toEqual(syncFp);
    expect(asyncFp.digest).toBe(syncFp.digest);
    // The tree is what buildRichTree claims, so the equality was not between
    // two thin views: seven files in, the three symlinks recorded without
    // being followed (recursing into link-to-sub would double sub's files),
    // and the excluded names out.
    expect(syncFp.nfiles).toBe(7);
    expect(syncFp.bytes).toBe(34);
    expect(syncFp.complete).toBe(true);
    const newest = join(dir, "sub", "deep", "c.txt");
    expect(syncFp.maxMtimeNs).toBe(lstatSync(newest, { bigint: true }).mtimeNs.toString());
  });

  test("an unreadable subdirectory is incomplete on both walkers, digest included", async () => {
    write("visible.txt", "x");
    write("blocked/hidden.txt", "y");
    const blocked = join(dir, "blocked");

    // The same tree read fully, to prove the failure framing changed the
    // digest and not only the complete flag.
    const readable = fingerprint(dir);

    let syncFp: Fingerprint;
    let asyncFp: Fingerprint;
    if (process.getuid?.() === 0) {
      // Root ignores mode bits, so a chmod 000 would not fail: inject the
      // same refusal through the seam each walk exposes.
      const syncIo: FingerprintIo = {
        lstat: (p) => lstatSync(p, { bigint: true }),
        open: (p) => {
          if (p === blocked) throw new Error("simulated read failure");
          return opendirSync(p);
        },
        readlink: (p) => readlinkSync(p),
      };
      const asyncIo: FingerprintIoAsync = {
        ...realAsyncIo,
        opendir: async (p) => {
          if (p === blocked) throw new Error("simulated read failure");
          return asyncOpendir(p);
        },
      };
      syncFp = fingerprint(dir, [], syncIo);
      asyncFp = await fingerprintAsync(dir, [], asyncIo);
    } else {
      // A real chmod 000, restored before the fixture is removed or the
      // removal itself would fail.
      chmodSync(blocked, 0o000);
      try {
        syncFp = fingerprint(dir);
        asyncFp = await fingerprintAsync(dir);
      } finally {
        chmodSync(blocked, 0o755);
      }
    }

    expect(syncFp.complete).toBe(false);
    expect(asyncFp.complete).toBe(false);
    expect(asyncFp).toEqual(syncFp);
    expect(asyncFp.digest).toBe(syncFp.digest);
    expect(asyncFp.digest).not.toBe(readable.digest);
    // The readable half is counted and the blocked half is not, on both.
    expect(syncFp.nfiles).toBe(1);
    expect(asyncFp.nfiles).toBe(1);
  });
});

describe("fingerprintAsync stops when the signal says so", () => {
  test("a pre-aborted signal does not walk the tree", async () => {
    buildRichTree();
    const controller = new AbortController();
    controller.abort();
    const aborted = await fingerprintAsync(dir, [], undefined, controller.signal);
    // Nothing is recorded: the signal is read before the first lookup, so
    // this is a refusal, not a partial view.
    expect(aborted.complete).toBe(false);
    expect(aborted.nfiles).toBe(0);
    expect(aborted.bytes).toBe(0);
  });

  test("an abort midway leaves a partial walk that is marked incomplete", async () => {
    write("a.txt", "aa");
    write("b.txt", "bb");
    write("sub/c.txt", "ccc");
    write("sub/d.txt", "dddd");
    const full = fingerprint(dir);
    const controller = new AbortController();
    // Abort once the walk opens its subdirectory: root is recorded, sub is not.
    const io: FingerprintIoAsync = {
      ...realAsyncIo,
      opendir: async (p) => {
        const d = await asyncOpendir(p);
        if (p === join(dir, "sub")) controller.abort();
        return d;
      },
    };
    const aborted = await fingerprintAsync(dir, [], io, controller.signal);
    expect(full.complete).toBe(true);
    expect(full.nfiles).toBe(4);
    expect(aborted.complete).toBe(false);
    expect(aborted.nfiles).toBe(2);
    expect(aborted.nfiles).toBeLessThan(full.nfiles);
    expect(aborted.digest).not.toBe(full.digest);
  });
});

describe("the async walk leaves the event loop free", () => {
  test("a timer scheduled alongside the walk resolves before the walk does", async () => {
    write("a.txt", "aa");
    write("sub/b.txt", "bbb");
    // Every seam call waits on a macrotask. A synchronous walk would hold
    // the whole loop until it finished; this one cannot.
    const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
    const io: FingerprintIoAsync = {
      lstat: async (p) => {
        await pause();
        return lstatSync(p, { bigint: true });
      },
      opendir: async (p) => {
        await pause();
        return opendirSync(p);
      },
      readlink: async (p) => {
        await pause();
        return readlinkSync(p);
      },
    };
    const order: string[] = [];
    const walk = fingerprintAsync(dir, [], io, undefined);
    const tick = new Promise<void>((resolve) => {
      setTimeout(() => {
        order.push("timer");
        resolve();
      }, 0);
    });
    const fp = await walk;
    await tick;
    order.push("walk");
    // Ordering, not durations: a 0 ms timer wins against a walk whose first
    // call cannot resolve before a 10 ms timer, on any machine. A
    // synchronous walk could not produce this order at all.
    expect(order).toEqual(["timer", "walk"]);
    expect(fp.complete).toBe(true);
    expect(fp.nfiles).toBe(2);
  });
});

/**
 * checkUnit measures the destination after the check — through the async
 * walk, because a synchronous lstat of every file over SMB would hold the
 * event loop for minutes — and reports null when the destination folder is
 * not there at all. The rsync path needs a real binary and is gated on one;
 * the missing-folder path spawns nothing and is not.
 */
const build = await checkBuild(DEFAULT_RSYNC);
const describeRsync = build.ok ? describe : describe.skip;

/** A unit at the source, with a sentinel-proven destination root. */
function checkFixture(): { config: Config; target: Target } {
  const config = parseConfig(`
source = "${join(dir, "src")}"

[[target]]
name = "ext"
path = "${join(dir, "dst")}"
sentinel = "s1"
`);
  const target = config.targets[0]!;
  const srcUnit = join(config.source, "photos");
  mkdirSync(srcUnit, { recursive: true });
  writeFileSync(join(srcUnit, "a.txt"), "aaa");
  mkdirSync(target.path, { recursive: true });
  writeFileSync(join(target.path, SENTINEL_NAME), "s1\n");
  return { config, target };
}

describe("checkUnit reports the destination fingerprint", () => {
  test("a missing destination folder is missing, with no fingerprint to report", async () => {
    const { config, target } = checkFixture();
    const result = await checkUnit(config, "photos", target, "quick");
    expect(result.scan.outcome).toBe("missing");
    expect(result.targetFingerprint).toBeNull();
    expect(result.exitCode).toBeNull();
  });
});

describeRsync("checkUnit measures the destination on the rsync path", () => {
  test("the fingerprint is what a sync walk of the same folder sees", async () => {
    const { config, target } = checkFixture();
    const dstUnit = join(target.path, "photos");
    mkdirSync(dstUnit, { recursive: true });
    const srcFile = join(config.source, "photos", "a.txt");
    const dstFile = join(dstUnit, "a.txt");
    // Same size and mtime: the quick check sees no difference, so the walk
    // measures exactly what the check just read.
    const st = lstatSync(srcFile);
    writeFileSync(dstFile, "aaa");
    utimesSync(dstFile, new Date(st.atimeMs), new Date(st.mtimeMs));

    const result = await checkUnit(config, "photos", target, "quick");
    expect(result.scan.outcome).toBe("clean");
    expect(result.targetFingerprint).not.toBeNull();
    expect(result.targetFingerprint).toEqual(fingerprint(dstUnit, config.exclude));
    expect(result.targetFingerprint?.nfiles).toBe(1);
    expect(result.targetFingerprint?.bytes).toBe(3);
    expect(result.targetFingerprint?.complete).toBe(true);
  });
});
