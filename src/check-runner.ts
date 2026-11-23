import { join } from "node:path";
import type { Config, Target } from "./config.ts";
import { saveDiff } from "./diff.ts";
import type { JobEvent, JobPhase } from "./engine-protocol.ts";
import { type Fingerprint, fingerprint } from "./fingerprint.ts";
import { debug } from "./log.ts";
import {
  allReachability,
  type CheckResult,
  checkUnit,
  methodOf,
  type Reachability,
  TargetCheckError,
} from "./scan.ts";
import {
  appendHistory,
  estimateMs,
  loadState,
  type Scan,
  type State,
  saveState,
  upsertScan,
} from "./state.ts";
import { reachWord } from "./status.ts";

export type CheckMode = "quick" | "deep";

export interface CheckRunUnit {
  readonly unit: string;
  readonly bytes: number;
  readonly files: number;
  /** One source walk shared by every destination in this run. */
  readonly fingerprint?: Fingerprint;
}

export interface SkippedDestination {
  readonly target: string;
  readonly why: Exclude<Reachability, "ok">;
}

export interface FailedCheck {
  readonly unit: string;
  readonly target: string;
  readonly message: string;
}

export interface CheckRunResult {
  readonly status: "completed" | "cancelled";
  readonly state: State;
  readonly total: number;
  readonly ran: number;
  readonly skipped: readonly SkippedDestination[];
  readonly failed: readonly FailedCheck[];
}

export interface CheckRunnerDependencies {
  readonly reachability: typeof allReachability;
  readonly check: typeof checkUnit;
  /** The merge base for every record: the state file as it is at record time. */
  readonly loadState: typeof loadState;
  readonly saveState: typeof saveState;
  readonly saveDiff: typeof saveDiff;
  readonly appendHistory: typeof appendHistory;
}

const DEFAULT_DEPENDENCIES: CheckRunnerDependencies = {
  reachability: allReachability,
  check: checkUnit,
  loadState,
  saveState,
  saveDiff,
  appendHistory,
};

export interface CheckRunOptions {
  readonly signal?: AbortSignal;
  /**
   * Confine the run to these destinations, by name.
   *
   * A check normally fans out to every configured target, because the question
   * the ledger asks is about the unit. The trailing check after a sync asks a
   * narrower question — what landed at the one destination that was just
   * written to — and fanning that out would make a two-second recheck of one
   * folder wait on every other drive in the fan-out.
   *
   * Omitted means every target, which is what every pre-existing caller wants.
   */
  readonly targets?: readonly string[];
  /** A cached result is safe for one run; the caller refreshes after completion. */
  readonly reachability?: ReadonlyMap<string, Reachability>;
  readonly onEvent?: (event: JobEvent) => void;
  /** Published only after evidence has been durably recorded. */
  readonly onState?: (state: State) => void;
  readonly now?: () => number;
  readonly jobId?: (unit: string, target: string, position: number) => string;
  /** Test seam. Production callers should use the guarded defaults. */
  readonly dependencies?: CheckRunnerDependencies;
}

/**
 * Records one finished check against what is on disk, not the copy at hand.
 *
 * The re-read is structural, not something a caller must remember: the
 * accumulated in-memory copy may be hours old, and another writer — the Mac
 * app, a scheduled run, a second terminal — may have replaced a record in it
 * since it was loaded. Merging the new scan into that stale copy and writing
 * the whole thing back silently resurrects whatever that writer superseded —
 * the deep `behind` found overnight is gone again by the morning's quick
 * `clean`, and the row reads `verified`.
 */
export function recordScan(
  scan: Scan,
  read: typeof loadState = loadState,
  write: typeof saveState = saveState,
): State {
  const merged = upsertScan(read(), scan);
  write(merged);
  return merged;
}

interface PlannedCheck extends CheckRunUnit {
  readonly target: Target;
}

/**
 * Runs a quick/deep queue without knowing about React, Ink, or SwiftUI.
 *
 * This owns the same persistence order the TUI historically did: state, diff,
 * history, then publication. An abort records no verdict for the interrupted
 * check and stops the rest of the queue.
 *
 * Every check that started leaves a history line, whatever became of it. A
 * cancelled or thrown check used to emit its event and write nothing, so the
 * record a scheduled run is judged by showed that work as never having
 * happened: the history could say completed and skipped, but not cancelled or
 * failed, for exactly the runs that most need saying.
 */
export async function runCheckQueue(
  config: Config,
  initialState: State,
  mode: CheckMode,
  units: readonly CheckRunUnit[],
  options: CheckRunOptions = {},
): Promise<CheckRunResult> {
  const deps = options.dependencies ?? DEFAULT_DEPENDENCIES;
  const now = options.now ?? Date.now;
  const reach = options.reachability ?? (await deps.reachability(config));
  const only = options.targets;
  const targets =
    only === undefined ? config.targets : config.targets.filter((t) => only.includes(t.name));
  const jobs: PlannedCheck[] = units.flatMap((unit) =>
    targets.map((target) => ({ ...unit, target })),
  );
  const bytesTotal = jobs.reduce((total, job) => total + job.bytes, 0);
  const fingerprints = new Map(
    units.flatMap((unit) =>
      unit.fingerprint === undefined ? [] : ([[unit.unit, unit.fingerprint]] as const),
    ),
  );
  const startedAt = now();
  let working = initialState;
  let done = 0;
  let bytesDone = 0;
  let ran = 0;
  const skipped: SkippedDestination[] = [];
  const failed: FailedCheck[] = [];
  const isAborted = (): boolean => options.signal?.aborted === true;

  const recordEnded = (
    job: PlannedCheck,
    outcome: "cancelled" | "failed",
    detail: string,
  ): void => {
    deps.appendHistory({
      ts: now(),
      unit: job.unit,
      target: job.target.name,
      argv: [],
      exitCode: null,
      operation: mode,
      outcome,
      detail,
    });
  };

  const cancelled = (): CheckRunResult => ({
    status: "cancelled",
    state: working,
    total: jobs.length,
    ran,
    skipped,
    failed,
  });

  for (const job of jobs) {
    if (isAborted()) return cancelled();
    const position = done + 1;
    const jobId =
      options.jobId?.(job.unit, job.target.name, position) ??
      `${startedAt}-${position}-${job.unit}-${job.target.name}`;
    const jobStartedAt = now();
    const estimate = estimateMs(working, job.target.name, methodOf(mode), job.bytes);
    const base = {
      protocolVersion: 1,
      jobId,
      operation: mode,
      unit: job.unit,
      target: job.target.name,
    } as const;
    options.onEvent?.({
      ...base,
      type: "job.started",
      at: jobStartedAt,
      phase: "queued",
      batch: { position, total: jobs.length, bytesDone, bytesTotal },
      unitSize: { files: job.files, bytes: job.bytes },
      ...(estimate === undefined ? {} : { estimatedDurationMs: estimate }),
    });

    const status = reach.get(job.target.name) ?? "unreachable";
    if (status !== "ok") {
      if (!skipped.some((entry) => entry.target === job.target.name)) {
        skipped.push({ target: job.target.name, why: status });
      }
      debug("check.skipped", { unit: job.unit, target: job.target.name, reach: status });
      options.onEvent?.({
        ...base,
        type: "job.skipped",
        at: now(),
        reachability: status,
        reason: reachWord(status),
      });
      deps.appendHistory({
        ts: now(),
        unit: job.unit,
        target: job.target.name,
        argv: [],
        exitCode: null,
        operation: mode,
        outcome: "skipped",
        detail: reachWord(status),
      });
      done += 1;
      bytesDone += job.bytes;
      continue;
    }

    ran += 1;
    debug("check.start", {
      mode,
      unit: job.unit,
      target: job.target.name,
      bytes: job.bytes,
      files: job.files,
      estimateMs: estimate ?? null,
    });
    try {
      const sourceFingerprint = fingerprints.get(job.unit);
      const result = await deps.check(config, job.unit, job.target, mode, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(sourceFingerprint === undefined ? {} : { fingerprint: sourceFingerprint }),
        onPhase: (phase) => {
          const mapped: JobPhase =
            phase === "comparing"
              ? mode === "deep"
                ? "comparing-content"
                : "comparing-metadata"
              : phase;
          options.onEvent?.({ ...base, type: "job.phase-changed", at: now(), phase: mapped });
        },
        onFile: (seen, name) => {
          options.onEvent?.({
            ...base,
            type: "job.progress-observed",
            at: now(),
            filesSeen: seen,
            filesTotal: job.files,
            lastItem: name,
          });
        },
      });
      if (isAborted()) {
        options.onEvent?.({ ...base, type: "job.cancelled", at: now() });
        recordEnded(job, "cancelled", "no verification was recorded");
        return cancelled();
      }
      const jobMs = now() - jobStartedAt;
      debugCompletion(mode, job, result, jobMs);
      // If the caller did not already measure it, checkUnit's first source
      // walk becomes the shared value for this unit's remaining destinations.
      if (!fingerprints.has(job.unit)) fingerprints.set(job.unit, result.scan.fingerprint);
      options.onEvent?.({
        ...base,
        type: "job.phase-changed",
        at: now(),
        phase: "recording-evidence",
      });
      // Merged onto the file as it is now, never onto `working`: see recordScan.
      working = recordScan(result.scan, deps.loadState, deps.saveState);
      deps.saveDiff(result.diff);
      deps.appendHistory({
        ts: result.scan.ts,
        unit: job.unit,
        target: job.target.name,
        argv: result.argv,
        exitCode: result.exitCode,
        operation: mode,
        outcome: result.scan.outcome === "error" ? "failed" : "completed",
      });
      options.onState?.(working);
      options.onEvent?.({
        ...base,
        type: "job.completed",
        at: now(),
        result: {
          outcome: result.scan.outcome,
          nChanges: result.scan.nChanges,
          ...(result.scan.nFiles === undefined ? {} : { nFiles: result.scan.nFiles }),
          ...(result.scan.nNew === undefined ? {} : { nNew: result.scan.nNew }),
          nExtra: result.scan.nExtra,
          bytesPending: result.scan.bytesPending,
          exitCode: result.exitCode,
          ...(result.scan.durationMs === undefined ? {} : { durationMs: result.scan.durationMs }),
        },
      });
    } catch (error) {
      if (isAborted()) {
        options.onEvent?.({ ...base, type: "job.cancelled", at: now() });
        recordEnded(job, "cancelled", "no verification was recorded");
        return cancelled();
      }
      if (error instanceof TargetCheckError) {
        ran -= 1;
        if (!skipped.some((entry) => entry.target === error.targetName)) {
          skipped.push({ target: error.targetName, why: error.reachability });
        }
        const reason = reachWord(error.reachability);
        debug("check.skipped", {
          unit: job.unit,
          target: error.targetName,
          reach: error.reachability,
          fresh: true,
        });
        options.onEvent?.({
          ...base,
          type: "job.skipped",
          at: now(),
          reachability: error.reachability,
          reason,
        });
        deps.appendHistory({
          ts: now(),
          unit: job.unit,
          target: error.targetName,
          argv: [],
          exitCode: null,
          operation: mode,
          outcome: "skipped",
          detail: reason,
        });
        done += 1;
        bytesDone += job.bytes;
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      debug("check.failed", {
        unit: job.unit,
        target: job.target.name,
        ms: now() - jobStartedAt,
        error: message,
      });
      failed.push({ unit: job.unit, target: job.target.name, message });
      options.onEvent?.({ ...base, type: "job.failed", at: now(), message, exitCode: null });
      recordEnded(job, "failed", message);
    }
    done += 1;
    bytesDone += job.bytes;
  }

  return { status: "completed", state: working, total: jobs.length, ran, skipped, failed };
}

/**
 * The quick check that closes a sync, for the one destination it wrote to.
 *
 * A transfer changes the destination and records nothing about it: the scan
 * that said `504 files not copied yet` is what the ledger keeps rendering
 * afterwards, so a folder that has just been copied in full goes on reporting
 * a backlog that no longer exists. rsync's own exit code is not a substitute —
 * DESIGN.md section 6 is explicit that a completed rsync proves a copy
 * happened, never that it matches — so the stale record is replaced with
 * evidence rather than with an assumption.
 *
 * Quick, not deep, and that is the whole ladder working as designed: this
 * establishes that every file is present at the right size and date, which
 * moves the row off `behind`. It does not read the bytes, so it cannot and
 * must not produce `verified`; only [d] does that.
 *
 * The source fingerprint is measured here rather than taken from the caller.
 * The sync may have run for hours, and a check recorded against a fingerprint
 * from before it started would be filed under a source state that no longer
 * exists — which the two-clock rule would then read as evidence for it.
 */
export async function recheckAfterSync(
  config: Config,
  state: State,
  unit: string,
  target: string,
  options: CheckRunOptions = {},
): Promise<CheckRunResult> {
  const measured = fingerprint(join(config.source, unit), config.exclude);
  return runCheckQueue(
    config,
    state,
    "quick",
    [{ unit, bytes: measured.bytes, files: measured.nfiles, fingerprint: measured }],
    { ...options, targets: [target] },
  );
}

function debugCompletion(
  mode: CheckMode,
  job: PlannedCheck,
  result: CheckResult,
  elapsedMs: number,
): void {
  debug("check.done", {
    mode,
    unit: job.unit,
    target: job.target.name,
    ms: elapsedMs,
    bytes: job.bytes,
    outcome: result.scan.outcome,
    nChanges: result.scan.nChanges,
    ...(mode === "deep" && elapsedMs >= 1000
      ? { readMBPerSec: Math.round(job.bytes / 1e6 / (elapsedMs / 1000)) }
      : {}),
  });
}
