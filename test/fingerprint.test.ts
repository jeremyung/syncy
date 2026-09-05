import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  opendirSync,
  readlinkSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  EMPTY,
  type FingerprintIo,
  fingerprint,
  matchesAny,
  sameFingerprint,
} from "../src/fingerprint.ts";
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
