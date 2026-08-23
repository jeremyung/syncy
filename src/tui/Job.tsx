import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Config, Target } from "../config.ts";
import { bytes, count } from "../format.ts";
import { PARTIAL_DIR } from "../rsync.ts";
import { startSync, type SyncHandle, type SyncResult } from "../sync.ts";
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
  const [started] = useState(() => Date.now());
  const [elapsed, setElapsed] = useState(0);
  const handle = useRef<SyncHandle | null>(null);
  const pending = useRef<string[]>([]);

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
  useEffect(() => () => {
    if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
  }, []);

  // The log pane grows with the window rather than being capped at six lines.
  const tail = Math.max(4, (height ?? 24) - 14);

  useEffect(() => {
    let live = true;

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
      const h = startSync(config, unit, target, {
        onLine: (line) => pending.current.push(line),
        ...(props.needsChecksum === true ? { checksum: true } : {}),
        ...(props.bin !== undefined ? { bin: props.bin } : {}),
      });
      handle.current = h;
      h.done
        .then((r) => {
          if (!live) return;
          setLines((prev) => [...prev, ...pending.current.splice(0)].slice(-tail));
          setDone(r);
          props.onDone(r);
        })
        .catch((e: unknown) => {
          // Explicit catch at the subprocess boundary; a swallowed rejection
          // would leave the view claiming a transfer is still running.
          if (live) {
            setDone({ exitCode: null, cancelled: false, transferred: 0, stderr: String(e) });
          }
        });
    } catch (e) {
      setDone({ exitCode: null, cancelled: false, transferred: 0, stderr: String(e) });
    }

    return () => {
      live = false;
      clearInterval(flush);
      clearInterval(ticker);
    };
  }, [config, unit, target.name, tail, props.bin]);

  useInput((input, key) => {
    if (done !== null) {
      if (key.escape || key.return || input === "q") props.onClose();
      return;
    }
    if (key.ctrl && input === "c") handle.current?.cancel();
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
        <Text color={theme.unverified}>{"  running · [ctrl-c] cancel"}</Text>
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
          <Text color={theme.missing}>{"  " + truncate(done.stderr.split("\n")[0] ?? "", W - 2)}</Text>
        ) : null}
        <Text> </Text>
        <Text color={theme.dim}>
          {"  copying is not verifying — press [d] on the ledger to check the bytes"}
        </Text>
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
