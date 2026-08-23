import { Box, Text, useApp, useInput, useStdout } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { EMPTY as EMPTY_FINGERPRINT, fingerprint, type Fingerprint } from "../fingerprint.ts";
import { bytes } from "../format.ts";
import { allReachability, checkUnit, listUnits, methodOf, type Reachability } from "../scan.ts";
import { appendHistory, estimateMs, loadState, saveState, upsertScan, type State } from "../state.ts";
import { debug, timed, timedAsync } from "../log.ts";
import { setTitle, titleFor } from "../title.ts";
import { padEnd, truncatePath } from "../width.ts";
import { evaluateUnit, reachWord, type CellState, type UnitState } from "../status.ts";
import { Diff as DiffScreen } from "./Diff.tsx";
import { buildDiff, loadDiff, saveDiff, type Diff } from "../diff.ts";
import { Ledger, type Row } from "./Ledger.tsx";
import { Confirm } from "./Confirm.tsx";
import { Job } from "./Job.tsx";
import { Mark } from "./Mark.tsx";
import { Plan } from "./Plan.tsx";
import { barFraction, type RunProgress } from "./Progress.tsx";
import { Rule, Screen } from "./Screen.tsx";
import { Setup } from "./Setup.tsx";
import { cellToken, resolveTheme } from "./theme.ts";
import { useScreen } from "./useScreen.ts";

/**
 * Phase 2: the ledger, read-only plus the two non-destructive checks.
 *
 * Quick and deep both run with -n and never write to a target, so they are safe
 * to bind to a keypress. Actual syncing is phase 3 and goes behind the confirm
 * page with its guard rails.
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
}

/** How long a refused keypress stays on screen. */
const NOTICE_MS = 3000;

export function App({ config: initialConfig }: AppProps): React.ReactElement {
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
  const [busy, setBusy] = useState<string | null>(null);
  /**
   * What is being checked right now.
   *
   * Held separately from `busy` — which is a transient message — so the work
   * stays visible on the row it belongs to even after the cursor moves away.
   */
  const [running, setRunning] = useState<RunProgress | null>(null);
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

  /** Shows a refusal for a few seconds, replacing any refusal already up. */
  const showNotice = useCallback((text: string) => {
    if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
    setNotice(text);
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);
  const [showPlan, setShowPlan] = useState(false);
  // Open straight into setup when there is nothing to show yet.
  const [showSetup, setShowSetup] = useState(() => initialConfig.targets.length === 0);
  // A sync moves through confirm -> job. Neither can be entered by accident:
  // `s` opens the confirm page, and only [enter] there starts a transfer.
  const [pendingSync, setPendingSync] = useState<{ unit: string; target: string } | null>(null);
  const [runningSync, setRunningSync] = useState<{ unit: string; target: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [frame, setFrame] = useState(0);


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
   * Rows are pure evaluation against cached facts — no filesystem work at all.
   *
   * This used to fingerprint every folder and read every sentinel on each
   * render. Fingerprinting a real archive measured 645 ms, and the progress
   * ticker moves `now` every 500 ms during a check, so the interface spent more
   * than all of its time re-walking the disk and never got round to drawing.
   * It looked exactly like a hang.
   */
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
  const diffs: ReadonlyMap<string, Diff | null> = useMemo(() => {
    const unit = rows[clampedSelection]?.status.unit;
    if (!showDiff || unit === undefined) return new Map<string, Diff | null>();
    return new Map(config.targets.map((t) => [t.name, loadDiff(unit, t.name)]));
  }, [showDiff, rows, clampedSelection, config.targets, state]);

  const runCheck = useCallback(
    async (mode: "quick" | "deep", scope: "selected" | "all") => {
      if (running !== null) {
        showNotice(
          `[${mode === "deep" ? "d" : "q"}] ignored — the ${running.mode} check on ` +
            `${running.unit} is still running`,
        );
        return;
      }
      const chosen = scope === "all" ? rows : rows.slice(clampedSelection, clampedSelection + 1);
      if (chosen.length === 0) return;

      const reach = scan?.reach ?? (await allReachability(config));
      const jobs = chosen.flatMap((row) =>
        config.targets.map((target) => ({
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
      let working = state;
      let done = 0;
      let bytesDone = 0;

      // Destinations that could not be reached, so the run can say what it did
      // not do. Skipping in silence and then reporting "deep check finished"
      // was a claim that nothing had been checked — indistinguishable from a
      // check that never started.
      const skipped: { readonly target: string; readonly why: Reachability }[] = [];

      for (const job of jobs) {
        const status = reach.get(job.target.name);
        if (status !== "ok") {
          if (!skipped.some((s) => s.target === job.target.name)) {
            skipped.push({ target: job.target.name, why: status ?? "unreachable" });
          }
          debug("check.skipped", { unit: job.unit, target: job.target.name, reach: status });
          done += 1;
          bytesDone += job.size;
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
        try {
          const { scan, argv, items, targetFingerprint, exitCode } = await checkUnit(config, job.unit, job.target, mode, {
            // Throttled: one render per 25 files keeps a large folder from
            // driving the render loop instead of the check.
            onFile: (seen) => {
              if (seen % 25 === 0) setRunning({ ...base, filesSeen: seen });
            },
          });
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
          // The itemized list is what the differences screen shows. rsync
          // produced it during the check; discarding it would mean re-running
          // the whole check to answer "which files?".
          saveDiff(
            buildDiff(job.unit, job.target.name, scan.method, items, {
              ts: scan.ts,
              wholeFolderMissing: scan.outcome === "missing",
              source: scan.fingerprint,
              target: targetFingerprint,
            }),
          );
          appendHistory({
            ts: scan.ts,
            unit: job.unit,
            target: job.target.name,
            argv,
            exitCode,
          });
          // Publish after every unit so the ledger fills in as it goes rather
          // than staying blank until the whole run finishes.
          setState(working);
          setNow(Date.now());
        } catch (e) {
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
        done += 1;
        bytesDone += job.size;
      }

      setRunning(null);
      // A check can change what is at the target, and the source may have moved
      // under us while it ran, so both facts are re-read once at the end.
      refresh();
      // A run in which every destination was skipped checked nothing, and must
      // not report otherwise.
      const ran = jobs.length - skipped.reduce((n, s) => n + jobs.filter((j) => j.target.name === s.target).length, 0);
      if (ran === 0 && skipped.length > 0) {
        setBusy(`nothing checked — ${skipped.map((s) => `${s.target} ${reachWord(s.why)}`).join(", ")}`);
      } else if (skipped.length > 0) {
        setBusy(
          `${mode} check finished · ${ran} of ${jobs.length} · skipped ` +
            skipped.map((s) => `${s.target} (${reachWord(s.why)})`).join(", "),
        );
      } else {
        setBusy(
          scope === "all"
            ? `${mode} check finished · ${chosen.length} folders`
            : `${mode} check finished · ${chosen[0]?.status.unit ?? ""}`,
        );
      }
      setNow(Date.now());
      // A skip needs longer on screen than a success: it is the message the
      // user has to read and act on.
      setTimeout(() => setBusy(null), skipped.length > 0 ? 8000 : 2500);
    },
    [rows, clampedSelection, running, config, state, scan, refresh, showNotice],
  );

  useInput((input, key) => {
    if (key.ctrl && input === "c") return exit();
    if (showHelp) {
      setShowHelp(false);
      return;
    }
    if (showEvidence) {
      if (key.escape || input === "e") setShowEvidence(false);
      return;
    }
    if (showDiff) return; // The differences screen owns the keyboard.
    if (showPlan) return; // Plan owns the keyboard while it is open.
    if (showSetup) return; // Setup owns the keyboard while it is open.
    if (pendingSync !== null || runningSync !== null) return; // Confirm/Job own it.
    if (key.upArrow || input === "k") setSelected((s) => Math.max(0, s - 1));
    else if (key.downArrow || input === "j") setSelected((s) => Math.min(rows.length - 1, s + 1));
    else if (input === "q") void runCheck("quick", "selected");
    else if (input === "Q") void runCheck("quick", "all");
    else if (input === "d") void runCheck("deep", "selected");
    else if (input === "D") void runCheck("deep", "all");
    else if (input === "r") refresh();
    else if (input === "f") {
      setFilter((f) => (f + 1) % FILTERS.length);
      setSelected(0);
    } else if (input === "e") setShowEvidence(true);
    else if (key.return) {
      // Enter on a row opens what differs about it. Guarded on there being a
      // row, or the keyboard guard above would swallow every key.
      if (rows[clampedSelection] !== undefined) setShowDiff(true);
    }
    else if (input === "p") {
      // Only open it when there is a folder to describe, or the keyboard guard
      // above would swallow every key with nothing on screen.
      if (rows[clampedSelection] !== undefined) setShowPlan(true);
    }
    else if (input === "s") {
      // Offer the target that is furthest behind; there is nothing to sync to a
      // target that is already clean.
      // A sync writes; starting one while a check is reading the same tree
      // would have the two disagree about what is there.
      if (running !== null) {
        showNotice(`[s] ignored — the ${running.mode} check on ${running.unit} is still running`);
        return;
      }
      const row = rows[clampedSelection];
      const cell = row?.status.cells.find((c) => c.state === "behind" || c.state === "missing");
      if (row !== undefined && cell !== undefined) {
        setPendingSync({ unit: row.status.unit, target: cell.target });
      }
    } else if (input === ",") setShowSetup(true);
    else if (input === "?") setShowHelp(true);
  });

  const syncing = pendingSync ?? runningSync;
  const syncRow = syncing === null ? undefined : allRows.find((r) => r.status.unit === syncing.unit);
  const syncTarget = syncing === null ? undefined : config.targets.find((t) => t.name === syncing.target);
  const syncCell = syncRow?.status.cells.find((c) => c.target === syncing?.target);

  if (pendingSync !== null && syncRow !== undefined && syncTarget !== undefined) {
    return (
      <Confirm
        config={config}
        unit={pendingSync.unit}
        target={syncTarget}
        nChanges={syncCell?.nChanges ?? 0}
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
        theme={theme}
        width={width}
        height={screen.rows}
        onDone={() => {
          // A transfer changes what is at the target, so every recorded scan
          // for it is now stale. Re-read state rather than assuming success.
          setState(loadState());
          setNow(Date.now());
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
          theme={theme}
          width={width}
          height={screen.rows}
          onClose={() => setShowPlan(false)}
          onCopy={(text) => {
            // pbcopy is macOS-only; failing to copy must not take the app down.
            try {
              // Absolute, like every other binary syncy runs. Resolving this from
              // PATH would have been the one place a planted executable could
              // run — inconsistent with pinning rsync for exactly that reason.
              Bun.spawn(["/usr/bin/pbcopy"], { stdin: new TextEncoder().encode(text) });
              setBusy("plan copied to the clipboard");
              setTimeout(() => setBusy(null), 1500);
            } catch {
              setBusy("could not reach pbcopy");
              setTimeout(() => setBusy(null), 1500);
            }
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
        <Text color={theme.unverified}>{`  filter: ${active} — ${rows.length} of ${allRows.length} units`}</Text>
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
        busy={busy}
        running={running}
        frame={frame}
        notice={notice}
      />
    </Box>
  );
}

function Help({
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
      {line("ctrl-c", "quit")}
      <Text> </Text>
      <Text color={theme.dim}>{"  syncy never deletes, and writes to no destination from this screen."}</Text>
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
function Evidence({ row, config, state, theme, width, height }: EvidenceProps): React.ReactElement {
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
        const deep = state.scans.find((s) => s.unit === row.status.unit && s.target === t.name && s.method === "deep");
        const quick = state.scans.find((s) => s.unit === row.status.unit && s.target === t.name && s.method === "quick");
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
