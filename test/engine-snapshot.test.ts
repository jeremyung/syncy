import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config.ts";
import { ENGINE_PROTOCOL_VERSION } from "../src/engine-protocol.ts";
import {
  buildEngineActivity,
  buildEngineSnapshot,
  evaluateUnitCell,
  type SnapshotIo,
  type UnitCellIo,
} from "../src/engine-snapshot.ts";
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
  test("polls live work without source or destination tree dependencies", () => {
    const activity = buildEngineActivity(1_750_000_001_000, {
      pidAlive: () => true,
      owner: () => ({
        version: 1,
        token: "private-owner-token",
        pid: 321,
        actor: "cli",
        operation: "quick",
        startedAt: 1_750_000_000_000,
        heartbeatAt: 1_750_000_000_500,
      }),
    });

    expect(activity).toMatchObject({
      type: "activity",
      generatedAt: 1_750_000_001_000,
      activeJob: { actor: "cli", operation: "quick" },
    });
    expect(JSON.stringify(activity)).not.toContain("private-owner-token");
  });

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
      cells: [{ target: "archive", state: "verified", reason: "deep verified today" }],
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
      pid: 321,
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

describe("single-cell evaluation for engine preflight", () => {
  // Three destinations, and evidence in state that several other units exist
  // and have been checked, so the assertions below cannot pass by accident —
  // there is real "everything else" for a full snapshot to have touched.
  const threeTargets: Config = {
    ...config,
    targets: [
      config.targets[0]!,
      { ...config.targets[0]!, name: "backup", path: "/backup", identity: "volume-2" },
      { ...config.targets[0]!, name: "offsite", path: "/offsite", identity: "volume-3" },
    ],
  };
  const othersHaveBeenChecked: State = {
    version: 1,
    scans: [
      {
        unit: "videos-2020",
        target: "archive",
        ts: 1,
        method: "quick",
        outcome: "clean",
        nChanges: 0,
        nExtra: 0,
        bytesPending: 0,
        fingerprint: fp,
        sentinel: "volume-1",
      },
      {
        unit: "docs-2021",
        target: "backup",
        ts: 1,
        method: "quick",
        outcome: "clean",
        nChanges: 0,
        nExtra: 0,
        bytesPending: 0,
        fingerprint: fp,
        sentinel: "volume-2",
      },
    ],
  };

  function spyIo(): {
    unitCellIo: UnitCellIo;
    fingerprintCalls: string[];
    reachabilityCalls: string[];
  } {
    const fingerprintCalls: string[] = [];
    const reachabilityCalls: string[] = [];
    const unitCellIo: UnitCellIo = {
      fingerprint: (root) => {
        fingerprintCalls.push(root);
        return fp;
      },
      targetReachability: async (target) => {
        reachabilityCalls.push(target.name);
        return "ok";
      },
    };
    return { unitCellIo, fingerprintCalls, reachabilityCalls };
  }

  test("fingerprints only the requested unit and reaches only the requested destination", async () => {
    const { unitCellIo, fingerprintCalls, reachabilityCalls } = spyIo();

    const result = await evaluateUnitCell(
      threeTargets,
      othersHaveBeenChecked,
      "photos-2019",
      threeTargets.targets[0]!,
      1_750_000_001_000,
      unitCellIo,
    );

    // `videos-2020` and `docs-2021` exist in state, and `backup`/`offsite` are
    // configured destinations — a full engine snapshot would fingerprint all
    // three units and resolve all three destinations. Preflight for one cell
    // must touch exactly the one unit and the one destination it was asked
    // about, not build the whole ledger to throw most of it away.
    expect(fingerprintCalls).toEqual(["/source/photos-2019"]);
    expect(reachabilityCalls).toEqual(["archive"]);
    expect(result?.unit.unit).toBe("photos-2019");
    expect(result?.cell.target).toBe("archive");
  });
});
