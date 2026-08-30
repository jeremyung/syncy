import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EMPTY, fingerprint, matchesAny, sameFingerprint } from "../src/fingerprint.ts";
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
