import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Config } from "./config.ts";
import {
  type ActivityMessage,
  ENGINE_PROTOCOL_VERSION,
  type SnapshotMessage,
} from "./engine-protocol.ts";
import { type Fingerprint, fingerprint } from "./fingerprint.ts";
import type { JobOwnerRecord } from "./job-owner.ts";
import { isJobOwnerActive, readJobOwner } from "./job-owner.ts";
import { presentReachability } from "./presentation.ts";
import { allReachability, listUnits, type Reachability } from "./scan.ts";
import { findScan, latestScan, type Scan, type State } from "./state.ts";
import { evaluateUnit, targetIdentity } from "./status.ts";

function evidenceSnapshot(scan: Scan) {
  return {
    method: scan.method,
    outcome: scan.outcome,
    at: scan.ts,
    ...(scan.durationMs === undefined ? {} : { durationMs: scan.durationMs }),
    nChanges: scan.nChanges,
    ...(scan.nFiles === undefined ? {} : { nFiles: scan.nFiles }),
    nExtra: scan.nExtra,
    bytesPending: scan.bytesPending,
  };
}

/**
 * Read-side dependencies are injectable so the protocol boundary can be
 * verified without asking a test machine about its real disks or shares.
 */
export interface ActivityIo {
  readonly owner?: () => JobOwnerRecord | undefined;
  readonly pidAlive?: (pid: number) => boolean;
}

export interface SnapshotIo extends ActivityIo {
  readonly listUnits: (source: string) => readonly string[];
  readonly fingerprint: (root: string, exclude: readonly string[]) => Fingerprint;
  readonly reachability: (config: Config) => Promise<ReadonlyMap<string, Reachability>>;
  /** Read after scanning, so a snapshot timestamp means the read is complete. */
  readonly completedAt?: () => number;
}

const REAL_IO: SnapshotIo = {
  listUnits,
  fingerprint,
  reachability: allReachability,
  owner: readJobOwner,
  completedAt: Date.now,
};

/** Read only the live ownership record; this never walks source or destination trees. */
export function buildEngineActivity(
  now: number = Date.now(),
  io: ActivityIo = { owner: readJobOwner },
): ActivityMessage {
  const candidate = io.owner?.();
  const owner =
    candidate !== undefined && isJobOwnerActive(candidate, now, 30_000, io.pidAlive)
      ? candidate
      : undefined;
  return {
    protocolVersion: ENGINE_PROTOCOL_VERSION,
    type: "activity" as const,
    generatedAt: now,
    ...(owner === undefined
      ? {}
      : {
          activeJob: {
            actor: owner.actor,
            pid: owner.pid,
            operation: owner.operation,
            startedAt: owner.startedAt,
            heartbeatAt: owner.heartbeatAt,
            ...(owner.estimatedDurationMs === undefined
              ? {}
              : { estimatedDurationMs: owner.estimatedDurationMs }),
            ...(owner.batchPosition === undefined ? {} : { batchPosition: owner.batchPosition }),
            ...(owner.batchTotal === undefined ? {} : { batchTotal: owner.batchTotal }),
            ...(owner.activity === undefined ? {} : { activity: owner.activity }),
          },
        }),
  };
}

/**
 * Build the authoritative, presentation-neutral ledger sent to another UI.
 *
 * This performs exactly the same evaluation as the TUI: current source
 * fingerprints and current destination identities are part of the snapshot.
 * A native client must never reconstruct a stronger verdict from state.json
 * alone, because a detached destination cannot support `verified` now.
 */
export async function buildEngineSnapshot(
  config: Config,
  state: State,
  now: number = Date.now(),
  io: SnapshotIo = REAL_IO,
): Promise<SnapshotMessage> {
  const reach = await io.reachability(config);
  const units = io.listUnits(config.source).map((unit) => {
    const current = io.fingerprint(join(config.source, unit), config.exclude);
    const status = evaluateUnit(
      config,
      state,
      { unit, fingerprint: current, sentinels: reach },
      now,
    );
    return {
      unit,
      state: status.state,
      reason: status.reason,
      fingerprint: current,
      cells: status.cells.map((cell) => {
        const target = config.targets.find((candidate) => candidate.name === cell.target)!;
        const identity = targetIdentity(target);
        const last = latestScan(state, unit, cell.target, identity);
        const deep = findScan(state, unit, cell.target, "deep", identity);
        const quick = findScan(state, unit, cell.target, "quick", identity);
        return {
          ...cell,
          evidence: {
            currentTarget: (reach.get(cell.target) ?? "unreachable") === "ok",
            ...(last === undefined ? {} : { lastCheck: evidenceSnapshot(last) }),
            ...(deep === undefined ? {} : { deepCheck: evidenceSnapshot(deep) }),
            ...(quick === undefined ? {} : { extrasObservedAt: quick.ts }),
          },
        };
      }),
    };
  });
  // A lease is a live-work signal, not durable history. A crashed owner can
  // remain on disk until the next contender archives it, so publishing it as
  // active would leave a native UI claiming work is still happening forever.
  const activity = buildEngineActivity(now, io);

  return {
    protocolVersion: ENGINE_PROTOCOL_VERSION,
    type: "snapshot",
    generatedAt: io.completedAt?.() ?? now,
    source: config.source,
    configRevision: createHash("sha256").update(JSON.stringify(config)).digest("hex"),
    targets: config.targets.map((target) => ({
      name: target.name,
      required: target.required,
      reachability: reach.get(target.name) ?? "unreachable",
      reachabilityPhrase: presentReachability(reach.get(target.name) ?? "unreachable").phrase,
      usesSentinel: target.sentinel !== undefined,
    })),
    units,
    ...(activity.activeJob === undefined
      ? {}
      : {
          activeJob: activity.activeJob,
        }),
  };
}
