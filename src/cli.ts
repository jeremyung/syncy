import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { recheckAfterSync, runCheckQueue } from "./check-runner.ts";
import { type Config, ConfigError, loadConfig } from "./config.ts";
import { EMPTY_CONFIG, saveConfig, withoutTarget, withTarget } from "./configio.ts";
import { loadDiff } from "./diff.ts";
import { loadHistorySnapshot } from "./engine-history.ts";
import { buildEngineActivity, buildEngineSnapshot, configRevision } from "./engine-snapshot.ts";
import { fingerprint } from "./fingerprint.ts";
import { bytes } from "./format.ts";
import { preflight } from "./guards.ts";
import { type JobOwnerRecord, type OwnedJob, withJobOwnership } from "./job-owner.ts";
import { configDir, configFile, stateDir, stateFile } from "./paths.ts";
import { presentDiffSummary } from "./presentation.ts";
import { serializeEngineMessage } from "./protocol-jsonl.ts";
import { type LedgerRow, renderLedger } from "./render.ts";
import { argvFor, checkBuild, DEFAULT_RSYNC } from "./rsync.ts";
import { allReachability, listUnits } from "./scan.ts";
import { writeSentinel } from "./sentinel.ts";
import { appendHistory, loadState, openState, type State } from "./state.ts";
import { evaluateUnit, timeoutWord } from "./status.ts";
import { startSync } from "./sync.ts";
import { claimSyncIntent } from "./sync-intent.ts";
import { cmdSyncPreflight } from "./sync-preflight.ts";
import { resolveTarget, validateTargetPath } from "./target.ts";
import { startTui } from "./tui/index.tsx";

/**
 * Phase 1: the engine, driven from a CLI. The Ink TUI in phase 2 sits on top of
 * exactly these functions; nothing here knows about rendering beyond one call.
 */

const USAGE = `syncy — replication ledger

  syncy                     open the ledger (interactive)
  syncy status              show the ledger
  syncy check [unit]        quick check (size and date) against every target
  syncy verify [unit]       deep verify (checksum) against every target
  syncy doctor              check the rsync build and target reachability
  syncy engine snapshot     print one versioned ledger snapshot for native clients
  syncy engine activity     print lightweight live-work status for native clients
  syncy engine check [unit] stream a quick check as versioned JSON lines
  syncy engine verify [unit] stream a deep verify as versioned JSON lines
  syncy engine preflight <unit> <destination>  prepare a guarded sync
  syncy engine sync <confirmation>             run one reviewed sync
  syncy engine set-source <path>                configure the source
  syncy engine add-destination <path> <name>    identify and add a destination
  syncy engine adopt-destination <name>         add a sentinel to a destination
  syncy engine remove-destination <name>        remove a destination from config
  syncy engine diff <unit> <destination>        print the recorded differences
  syncy engine history                          print literal task outcomes
  syncy engine record-missed <quick|deep|sync> <unit|*> <scheduled-ms> [destination|*]
  syncy init                write a starter config
  syncy adopt <path>        write a sentinel to a target

Configuration lives at ${configFile()}.
State, logs and history live in ${stateDir()}.

Set SYNCY_DEBUG=1 to write diagnostics to ${stateDir()}/debug.log — useful when
the interface appears to hang, since a TUI cannot print to the screen it owns.
Set SYNCY_THEME=dark|light|ansi to pick a theme; NO_COLOR uses the terminal's own.
`;

/** Ink needs raw mode, which requires a tty on stdin. */
const interactive = (): boolean => process.stdin.isTTY === true;

function fail(message: string): never {
  process.stderr.write(message.endsWith("\n") ? message : message + "\n");
  process.exit(1);
}

async function buildRows(config: Config, state: State, now: number): Promise<LedgerRow[]> {
  const units = listUnits(config.source);
  const sentinels = await allReachability(config);
  return units.map((unit) => {
    const fp = fingerprint(join(config.source, unit), config.exclude);
    const status = evaluateUnit(config, state, { unit, fingerprint: fp, sentinels }, now);
    return { status, size: fp.bytes };
  });
}

async function cmdStatus(config: Config): Promise<void> {
  const now = Date.now();
  const state = loadState();
  const rows = await buildRows(config, state, now);
  if (rows.length === 0) {
    fail(`no subfolders found under ${config.source}`);
  }
  process.stdout.write(renderLedger({ rows, selected: 0, config, state, now }) + "\n");
}

async function cmdCheck(
  config: Config,
  mode: "quick" | "deep",
  only: string | undefined,
): Promise<void> {
  const build = await checkBuild(DEFAULT_RSYNC);
  if (!build.ok) fail(`rsync: ${build.detail}`);

  const units = listUnits(config.source).filter((u) => only === undefined || u === only);
  if (units.length === 0)
    fail(only ? `no such unit: ${only}` : `no subfolders under ${config.source}`);

  await owned(
    "cli",
    mode,
    (job) =>
      runCheckQueue(
        config,
        loadState(),
        mode,
        units.map((unit) => {
          const measured = fingerprint(join(config.source, unit), config.exclude);
          return { unit, files: measured.nfiles, bytes: measured.bytes, fingerprint: measured };
        }),
        {
          signal: job.signal,
          onEvent: (event) => {
            job.lease.observe(event);
            if (event.type === "job.started") {
              process.stdout.write(`  ${event.unit} → ${event.target}: ${mode}…`);
            } else if (event.type === "job.skipped") {
              // The raw member would print "timeout", a value rather than a fact;
              // the ledger says the same condition in the same words.
              const why = event.reachability === "timeout" ? timeoutWord() : event.reachability;
              process.stdout.write(` skipped (${why})\n`);
            } else if (event.type === "job.completed" && event.operation !== "sync") {
              const detail =
                event.result.outcome === "clean"
                  ? "clean"
                  : event.result.outcome === "behind"
                    ? `${event.result.nChanges} pending · ${bytes(event.result.bytesPending)}`
                    : event.result.outcome;
              process.stdout.write(` ${detail}\n`);
            } else if (event.type === "job.failed") {
              process.stdout.write(` failed (${event.message})\n`);
            }
          },
        },
      ),
    { signals: true },
  );
  process.stdout.write("\n");
  await cmdStatus(config);
}

/**
 * Runs work under the job-owner lease, refusing the way every command does:
 * the shared sentence on stderr and exit 1.
 */
function owned<T>(
  actor: JobOwnerRecord["actor"],
  operation: JobOwnerRecord["operation"],
  work: (job: OwnedJob) => Promise<T> | T,
  options: { readonly heartbeat?: boolean; readonly signals?: boolean } = {},
): Promise<T> {
  return withJobOwnership(actor, operation, work, {
    ...options,
    onRefused: (refusal) => fail(refusal.message),
  });
}

/** Who is asking, for a command a native client or the scheduler may run. */
function engineActor(): JobOwnerRecord["actor"] {
  return process.env.SYNCY_ACTOR === "mac" || process.env.SYNCY_ACTOR === "scheduler"
    ? process.env.SYNCY_ACTOR
    : "cli";
}

/** Setup edits are short, so their lease is held without a heartbeat or signal handlers. */
function withSetupOwnership<T>(work: () => Promise<T> | T): Promise<T> {
  const actor = process.env.SYNCY_ACTOR === "mac" ? "mac" : "cli";
  return owned(actor, "setup", () => work(), { heartbeat: false });
}

async function cmdDoctor(config: Config): Promise<void> {
  const build = await checkBuild(DEFAULT_RSYNC);
  process.stdout.write(
    `  rsync        ${build.ok ? "ok" : "FAIL"}   ${build.ok ? build.version + " at " + build.detail : build.detail}\n`,
  );
  process.stdout.write(
    `  source       ${existsSync(config.source) ? "ok" : "FAIL"}   ${config.source}\n`,
  );
  const reach = await allReachability(config);
  let mismatched = false;
  for (const t of config.targets) {
    const s = reach.get(t.name) ?? "unreachable";
    if (s === "mismatch") mismatched = true;
    // A timeout would print as the raw value, which names nothing; the doctor
    // says the condition in the same words the ledger does.
    const shown = s === "timeout" ? timeoutWord() : s;
    process.stdout.write(
      `  ${t.name.padEnd(12)} ${s === "ok" ? "ok" : "FAIL"}   ${t.path} (${shown})\n`,
    );
  }
  if (mismatched) {
    process.stdout.write(
      "\n  A mismatch means the directory carries a different id than the one\n" +
        "  recorded for it — a different volume mounted at that path, or the\n" +
        "  directory recreated since it was added. syncy refuses to write to it.\n" +
        "  If the path is genuinely the right one, remove and re-add the target\n" +
        "  in setup. That registers the id that is actually there rather than\n" +
        "  silently inheriting the old volume's history: every unit re-added\n" +
        "  this way reads unchecked until it is checked again, which costs a\n" +
        "  fresh quick check at minimum and a deep verify to reach verified.\n",
    );
  }
  // The state line says what opening the record actually produced: a file
  // syncy cannot read is set aside on the way in, and the doctor names it
  // rather than showing a path that no longer holds the record.
  const opened = openState();
  process.stdout.write(
    `  state        ${opened.setAside === null ? "ok     " : "FAIL   "}${stateFile()}` +
      `${opened.setAside === null ? "" : ` (unreadable; set aside as ${basename(opened.setAside)})`}\n`,
  );
}

/**
 * `syncy engine <action> [operand…]`, as typed.
 *
 * The operands used to arrive as four positional parameters named `detail`,
 * `extra`, `more` and `last`, so `extra` was a destination in one action, a
 * name in another and a unit in a third. Each action now names its own.
 */
interface EngineArgs {
  readonly action: string | undefined;
  readonly operands: readonly string[];
}

function engineArgs(argv: readonly string[]): EngineArgs {
  const [action, ...operands] = argv;
  return { action, operands };
}

async function cmdEngine(config: Config, args: EngineArgs): Promise<void> {
  const { action, operands } = args;
  if (action === "activity") {
    process.stdout.write(serializeEngineMessage(buildEngineActivity()));
    return;
  }
  if (action === "snapshot") {
    const snapshot = await buildEngineSnapshot(config, loadState());
    process.stdout.write(serializeEngineMessage(snapshot));
    return;
  }
  if (action === "preflight") {
    const [unit, destination] = operands;
    if (unit === undefined || destination === undefined) {
      fail("usage: syncy engine preflight <unit> <destination>");
    }
    await cmdSyncPreflight(config, unit, destination, {}, fail);
    return;
  }
  if (action === "sync") {
    const [confirmation] = operands;
    if (confirmation === undefined) fail("usage: syncy engine sync <confirmation>");
    await cmdEngineSync(config, confirmation);
    return;
  }
  if (action === "set-source") {
    const [typed] = operands;
    if (typed === undefined) fail("usage: syncy engine set-source <path>");
    const source = resolve(typed);
    if (!existsSync(source) || !statSync(source).isDirectory()) {
      fail(`source is not a directory: ${source}`);
    }
    const next = await withSetupOwnership(() => {
      const next = { ...config, source };
      saveConfig(next, configFile());
      return next;
    });
    process.stdout.write(serializeEngineMessage(await buildEngineSnapshot(next, loadState())));
    return;
  }
  if (action === "add-destination") {
    const [typed, name] = operands;
    if (typed === undefined || name === undefined) {
      fail("usage: syncy engine add-destination <path> <name>");
    }
    const path = resolve(typed);
    const invalid = validateTargetPath(path, config);
    if (invalid !== null) fail(`destination not added: ${invalid}`);
    // `fail` exits the process, which skips the `finally` that releases the
    // lease — leaving a fresh ownership record that refuses every command for
    // the next staleness window. Report the refusal outward and exit after.
    const outcome = await withSetupOwnership(async () => {
      const result = await resolveTarget(path, name);
      if (!result.ok) return { refused: result.reason } as const;
      const next = withTarget(config, result.target);
      saveConfig(next, configFile());
      return { config: next } as const;
    });
    if ("refused" in outcome) fail(`destination not added: ${outcome.refused}`);
    const next = outcome.config;
    process.stdout.write(serializeEngineMessage(await buildEngineSnapshot(next, loadState())));
    return;
  }
  if (action === "remove-destination") {
    const [name] = operands;
    if (name === undefined) fail("usage: syncy engine remove-destination <name>");
    if (!config.targets.some((target) => target.name === name)) {
      fail(`no such destination: ${name}`);
    }
    const next = await withSetupOwnership(() => {
      const next = withoutTarget(config, name);
      saveConfig(next, configFile());
      return next;
    });
    process.stdout.write(serializeEngineMessage(await buildEngineSnapshot(next, loadState())));
    return;
  }
  if (action === "adopt-destination") {
    const [name] = operands;
    if (name === undefined) fail("usage: syncy engine adopt-destination <name>");
    const target = config.targets.find((candidate) => candidate.name === name);
    if (target === undefined) fail(`no such destination: ${name}`);
    const next = await withSetupOwnership(async () => {
      const sentinel = await writeSentinel(target.path);
      const next = withTarget(config, { ...target, sentinel });
      saveConfig(next, configFile());
      return next;
    });
    process.stdout.write(serializeEngineMessage(await buildEngineSnapshot(next, loadState())));
    return;
  }
  if (action === "diff") {
    const [unit, destination] = operands;
    if (unit === undefined || destination === undefined) {
      fail("usage: syncy engine diff <unit> <destination>");
    }
    if (!listUnits(config.source).includes(unit)) fail(`no such unit: ${unit}`);
    if (!config.targets.some((target) => target.name === destination)) {
      fail(`no such destination: ${destination}`);
    }
    const diff = loadDiff(unit, destination);
    const target = config.targets.find((candidate) => candidate.name === destination)!;
    const presentation = presentDiffSummary(diff);
    const reachability = (await allReachability(config)).get(destination) ?? "unreachable";
    const configuredIdentity = target.identity ?? target.sentinel ?? "";
    const identityMatches = diff?.targetIdentity === configuredIdentity;
    process.stdout.write(
      serializeEngineMessage({
        protocolVersion: 1,
        type: "diff",
        generatedAt: Date.now(),
        unit,
        target: destination,
        diff,
        presentation: {
          state: presentation.state,
          ...(presentation.title === undefined ? {} : { title: presentation.title }),
          ...(presentation.detail === undefined ? {} : { detail: presentation.detail }),
          parts: presentation.parts,
          copyableFiles: presentation.copyableFiles,
        },
        ...(diff?.targetIdentity === undefined
          ? {}
          : {
              provenance: {
                targetIdentity: diff.targetIdentity,
                identityMatches,
                reachability,
                current: identityMatches && reachability === "ok",
              },
            }),
      }),
    );
    return;
  }
  if (action === "history") {
    process.stdout.write(
      serializeEngineMessage({
        protocolVersion: 1,
        type: "history",
        generatedAt: Date.now(),
        entries: loadHistorySnapshot(),
      }),
    );
    return;
  }
  if (action === "record-missed") {
    const [operation, unit, scheduled, destination] = operands;
    if (
      (operation !== "quick" && operation !== "deep" && operation !== "sync") ||
      unit === undefined ||
      scheduled === undefined
    ) {
      fail(
        "usage: syncy engine record-missed <quick|deep|sync> <unit|*> <scheduled-ms> [destination|*]",
      );
    }
    const scheduledAt = Number(scheduled);
    if (!Number.isFinite(scheduledAt) || scheduledAt < 0 || scheduledAt > Date.now()) {
      fail("scheduled time must be a past epoch-millisecond value");
    }
    appendHistory({
      ts: scheduledAt,
      unit: unit === "*" ? "all units" : unit,
      target: destination === undefined || destination === "*" ? "all destinations" : destination,
      argv: [],
      exitCode: null,
      operation,
      outcome: "missed",
      detail: "Mac was asleep or Syncy was not running at the scheduled time",
    });
    process.stdout.write("recorded missed schedule\n");
    return;
  }

  const mode = action === "check" ? "quick" : action === "verify" ? "deep" : undefined;
  if (mode === undefined) fail("usage: syncy engine snapshot|activity|check [unit]|verify [unit]");
  const [only] = operands;
  const build = await checkBuild(DEFAULT_RSYNC);
  if (!build.ok) fail(`rsync: ${build.detail}`);
  const units = listUnits(config.source)
    .filter((unit) => only === undefined || unit === only)
    .map((unit) => {
      const measured = fingerprint(join(config.source, unit), config.exclude);
      return { unit, files: measured.nfiles, bytes: measured.bytes, fingerprint: measured };
    });
  if (units.length === 0)
    fail(only ? `no such unit: ${only}` : `no subfolders under ${config.source}`);

  await owned(
    engineActor(),
    mode,
    async (job) => {
      const result = await runCheckQueue(config, loadState(), mode, units, {
        signal: job.signal,
        onEvent: (event) => {
          job.lease.observe(event);
          process.stdout.write(serializeEngineMessage(event));
        },
      });
      if (result.status === "cancelled") process.exitCode = 130;
      else if (result.failed.length > 0) process.exitCode = 1;
    },
    { signals: true },
  );
}

async function cmdEngineSync(config: Config, token: string): Promise<void> {
  await owned(engineActor(), "sync", (job) => runEngineSync(config, token, job), {
    signals: true,
  });
}

async function runEngineSync(config: Config, token: string, job: OwnedJob): Promise<void> {
  let handle: ReturnType<typeof startSync> | undefined;
  // A cancel — a signal, a lost heartbeat, a lost lease — stops rsync as well
  // as the work that reads the abort signal.
  job.signal.addEventListener("abort", () => handle?.cancel());
  const intent = claimSyncIntent(token);
  const target = config.targets.find((candidate) => candidate.name === intent.target);
  if (target === undefined) throw new Error(`destination no longer exists: ${intent.target}`);
  // Defence in depth: the fingerprint and argv checks below catch most
  // config edits as a side effect (a changed destination path changes the
  // argv it produces), but this closes the gap for any config change that
  // doesn't happen to move either of those — the confirmation is bound to
  // the exact config it was reviewed against.
  if (configRevision(config) !== intent.configRevision) {
    throw new Error("configuration changed after review; run the preflight again");
  }
  const measured = fingerprint(join(config.source, intent.unit), config.exclude);
  if (
    measured.nfiles !== intent.fingerprint.nfiles ||
    measured.bytes !== intent.fingerprint.bytes ||
    measured.maxMtimeNs !== intent.fingerprint.maxMtimeNs
  ) {
    throw new Error("source changed after review; run the check and preflight again");
  }
  const argv = argvFor(config, intent.unit, target, "sync", {
    ...(intent.needsChecksum ? { checksum: true } : {}),
  });
  if (JSON.stringify(argv) !== JSON.stringify(intent.argv)) {
    throw new Error("sync command changed after review; run the preflight again");
  }
  const fresh = await preflight(config, target, argv, intent.bytesPending);
  if (!fresh.ok) {
    throw new Error(
      `sync preflight no longer passes: ${fresh.checks
        .filter((check) => !check.ok)
        .map((check) => `${check.name}: ${check.detail}`)
        .join(", ")}`,
    );
  }

  const jobId = `${Date.now()}-${intent.unit}-${intent.target}`;
  const base = {
    protocolVersion: 1,
    jobId,
    operation: "sync",
    unit: intent.unit,
    target: intent.target,
  } as const;
  const emit = (event: Parameters<OwnedJob["lease"]["observe"]>[0]): void => {
    job.lease.observe(event);
    process.stdout.write(serializeEngineMessage(event));
  };
  emit({
    ...base,
    type: "job.started",
    at: Date.now(),
    phase: "queued",
    unitSize: {
      ...(intent.nFiles === undefined ? {} : { files: intent.nFiles }),
      bytes: intent.bytesPending,
    },
  });
  emit({ ...base, type: "job.phase-changed", at: Date.now(), phase: "starting-rsync" });
  let transferred = 0;
  handle = startSync(config, intent.unit, target, {
    ...(intent.needsChecksum ? { checksum: true } : {}),
    onItem: (item) => {
      if (item.kind !== "change" || item.flags[1] !== "f") return;
      transferred += 1;
      if (transferred % 25 === 0 || transferred === intent.nFiles) {
        try {
          emit({
            ...base,
            type: "job.progress-observed",
            at: Date.now(),
            filesSeen: transferred,
            ...(intent.nFiles === undefined ? {} : { filesTotal: intent.nFiles }),
          });
        } catch {
          // The lease is gone — same as a lost heartbeat or a SIGTERM: stop
          // rsync through the one cancellation path, rather than letting
          // the error reach pump() inside startSync and abort the transfer
          // ungracefully (sync.ts's own `done` still copes if it does, but
          // this is the graceful route and it also earns the "cancelled"
          // outcome instead of "failed").
          job.cancel();
        }
      }
    },
  });
  emit({ ...base, type: "job.phase-changed", at: Date.now(), phase: "transferring" });
  if (job.signal.aborted) handle.cancel();
  const result = await handle.done;
  if (result.cancelled) {
    emit({ ...base, type: "job.cancelled", at: Date.now(), transferred: result.transferred });
    process.exitCode = 130;
  } else if (result.exitCode === 0 || result.exitCode === 24) {
    emit({
      ...base,
      type: "job.completed",
      at: Date.now(),
      result: { exitCode: result.exitCode, transferred: result.transferred },
    });
    // The transfer records nothing the ledger reads, so a destination that
    // was just brought up to date goes on reporting the backlog its last
    // check found. Same trailing quick check the TUI runs, under the same
    // lease, streamed so the client sees the row change rather than having
    // to ask for a check of its own. A check that will not run does not
    // undo a transfer that did: the sync's own outcome is already emitted.
    try {
      await recheckAfterSync(config, loadState(), intent.unit, intent.target, {
        signal: job.signal,
        onEvent: emit,
      });
    } catch (error) {
      emit({
        protocolVersion: 1,
        jobId: `${jobId}-recheck`,
        operation: "quick",
        unit: intent.unit,
        target: intent.target,
        type: "job.failed",
        at: Date.now(),
        message: error instanceof Error ? error.message : String(error),
        exitCode: null,
      });
    }
  } else {
    emit({
      ...base,
      type: "job.failed",
      at: Date.now(),
      message: result.stderr || `rsync exited ${String(result.exitCode)}`,
      exitCode: result.exitCode,
    });
    process.exitCode = 1;
  }
}

function cmdInit(): void {
  const file = configFile();
  if (existsSync(file)) fail(`config already exists at ${file}`);
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(
    file,
    `# syncy — written by the setup screen; edit by hand at your own risk.
source = "/absolute/path/to/source/root"
exclude = [".DS_Store", "._*"]

[status]
max_verify_age_days = 30   # deep: guards silent bit rot
max_quick_age_days  = 7    # quick: guards deletion and truncation
min_targets         = 1   # every configured target must verify regardless

# [[target]]
# name     = "ext"
# path     = "/Volumes/Archive/photos"
# required = true
# sentinel = "run 'syncy adopt <path>' to write the id here"
`,
    "utf8",
  );
  process.stdout.write(`wrote ${file}\n`);
}

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(USAGE);
    return;
  }
  if (cmd === "init") {
    cmdInit();
    return;
  }
  // `adopt` writes the sentinel that the config then references, so it has to
  // run before any config exists — it is the bootstrap step.
  if (cmd === "adopt") {
    if (arg === undefined) fail("usage: syncy adopt <target-path>");
    if (!existsSync(arg)) fail(`no such directory: ${arg}`);
    const id = await withSetupOwnership(() => writeSentinel(arg));
    process.stdout.write(`sentinel ${id} written to ${arg}\n`);
    return;
  }

  let config: Config;
  try {
    config = loadConfig(configFile());
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    // First run: open the setup screen on an empty config rather than refusing
    // to start. Every other command still needs a real config.
    if (
      !existsSync(configFile()) &&
      (cmd === undefined || (cmd === "engine" && arg === "set-source"))
    ) {
      if (cmd === "engine" && arg === "set-source") {
        config = EMPTY_CONFIG();
      } else if (!interactive()) {
        fail(
          `no config at ${configFile()}\n` +
            "run syncy in a terminal to open the setup screen, or write the file by hand.",
        );
      } else {
        startTui(EMPTY_CONFIG());
        return;
      }
    } else {
      fail(e.message);
    }
  }

  // No argument opens the ledger. Without a tty — piped, or a non-interactive
  // ssh command — Ink cannot enter raw mode, so print the ledger instead of
  // crashing with a raw-mode stack trace.
  if (cmd === undefined) {
    if (interactive()) startTui(config);
    else await cmdStatus(config);
    return;
  }

  switch (cmd) {
    case "status":
      await cmdStatus(config);
      return;
    case "check":
      await cmdCheck(config, "quick", arg);
      return;
    case "verify":
      await cmdCheck(config, "deep", arg);
      return;
    case "doctor":
      await cmdDoctor(config);
      return;
    case "engine":
      await cmdEngine(config, engineArgs(process.argv.slice(3)));
      return;
    default:
      fail(`unknown command: ${cmd}\n\n${USAGE}`);
  }
}

// Go's forced error handling was the property given up by choosing TypeScript.
// A rejected promise that vanishes silently is the failure mode this replaces.
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`fatal: unhandled rejection: ${String(reason)}\n`);
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  process.stderr.write(`fatal: ${err.stack ?? err.message}\n`);
  process.exit(1);
});

await main();
