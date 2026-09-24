import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeSync, existsSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config, Target } from "../src/config.ts";
import { allReachability, targetReachability } from "../src/scan.ts";
import {
  checkSentinel,
  checkSentinelAsync,
  readSentinel,
  readSentinelAsync,
  SENTINEL_NAME,
  type SentinelStatus,
} from "../src/sentinel.ts";
import { makeFixtureDir, removeFixtureDir } from "./helpers.ts";

/**
 * A destination can stop answering without going away.
 *
 * A network mount that has died without unmounting is the shape: the path is
 * there, and a read of it blocks until the kernel gives up. The status path
 * must bound that read, answer "timeout", and name the destination that has
 * not answered — while a destination that does answer gets exactly the
 * answer it always got.
 *
 * The `probe` seam stands in for the destination-touching path read, so the
 * timeout can be exercised with short overrides instead of a five-second
 * wait. One test additionally uses the real seam — a FIFO held open at the
 * write end — because a stall that only the fake can produce has proved
 * nothing about the read the product actually makes.
 */

let root: string;
beforeEach(() => {
  root = makeFixtureDir("syncy-reach");
});
afterEach(() => {
  removeFixtureDir(root);
});

/** A target with no recorded identity: the branch the status path always takes. */
const target = (name: string, path: string, sentinel?: string): Target => ({
  name,
  path,
  required: true,
  ...(sentinel === undefined ? {} : { sentinel }),
  fstype: "unknown",
  modifyWindow: 0,
  flagsDrop: [],
});

/** Never settles: the seam that models a read the kernel will not answer. */
const neverSettles = (): Promise<boolean> => new Promise<boolean>(() => {});

describe("a destination that does not answer is bounded, not a hang", () => {
  test("a probe that never settles yields timeout within the bound", async () => {
    const t0 = Date.now();
    const r = await targetReachability(target("slow", join(root, "slow")), {
      timeoutMs: 100,
      slowMs: 20,
      probe: neverSettles,
    });
    const elapsed = Date.now() - t0;
    expect(r).toBe("timeout");
    // The bound is the point: it waited out the deadline and came back, with
    // generous slack so a loaded runner cannot flake the assertion.
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(1_000);
  });

  test("a stalled sentinel read — the real seam, not just the probe — yields timeout", async () => {
    // The probe (the path read) is left at its default and answers at once;
    // what stalls is checkSentinelAsync's read of the sentinel file, which a
    // FIFO held open at the write end blocks the way a dead mount does — in
    // a worker thread, so the event loop keeps ticking while it does.
    const dst = join(root, "dst");
    mkdirSync(dst, { recursive: true });
    const fifo = join(dst, SENTINEL_NAME);
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    const writer = openSync(fifo, "w+");
    try {
      const r = await targetReachability(target("dst", dst, "some-uuid"), {
        timeoutMs: 100,
        slowMs: 30,
      });
      expect(r).toBe("timeout");
    } finally {
      // Closing the write end hands the abandoned read its EOF, so the test
      // leaves no blocked reader behind.
      closeSync(writer);
    }
  });
});

describe("a destination that answers is unaffected", () => {
  // The guard against the timeout simply blinding the check: every outcome
  // the synchronous path could reach must still come back when the read is
  // bounded and fast.

  test("no sentinel: a present path reads missing", async () => {
    const dst = join(root, "dst");
    mkdirSync(dst, { recursive: true });
    const r = await targetReachability(target("dst", dst), {
      timeoutMs: 200,
      slowMs: 50,
      probe: () => Promise.resolve(true),
    });
    expect(r).toBe("missing");
  });

  test("no sentinel: an absent path reads unreachable", async () => {
    const r = await targetReachability(target("dst", join(root, "absent")), {
      timeoutMs: 200,
      slowMs: 50,
      probe: () => Promise.resolve(false),
    });
    expect(r).toBe("unreachable");
  });

  test("a matching sentinel reads ok", async () => {
    const dst = join(root, "dst");
    mkdirSync(dst, { recursive: true });
    writeFileSync(join(dst, SENTINEL_NAME), "vol-1\n");
    const r = await targetReachability(target("dst", dst, "vol-1"), {
      timeoutMs: 200,
      slowMs: 50,
      probe: () => Promise.resolve(true),
    });
    expect(r).toBe("ok");
  });

  test("a different sentinel reads mismatch", async () => {
    const dst = join(root, "dst");
    mkdirSync(dst, { recursive: true });
    writeFileSync(join(dst, SENTINEL_NAME), "vol-2\n");
    const r = await targetReachability(target("dst", dst, "vol-1"), {
      timeoutMs: 200,
      slowMs: 50,
      probe: () => Promise.resolve(true),
    });
    expect(r).toBe("mismatch");
  });

  test("a slow-but-honest answer still wins when it beats the deadline", async () => {
    // 40 ms is slow for a local disk and fast for a dead share: the answer
    // must be the answer, not a timeout declared before it arrived.
    const dst = join(root, "dst");
    mkdirSync(dst, { recursive: true });
    writeFileSync(join(dst, SENTINEL_NAME), "vol-1\n");
    const r = await targetReachability(target("dst", dst, "vol-1"), {
      timeoutMs: 200,
      slowMs: 50,
      probe: () => new Promise<boolean>((res) => setTimeout(() => res(true), 40)),
    });
    expect(r).toBe("ok");
  });
});

describe("allReachability checks the destinations at once", () => {
  const twoTargetConfig = (fastPath: string, slowPath: string): Config => ({
    source: join(root, "src"),
    maxVerifyAgeDays: 30,
    maxQuickAgeDays: 7,
    minTargets: 1,
    exclude: [],
    targets: [target("fast", fastPath, "s-fast"), target("slow", slowPath, "s-slow")],
  });

  test("one stalled destination does not delay the fast one, and both answers come back", async () => {
    const fastPath = join(root, "fast");
    const slowPath = join(root, "slow");
    mkdirSync(fastPath, { recursive: true });
    mkdirSync(slowPath, { recursive: true });
    const config = twoTargetConfig(fastPath, slowPath);

    // Ordered events, not wall-clock thresholds: the question is whether the
    // fast answer was already in hand while the slow deadline still had to
    // run out, and the order of these events is what says so.
    const events: Array<{ at: number; kind: string }> = [];
    const t0 = Date.now();
    const probe = (path: string): Promise<boolean> => {
      if (path === slowPath) return neverSettles();
      events.push({ at: Date.now() - t0, kind: "fast-answered" });
      return Promise.resolve(true);
    };

    const map = await allReachability(config, {
      timeoutMs: 300,
      slowMs: 60,
      probe,
      onWaiting: (name) => events.push({ at: Date.now() - t0, kind: `waiting:${name}` }),
    });
    const settledAt = Date.now() - t0;
    events.push({ at: settledAt, kind: "settled" });

    // Both answers are present; the fast one is its real answer, not a
    // timeout, and not the slow one's.
    expect(map.get("fast")).toBe("missing");
    expect(map.get("slow")).toBe("timeout");

    const iFast = events.findIndex((e) => e.kind === "fast-answered");
    const iWait = events.findIndex((e) => e.kind === "waiting:slow");
    expect(iFast, "the fast probe ran").toBeGreaterThanOrEqual(0);
    expect(iWait, "the stalled destination was named").toBeGreaterThanOrEqual(0);
    // Ordering: the fast answer was in hand before the slow destination was
    // even named as waiting, and long before the call settled on the slow
    // destination's deadline.
    expect(iFast).toBeLessThan(iWait);
    expect(events[iFast]!.at).toBeLessThan(300);
    expect(settledAt).toBeGreaterThanOrEqual(300);
    // Bounded by the slow deadline, not by it plus whatever: no hang.
    expect(settledAt).toBeLessThan(300 + 1_000);
  });

  test("onWaiting names the stalling destination and only it", async () => {
    const fastPath = join(root, "fast");
    const slowPath = join(root, "slow");
    mkdirSync(fastPath, { recursive: true });
    mkdirSync(slowPath, { recursive: true });
    const config = twoTargetConfig(fastPath, slowPath);

    const named: string[] = [];
    const probe = (path: string): Promise<boolean> =>
      path === slowPath ? neverSettles() : Promise.resolve(true);
    await allReachability(config, {
      timeoutMs: 120,
      slowMs: 40,
      probe,
      onWaiting: (n) => named.push(n),
    });
    expect(named).toEqual(["slow"]);
  });

  test("being named is not a verdict: a late answerer still gets its real answer", async () => {
    // Named at 20 ms, answers at 30 ms: the notice went up for it, and the
    // result is still what it said, not the timeout that was waiting for it.
    const named: string[] = [];
    const r = await targetReachability(target("late", join(root, "late"), "s-late"), {
      timeoutMs: 200,
      slowMs: 20,
      probe: () => new Promise<boolean>((res) => setTimeout(() => res(false), 30)),
      onWaiting: (n) => named.push(n),
    });
    expect(r).toBe("unreachable");
    expect(named).toEqual(["late"]);
  });
});

describe("readSentinelAsync agrees with readSentinel", () => {
  // The async read is the one the status path now makes; the sync one is the
  // behaviour it must not drift from.

  const agree = async (rootDir: string): Promise<void> => {
    const [a, b] = await Promise.all([
      readSentinelAsync(rootDir),
      Promise.resolve(readSentinel(rootDir)),
    ]);
    expect(a, "async").toBe(b);
    expect(b, "sync").toBeDefined();
  };

  test("a present value", async () => {
    const dst = join(root, "dst");
    mkdirSync(dst, { recursive: true });
    writeFileSync(join(dst, SENTINEL_NAME), "vol-1\n");
    await agree(dst);
    expect(readSentinel(dst)).toBe("vol-1");
  });

  test("an empty file", async () => {
    const dst = join(root, "dst");
    mkdirSync(dst, { recursive: true });
    writeFileSync(join(dst, SENTINEL_NAME), "");
    await agree(dst);
    // Whitespace-only is empty too: a sentinel that trims to nothing names
    // no volume.
    writeFileSync(join(dst, SENTINEL_NAME), "   \n");
    await agree(dst);
    expect(readSentinel(dst)).toBeNull();
  });

  test("an absent file", async () => {
    const dst = join(root, "dst");
    mkdirSync(dst, { recursive: true });
    expect(existsSync(join(dst, SENTINEL_NAME))).toBe(false);
    await agree(dst);
    expect(readSentinel(dst)).toBeNull();
  });

  test("a directory with no sentinel", async () => {
    // The destination exists — that is the dangerous case — but carries no
    // sentinel file: nothing was ever placed there, or it is the wrong
    // volume under the same name.
    const dst = join(root, "dst");
    mkdirSync(join(dst, "photos-2019"), { recursive: true });
    writeFileSync(join(dst, "photos-2019", "a.txt"), "aaa");
    await agree(dst);
    expect(readSentinel(dst)).toBeNull();
  });

  test("checkSentinelAsync reaches the same verdicts as checkSentinel", async () => {
    const dst = join(root, "dst");
    mkdirSync(dst, { recursive: true });
    const cases: Array<[contents: string | null, expected: SentinelStatus]> = [
      ["vol-1\n", "ok"],
      ["vol-2\n", "mismatch"],
      [null, "missing"],
    ];
    for (const [contents, verdict] of cases) {
      if (contents === null) {
        // Our own fixture file, removed to test the missing case.
        if (existsSync(join(dst, SENTINEL_NAME))) unlinkSync(join(dst, SENTINEL_NAME));
      } else {
        writeFileSync(join(dst, SENTINEL_NAME), contents);
      }
      expect(await checkSentinelAsync(dst, "vol-1"), `async ${verdict}`).toBe(
        checkSentinel(dst, "vol-1"),
      );
      expect(checkSentinel(dst, "vol-1"), `sync ${verdict}`).toBe(verdict);
    }
  });
});
