import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config.ts";
import { ENGINE_PROTOCOL_VERSION } from "../src/engine-protocol.ts";
import { buildEngineSnapshot, type SnapshotIo } from "../src/engine-snapshot.ts";
import type { Fingerprint } from "../src/fingerprint.ts";
import { EMPTY_STATE, type State } from "../src/state.ts";

const fp: Fingerprint = { nfiles: 12, bytes: 4096, maxMtimeNs: "1700000000000000000" };

const config: Config = {
  source: "/source",
  maxVerifyAgeDays: 30,
  maxQuickAgeDays: 7,
  minTargets: 1,
  exclude: [".DS_Store"],
  targets: [
    {
      name: "archive",
      path: "/destination",
      required: true,
      identity: "volume-1",
      identityKind: "volume-uuid",
      fstype: "apfs",
      modifyWindow: 0,
      flagsDrop: [],
    },
  ],
};

function io(reachability: "ok" | "unreachable" = "ok"): SnapshotIo {
  return {
    listUnits: () => ["photos-2019"],
    fingerprint: () => fp,
    reachability: async () => new Map([["archive", reachability]]),
  };
}

describe("engine snapshot", () => {
  test("carries the same evaluated evidence a UI is allowed to render", async () => {
    const state: State = {
      version: 1,
      scans: [
        {
          unit: "photos-2019",
          target: "archive",
          ts: 1_750_000_000_000,
          method: "deep",
          outcome: "clean",
          nChanges: 0,
          nExtra: 0,
          bytesPending: 0,
          fingerprint: fp,
          sentinel: "volume-1",
        },
      ],
    };
    const snapshot = await buildEngineSnapshot(config, state, 1_750_000_001_000, io());

    expect(snapshot.protocolVersion).toBe(ENGINE_PROTOCOL_VERSION);
    expect(snapshot.configRevision).toHaveLength(64);
    expect(snapshot.targets).toEqual([
      {
        name: "archive",
        required: true,
        reachability: "ok",
        reachabilityPhrase: "connected",
        usesSentinel: false,
      },
    ]);
    expect(snapshot.units[0]).toMatchObject({
      unit: "photos-2019",
      state: "verified",
      reason: "all destinations deep verified",
      fingerprint: fp,
      cells: [{ target: "archive", state: "verified", differenceSummary: "deep verified today" }],
    });
  });

  test("configuration changes suspend approvals without exposing paths", async () => {
    const before = await buildEngineSnapshot(config, EMPTY_STATE, 1_750_000_001_000, io());
    const after = await buildEngineSnapshot(
      { ...config, targets: [{ ...config.targets[0]!, path: "/replacement" }] },
      EMPTY_STATE,
      1_750_000_001_000,
      io(),
    );

    expect(after.configRevision).not.toBe(before.configRevision);
    expect(after.configRevision).not.toContain("replacement");
  });

  test("an unavailable destination cannot survive as verified in the wire snapshot", async () => {
    const snapshot = await buildEngineSnapshot(
      config,
      EMPTY_STATE,
      1_750_000_001_000,
      io("unreachable"),
    );

    expect(snapshot.targets[0]?.reachability).toBe("unreachable");
    expect(snapshot.units[0]?.state).toBe("unchecked");
    expect(snapshot.units[0]?.cells[0]).toMatchObject({
      state: "unchecked",
      reason: "not connected",
    });
  });

  test("missing reachability is explicit rather than assumed healthy", async () => {
    const missing: SnapshotIo = {
      ...io(),
      reachability: async () => new Map(),
    };
    const snapshot = await buildEngineSnapshot(config, EMPTY_STATE, 1_750_000_001_000, missing);

    expect(snapshot.targets[0]?.reachability).toBe("unreachable");
    expect(snapshot.units[0]?.state).toBe("unchecked");
  });

  test("exposes current process ownership without implying job completion", async () => {
    const snapshot = await buildEngineSnapshot(config, EMPTY_STATE, 1_750_000_001_000, {
      ...io(),
      pidAlive: () => true,
      owner: () => ({
        version: 1,
        token: "private-owner-token",
        pid: 321,
        actor: "mac",
        operation: "deep",
        startedAt: 1_750_000_000_000,
        heartbeatAt: 1_750_000_000_500,
        estimatedDurationMs: 42_000,
        batchPosition: 2,
        batchTotal: 4,
        activity: {
          unit: "photos-2019",
          target: "archive",
          phase: "comparing-content",
          at: 1_750_000_000_400,
          filesSeen: 12,
          filesTotal: 120,
          lastItem: "image.jpg",
        },
      }),
    });

    expect(snapshot.activeJob).toEqual({
      actor: "mac",
      operation: "deep",
      startedAt: 1_750_000_000_000,
      heartbeatAt: 1_750_000_000_500,
      estimatedDurationMs: 42_000,
      batchPosition: 2,
      batchTotal: 4,
      activity: {
        unit: "photos-2019",
        target: "archive",
        phase: "comparing-content",
        at: 1_750_000_000_400,
        filesSeen: 12,
        filesTotal: 120,
        lastItem: "image.jpg",
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain("private-owner-token");
  });

  test("does not present an abandoned lease as active work", async () => {
    const snapshot = await buildEngineSnapshot(config, EMPTY_STATE, 1_750_000_100_000, {
      ...io(),
      owner: () => ({
        version: 1,
        token: "stale-owner-token",
        pid: 321,
        actor: "mac",
        operation: "deep",
        startedAt: 1_750_000_000_000,
        heartbeatAt: 1_750_000_000_500,
      }),
    });
    expect(snapshot.activeJob).toBeUndefined();
  });

  test("does not present a fresh lease whose process is dead", async () => {
    const snapshot = await buildEngineSnapshot(config, EMPTY_STATE, 1_750_000_001_000, {
      ...io(),
      pidAlive: () => false,
      owner: () => ({
        version: 1,
        token: "dead-owner-token",
        pid: 321,
        actor: "mac",
        operation: "deep",
        startedAt: 1_750_000_000_000,
        heartbeatAt: 1_750_000_000_500,
      }),
    });

    expect(snapshot.activeJob).toBeUndefined();
  });
});
