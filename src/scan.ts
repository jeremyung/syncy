import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Config, Target } from "./config.ts";
import { fingerprint, type Fingerprint } from "./fingerprint.ts";
import { parseItemizeLine, summarize, type Item } from "./itemize.ts";
import { logDir } from "./paths.ts";
import { buildArgv, runRsync, type Mode } from "./rsync.ts";
import { checkSentinel, type SentinelStatus } from "./sentinel.ts";
import { checkVolume } from "./volume.ts";
import type { Method, Scan } from "./state.ts";

/** Units are the immediate subfolders of the source root. Not a depth, not a list. */
export function listUnits(source: string): string[] {
  let entries;
  try {
    entries = readdirSync(source, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

export type Reachability = SentinelStatus | "unreachable";

/**
 * Reachability is decided by the destination proving it is itself, never by the
 * path existing.
 *
 * An unmounted /Volumes/media is still a writable directory on the boot disk,
 * so `existsSync` is exactly the check that gets you into trouble.
 *
 * Two ways to prove it. `identity` asks the operating system which volume is
 * mounted at the path and compares that with what was recorded — nothing is
 * written to the destination. `sentinel` reads a file syncy placed at the
 * target root, which additionally catches the directory being deleted and
 * recreated. Identity wins when both are present.
 */
export async function targetReachability(target: Target): Promise<Reachability> {
  if (target.identity !== undefined && target.identity !== "") {
    const v = await checkVolume(target.path, target.identity);
    if (v !== "ok") return v === "unreachable" ? "unreachable" : "mismatch";
    // The volume is right; the directory still has to exist on it.
    return existsSync(target.path) ? "ok" : "unreachable";
  }
  if (!existsSync(target.path)) return "unreachable";
  if (target.sentinel === undefined) return "missing";
  return checkSentinel(target.path, target.sentinel);
}

export async function allReachability(config: Config): Promise<Map<string, Reachability>> {
  const entries = await Promise.all(
    config.targets.map(async (t) => [t.name, await targetReachability(t)] as const),
  );
  return new Map(entries);
}

export interface CheckResult {
  readonly scan: Scan;
  readonly items: readonly Item[];
  /**
   * What is actually at the destination: a read-only walk of the target folder.
   *
   * The file counts could be derived from the itemize stream, but the *bytes*
   * at the destination cannot — rsync reports the source length for every item,
   * never the destination's. Without measuring, "how far behind is this?"
   * can only be answered in file counts, which for photos is the less useful
   * half. `null` when the folder is not there at all.
   */
  readonly targetFingerprint: Fingerprint | null;
  /** The literal argv that ran, so history records what happened, not a guess. */
  readonly argv: readonly string[];
}

export interface CheckOptions {
  readonly bin?: string;
  readonly onLine?: (line: string) => void;
  /** Called as rsync finishes with each file — the only source of progress. */
  readonly onFile?: (seen: number, name: string) => void;
  readonly now?: number;
  readonly fingerprint?: Fingerprint;
}

export const methodOf = (mode: Mode): Method => (mode === "deep" ? "deep" : "quick");

export async function checkUnit(
  config: Config,
  unit: string,
  target: Target,
  mode: Exclude<Mode, "sync">,
  opts: CheckOptions = {},
): Promise<CheckResult> {
  const now = opts.now ?? Date.now();
  const startedAt = Date.now();
  const fp = opts.fingerprint ?? fingerprint(join(config.source, unit), config.exclude);
  const base = {
    unit,
    target: target.name,
    ts: now,
    method: methodOf(mode),
    fingerprint: fp,
    sentinel: target.identity ?? target.sentinel ?? "",
  } as const;

  // Nothing at the destination at all: report it directly rather than letting
  // rsync itemize the entire tree as pending.
  if (!existsSync(join(target.path, unit))) {
    return {
      scan: { ...base, outcome: "missing", nChanges: 0, nExtra: 0, bytesPending: 0 },
      items: [],
      argv: [],
      targetFingerprint: null,
    };
  }

  const argv = buildArgv(mode, join(config.source, unit), { ...target, path: join(target.path, unit) }, config.exclude);
  const items: Item[] = [];
  // Counted as we go rather than by filtering `items` on every line: that
  // filter was O(n) per line, so a 40,000-file folder spent 800 million
  // comparisons re-deriving a number it could have incremented.
  let nFiles = 0;
  const result = await runRsync(argv, {
    ...(opts.bin !== undefined ? { bin: opts.bin } : {}),
    onLine: (line) => {
      opts.onLine?.(line);
      const item = parseItemizeLine(line);
      if (item === null) return;
      items.push(item);
      // Directories are not files; counting them would overshoot the total.
      if (item.flags[1] === "f") opts.onFile?.((nFiles += 1), item.name);
    },
  });

  if (result.exitCode !== 0) {
    return {
      scan: { ...base, outcome: "error", nChanges: 0, nExtra: 0, bytesPending: 0 },
      items,
      argv,
      targetFingerprint: null,
    };
  }

  // After rsync, not before: the walk is read-only and cheap next to a check,
  // but doing it first would delay the run for a number only shown afterwards.
  const targetFingerprint = fingerprint(join(target.path, unit), config.exclude);

  const s = summarize(items);
  return {
    scan: {
      ...base,
      durationMs: Date.now() - startedAt,
      outcome: s.nChanges === 0 ? "clean" : "behind",
      nChanges: s.nChanges,
      nNew: s.nNew,
      nExtra: s.nExtra,
      bytesPending: s.bytesPending,
    },
    items,
    argv,
    targetFingerprint,
  };
}

export function ensureLogDir(): string {
  const d = logDir();
  mkdirSync(d, { recursive: true });
  return d;
}
