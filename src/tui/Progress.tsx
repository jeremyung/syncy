import { Box, Text } from "ink";
import { bytes } from "../format.ts";
import { truncate } from "../width.ts";
import type { Theme } from "./theme.ts";

/**
 * Progress for a run of checks.
 *
 * What rsync will tell you depends on the archive, and this was measured rather
 * than assumed — twice, because the first measurement was wrong.
 *
 *   quick, 12 gb                every itemize line at 0.0s; the run is 0.03s
 *   deep, 40,000 tiny files     lines spread evenly across the run
 *   deep, 40 large files        every line in the final fifth
 *
 * Under `--checksum` rsync reads whole files, and nothing is reported until
 * that work is done. On a 13 gb archive of 14 mb photos over SMB, that means no
 * output at all for the twelve minutes the check takes — verified against a
 * real NAS, including with `--outbuf=L`, which rules out buffering.
 *
 * So a file counter cannot be relied on. It is shown when lines are genuinely
 * arriving and replaced when they are not, rather than sitting at `0/935` for
 * twelve minutes telling the user their machine has hung. The bar is measured
 * against the previous run of the same check, which is the only honest number
 * available when rsync itself is silent.
 */

export interface RunProgress {
  readonly unit: string;
  readonly target: string;
  readonly mode: "quick" | "deep";
  readonly done: number;
  readonly total: number;
  readonly bytesDone: number;
  readonly bytesTotal: number;
  /** When this run of checks began — the whole batch, not this one folder. */
  readonly startedAt: number;
  /**
   * When THIS job began.
   *
   * Distinct from `startedAt` on purpose: `priorMs` estimates one folder, and
   * measuring it against how long the whole run has been going pinned the bar
   * near 100% from partway through the second folder onward (see the doc
   * comment on `barFraction`). This is what the estimate is actually for.
   */
  readonly jobStartedAt: number;
  /** Files rsync has reported finishing. Often stays 0 for a whole deep run. */
  readonly filesSeen?: number;
  readonly filesTotal?: number;
  /** Bytes in the folder being checked, which a deep check reads in full. */
  readonly unitBytes?: number;
  /** How long this same check took last time, if it has ever run. */
  readonly priorMs?: number;
}

export interface ProgressProps {
  readonly progress: RunProgress;
  /**
   * A key that was pressed and refused, shown beneath the bar.
   *
   * `busy` cannot carry this: while a check runs, this component occupies the
   * line `busy` would otherwise print on, so a message set there is invisible
   * exactly when it is needed.
   */
  readonly notice?: string | null;
  readonly now: number;
  readonly width: number;
  readonly theme: Theme;
}

export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

/** Seconds before a silent check starts explaining itself. */
const QUIET_GRACE_MS = 4000;

/**
 * How full the bar is, and whether that is a measurement or an estimate.
 *
 * Preferring the previous duration over completed-folder bytes matters most in
 * the single-folder case, where the byte fraction is 0% for the entire run and
 * then 100% — which is not progress, it is a light that turns on at the end.
 *
 * MEASURED, before the blend below existed: `priorMs` estimates one job, but
 * this was comparing it against `now - startedAt` — elapsed time for the
 * *whole run*. Five folders, each ~60s and each estimated at 60s: 10s into
 * folder 1 read 17%, 50s into folder 1 read 83%, then 10s into folder 2 read
 * 99% — because 70s of run time against a 60s estimate is already past
 * 100%, capped. Every folder from the second one on read 99% for its entire
 * duration; a bar frozen near full for most of an hour is the same complaint
 * as one frozen at zero. The fix blends what has actually completed
 * (`bytesDone`, real across the whole run) with how far the *current* job has
 * gotten against its own estimate (`jobStartedAt`, not `startedAt`).
 */
export function barFraction(p: RunProgress, now: number): {
  readonly fraction: number;
  readonly estimated: boolean;
  /**
   * False when there is nothing honest to draw.
   *
   * A single folder with no timing sample yet has a fraction of 0 until it has
   * one of 1 — a bar that sits empty for twelve minutes and then fills. That is
   * indistinguishable from a hung program, which is the complaint this whole
   * line exists to answer, so it is not drawn at all.
   */
  readonly drawable: boolean;
} {
  if (p.priorMs !== undefined && p.priorMs > 0) {
    // How far the current job alone has gotten against its own estimate.
    const inJob = Math.min(1, (now - p.jobStartedAt) / p.priorMs);
    // Blended with the bytes other jobs in this run have actually finished,
    // so the bar reflects the whole run rather than repeating one folder's
    // progress five times. bytesTotal <= 0 has nothing to divide by — one
    // folder's own fraction is the only thing left to show.
    const fraction =
      p.bytesTotal > 0 ? (p.bytesDone + inJob * (p.unitBytes ?? 0)) / p.bytesTotal : inJob;
    // Capped just short of full: claiming 100% while it is still running is the
    // one thing a progress bar must never do.
    return {
      fraction: Math.min(0.99, fraction),
      estimated: true,
      drawable: true,
    };
  }
  // Without a timing sample the only real signal is folders completing, which
  // needs more than one folder to say anything.
  const drawable = p.total > 1;
  if (p.bytesTotal > 0) {
    return { fraction: p.bytesDone / p.bytesTotal, estimated: false, drawable };
  }
  return { fraction: p.done / Math.max(1, p.total), estimated: false, drawable };
}

/**
 * The right-hand detail: a file count when rsync is actually reporting one,
 * and an explanation when it is not.
 */
export function detailLine(p: RunProgress, now: number): string {
  const elapsed = now - p.startedAt;
  const seen = p.filesSeen ?? 0;
  if (seen > 0 && p.filesTotal !== undefined && p.filesTotal > 0) {
    return `${seen}/${p.filesTotal} files · ${clock(elapsed)}`;
  }
  if (elapsed < QUIET_GRACE_MS) return clock(elapsed);
  const reading =
    p.mode === "deep" && p.unitBytes !== undefined && p.unitBytes > 0
      ? `reading ${bytes(p.unitBytes)} · `
      : "";
  // Three cases, and the line must not contradict what is drawn above it.
  // With a timing sample, name the expected total. With a folder-count bar but
  // no sample, say nothing — the bar already carries it. With no bar at all,
  // say why, and that syncy is measuring this run so the next one has one.
  const eta =
    p.priorMs !== undefined && p.priorMs > 0
      ? ` of ~${clock(p.priorMs)}`
      : barFraction(p, now).drawable
        ? ""
        : " · no estimate yet, timing this run";
  return `${reading}${clock(elapsed)}${eta}`;
}

/**
 * How many lines this component will occupy, for the ledger's line budget.
 *
 * Exported rather than assumed: the ledger hard-coded 2, and the bar is now
 * omitted when there is nothing honest to draw, so the two would drift apart
 * and the ledger would over-budget by a row.
 */
export function progressLines(p: RunProgress, now: number, hasNotice: boolean): number {
  return (barFraction(p, now).drawable ? 1 : 0) + 1 + (hasNotice ? 1 : 0);
}

export function Progress({ progress, now, width, theme, notice }: ProgressProps): React.ReactElement {
  const { fraction, estimated, drawable } = barFraction(progress, now);

  const barWidth = Math.max(10, width - 22);
  const filled = Math.min(barWidth, Math.max(0, Math.round(fraction * barWidth)));
  const bar = "━".repeat(filled) + "─".repeat(barWidth - filled);
  // A tilde marks the estimate, so a bar derived from last time's duration is
  // never mistaken for a count of work actually completed.
  const pct = `${estimated ? "~" : ""}${Math.round(fraction * 100)}%`.padStart(5);

  return (
    <Box flexDirection="column">
      {drawable ? (
        <Box>
          <Text color={theme.unverified}>{"  " + bar}</Text>
          <Text color={theme.figure}>{" " + pct}</Text>
        </Box>
      ) : null}
      <Box>
        <Text color={theme.unverified}>{`  ${progress.mode} `}</Text>
        <Text color={theme.figure}>{truncate(progress.unit, Math.max(8, width - 52))}</Text>
        <Text color={theme.dim}>{` → ${truncate(progress.target, 10)}`}</Text>
        <Text color={theme.dim}>
          {`  ${progress.done + 1}/${progress.total} · ${detailLine(progress, now)}`}
        </Text>
      </Box>
      {notice == null ? null : (
        <Text color={theme.missing}>{"  " + truncate(notice, width - 2)}</Text>
      )}
    </Box>
  );
}
