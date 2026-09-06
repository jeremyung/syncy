import { useEffect, useState } from "react";
import { type CheckRunResult, runCheckQueue } from "../check-runner.ts";
import type { Config } from "../config.ts";
import type { Fingerprint } from "../fingerprint.ts";
import { acquireJobOwner } from "../job-owner.ts";
import { presentCheckOutcome } from "../presentation.ts";
import type { Reachability } from "../scan.ts";
import type { State } from "../state.ts";
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

    const ownership = acquireJobOwner("cli", mode);
    if (!ownership.acquired) {
      const owner = ownership.owner;
      facts.notify(
        owner === undefined
          ? "check ignored — another Syncy process is starting"
          : `check ignored — ${owner.actor} ${owner.operation} is still running`,
      );
      return;
    }

    const startedAt = Date.now();
    const heartbeat = setInterval(() => {
      try {
        ownership.lease.heartbeat();
      } catch {
        quitting.abort();
      }
    }, 10_000);
    let result: CheckRunResult;
    try {
      result = await runCheckQueue(
        facts.config,
        facts.state,
        mode,
        chosen.map((row) => ({
          unit: row.status.unit,
          bytes: row.size,
          files: row.files ?? 0,
          ...(facts.scan?.fingerprints.get(row.status.unit) === undefined
            ? {}
            : { fingerprint: facts.scan.fingerprints.get(row.status.unit)! }),
        })),
        {
          signal: quitting.signal,
          ...(facts.scan?.reach === undefined ? {} : { reachability: facts.scan.reach }),
          onEvent: (event) => {
            ownership.lease.observe(event);
            if (event.type === "job.started") {
              const batch = event.batch;
              if (batch === undefined) return;
              setRunning({
                unit: event.unit,
                target: event.target,
                mode,
                done: batch.position - 1,
                total: batch.total,
                bytesDone: batch.bytesDone,
                bytesTotal: batch.bytesTotal,
                startedAt,
                jobStartedAt: event.at,
                filesSeen: 0,
                ...(event.unitSize.files === undefined ? {} : { filesTotal: event.unitSize.files }),
                unitBytes: event.unitSize.bytes,
                ...(event.priorDurationMs === undefined ? {} : { priorMs: event.priorDurationMs }),
              });
            } else if (event.type === "job.progress-observed" && event.filesSeen !== undefined) {
              // The engine reports every observation; Ink renders at a lower
              // cadence so a large folder cannot make React the bottleneck.
              if (event.filesSeen % 25 === 0) {
                const filesSeen = event.filesSeen;
                setRunning((current) => (current === null ? null : { ...current, filesSeen }));
              }
            } else if (event.type === "job.failed") {
              setBusy(`${event.unit} → ${event.target}: failed — ${event.message}`);
            }
          },
          // Publish after each durable record so the ledger fills in while a
          // batch runs, preserving the old hook's visible behaviour.
          onState: (state) => {
            facts.setState(state);
            facts.setNow(Date.now());
          },
        },
      );
    } finally {
      clearInterval(heartbeat);
      ownership.lease.release();
    }
    setRunning(null);
    if (result.status === "cancelled") return;
    // A check can change what is at the target, and the source may have moved
    // under us while it ran, so both facts are re-read once at the end.
    facts.refresh();
    setBusy(
      presentCheckOutcome({
        mode,
        scope,
        ...(chosen[0] === undefined ? {} : { selectedUnit: chosen[0].status.unit }),
        selectedFolders: chosen.length,
        total: result.total,
        ran: result.ran,
        failed: result.failed,
        skipped: result.skipped,
      }).summary,
    );
    facts.setNow(Date.now());
    // A skip needs longer on screen than a success: it is the message the
    // user has to read and act on.
    timers.later(
      () => setBusy(null),
      result.failed.length > 0 || result.skipped.length > 0 ? 8000 : 2500,
    );
  };

  return { running, busy, runCheck };
}
