import {
  attributedScans,
  type LocalPresence,
  observeCatalog,
  verifiedLocalDates,
  withArchiveStore,
} from "./archive-catalog.ts";
import {
  type DisplayPairEvidence,
  type PairOption,
  pairOptions,
  recordedPairs,
} from "./archive-pair.ts";
import type { Config } from "./config.ts";
import type { Reachability } from "./scan.ts";
import type { State } from "./state.ts";
import { targetIdentity } from "./status.ts";

export interface ArchiveRecord {
  local: LocalPresence;
  localEpoch: number;
  label: string;
  pairs: DisplayPairEvidence[];
  pairOptions: PairOption[];
  localChecks: { target: string; at: number }[];
}

export function archiveLedger(
  config: Config,
  state: State,
  reach: ReadonlyMap<string, Reachability>,
  now: number,
) {
  // Snapshot the catalog and distinguish historical measurements from usable local
  // evidence in one transaction. The number of database opens is independent of the
  // number of folders or destination pairs in a ledger.
  const options = pairOptions(config, reach);
  const localProblems = {
    unconfirmed: "select the expected source in setup",
    "different-root": "different volume or directory",
    unreadable: "cannot read the configured source root",
  };
  return withArchiveStore((db) => {
    const folders = observeCatalog(db, config, now, false, state).filter((f) => f.active);
    const current = attributedScans(db, config, state, folders, true);
    const dates = verifiedLocalDates(db, config.source);
    const pairs = recordedPairs(db, config, reach, now);
    const identities = new Map(config.targets.map((t) => [t.name, targetIdentity(t)]));
    const checked = new Set(
      current.scans.filter((scan) => scan.outcome !== "error").map((scan) => scan.unit),
    );
    const byFolder = new Map<string, ArchiveRecord["localChecks"]>();
    for (const date of dates) {
      if (identities.get(date.target) !== date.identity) continue;
      const checks = byFolder.get(date.unit) ?? [];
      checks.push({ target: date.target, at: date.at });
      byFolder.set(date.unit, checks);
    }
    const records = folders.map((folder) => {
      const label =
        folder.local === "absent"
          ? "Absent locally"
          : folder.local === "unavailable"
            ? "Local source unavailable · " + localProblems[folder.problem ?? "unreadable"]
            : folder.since && !checked.has(folder.unit)
              ? "Local copy present · awaiting check"
              : "Local copy present";
      const archive: ArchiveRecord = {
        local: folder.local,
        localEpoch: folder.since,
        label,
        pairs: pairs.get(folder.unit) ?? [],
        pairOptions: options,
        localChecks: byFolder.get(folder.unit) ?? [],
      };
      return { unit: folder.unit, archive };
    });
    return { records, current };
  });
}
