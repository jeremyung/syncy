import { join } from "node:path";
import { useEffect, useState } from "react";
import type { Config } from "../config.ts";
import { saveDiff } from "../diff.ts";
import { fingerprint, type Fingerprint } from "../fingerprint.ts";
import { debug } from "../log.ts";
import {
  allReachability,
  checkUnit,
  methodOf,
  TargetCheckError,
  type Reachability,
} from "../scan.ts";
import { appendHistory, estimateMs, type State, saveState, upsertScan } from "../state.ts";
import { reachWord } from "../status.ts";
import type { Row } from "./Ledger.tsx";
import type { RunProgress } from "./Progress.tsx";
import { useTimers } from "./useTimers.ts";

/**
 * Running a check: the state of the work itself, separated from the screens.
 *
 * `App` used to hold the whole orchestration — the job list, the bar, the
 * per-destination skips, the state writes — inside a 760-line component
 * alongside its keyboard handling and render tree. The job is self-contained
 * except for the facts it reads (rows, cached scan) and the effects it has
 * (state, the ledger's busy line, a notification when a key is refused), so
 * those are the only things it takes and the only things it returns.
 */

/** What the caller knows about the world, so the job can plan against it. */
export interface JobFacts {
  readonly config: Config;
  /** The rows currently on screen, in the order they appear. */
  readonly rows: Row[];
  /** Which row the cursor is on, already clamped to the visible range. */
  readonly clampedSelection: number;
  readonly state: State;
  /** Cached fingerprints and reachability, or null before the first scan. */
  readonly scan: {
    readonly fingerprints: ReadonlyMap<string, Fingerprint>;
    readonly reach: ReadonlyMap<string, Reachability>;
  } | null;
  /** Re-read fingerprints and reachability after the run has changed things. */
  readonly refresh: () => void;
  /** Show a short refusal message, e.g. when a key arrives while a job runs. */
  readonly notify: (text: string) => void;
  readonly setNow: React.Dispatch<React.SetStateAction<number>>;
  readonly setState: React.Dispatch<React.SetStateAction<State>>;
}

export interface Job {
  /** The run in flight, for the row the cursor may have left. */
  readonly running: RunProgress | null;
  /** The transient status line under the ledger, or null when idle. */
  readonly busy: string | null;
  readonly runCheck: (mode: "quick" | "deep", scope: "selected" | "all") => Promise<void>;
}

/**
 * Returns one source fingerprint for a unit during a queued run.
 *
 * The opening refresh usually provides the cache. The fallback matters when a
 * key arrives before that refresh resolves: without it, a run over two
 * destinations would walk the same source twice before either check starts.
 * Keeping this small seam separate also makes the one-walk invariant directly
 * testable without rendering a terminal or spawning rsync.
 */
export function cachedSourceFingerprint(
  config: Pick<Config, "source" | "exclude">,
  unit: string,
  cache: Map<string, Fingerprint>,
  read: typeof fingerprint = fingerprint,
): Fingerprint {
  const existing = cache.get(unit);
  if (existing !== undefined) return existing;
  const current = read(join(config.source, unit), config.exclude);
  cache.set(unit, current);
  return current;
}

/** Counts jobs that were not skipped; displayed skip reasons are deduplicated. */
export function jobsRan(totalJobs: number, skippedJobs: number): number {
  return Math.max(0, totalJobs - skippedJobs);
}

export function useJob(facts: JobFacts): Job {
  const [busy, setBusy] = useState<string | null>(null);
  const timers = useTimers();

  /**
   * Tripped when the interface unmounts, calling off the work it started.
   *
   * The run below is a plain async loop with no connection to React's
   * lifecycle, so quitting mid-run used to stop nothing: it finished the
   * folder in flight and then spawned rsync for every remaining one, recording
   * scans, history and diffs with nothing on screen. The alternate screen had
   * already been handed back, so what you saw was your own shell, no prompt,
   * and both disks working.
   *
   * The signal reaches Bun.spawn, so the child dies with the interface, and
   * the loop reads it between jobs so the queue stops rather than draining.
   */
  const [quitting] = useState(() => new AbortController());
  useEffect(() => () => quitting.abort(), [quitting]);
  /**
   * What is being checked right now.
   *
   * Held separately from `busy` — which is a transient message — so the work
   * stays visible on the row it belongs to even after the cursor moves away.
   */
  const [running, setRunning] = useState<RunProgress | null>(null);

  /**
   * Not memoised, deliberately.
   *
   * `facts` is a fresh object every render and `rows` a fresh array whenever
   * a filter is on, so a `useCallback` over them would rebuild the closure
   * every render anyway — the memo would be a claim of stability that the
   * dependencies cannot keep. Nothing depends on this function's identity:
   * `useKeys` re-registers its handler each render regardless. A plain
   * definition is what actually happens, so it is what is written.
   */
  const runCheck = async (mode: "quick" | "deep", scope: "selected" | "all"): Promise<void> => {
    if (running !== null) {
      facts.notify(
        `[${mode === "deep" ? "d" : "q"}] ignored — the ${running.mode} check on ` +
          `${running.unit} is still running`,
      );
      return;
    }
    const chosen =
      scope === "all"
        ? facts.rows
        : facts.rows.slice(facts.clampedSelection, facts.clampedSelection + 1);
    if (chosen.length === 0) return;

    const reach = facts.scan?.reach ?? (await allReachability(facts.config));
    const jobs = chosen.flatMap((row) =>
      facts.config.targets.map((target) => ({
        unit: row.status.unit,
        target,
        size: row.size,
        files: row.files ?? 0,
      })),
    );
    // The bar fills by bytes: a 78 gb folder and a 442 mb one take wildly
    // different times, so counting folders equally would make it lie.
    const bytesTotal = jobs.reduce((a, j) => a + j.size, 0);
    const startedAt = Date.now();
    let working = facts.state;
    let done = 0;
    let bytesDone = 0;

    // A refresh normally supplies this map. If the user starts a check while
    // the first reachability refresh is still in flight, however, `scan` is
    // null and checkUnit would otherwise walk the same source once per target.
    // Keep the per-run fallback here so a multi-target check has exactly one
    // source fingerprint per unit in either case.
    const sourceFingerprints = new Map(facts.scan?.fingerprints ?? []);

    // Destinations that could not be reached, so the run can say what it did
    // not do. Skipping in silence and then reporting "deep check finished"
    // was a claim that nothing had been checked — indistinguishable from a
    // check that never started.
    const skipped: { readonly target: string; readonly why: Reachability }[] = [];
    let skippedJobs = 0;
    const failed: { readonly unit: string; readonly target: string }[] = [];

    for (const job of jobs) {
      // Nothing to report and nobody to report it to: the interface has
      // unmounted, so the rest of the queue is work no one asked to keep.
      if (quitting.signal.aborted) return;
      const status = reach.get(job.target.name);
      if (status !== "ok") {
        if (!skipped.some((s) => s.target === job.target.name)) {
          skipped.push({
            target: job.target.name,
            why: status ?? "unreachable",
          });
        }
        debug("check.skipped", {
          unit: job.unit,
          target: job.target.name,
          reach: status,
        });
        done += 1;
        bytesDone += job.size;
        skippedJobs += 1;
        continue;
      }
      // Estimated from measured throughput at this destination, so the bar
      // works from the second check onwards on *any* folder rather than only
      // on one that has been checked twice.
      const prior = estimateMs(working, job.target.name, methodOf(mode), job.size);
      const jobStarted = Date.now();
      const base = {
        unit: job.unit,
        target: job.target.name,
        mode,
        done,
        total: jobs.length,
        bytesDone,
        bytesTotal,
        startedAt,
        jobStartedAt: jobStarted,
        filesTotal: job.files,
        unitBytes: job.size,
        ...(prior !== undefined ? { priorMs: prior } : {}),
      } as const;
      setRunning({ ...base, filesSeen: 0 });
      debug("check.start", {
        mode,
        unit: job.unit,
        target: job.target.name,
        bytes: job.size,
        files: job.files,
        estimateMs: prior ?? null,
      });
      const cachedFingerprint = cachedSourceFingerprint(facts.config, job.unit, sourceFingerprints);
      try {
        const { scan, diff, argv, exitCode } = await checkUnit(
          facts.config,
          job.unit,
          job.target,
          mode,
          {
            signal: quitting.signal,
            // The refresh snapshot already paid for this metadata walk. Pass
            // it through so each target does not fingerprint the same source
            // unit again while a queue is running.
            ...(cachedFingerprint === undefined ? {} : { fingerprint: cachedFingerprint }),
            // Throttled: one render per 25 files keeps a large folder from
            // driving the render loop instead of the check.
            onFile: (seen) => {
              if (seen % 25 === 0) setRunning({ ...base, filesSeen: seen });
            },
          },
        );
        // An abandoned check proved nothing. rsync was killed, so it exits
        // non-zero and reads as `error` — a verdict about the quit, not about
        // the folder. Recorded, it would leave the ledger claiming a check had
        // failed on a folder nobody checked.
        if (quitting.signal.aborted) return;
        const jobMs = Date.now() - jobStarted;
        debug("check.done", {
          mode,
          unit: job.unit,
          target: job.target.name,
          ms: jobMs,
          bytes: job.size,
          outcome: scan.outcome,
          nChanges: scan.nChanges,
          // A rate only where one was actually achieved. A quick check reads
          // no file contents, so dividing the folder's bytes by its elapsed
          // time reported 90,353 MB/s — a number with no referent. Sub-second
          // runs are excluded for the same reason: the divisor is noise.
          ...(mode === "deep" && jobMs >= 1000
            ? { readMBPerSec: Math.round(job.size / 1e6 / (jobMs / 1000)) }
            : {}),
        });
        working = upsertScan(working, scan);
        saveState(working);
        // The itemized list is accumulated during the rsync stream and capped
        // before it reaches this queue. Saving it here does not retain the
        // full output or map it into a second unbounded array.
        saveDiff(diff);
        appendHistory({
          ts: scan.ts,
          unit: job.unit,
          target: job.target.name,
          argv,
          exitCode,
        });
        // Publish after every unit so the ledger fills in as it goes rather
        // than staying blank until the whole run finishes.
        facts.setState(working);
        facts.setNow(Date.now());
      } catch (e) {
        if (quitting.signal.aborted) return;
        if (e instanceof TargetCheckError) {
          // A destination can change while an earlier queued check is
          // running. Treat that job as a named skip, not a transient failure:
          // the final line must not be overwritten by "check finished".
          if (!skipped.some((s) => s.target === e.targetName)) {
            skipped.push({ target: e.targetName, why: e.reachability });
          }
          debug("check.skipped", {
            unit: job.unit,
            target: e.targetName,
            reach: e.reachability,
            fresh: true,
          });
          skippedJobs += 1;
        } else {
          failed.push({ unit: job.unit, target: job.target.name });
          // Explicit catch at the subprocess boundary; a swallowed rejection
          // would leave the ledger showing stale state as if it were fresh.
          debug("check.failed", {
            unit: job.unit,
            target: job.target.name,
            ms: Date.now() - jobStarted,
            error: (e as Error).message,
          });
          setBusy(`${job.unit} → ${job.target.name}: failed — ${(e as Error).message}`);
        }
      }
      done += 1;
      bytesDone += job.size;
    }

    setRunning(null);
    // A check can change what is at the target, and the source may have moved
    // under us while it ran, so both facts are re-read once at the end.
    facts.refresh();
    // A run in which every destination was skipped checked nothing, and must
    // not report otherwise.
    // `skipped` is deduplicated for the human-facing message, so it cannot
    // also count work: a target may complete one queued unit before becoming
    // unavailable for the next. Count the actual skipped jobs at the boundary.
    const ran = jobsRan(jobs.length, skippedJobs);
    if (ran === 0 && skipped.length > 0) {
      setBusy(
        `nothing checked — ${skipped.map((s) => `${s.target} ${reachWord(s.why)}`).join(", ")}`,
      );
    } else if (skipped.length > 0) {
      setBusy(
        `${mode} check finished · ${ran} of ${jobs.length} · skipped ` +
          skipped.map((s) => `${s.target} (${reachWord(s.why)})`).join(", "),
      );
    } else if (failed.length > 0) {
      setBusy(
        `${mode} check finished · ${jobs.length - failed.length} of ${jobs.length} · ` +
          `failed ${failed.map((f) => `${f.target}/${f.unit}`).join(", ")}`,
      );
    } else {
      setBusy(
        scope === "all"
          ? `${mode} check finished · ${chosen.length} folders`
          : `${mode} check finished · ${chosen[0]?.status.unit ?? ""}`,
      );
    }
    facts.setNow(Date.now());
    // A skip needs longer on screen than a success: it is the message the
    // user has to read and act on.
    timers.later(() => setBusy(null), skipped.length > 0 ? 8000 : 2500);
  };

  return { running, busy, runCheck };
}
