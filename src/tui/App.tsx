import { join } from "node:path";
import { Box, Text, useApp, useStdout } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { copyToClipboard } from "../clipboard.ts";
import type { Config } from "../config.ts";
import { type Diff, loadDiff } from "../diff.ts";
import { EMPTY as EMPTY_FINGERPRINT, type Fingerprint, fingerprint } from "../fingerprint.ts";
import { bytes } from "../format.ts";
import { timed, timedAsync } from "../log.ts";
import { allReachability, listUnits, type Reachability } from "../scan.ts";
import { lastSyncAt, loadState, type State } from "../state.ts";
import { type CellState, evaluateUnit, type UnitState } from "../status.ts";
import { setTitle, titleFor } from "../title.ts";
import { padEnd, truncatePath } from "../width.ts";
import { Confirm } from "./Confirm.tsx";
import { Diff as DiffScreen } from "./Diff.tsx";
import { Job } from "./Job.tsx";
import { Ledger, type Row } from "./Ledger.tsx";
import { Mark } from "./Mark.tsx";
import { Plan } from "./Plan.tsx";
import { barFraction } from "./Progress.tsx";
import { Rule, Screen } from "./Screen.tsx";
import { Setup } from "./Setup.tsx";
import { cellToken, resolveTheme } from "./theme.ts";
import { useJob } from "./useJob.ts";
import { useKeys } from "./useKeys.ts";
import { useScreen } from "./useScreen.ts";
import { useTimers } from "./useTimers.ts";

/**
 * The ledger: screens, selection and the composition of what each key does.
 *
 * The work is not here. Running a check — the job list, its byte-based bar,
 * the per-destination skips, the state and history writes — lives in useJob,
 * and the keyboard decision, which screen owns it right now, lives in useKeys.
 * What remains is the state the screens share and the render: selection,
 * filters, the overlay screens, the window title.
 */

const FILTERS: ReadonlyArray<UnitState | "all"> = [
  "all",
  "verified",
  "unverified",
  "behind",
  "missing",
  "unchecked",
];

export interface AppProps {
  readonly config: Config;
  /** Not used by the app; lets tests point the job screen at a controllable stand-in for rsync. */
  readonly bin?: string;
}

/** How long a refused keypress stays on screen. */
const NOTICE_MS = 3000;

export function App({ config: initialConfig, bin }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const theme = useMemo(() => resolveTheme(), []);

  const [config, setConfig] = useState<Config>(initialConfig);
  const [state, setState] = useState<State>(() => loadState());
  // Recomputed rather than held, since the setup screen can change the source.
  const units = useMemo(
    () => (config.source === "" ? [] : listUnits(config.source)),
    [config.source],
  );
  const [selected, setSelected] = useState(0);
  const [filter, setFilter] = useState(0);
  const [showHelp, setShowHelp] = useState(false);
  const [showEvidence, setShowEvidence] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  /**
   * A keypress that was refused, and why.
   *
   * Only one rsync runs at a time, and every key that would start another was
   * dropped in silence — no message, no queue, no sign the key was seen. That
   * is the same failure as a counter frozen at zero: the interface knows
   * something the person watching it does not.
   */
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timers = useTimers();

  /** Shows a refusal for a few seconds, replacing any refusal already up. */
  const showNotice = useCallback(
    (text: string) => {
      if (noticeTimer.current !== null) timers.cancel(noticeTimer.current);
      setNotice(text);
      noticeTimer.current = timers.later(() => setNotice(null), NOTICE_MS);
    },
    [timers],
  );
  const [showPlan, setShowPlan] = useState(false);
  // Open straight into setup when there is nothing to show yet.
  const [showSetup, setShowSetup] = useState(() => initialConfig.targets.length === 0);
  // A sync moves through confirm -> job. Neither can be entered by accident:
  // `s` opens the confirm page, and only [enter] there starts a transfer.
  const [pendingSync, setPendingSync] = useState<{ unit: string; target: string } | null>(null);
  const [runningSync, setRunningSync] = useState<{ unit: string; target: string } | null>(null);
  /**
   * ctrl-c presses seen while a transfer is running.
   *
   * Ink calls every mounted useInput handler, so App and Job both see every
   * ctrl-c. Job's handler cancels rsync; this one used to exit unconditionally,
   * which meant the app quit the instant a transfer was cancelled — before
   * Job's own screen could render the outcome or its [esc] back. The first
   * press while a transfer is running is left to Job; only a second press
   * exits, so a transfer that ignores SIGTERM can never trap the user. Reset
   * once the job screen closes, so the next transfer starts counting fresh.
   */
  const ctrlCPresses = useRef(0);
  useEffect(() => {
    if (runningSync === null) ctrlCPresses.current = 0;
  }, [runningSync]);
  const [now, setNow] = useState(() => Date.now());
  const [frame, setFrame] = useState(0);
  // The plan's copy feedback lands on the ledger's busy line, like everything
  // else the ledger says. Merged rather than nested: the plan screen is up
  // while the copy happens, and the line is what is read after [esc].
  const [planStatus, setPlanStatus] = useState<string | null>(null);

  const screen = useScreen(stdout);
  const width = screen.width;

  /**
   * Fingerprints and reachability, cached.
   *
   * Both are expensive and both used to sit on the render path: fingerprinting
   * walks the whole source (measured at 645 ms for ~18k files), and
   * reachability reads a sentinel over the network. With a ticker moving `now`
   * every 500 ms during a check, the interface spent more than all of its time
   * re-walking the disk and never got round to drawing — which looked exactly
   * like a hang.
   *
   * They are recomputed when something could actually have changed them: on
   * open, on [r], and when a run of checks finishes.
   */
  const [scan, setScan] = useState<{
    readonly fingerprints: ReadonlyMap<string, Fingerprint>;
    readonly reach: ReadonlyMap<string, Reachability>;
  } | null>(null);

  const refresh = useCallback(() => {
    if (config.source === "") {
      setScan({ fingerprints: new Map(), reach: new Map() });
      return;
    }
    const fingerprints = new Map<string, Fingerprint>();
    timed("refresh.fingerprints", 250, () => {
      for (const unit of units) {
        fingerprints.set(unit, fingerprint(join(config.source, unit), config.exclude));
      }
    });
    // Reachability may spawn a process (diskutil, mount), so it is awaited off
    // the render path rather than blocking a frame.
    void timedAsync("refresh.reachability", 250, () => allReachability(config)).then((reach) =>
      setScan({ fingerprints, reach }),
    );
    setNow(Date.now());
  }, [units, config]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const allRows: Row[] = useMemo(() => {
    if (config.source === "" || config.targets.length === 0 || scan === null) return [];
    return units.map((unit) => {
      const fp = scan.fingerprints.get(unit) ?? EMPTY_FINGERPRINT;
      return {
        status: evaluateUnit(config, state, { unit, fingerprint: fp, sentinels: scan.reach }, now),
        size: fp.bytes,
        files: fp.nfiles,
      };
    });
  }, [units, config, state, now, scan]);

  const active = FILTERS[filter] ?? "all";
  const rows = active === "all" ? allRows : allRows.filter((r) => r.status.state === active);
  const clampedSelection = Math.min(selected, Math.max(0, rows.length - 1));

  const job = useJob({
    config,
    rows,
    clampedSelection,
    state,
    scan,
    refresh,
    notify: showNotice,
    setNow,
    setState,
  });
  const { running, busy, runCheck } = job;

  // While a run is in flight the elapsed time has to keep moving, or the
  // interface looks frozen even though work is happening.
  useEffect(() => {
    if (running === null) return;
    const clock = setInterval(() => setNow(Date.now()), 500);
    // Faster than the clock, so the forklift reads as motion. Costs nothing
    // when idle because the interval only exists while something runs.
    const anim = setInterval(() => setFrame((f) => f + 1), 220);
    return () => {
      clearInterval(clock);
      clearInterval(anim);
    };
  }, [running]);

  /**
   * Keep the window title current.
   *
   * A deep verify runs for tens of minutes and syncy owns the whole viewport,
   * so the tab strip is the only place it can report to someone working in
   * another window. Driven off `running` and the `now` ticker, so the
   * percentage advances with the bar rather than only when a folder finishes.
   */
  useEffect(() => {
    if (running === null) {
      const verified = allRows.filter((r) => r.status.state === "verified").length;
      setTitle(titleFor({ folders: allRows.length, verified }));
      return;
    }
    const { fraction, drawable } = barFraction(running, now);
    setTitle(
      titleFor({
        running: {
          mode: running.mode,
          unit: running.unit,
          percent: drawable ? fraction : null,
        },
      }),
    );
  }, [running, now, allRows]);

  // Read only while the differences screen is open, and re-read whenever a
  // check finishes, so it never shows a listing older than the record above it.
  // `state` is an intentional invalidation trigger: it changes exactly when a
  // check finishes writing a new diff, and the memo body reads the diff files
  // rather than state itself.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above.
  const diffs: ReadonlyMap<string, Diff | null> = useMemo(() => {
    const unit = rows[clampedSelection]?.status.unit;
    if (!showDiff || unit === undefined) return new Map<string, Diff | null>();
    return new Map(config.targets.map((t) => [t.name, loadDiff(unit, t.name)]));
  }, [showDiff, rows, clampedSelection, config.targets, state]);

  // Read on the same terms as the diffs themselves: the differences screen is
  // the only thing that asks when a sync last landed, and it has to be the
  // sync that just finished rather than the one recorded when the app opened.
  // The same terms as the diffs memo above: `state` is an invalidation
  // trigger, and the body reads the history rather than state itself.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above.
  const lastSync: ReadonlyMap<string, number | null> = useMemo(() => {
    const unit = rows[clampedSelection]?.status.unit;
    if (!showDiff || unit === undefined) return new Map<string, number | null>();
    return new Map(config.targets.map((t) => [t.name, lastSyncAt(unit, t.name)]));
  }, [showDiff, rows, clampedSelection, config.targets, state]);

  useKeys(
    showHelp
      ? "help"
      : showEvidence
        ? "evidence"
        : showDiff || showPlan || showSetup || pendingSync !== null || runningSync !== null
          ? "inert"
          : "ledger",
    {
      controlC: () => {
        // While a transfer is running, the first press is Job's to act on: let
        // it cancel and render the outcome instead of the app vanishing under
        // it. A second press exits regardless of what the transfer is doing.
        if (runningSync !== null) {
          ctrlCPresses.current += 1;
          if (ctrlCPresses.current < 2) return;
        }
        exit();
      },
      closeHelp: () => setShowHelp(false),
      closeEvidence: () => setShowEvidence(false),
      ledger: {
        up: () => setSelected((s) => Math.max(0, s - 1)),
        down: () => setSelected((s) => Math.min(rows.length - 1, s + 1)),
        quick: () => void runCheck("quick", "selected"),
        quickAll: () => void runCheck("quick", "all"),
        deep: () => void runCheck("deep", "selected"),
        deepAll: () => void runCheck("deep", "all"),
        refresh,
        cycleFilter: () => {
          setFilter((f) => (f + 1) % FILTERS.length);
          setSelected(0);
        },
        evidence: () => setShowEvidence(true),
        openDiff: () => {
          // Only open it when there is a row, or the keyboard guard in
          // useKeys would swallow every key with nothing on screen.
          if (rows[clampedSelection] !== undefined) setShowDiff(true);
        },
        openPlan: () => {
          // Only open it when there is a folder to describe, or the keyboard
          // guard in useKeys would swallow every key with nothing on screen.
          if (rows[clampedSelection] !== undefined) setShowPlan(true);
        },
        startSync: () => {
          // Offer the target that is furthest behind; there is nothing to sync
          // to a target that is already clean.
          // A sync writes; starting one while a check is reading the same tree
          // would have the two disagree about what is there.
          if (running !== null) {
            showNotice(
              `[s] ignored — the ${running.mode} check on ${running.unit} is still running`,
            );
            return;
          }
          const row = rows[clampedSelection];
          const cell = row?.status.cells.find((c) => c.state === "behind" || c.state === "missing");
          if (row !== undefined && cell !== undefined) {
            setPendingSync({ unit: row.status.unit, target: cell.target });
          }
        },
        setup: () => setShowSetup(true),
        help: () => setShowHelp(true),
      },
    },
  );

  const syncing = pendingSync ?? runningSync;
  const syncRow =
    syncing === null ? undefined : allRows.find((r) => r.status.unit === syncing.unit);
  const syncTarget =
    syncing === null ? undefined : config.targets.find((t) => t.name === syncing.target);
  const syncCell = syncRow?.status.cells.find((c) => c.target === syncing?.target);

  if (pendingSync !== null && syncRow !== undefined && syncTarget !== undefined) {
    return (
      <Confirm
        config={config}
        unit={pendingSync.unit}
        target={syncTarget}
        nChanges={syncCell?.nChanges ?? 0}
        {...(syncCell?.nNew === undefined ? {} : { nNew: syncCell.nNew })}
        nExtra={syncCell?.nExtra ?? 0}
        bytesPending={syncCell?.bytesPending ?? 0}
        {...(syncCell?.needsChecksum === true ? { needsChecksum: true } : {})}
        theme={theme}
        width={width}
        height={screen.rows}
        onRun={() => {
          setRunningSync(pendingSync);
          setPendingSync(null);
        }}
        onCancel={() => setPendingSync(null)}
      />
    );
  }

  if (runningSync !== null && syncRow !== undefined && syncTarget !== undefined) {
    return (
      <Job
        config={config}
        unit={runningSync.unit}
        target={syncTarget}
        nChanges={syncCell?.nChanges ?? 0}
        bytesPending={syncCell?.bytesPending ?? 0}
        {...(syncCell?.needsChecksum === true ? { needsChecksum: true } : {})}
        {...(bin !== undefined ? { bin } : {})}
        theme={theme}
        width={width}
        height={screen.rows}
        onDone={() => {
          // A transfer changes what is at the target, so every recorded scan
          // for it is now stale. Re-read state rather than assuming success.
          setState(loadState());
          setNow(Date.now());
          // Nothing is running any more, so ctrl-c has nothing to leave to the
          // job screen: arm it to exit on the very next press. Without this the
          // count is still 0 while the finished screen is up, so a ctrl-c there
          // would be swallowed and appear to do nothing — and that screen's
          // footer offers [esc], never mentioning a press was needed twice.
          ctrlCPresses.current = 1;
        }}
        onClose={() => {
          setRunningSync(null);
          setNow(Date.now());
        }}
      />
    );
  }

  if (showPlan) {
    const row = rows[clampedSelection];
    if (row !== undefined) {
      return (
        <Plan
          config={config}
          unit={row.status.unit}
          needsChecksum={
            new Set(row.status.cells.filter((c) => c.needsChecksum === true).map((c) => c.target))
          }
          theme={theme}
          width={width}
          height={screen.rows}
          onClose={() => setShowPlan(false)}
          onCopy={(text) => {
            // Copying is best-effort: a machine with no clipboard tool says so
            // rather than taking the app down.
            void copyToClipboard(text).then((message) => {
              setPlanStatus(message);
              timers.later(() => setPlanStatus(null), 1500);
            });
          }}
        />
      );
    }
  }

  // The first scan happens in an effect so the interface paints immediately;
  // on a large archive it takes about a second, and a blank table would read as
  // "no folders" rather than "still looking".
  if (scan === null && config.source !== "" && config.targets.length > 0) {
    return (
      <Screen title="syncy" width={width} height={screen.rows} theme={theme}>
        <Text color={theme.dim}>{`  reading ${config.source}…`}</Text>
      </Screen>
    );
  }

  if (showSetup) {
    return (
      <Setup
        config={config}
        theme={theme}
        width={width}
        height={screen.rows}
        onChange={(next) => {
          setConfig(next);
          setNow(Date.now());
        }}
        onExit={() => setShowSetup(false)}
      />
    );
  }
  if (showHelp)
    return (
      <Help
        theme={theme}
        width={width}
        height={screen.rows}
        config={config}
        units={units.length}
        states={
          new Map(
            config.targets.map((t) => [
              t.name,
              allRows[0]?.status.cells.find((c) => c.target === t.name)?.state ?? "unchecked",
            ]),
          )
        }
      />
    );
  if (showDiff) {
    const row = rows[clampedSelection];
    if (row !== undefined)
      return (
        <DiffScreen
          config={config}
          unit={row.status.unit}
          diffs={diffs}
          lastSync={lastSync}
          theme={theme}
          width={width}
          height={screen.rows}
          now={now}
          onClose={() => setShowDiff(false)}
        />
      );
  }
  if (showEvidence) {
    const row = rows[clampedSelection];
    if (row !== undefined)
      return (
        <Evidence
          row={row}
          config={config}
          state={state}
          theme={theme}
          now={now}
          width={width}
          height={screen.rows}
        />
      );
  }

  return (
    <Box flexDirection="column">
      {active !== "all" ? (
        <Text
          color={theme.unverified}
        >{`  filter: ${active} — ${rows.length} of ${allRows.length} units`}</Text>
      ) : null}
      <Ledger
        rows={rows}
        selected={clampedSelection}
        config={config}
        state={state}
        theme={theme}
        width={width}
        height={screen.rows - (active === "all" ? 0 : 1)}
        now={now}
        busy={planStatus ?? busy}
        running={running}
        frame={frame}
        notice={notice}
      />
    </Box>
  );
}

export function Help({
  theme,
  width,
  height,
  config,
  units,
  states,
}: {
  theme: ReturnType<typeof resolveTheme>;
  width: number;
  height: number;
  config: Config;
  units: number;
  states: ReadonlyMap<string, CellState>;
}): React.ReactElement {
  const line = (k: string, d: string): React.ReactElement => (
    <Box key={k}>
      <Text color={theme.figure}>{"  " + k.padEnd(12)}</Text>
      <Text color={theme.dim}>{d}</Text>
    </Box>
  );
  return (
    <Screen
      title="syncy · keys"
      width={width}
      height={height}
      theme={theme}
      footer={<Text color={theme.dim}>{"  press any key to return"}</Text>}
    >
      <Mark config={config} theme={theme} width={width} units={units} states={states} />
      <Text> </Text>
      {line("↑ ↓ / j k", "move between folders")}
      {line("q / Q", "quick check — this folder / all · size and date · writes nothing")}
      {line("d / D", "deep verify — this folder / all · checksums · writes nothing")}
      {line("s", "sync — copies what is missing · the only key that writes")}
      {line("p", "show the exact rsync command each of those runs")}
      {line("enter", "which files differ, per destination")}
      {line("e", "evidence for the selected folder")}
      {line("f", "cycle the status filter")}
      {line("r", "re-read the source, recompute sizes")}
      {line(",", "setup — source root and destinations")}
      {line("ctrl-c", "quit — during a transfer, the first press cancels it")}
      <Text> </Text>
      <Text color={theme.dim}>
        {"  syncy never deletes, and writes to no destination from this screen."}
      </Text>
    </Screen>
  );
}

interface EvidenceProps {
  readonly row: Row;
  readonly config: Config;
  readonly state: State;
  readonly theme: ReturnType<typeof resolveTheme>;
  readonly now: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The evidence view ends at the evidence. No recommendation, no command to
 * copy, nothing organised around deleting.
 */
export function Evidence({
  row,
  config,
  state,
  theme,
  width,
  height,
}: EvidenceProps): React.ReactElement {
  return (
    <Screen
      title="syncy · evidence"
      width={width}
      height={height}
      theme={theme}
      footer={<Text color={theme.dim}>{"  [esc] back"}</Text>}
    >
      <Box>
        <Text color={theme.figure}>{"  " + row.status.unit}</Text>
        <Text color={theme.dim}>{`   ${bytes(row.size)}`}</Text>
      </Box>
      <Rule width={width} theme={theme} />
      {config.targets.map((t) => {
        const deep = state.scans.find(
          (s) => s.unit === row.status.unit && s.target === t.name && s.method === "deep",
        );
        const quick = state.scans.find(
          (s) => s.unit === row.status.unit && s.target === t.name && s.method === "quick",
        );
        const cell = row.status.cells.find((c) => c.target === t.name);
        return (
          <Box key={t.name} flexDirection="column">
            <Box>
              <Text color={theme.figure}>{"  " + padEnd(t.name, 10)}</Text>
              <Text color={theme[cell === undefined ? "unchecked" : cellToken(cell.state)]}>
                {padEnd(cell?.state ?? "unchecked", 12)}
              </Text>
              <Text color={theme.dim}>{cell?.reason ?? ""}</Text>
            </Box>
            <Text color={theme.dim}>{`      path        ${truncatePath(t.path, width - 18)}`}</Text>
            <Text color={theme.dim}>
              {`      deep        ${deep === undefined ? "never" : `${deep.outcome} · ${new Date(deep.ts).toLocaleString()}`}`}
            </Text>
            <Text color={theme.dim}>
              {`      quick       ${quick === undefined ? "never" : `${quick.outcome} · ${new Date(quick.ts).toLocaleString()}`}`}
            </Text>
            <Text color={theme.dim}>{`      required    ${t.required ? "yes" : "no"}`}</Text>
            <Text> </Text>
          </Box>
        );
      })}
      <Rule width={width} theme={theme} />
    </Screen>
  );
}
