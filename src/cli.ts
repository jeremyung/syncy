import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, loadConfig, type Config } from "./config.ts";
import { EMPTY_CONFIG } from "./configio.ts";
import { fingerprint } from "./fingerprint.ts";
import { bytes } from "./format.ts";
import { configDir, configFile, stateDir, stateFile } from "./paths.ts";
import { renderLedger, type LedgerRow } from "./render.ts";
import { checkBuild, DEFAULT_RSYNC } from "./rsync.ts";
import { allReachability, checkUnit, listUnits } from "./scan.ts";
import { writeSentinel } from "./sentinel.ts";
import { appendHistory, loadState, saveState, upsertScan, type State } from "./state.ts";
import { evaluateUnit } from "./status.ts";
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

async function cmdCheck(config: Config, mode: "quick" | "deep", only: string | undefined): Promise<void> {
  const build = await checkBuild(DEFAULT_RSYNC);
  if (!build.ok) fail(`rsync: ${build.detail}`);

  const units = listUnits(config.source).filter((u) => only === undefined || u === only);
  if (units.length === 0) fail(only ? `no such unit: ${only}` : `no subfolders under ${config.source}`);

  const reach = await allReachability(config);
  let state = loadState();

  for (const unit of units) {
    const fp = fingerprint(join(config.source, unit), config.exclude);
    for (const target of config.targets) {
      const status = reach.get(target.name);
      if (status !== "ok") {
        process.stdout.write(`  ${unit} → ${target.name}: skipped (${status})\n`);
        continue;
      }
      process.stdout.write(`  ${unit} → ${target.name}: ${mode}…`);
      const { scan, argv, exitCode } = await checkUnit(config, unit, target, mode, { fingerprint: fp });
      state = upsertScan(state, scan);
      saveState(state);
      appendHistory({
        ts: scan.ts,
        unit,
        target: target.name,
        argv,
        exitCode,
      });
      const detail =
        scan.outcome === "clean"
          ? "clean"
          : scan.outcome === "behind"
            ? `${scan.nChanges} pending · ${bytes(scan.bytesPending)}`
            : scan.outcome;
      process.stdout.write(` ${detail}\n`);
    }
  }
  process.stdout.write("\n");
  await cmdStatus(config);
}

async function cmdDoctor(config: Config): Promise<void> {
  const build = await checkBuild(DEFAULT_RSYNC);
  process.stdout.write(`  rsync        ${build.ok ? "ok" : "FAIL"}   ${build.ok ? build.version + " at " + build.detail : build.detail}\n`);
  process.stdout.write(`  source       ${existsSync(config.source) ? "ok" : "FAIL"}   ${config.source}\n`);
  const reach = await allReachability(config);
  let mismatched = false;
  for (const t of config.targets) {
    const s = reach.get(t.name) ?? "unreachable";
    if (s === "mismatch") mismatched = true;
    process.stdout.write(`  ${t.name.padEnd(12)} ${s === "ok" ? "ok" : "FAIL"}   ${t.path} (${s})\n`);
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
  process.stdout.write(`  state        ${stateFile()}\n`);
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
    const id = await writeSentinel(arg);
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
    if (cmd === undefined && !existsSync(configFile())) {
      if (!interactive()) {
        fail(
          `no config at ${configFile()}\n` +
            "run syncy in a terminal to open the setup screen, or write the file by hand.",
        );
      }
      startTui(EMPTY_CONFIG());
      return;
    }
    fail(e.message);
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
