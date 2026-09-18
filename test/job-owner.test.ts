import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireJobOwner, jobOwnerExists, readJobOwner } from "../src/job-owner.ts";
import { makeFixtureDir, PROJECT_ROOT, removeFixtureDir } from "./helpers.ts";

const roots: string[] = [];

function fixture(name: string): string {
  const root = makeFixtureDir(name);
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) removeFixtureDir(root);
});

describe("cross-process job ownership", () => {
  test("only one live process owns work", () => {
    const root = fixture("job-owner-live");
    const first = acquireJobOwner("cli", "deep", {
      root,
      now: () => 1_000,
      pid: 101,
      token: () => "first",
      pidAlive: () => true,
    });
    expect(first.acquired).toBe(true);

    const second = acquireJobOwner("mac", "quick", {
      root,
      now: () => 50_000,
      pid: 202,
      token: () => "second",
      pidAlive: () => true,
      staleAfterMs: 10,
    });
    expect(second).toEqual({
      acquired: false,
      owner: expect.objectContaining({ token: "first", actor: "cli", operation: "deep" }),
      reason: "owned",
    });
  });

  test("a fresh owner can be observed without taking it", () => {
    const root = fixture("job-owner-observe");
    const result = acquireJobOwner("scheduler", "quick", {
      root,
      now: () => 2_000,
      pid: 303,
      token: () => "scheduled",
    });
    expect(result.acquired).toBe(true);
    expect(readJobOwner(root)).toEqual(
      expect.objectContaining({ token: "scheduled", actor: "scheduler", heartbeatAt: 2_000 }),
    );
  });

  test("a stale dead owner is archived (as a file keyed by its token) before recovery", () => {
    const root = fixture("job-owner-stale");
    const first = acquireJobOwner("cli", "sync", {
      root,
      now: () => 1_000,
      pid: 404,
      token: () => "dead",
    });
    expect(first.acquired).toBe(true);
    expect(readdirSync(join(root, "job-owner"))).toEqual(["owner.dead.json"]);

    const recovered = acquireJobOwner("mac", "deep", {
      root,
      now: () => 90_000,
      pid: 505,
      token: () => "replacement",
      pidAlive: () => false,
      staleAfterMs: 30_000,
    });
    expect(recovered.acquired).toBe(true);
    expect(readJobOwner(root)?.token).toBe("replacement");
    expect(readdirSync(join(root, "job-owners"))).toContain("90000-stale-dead.json");
    expect(
      JSON.parse(readFileSync(join(root, "job-owners", "90000-stale-dead.json"), "utf8")).token,
    ).toBe("dead");
  });

  test("a reused PID cannot preserve an abandoned lease indefinitely", () => {
    const root = fixture("job-owner-reused-pid");
    const first = acquireJobOwner("cli", "sync", {
      root,
      now: () => 1_000,
      pid: 404,
      token: () => "old-process",
    });
    expect(first.acquired).toBe(true);

    const recovered = acquireJobOwner("scheduler", "quick", {
      root,
      now: () => 601_000,
      pid: 505,
      token: () => "new-process",
      pidAlive: () => true,
      staleAfterMs: 30_000,
      abandonAfterMs: 300_000,
    });
    expect(recovered.acquired).toBe(true);
    expect(readJobOwner(root)?.token).toBe("new-process");
  });

  test("release preserves the ownership record in history, as one file", () => {
    const root = fixture("job-owner-release");
    const result = acquireJobOwner("cli", "quick", {
      root,
      now: () => 7_000,
      pid: 606,
      token: () => "done",
    });
    if (!result.acquired) throw new Error("expected ownership");
    result.lease.release();

    expect(jobOwnerExists(root)).toBe(false);
    const archived = join(root, "job-owners", "7000-released-done.json");
    expect(JSON.parse(readFileSync(archived, "utf8")).token).toBe("done");
  });

  test("an empty ownership directory (mkdir with no record yet) is reclaimed, not treated as owned", () => {
    const root = fixture("job-owner-empty-dir");
    // Simulates the aftermath of a crash between mkdir and the first write:
    // the directory exists but holds no record. Nothing legitimate to
    // protect, so this must resolve to a normal acquisition.
    mkdirSync(join(root, "job-owner"));
    const result = acquireJobOwner("mac", "quick", {
      root,
      now: () => 1_000,
      pid: 707,
      token: () => "late",
    });
    expect(result.acquired).toBe(true);
    expect(readJobOwner(root)?.token).toBe("late");
  });

  test("a directory with only unparsable files is swept into the archive as invalid", () => {
    const root = fixture("job-owner-corrupt");
    mkdirSync(join(root, "job-owner"));
    writeFileSync(join(root, "job-owner", "owner.garbage.json"), "not json");
    const result = acquireJobOwner("mac", "quick", {
      root,
      now: () => 5_000,
      pid: 808,
      token: () => "recovered",
    });
    expect(result.acquired).toBe(true);
    expect(readJobOwner(root)?.token).toBe("recovered");
    expect(readdirSync(join(root, "job-owners"))).toContain("5000-invalid-owner.garbage.json");
  });

  test("heartbeat refuses to update after ownership changes", () => {
    const root = fixture("job-owner-lost");
    let clock = 1_000;
    const result = acquireJobOwner("cli", "quick", {
      root,
      now: () => clock,
      pid: 808,
      token: () => "mine",
    });
    if (!result.acquired) throw new Error("expected ownership");
    writeFileSync(
      join(root, "job-owner", "owner.mine.json"),
      JSON.stringify({ ...result.lease.record, token: "other" }),
    );
    clock = 2_000;
    expect(() => result.lease.heartbeat()).toThrow("job ownership was lost");
  });

  test("observations publish honest phase and measured progress", () => {
    const root = fixture("job-owner-progress");
    const result = acquireJobOwner("mac", "deep", {
      root,
      now: () => 2_000,
      pid: 909,
      token: () => "progress",
    });
    if (!result.acquired) throw new Error("expected ownership");
    result.lease.observe({
      protocolVersion: 1,
      type: "job.started",
      jobId: "job-1",
      at: 1_800,
      operation: "deep",
      unit: "photos",
      target: "archive",
      phase: "queued",
      batch: { position: 2, total: 4, bytesDone: 1_000, bytesTotal: 4_000 },
      unitSize: { files: 100, bytes: 1_000 },
      estimatedDurationMs: 42_000,
    });
    result.lease.observe({
      protocolVersion: 1,
      type: "job.progress-observed",
      jobId: "job-1",
      at: 1_900,
      operation: "deep",
      unit: "photos",
      target: "archive",
      filesSeen: 12,
      filesTotal: 100,
      lastItem: "image.jpg",
    });

    expect(readJobOwner(root)?.activity).toEqual({
      unit: "photos",
      target: "archive",
      phase: "queued",
      at: 1_900,
      filesSeen: 12,
      filesTotal: 100,
      lastItem: "image.jpg",
    });
    expect(readJobOwner(root)).toMatchObject({
      estimatedDurationMs: 42_000,
      batchPosition: 2,
      batchTotal: 4,
    });

    result.lease.observe({
      protocolVersion: 1,
      type: "job.phase-changed",
      jobId: "job-1",
      at: 1_950,
      operation: "deep",
      unit: "photos",
      target: "archive",
      phase: "recording-evidence",
    });

    expect(readJobOwner(root)?.activity).toMatchObject({
      phase: "recording-evidence",
      filesSeen: 12,
      filesTotal: 100,
      lastItem: "image.jpg",
    });

    result.lease.observe({
      protocolVersion: 1,
      type: "job.started",
      jobId: "job-2",
      at: 1_975,
      operation: "deep",
      unit: "videos",
      target: "archive",
      phase: "queued",
      unitSize: { files: 2, bytes: 200 },
    });
    expect(readJobOwner(root)).not.toHaveProperty("estimatedDurationMs");
    expect(readJobOwner(root)).not.toHaveProperty("batchPosition");
    expect(readJobOwner(root)?.activity).toMatchObject({ unit: "videos", phase: "queued" });
  });

  test("readJobOwner treats more than one record file as unresolved, not a guess", () => {
    const root = fixture("job-owner-ambiguous");
    mkdirSync(join(root, "job-owner"));
    writeFileSync(
      join(root, "job-owner", "owner.a.json"),
      JSON.stringify({
        version: 1,
        token: "a",
        pid: 111,
        actor: "cli",
        operation: "quick",
        startedAt: 1,
        heartbeatAt: 1,
      }),
    );
    writeFileSync(
      join(root, "job-owner", "owner.b.json"),
      JSON.stringify({
        version: 1,
        token: "b",
        pid: 222,
        actor: "cli",
        operation: "quick",
        startedAt: 1,
        heartbeatAt: 1,
      }),
    );
    expect(readJobOwner(root)).toBeUndefined();
    expect(jobOwnerExists(root)).toBe(false);
  });

  test("a write that lands after a rival rmdir's our still-empty directory retries instead of returning two owners", () => {
    // Hooks `token()`, which acquireJobOwner calls right after its own mkdir
    // succeeds but before it writes its record — exactly the window a rival
    // could act in. The first call simulates that rival: it rmdir's the
    // directory out from under us (still empty, so the rmdir genuinely
    // succeeds), which must make our subsequent write fail with ENOENT and
    // retry, rather than silently landing in whatever directory happens to
    // exist by the time the write runs.
    const root = fixture("job-owner-write-race");
    let calls = 0;
    const result = acquireJobOwner("cli", "quick", {
      root,
      now: () => 3_000,
      pid: 1010,
      token: () => {
        calls += 1;
        if (calls === 1) {
          rmdirSync(join(root, "job-owner"));
          return "should-not-be-used";
        }
        return "won-the-retry";
      },
    });
    expect(result.acquired).toBe(true);
    if (result.acquired) expect(result.lease.record.token).toBe("won-the-retry");
    expect(readdirSync(join(root, "job-owner"))).toEqual(["owner.won-the-retry.json"]);
  });

  test("a write that lands in a rival's freshly re-mkdir'd directory backs itself out", () => {
    // Same hook point as above, but this time the rival doesn't just rmdir —
    // it rmdir's, re-mkdirs, and publishes its OWN record before we resume,
    // so our directory still exists by the time we write (no ENOENT). Our
    // write succeeds too (different filename), landing two records in one
    // directory. The post-write self-check must catch that and back out —
    // the rival's record is fresh, so we must end up correctly reporting
    // "owned" by the rival, never a lease of our own that shares a
    // directory with theirs.
    const root = fixture("job-owner-write-race-collision");
    const result = acquireJobOwner("cli", "quick", {
      root,
      now: () => 4_000,
      pid: 1111,
      token: () => {
        const rival = acquireJobOwner("mac", "quick", {
          root,
          now: () => 4_000,
          pid: 2222,
          token: () => "rival",
        });
        if (!rival.acquired) throw new Error("expected the rival to win the directory");
        return "loser";
      },
    });
    expect(result).toEqual({
      acquired: false,
      owner: expect.objectContaining({ token: "rival" }),
      reason: "owned",
    });
    // Exactly one record remains — the rival's — never our "loser" write.
    expect(readdirSync(join(root, "job-owner")).filter((name) => name.endsWith(".json"))).toEqual([
      "owner.rival.json",
    ]);
    expect(readJobOwner(root)?.token).toBe("rival");
  });
});

describe("two real processes racing for the same dead owner", () => {
  const WORKER_SOURCE = `
import { acquireJobOwner } from ${JSON.stringify(join(PROJECT_ROOT, "src", "job-owner.ts"))};

const root = process.argv[2];
const label = process.argv[3];

const result = acquireJobOwner("cli", "quick", {
  root,
  pid: process.pid,
  token: () => \`\${label}-\${process.pid}-\${Math.random().toString(36).slice(2)}\`,
  pidAlive: () => false,
  staleAfterMs: 30_000,
  abandonAfterMs: 300_000,
});

process.stdout.write(JSON.stringify({ acquired: result.acquired }));
`;

  test("exactly one of two concurrent processes acquires a dead owner, every trial", async () => {
    const scriptDir = fixture("job-owner-race-worker-src");
    const workerPath = join(scriptDir, "worker.ts");
    writeFileSync(workerPath, WORKER_SOURCE, "utf8");

    const TRIALS = 40;
    for (let i = 0; i < TRIALS; i += 1) {
      const root = fixture(`job-owner-race-${i}`);
      mkdirSync(join(root, "job-owner"));
      writeFileSync(
        join(root, "job-owner", "owner.dead-seed.json"),
        JSON.stringify({
          version: 1,
          token: "dead-seed",
          pid: 999_999,
          actor: "cli",
          operation: "quick",
          startedAt: 1,
          heartbeatAt: 1,
        }),
      );

      const spawn = (label: string) =>
        Bun.spawn(["bun", "run", workerPath, root, label], {
          cwd: PROJECT_ROOT,
          stdout: "pipe",
          stderr: "pipe",
        });
      const a = spawn("A");
      const b = spawn("B");
      const [outA, outB, exitA, exitB, errA, errB] = await Promise.all([
        new Response(a.stdout).text(),
        new Response(b.stdout).text(),
        a.exited,
        b.exited,
        new Response(a.stderr).text(),
        new Response(b.stderr).text(),
      ]);
      expect(exitA, errA).toBe(0);
      expect(exitB, errB).toBe(0);
      const acquiredA = (JSON.parse(outA) as { acquired: boolean }).acquired;
      const acquiredB = (JSON.parse(outB) as { acquired: boolean }).acquired;
      expect([acquiredA, acquiredB].filter(Boolean).length, `trial ${i}: A=${outA} B=${outB}`).toBe(
        1,
      );
    }
  }, 20_000);
});
