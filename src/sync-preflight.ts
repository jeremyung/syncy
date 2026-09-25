import type { Config, Target } from "./config.ts";
import { configRevision, evaluateUnitCell, type UnitCellIo } from "./engine-snapshot.ts";
import { type Preflight, preflight } from "./guards.ts";
import { serializeEngineMessage } from "./protocol-jsonl.ts";
import { argvFor } from "./rsync.ts";
import { listUnits } from "./scan.ts";
import { appendHistory, type HistoryEntry, loadState, type State } from "./state.ts";
import { reachWord } from "./status.ts";
import { type SyncIntent, saveSyncIntent } from "./sync-intent.ts";

/**
 * Read-side and effect seams for `cmdSyncPreflight`, injectable so a test can
 * prove the command itself — not just the evaluation helper it calls —
 * fingerprints one unit and reaches one destination.
 *
 * Every field defaults to the real implementation; a test overrides only the
 * ones it needs to instrument or keep off the filesystem. Kept in its own
 * module, rather than inline in cli.ts, because cli.ts runs its CLI entry
 * point as an unconditional top-level `await main()` — importing it for a
 * test would run the whole command line tool.
 */
export interface SyncPreflightIo {
  readonly listUnits?: (source: string) => readonly string[];
  readonly loadState?: () => State;
  readonly now?: () => number;
  readonly unitCell?: UnitCellIo;
  readonly preflight?: (
    config: Config,
    target: Target,
    argv: readonly string[],
    bytesPending: number,
  ) => Promise<Preflight>;
  readonly randomToken?: () => string;
  readonly saveSyncIntent?: (intent: SyncIntent) => void;
  readonly write?: (chunk: string) => void;
  /** Who asked; defaults to `SYNCY_ACTOR`, which the Mac app sets per launch. */
  readonly actor?: string;
  readonly appendHistory?: (entry: HistoryEntry) => void;
}

/**
 * `syncy engine preflight <unit> <destination>`: review one cell and, if it
 * has pending work, stage a confirmation token for `engine sync` to spend.
 *
 * Used to call `buildEngineSnapshot`, which fingerprints every unit and
 * resolves every destination to answer one cell's question, then `engine
 * sync` fingerprinted the same unit again. This fingerprints the one unit
 * asked about and reaches the one destination asked about, via
 * `evaluateUnitCell`.
 *
 * A caller that does not supply `fail` gets `throw` instead, since exiting
 * the process out from under a test would end the test run, not just the
 * command.
 */
export async function cmdSyncPreflight(
  config: Config,
  unitName: string,
  targetName: string,
  io: SyncPreflightIo = {},
  fail: (message: string) => never = (message) => {
    throw new Error(message);
  },
): Promise<void> {
  const now = (io.now ?? Date.now)();
  const target = config.targets.find((candidate) => candidate.name === targetName);
  if (target === undefined) fail(`no such destination: ${targetName}`);
  if (!(io.listUnits ?? listUnits)(config.source).includes(unitName)) {
    fail(`no such unit: ${unitName}`);
  }
  const state = (io.loadState ?? loadState)();
  const evaluation = await evaluateUnitCell(config, state, unitName, target, now, io.unitCell);
  if (evaluation === undefined) fail(`no evidence for ${unitName} at ${targetName}`);
  const { unit, cell, reachability } = evaluation;
  // A scheduled sync that does not run is a skipped sync, and says so in
  // history by name. Without this, a scheduled sync to an unplugged drive
  // left no record at all — the preflight refused, the app said "failed",
  // and the history that outlives both said nothing had been attempted.
  // A person reviewing a sync by hand sees the refusal on screen instead.
  const scheduled = (io.actor ?? process.env.SYNCY_ACTOR) === "scheduler";
  const recordSkipped = (detail: string): void => {
    if (!scheduled) return;
    (io.appendHistory ?? appendHistory)({
      ts: now,
      unit: unitName,
      target: targetName,
      argv: [],
      exitCode: null,
      operation: "sync",
      outcome: "skipped",
      detail,
    });
  };
  if (cell.state !== "behind" && cell.state !== "missing") {
    recordSkipped(
      reachability === "ok"
        ? `no recorded files to sync · ${cell.reason}`
        : reachWord(reachability),
    );
    fail(`${unitName} → ${targetName} has no recorded files to sync (${cell.reason})`);
  }
  const needsChecksum = cell.needsChecksum === true;
  const argv = argvFor(config, unitName, target, "sync", {
    ...(needsChecksum ? { checksum: true } : {}),
  });
  const result = await (io.preflight ?? preflight)(config, target, argv, cell.bytesPending);
  const token = (io.randomToken ?? (() => crypto.randomUUID()))();
  const expiresAt = now + 5 * 60_000;
  if (!result.ok) {
    recordSkipped(result.checks.find((check) => !check.ok)?.detail ?? "a guard refused the sync");
  }
  if (result.ok) {
    (io.saveSyncIntent ?? saveSyncIntent)({
      version: 1,
      token,
      createdAt: now,
      expiresAt,
      unit: unitName,
      target: targetName,
      argv,
      fingerprint: unit.fingerprint,
      configRevision: configRevision(config),
      nChanges: cell.nChanges,
      ...(cell.nFiles === undefined ? {} : { nFiles: cell.nFiles }),
      bytesPending: cell.bytesPending,
      needsChecksum,
    });
  }
  (io.write ?? ((chunk: string) => process.stdout.write(chunk)))(
    serializeEngineMessage({
      protocolVersion: 1,
      type: "sync.preflight",
      generatedAt: now,
      unit: unitName,
      target: targetName,
      argv,
      configRevision: configRevision(config),
      checks: result.checks,
      ok: result.ok,
      nChanges: cell.nChanges,
      ...(cell.nFiles === undefined ? {} : { nFiles: cell.nFiles }),
      ...(cell.nNew === undefined ? {} : { nNew: cell.nNew }),
      nExtra: cell.nExtra,
      bytesPending: cell.bytesPending,
      needsChecksum,
      ...(result.ok ? { confirmationToken: token, expiresAt } : {}),
    }),
  );
}
