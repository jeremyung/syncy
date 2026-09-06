import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { recheckAfterSync } from "../check-runner.ts";
import type { Config, Target } from "../config.ts";
import { bytes, count } from "../format.ts";
import { acquireJobOwner, type JobOwnerLease } from "../job-owner.ts";
import { PARTIAL_DIR } from "../rsync.ts";
import { loadState } from "../state.ts";
import { type SyncHandle, type SyncResult, startSync } from "../sync.ts";
import { padEnd, truncate, truncatePath } from "../width.ts";
import { Rule, Screen } from "./Screen.tsx";
import type { Theme } from "./theme.ts";

/**
 * The running job (DESIGN.md section 6).
 *
 * Log lines are batched and committed at ~20fps rather than per line: Ink
 * re-renders and diffs the whole frame, and a fast rsync stream would otherwise
 * make the render loop the bottleneck. Motion is confined to one line.
 */

const FLUSH_MS = 50;

/** How long a refused keypress stays on screen, matching App.tsx's notice. */
const NOTICE_MS = 3000;

export interface JobProps {
  readonly config: Config;
  readonly unit: string;
  readonly target: Target;
  readonly nChanges: number;
  readonly bytesPending: number;
  readonly needsChecksum?: boolean;
  readonly theme: Theme;
  readonly width: number;
  readonly height?: number;
  readonly onDone: (result: SyncResult) => void;
  readonly onClose: () => void;
  /** Not used by the app; lets tests point this screen at a controllable stand-in for rsync. */
  readonly bin?: string;
}

export function Job(props: JobProps): React.ReactElement {
  const { config, unit, target, theme, width, height } = props;
  const [lines, setLines] = useState<string[]>([]);
  const [done, setDone] = useState<SyncResult | null>(null);
  // Set on the first ctrl-c so the footer can say a second press is what
  // quits — App.tsx eats that first press too and lets this screen act on
  // it alone; a discoverable "again to quit" beats the user having to guess.
  const [cancelling, setCancelling] = useState(false);
  const [started] = useState(() => Date.now());
  const [elapsed, setElapsed] = useState(0);
  const handle = useRef<SyncHandle | null>(null);
  const pending = useRef<string[]>([]);

  /**
   * The quick check that runs when the transfer succeeds, and what it found.
   *
   * The transfer itself records nothing the ledger reads, so without this the
   * screen would return to a row still claiming the files it just copied are
   * not copied. `checked` is what the check concluded, or null when it did not
   * run — cancelled, failed, or refused for an unreachable destination.
   */
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState<{ outcome: string; nChanges: number } | null>(null);
  const recheck = useRef<AbortController | null>(null);

  /**
   * A keypress refused rather than acted on, so the refusal is visible instead
   * of silent — the same vocabulary App.tsx's ledger uses for a refused key.
   */
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showNotice = useCallback((text: string) => {
    if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
    setNotice(text);
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);
  useEffect(
    () => () => {
      if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
    },
    [],
  );

  // The log pane grows with the window rather than being capped at six lines.
  const tail = Math.max(4, (height ?? 24) - 14);

  // The transfer's state (start, done, the flush timer) lives in this
  // component's closure: depending on it would re-run this effect on every
  // parent render, tearing down and rebuilding the flush and ticker intervals
  // of a transfer that is already in flight. The job page owns the keyboard
  // while it is up, so nothing that changes the sync can change mid-run.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above.
  useEffect(() => {
    let live = true;
    let ownerHeartbeat: ReturnType<typeof setInterval> | null = null;
    const ownership = acquireJobOwner("cli", "sync");

    // The batch: lines accumulate in a ref and are committed on a timer, so a
    // fast stream cannot drive one React render per line.
    const flush = setInterval(() => {
      if (!live || pending.current.length === 0) return;
      const batch = pending.current.splice(0);
      setLines((prev) => [...prev, ...batch].slice(-tail));
    }, FLUSH_MS);
    const ticker = setInterval(() => {
      if (live) setElapsed(Date.now() - started);
    }, 500);

    try {
      if (!ownership.acquired) {
        const message = ownership.owner
          ? `${ownership.owner.actor} ${ownership.owner.operation} is already running`
          : "another Syncy process is starting";
        setDone({ exitCode: null, cancelled: false, transferred: 0, stderr: message });
        return () => {
          live = false;
          clearInterval(flush);
          clearInterval(ticker);
        };
      }
      const jobId = `${started}-${unit}-${target.name}`;
      const base = {
        protocolVersion: 1,
        jobId,
        operation: "sync",
        unit,
        target: target.name,
      } as const;
      ownership.lease.observe({
        ...base,
        type: "job.started",
        at: started,
        phase: "queued",
        unitSize: { files: props.nChanges, bytes: props.bytesPending },
      });
      ownership.lease.observe({
        ...base,
        type: "job.phase-changed",
        at: Date.now(),
        phase: "transferring",
      });

      /**
       * The trailing quick check, run under the sync's own lease.
       *
       * Reads state from disk rather than from a prop: the transfer may have
       * taken hours, and the copy of state this screen mounted with is the one
       * that still says these files are missing.
       */
      const runRecheck = async (lease: JobOwnerLease): Promise<void> => {
        const abort = new AbortController();
        recheck.current = abort;
        setChecking(true);
        try {
          await recheckAfterSync(config, loadState(), unit, target.name, {
            signal: abort.signal,
            onEvent: (event) => {
              lease.observe(event);
              if (event.type === "job.completed" && "outcome" in event.result) {
                setChecked({ outcome: event.result.outcome, nChanges: event.result.nChanges });
              }
            },
          });
        } catch {
          // A check that will not run is not a reason to lose the transfer's
          // own outcome. The footer says the row is unchecked, which is true.
        } finally {
          recheck.current = null;
          if (live) setChecking(false);
        }
      };

      let seen = 0;
      const h = startSync(config, unit, target, {
        onLine: (line) => pending.current.push(line),
        onItem: (item) => {
          if (item.kind !== "change" || item.flags[1] !== "f") return;
          seen += 1;
          if (seen % 25 === 0 || seen === props.nChanges) {
            ownership.lease.observe({
              ...base,
              type: "job.progress-observed",
              at: Date.now(),
              filesSeen: seen,
            });
          }
        },
        ...(props.needsChecksum === true ? { checksum: true } : {}),
        ...(props.bin !== undefined ? { bin: props.bin } : {}),
      });
      handle.current = h;
      ownerHeartbeat = setInterval(() => {
        try {
          ownership.lease.heartbeat();
        } catch {
          h.cancel();
        }
      }, 10_000);
      h.done
        .then(async (r) => {
          ownership.lease.observe(
            r.cancelled
              ? { ...base, type: "job.cancelled", at: Date.now(), transferred: r.transferred }
              : r.exitCode === 0
                ? {
                    ...base,
                    type: "job.completed",
                    at: Date.now(),
                    result: { exitCode: r.exitCode, transferred: r.transferred },
                  }
                : {
                    ...base,
                    type: "job.failed",
                    at: Date.now(),
                    message: r.stderr || `rsync exited ${String(r.exitCode)}`,
                    exitCode: r.exitCode,
                  },
          );
          // Before the lease is released and before the parent re-reads state,
          // so the ledger it returns to is reading the check's record rather
          // than the pre-sync one it would otherwise still be rendering. The
          // heartbeat keeps running: a quick check over a large folder easily
          // outlasts the 30s staleness window, and a lease that expired here
          // would let a second job start against a tree this one is reading.
          if (live && !r.cancelled && (r.exitCode === 0 || r.exitCode === 24)) {
            await runRecheck(ownership.lease);
          }
          if (ownerHeartbeat !== null) clearInterval(ownerHeartbeat);
          ownership.lease.release();
          if (!live) return;
          setLines((prev) => [...prev, ...pending.current.splice(0)].slice(-tail));
          setDone(r);
          props.onDone(r);
        })
        .catch((e: unknown) => {
          if (ownerHeartbeat !== null) clearInterval(ownerHeartbeat);
          ownership.lease.observe({
            ...base,
            type: "job.failed",
            at: Date.now(),
            message: String(e),
            exitCode: null,
          });
          ownership.lease.release();
          // Explicit catch at the subprocess boundary; a swallowed rejection
          // would leave the view claiming a transfer is still running.
          if (live) {
            setDone({ exitCode: null, cancelled: false, transferred: 0, stderr: String(e) });
          }
        });
    } catch (e) {
      if (ownership.acquired) {
        if (ownerHeartbeat !== null) clearInterval(ownerHeartbeat);
        ownership.lease.release();
      }
      setDone({ exitCode: null, cancelled: false, transferred: 0, stderr: String(e) });
    }

    return () => {
      live = false;
      clearInterval(flush);
      clearInterval(ticker);
      if (ownerHeartbeat !== null) clearInterval(ownerHeartbeat);
      // The check outlives the screen otherwise: it is a plain async call with
      // no tie to React's lifecycle, the same way the transfer queue was.
      recheck.current?.abort();
    };
  }, [config, unit, target.name, tail, props.bin]);

  useInput((input, key) => {
    if (done !== null) {
      if (key.escape || key.return || input === "q") props.onClose();
      return;
    }
    if (key.ctrl && input === "c") {
      setCancelling(true);
      handle.current?.cancel();
      // Once the transfer is done the handle is inert, and the thing still
      // running is the check. Cancelling it costs only the evidence: the bytes
      // are already copied, and the row stays on its pre-sync record until
      // something checks — which is what the footer then says.
      recheck.current?.abort();
      return;
    }
    // esc used to close this screen while a transfer was in flight: the
    // screen unmounted, `live` went false, and the rsync child kept writing to
    // the destination with nothing attached to it — onDone never fired
    // because it is guarded on `live`, and App.tsx unlocked [s]/[q] as soon as
    // the screen closed, so a second sync could start against the same tree
    // the first one was still writing to. esc is a reflex key; refuse out
    // loud instead of cancelling a long transfer by reflex.
    if (key.escape) showNotice("[esc] ignored — [ctrl-c] cancels this transfer");
  });

  const W = width;
  const secs = Math.floor(elapsed / 1000);
  const clock = `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s`;

  const footer =
    done === null ? (
      <Box flexDirection="column">
        <Rule width={W} theme={theme} />
        <Text color={theme.unverified}>
          {cancelling
            ? "  cancelling… · [ctrl-c] again to quit"
            : checking
              ? "  copied · checking what landed · [ctrl-c] skip the check"
              : "  running · [ctrl-c] cancel"}
        </Text>
        {notice == null ? null : (
          <Text color={theme.missing}>{"  " + truncate(notice, W - 2)}</Text>
        )}
      </Box>
    ) : (
      <Box flexDirection="column">
        <Rule width={W} theme={theme} />
        <Text
          color={
            done.cancelled ? theme.unverified : done.exitCode === 0 ? theme.verified : theme.missing
          }
        >
          {done.cancelled
            ? // --partial-dir quarantines the fragment out of the archive's
              // namespace instead of leaving it at its final name (see the
              // comment at src/rsync.ts:~98) so rsync can resume it — it is
              // kept, not discarded, and saying "nothing partial was left
              // behind" tells a user who later finds .syncy-partial that it
              // should not exist.
              `  cancelled after ${count(done.transferred)} files — any part-transferred file is held in ${PARTIAL_DIR}, not at its final name`
            : done.exitCode === 0
              ? `  done · ${count(done.transferred)} files transferred`
              : `  failed · exit ${String(done.exitCode)}`}
        </Text>
        {done.stderr !== "" ? (
          <Text color={theme.missing}>
            {"  " + truncate(done.stderr.split("\n")[0] ?? "", W - 2)}
          </Text>
        ) : null}
        <Text> </Text>
        <Text color={theme.dim}>{"  " + truncate(afterword(checked), W - 2)}</Text>
        <Text color={theme.dim}>{"  [esc] back"}</Text>
      </Box>
    );

  return (
    <Screen
      title="syncy · sync"
      width={W}
      theme={theme}
      footer={footer}
      {...(height === undefined ? {} : { height })}
    >
      <Box>
        <Text color={theme.figure}>{"  " + unit}</Text>
        <Text color={theme.dim}>{"  →  "}</Text>
        <Text color={theme.figure}>{target.name}</Text>
      </Box>
      <Text color={theme.dim}>
        {`  elapsed ${clock} · ${count(props.nChanges)} files · ${bytes(props.bytesPending)} to move`}
      </Text>
      <Rule width={W} theme={theme} />

      {lines.length === 0 ? (
        <Text color={theme.dim}>{"  starting…"}</Text>
      ) : (
        lines.map((l, i) => (
          <Text key={`${i}-${l.slice(0, 12)}`} color={theme.dim}>
            {"  " + renderLine(l, W - 2)}
          </Text>
        ))
      )}
    </Screen>
  );
}

/**
 * What the ledger will say about this destination, in one line.
 *
 * The screen used to end on "press [d] to check the bytes" whatever had
 * happened, which was advice rather than a report — and read as the whole
 * story when in fact the row was about to go back to claiming the files had
 * never been copied. Each case below names the state the row is actually in.
 */
function afterword(
  checked: { readonly outcome: string; readonly nChanges: number } | null,
): string {
  if (checked === null) return "not checked · the ledger still shows its last check";
  if (checked.outcome === "clean") {
    return "present at the right size and date · [d] reads the bytes";
  }
  if (checked.outcome === "behind") {
    return `the check still finds ${count(checked.nChanges)} pending · [enter] for the differences`;
  }
  return "the check after the copy was not clean · [enter] for the differences";
}

/** Itemize lines arrive as `%i|%l|%n`; show the flags and the name. */
function renderLine(line: string, width: number): string {
  const parts = line.split("|");
  if (parts.length < 3) return truncate(line, width);
  const flags = parts[0]!.trim();
  const name = parts.slice(2).join("|");
  const size = Number.parseInt(parts[1]!, 10);
  const right = Number.isFinite(size) && size > 0 ? bytes(size) : "";
  const left = padEnd(flags, 12) + truncatePath(name, Math.max(10, width - 14 - right.length));
  return padEnd(left, width - right.length) + right;
}
