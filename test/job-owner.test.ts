import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireJobOwner, jobOwnerExists, readJobOwner } from "../src/job-owner.ts";
import { makeFixtureDir, removeFixtureDir } from "./helpers.ts";

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

  test("a stale dead owner is archived before recovery", () => {
    const root = fixture("job-owner-stale");
    const first = acquireJobOwner("cli", "sync", {
      root,
      now: () => 1_000,
      pid: 404,
      token: () => "dead",
    });
    expect(first.acquired).toBe(true);

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
    expect(readdirSync(join(root, "job-owners"))).toContain("90000-stale-dead");
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

  test("release preserves the ownership record in history", () => {
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
    const archived = join(root, "job-owners", "7000-released-done", "owner.json");
    expect(JSON.parse(readFileSync(archived, "utf8")).token).toBe("done");
  });

  test("an incomplete fresh claim is not stolen", () => {
    const root = fixture("job-owner-starting");
    mkdirSync(join(root, "job-owner"));
    const result = acquireJobOwner("mac", "quick", {
      root,
      now: () => Date.now(),
      pid: 707,
      token: () => "late",
    });
    expect(result).toEqual({ acquired: false, reason: "owner-starting" });
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
      join(root, "job-owner", "owner.json"),
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
});
