import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config.ts";
import { configRevision, type UnitCellIo } from "../src/engine-snapshot.ts";
import type { Fingerprint } from "../src/fingerprint.ts";
import type { Preflight } from "../src/guards.ts";
import { parseEngineMessage } from "../src/protocol-jsonl.ts";
import { argvFor } from "../src/rsync.ts";
import type { HistoryEntry, State } from "../src/state.ts";
import type { SyncIntent } from "../src/sync-intent.ts";
import { cmdSyncPreflight, type SyncPreflightIo } from "../src/sync-preflight.ts";

// The requested unit's current fingerprint — distinct from anything recorded
// in state, so a "missing" cell's nChanges/nFiles/nNew/bytesPending can only
// have come from this value, not a stale scan.
const currentFingerprint: Fingerprint = {
  nfiles: 3,
  bytes: 999,
  maxMtimeNs: "1700000000000000000",
};

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
    {
      name: "backup",
      path: "/backup",
      required: false,
      identity: "volume-2",
      identityKind: "volume-uuid",
      fstype: "apfs",
      modifyWindow: 0,
      flagsDrop: [],
    },
    {
      name: "offsite",
      path: "/offsite",
      required: false,
      identity: "volume-3",
      identityKind: "volume-uuid",
      fstype: "apfs",
      modifyWindow: 0,
      flagsDrop: [],
    },
  ],
};

// Evidence that several units exist and have history, and that a scan
// recorded photos-2019 as missing at archive — the shape `cmdSyncPreflight`
// needs to proceed past its "nothing to sync" guard.
const state: State = {
  version: 1,
  scans: [
    {
      unit: "photos-2019",
      target: "archive",
      ts: 1_700_000_000_000,
      method: "quick",
      outcome: "missing",
      nChanges: 0,
      nExtra: 0,
      bytesPending: 0,
      fingerprint: { nfiles: 0, bytes: 0, maxMtimeNs: "0" },
      sentinel: "volume-1",
    },
    {
      unit: "videos-2020",
      target: "archive",
      ts: 1_700_000_000_000,
      method: "quick",
      outcome: "clean",
      nChanges: 0,
      nExtra: 0,
      bytesPending: 0,
      fingerprint: currentFingerprint,
      sentinel: "volume-1",
    },
    {
      unit: "docs-2021",
      target: "backup",
      ts: 1_700_000_000_000,
      method: "quick",
      outcome: "clean",
      nChanges: 0,
      nExtra: 0,
      bytesPending: 0,
      fingerprint: currentFingerprint,
      sentinel: "volume-2",
    },
  ],
};

function spyIo(): {
  unitCell: UnitCellIo;
  preflightIo: SyncPreflightIo;
  fingerprintCalls: string[];
  reachabilityCalls: string[];
  savedIntents: SyncIntent[];
  written: string[];
} {
  const fingerprintCalls: string[] = [];
  const reachabilityCalls: string[] = [];
  const savedIntents: SyncIntent[] = [];
  const written: string[] = [];

  const unitCell: UnitCellIo = {
    fingerprint: (root) => {
      fingerprintCalls.push(root);
      return currentFingerprint;
    },
    targetReachability: async (target) => {
      reachabilityCalls.push(target.name);
      return "ok";
    },
  };

  const canned: Preflight = {
    checks: [{ name: "rsync", ok: true, detail: "rsync found" }],
    ok: true,
    freeAfter: 1_000_000_000,
  };

  const preflightIo: SyncPreflightIo = {
    listUnits: () => ["docs-2021", "photos-2019", "videos-2020"],
    loadState: () => state,
    now: () => 1_750_000_001_000,
    unitCell,
    preflight: async () => canned,
    randomToken: () => "test-confirmation-token",
    saveSyncIntent: (intent) => {
      savedIntents.push(intent);
    },
    write: (chunk) => {
      written.push(chunk);
    },
  };

  return { unitCell, preflightIo, fingerprintCalls, reachabilityCalls, savedIntents, written };
}

describe("engine preflight reads exactly one cell", () => {
  test("fingerprints one unit, reaches one destination, and emits the same message shape as before", async () => {
    const { preflightIo, fingerprintCalls, reachabilityCalls, savedIntents, written } = spyIo();

    await cmdSyncPreflight(config, "photos-2019", "archive", preflightIo, (message) => {
      throw new Error(message);
    });

    // Three units are known (via `listUnits`) and three destinations are
    // configured — a full engine snapshot would fingerprint all three units
    // and resolve all three destinations. Reading one cell must touch exactly
    // the one unit and the one destination asked about.
    expect(fingerprintCalls).toEqual(["/source/photos-2019"]);
    expect(reachabilityCalls).toEqual(["archive"]);

    expect(written).toHaveLength(1);
    const message = parseEngineMessage(written[0]!);
    const expectedArgv = argvFor(config, "photos-2019", config.targets[0]!, "sync", {});

    expect(message).toEqual({
      protocolVersion: 1,
      type: "sync.preflight",
      generatedAt: 1_750_000_001_000,
      unit: "photos-2019",
      target: "archive",
      argv: expectedArgv,
      configRevision: configRevision(config),
      checks: [{ name: "rsync", ok: true, detail: "rsync found" }],
      ok: true,
      nChanges: 3,
      nFiles: 3,
      nNew: 3,
      nExtra: 0,
      bytesPending: 999,
      needsChecksum: false,
      confirmationToken: "test-confirmation-token",
      expiresAt: 1_750_000_001_000 + 5 * 60_000,
    });

    expect(savedIntents).toHaveLength(1);
    expect(savedIntents[0]).toMatchObject({
      token: "test-confirmation-token",
      unit: "photos-2019",
      target: "archive",
      fingerprint: currentFingerprint,
    });
  });

  test("refuses a unit that listUnits does not know about, without fingerprinting or reaching anything", async () => {
    const { preflightIo, fingerprintCalls, reachabilityCalls } = spyIo();
    let failure: string | undefined;

    await cmdSyncPreflight(config, "no-such-unit", "archive", preflightIo, (message) => {
      failure = message;
      throw new Error(message);
    }).catch(() => {});

    expect(failure).toBe("no such unit: no-such-unit");
    expect(fingerprintCalls).toEqual([]);
    expect(reachabilityCalls).toEqual([]);
  });
});

describe("a scheduled sync that does not run is recorded as skipped", () => {
  function scheduledIo(
    overrides: Partial<SyncPreflightIo>,
    reach: "ok" | "unreachable" = "ok",
  ): { io: SyncPreflightIo; history: HistoryEntry[] } {
    const { preflightIo, unitCell } = spyIo();
    const history: HistoryEntry[] = [];
    return {
      history,
      io: {
        ...preflightIo,
        unitCell: { ...unitCell, targetReachability: async () => reach },
        actor: "scheduler",
        appendHistory: (entry) => history.push(entry),
        ...overrides,
      },
    };
  }

  test("names an unplugged destination and why", async () => {
    const { io, history } = scheduledIo({}, "unreachable");

    await expect(cmdSyncPreflight(config, "photos-2019", "archive", io)).rejects.toThrow(
      /no recorded files to sync/,
    );
    expect(history).toEqual([
      {
        ts: 1_750_000_001_000,
        unit: "photos-2019",
        target: "archive",
        argv: [],
        exitCode: null,
        operation: "sync",
        outcome: "skipped",
        detail: "not connected",
      },
    ]);
  });

  test("names a folder with nothing recorded as behind", async () => {
    const { io, history } = scheduledIo({});

    await expect(cmdSyncPreflight(config, "videos-2020", "archive", io)).rejects.toThrow();
    expect(history.map((entry) => [entry.unit, entry.target, entry.outcome])).toEqual([
      ["videos-2020", "archive", "skipped"],
    ]);
    expect(history[0]?.detail).toStartWith("no recorded files to sync · ");
  });

  test("names the guard that refused", async () => {
    const { io, history } = scheduledIo({
      preflight: async () => ({
        checks: [
          { name: "rsync", ok: true, detail: "rsync found" },
          { name: "space", ok: false, detail: "needs 2 GB, 1 GB free" },
        ],
        ok: false,
        freeAfter: 0,
      }),
    });

    await cmdSyncPreflight(config, "photos-2019", "archive", io);
    expect(history.map((entry) => [entry.outcome, entry.detail])).toEqual([
      ["skipped", "needs 2 GB, 1 GB free"],
    ]);
  });

  test("a sync reviewed by hand records nothing: the refusal is on screen", async () => {
    const { io, history } = scheduledIo({ actor: "mac" }, "unreachable");

    await expect(cmdSyncPreflight(config, "photos-2019", "archive", io)).rejects.toThrow();
    expect(history).toEqual([]);
  });
});
