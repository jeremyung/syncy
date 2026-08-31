import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { forgetMountTable, identify, mountTableReads } from "../src/volume.ts";

/**
 * What identifying a destination costs.
 *
 * The volume uuid comes from a subprocess (`diskutil`) and the table from
 * whichever source the platform has — `/sbin/mount` on macOS, `/proc/mounts`
 * on Linux — and both are cached, because `/sbin/mount` stats every mount
 * point and takes over a second on a machine with a network share mounted.
 *
 * The table assertions count reads, not spawns. Counting spawns only ever
 * measured the macOS branch: Linux reads a file, so `/sbin/mount` was spawned
 * zero times there and `toBe(1)` failed on a cache that was working
 * perfectly. Reads are the thing the cache is about, on either platform. The cache held the resolved value, which only ever helps a caller
 * that arrives after an earlier one has finished. Nothing calls this that way:
 * reachability checks every destination at once, so all of them missed the
 * empty cache at the same instant and each spawned its own copy of the command
 * the cache exists to run once.
 */

/** Records what was spawned while `fn` runs, without stopping it from running. */
async function spawns(fn: () => Promise<unknown>): Promise<string[]> {
  const real = Bun.spawn;
  const seen: string[] = [];
  // @ts-expect-error deliberately replacing the binding for the duration
  Bun.spawn = (...args: Parameters<typeof real>) => {
    const argv = args[0];
    if (Array.isArray(argv)) seen.push(String(argv[0]));
    return real(...args);
  };
  try {
    await fn();
  } finally {
    Bun.spawn = real;
  }
  return seen;
}

const count = (seen: readonly string[], bin: string): number =>
  seen.filter((s) => s === bin).length;

/** How many times `fn` caused the mount table to be read from the system. */
async function reads(fn: () => Promise<unknown>): Promise<number> {
  const before = mountTableReads();
  await fn();
  return mountTableReads() - before;
}

const DISKUTIL = "/usr/sbin/diskutil";

beforeEach(() => forgetMountTable());
afterEach(() => forgetMountTable());

describe("identifying several destinations at once", () => {
  test("reads the mount table once, not once per destination", async () => {
    // The root volume, which exists everywhere this runs, asked for three
    // times at the same instant — the shape `allReachability` produces.
    const n = await reads(() => Promise.all([identify("/"), identify("/"), identify("/")]));
    expect(n).toBe(1);
  });

  test("asks diskutil once for one volume, not once per caller", async () => {
    const seen = await spawns(() => Promise.all([identify("/"), identify("/"), identify("/")]));
    expect(count(seen, DISKUTIL)).toBeLessThanOrEqual(1);
  });

  test("all of them get the same answer", async () => {
    const [a, b, c] = await Promise.all([identify("/"), identify("/"), identify("/")]);
    expect(a).toEqual(b!);
    expect(b).toEqual(c!);
    expect(a?.mountPoint).toBe("/");
  });
});

describe("the cache still expires", () => {
  test("a caller arriving after the first read spawns nothing", async () => {
    await identify("/");
    const n = await reads(() => identify("/"));
    expect(n).toBe(0);
  });

  test("dropping the table forces a fresh read", async () => {
    await identify("/");
    forgetMountTable();
    const n = await reads(() => identify("/"));
    expect(n).toBe(1);
  });
});
