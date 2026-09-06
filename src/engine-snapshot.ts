import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { ENGINE_PROTOCOL_VERSION, type SnapshotMessage } from "./engine-protocol.ts";
import { type Fingerprint, fingerprint } from "./fingerprint.ts";
import type { JobOwnerRecord } from "./job-owner.ts";
import { readJobOwner } from "./job-owner.ts";
import { allReachability, listUnits, type Reachability } from "./scan.ts";
import type { State } from "./state.ts";
import { evaluateUnit } from "./status.ts";

/**
 * Read-side dependencies are injectable so the protocol boundary can be
 * verified without asking a test machine about its real disks or shares.
 */
export interface SnapshotIo {
  readonly listUnits: (source: string) => readonly string[];
  readonly fingerprint: (root: string, exclude: readonly string[]) => Fingerprint;
  readonly reachability: (config: Config) => Promise<ReadonlyMap<string, Reachability>>;
  readonly owner?: () => JobOwnerRecord | undefined;
}

const REAL_IO: SnapshotIo = {
  listUnits,
  fingerprint,
  reachability: allReachability,
  owner: readJobOwner,
};

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
      cells: status.cells,
    };
  });
  const owner = io.owner?.();

  return {
    protocolVersion: ENGINE_PROTOCOL_VERSION,
    type: "snapshot",
    generatedAt: now,
    source: config.source,
    configRevision: createHash("sha256").update(JSON.stringify(config)).digest("hex"),
    targets: config.targets.map((target) => ({
      name: target.name,
      required: target.required,
      reachability: reach.get(target.name) ?? "unreachable",
    })),
    units,
    ...(owner === undefined
      ? {}
      : {
          activeJob: {
            actor: owner.actor,
            operation: owner.operation,
            startedAt: owner.startedAt,
            heartbeatAt: owner.heartbeatAt,
            ...(owner.activity === undefined ? {} : { activity: owner.activity }),
          },
        }),
  };
}
