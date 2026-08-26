import { type Dirent, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Config, Target } from "./config.ts";
import { type Fingerprint, fingerprint } from "./fingerprint.ts";
import { type Item, parseItemizeLine, summarize } from "./itemize.ts";
import { logDir } from "./paths.ts";
import { argvFor, type Mode, runRsync } from "./rsync.ts";
import { checkSentinel, type SentinelStatus } from "./sentinel.ts";
import type { Method, Scan } from "./state.ts";
import { checkVolume } from "./volume.ts";

/** Units are the immediate subfolders of the source root. Not a depth, not a list. */
export function listUnits(source: string): string[] {
  let entries: Dirent[];
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
 * recreated.
 *
 * Not every recorded identity is proof, and `identityIsProof` is where that
 * is decided. A volume uuid names the filesystem and nothing else can answer
 * to it. A network mount source — `//nas/media`, `archive:/exports` — names a
 * host and an export, which is equally a name for the thing itself. A local
 * device path is neither: `identify` falls back to one when no uuid is
 * published, and `/dev/sdb1` is a slot in this boot's enumeration order.
 * Unplug the backup disk, plug a different one into the same port, and it
 * answers to the same path.
 *
 * So a device-path identity is checked — it still catches the volume being
 * unmounted — and then handed to the sentinel, whose answer is returned: the
 * sentinel is the thing that survives the disk being swapped, and where one
 * exists it should be what decides.
 *
 * With no sentinel to hand it to, the device path is accepted. That is the
 * weakest branch here and it is deliberate: refusing instead makes syncy
 * unusable on a machine that publishes no uuid — a container, a system
 * without udev, or a root filesystem the initramfs named `/dev/root` — and a
 * tool that will not run is not safer than one that runs with a proof it has
 * labelled as weak. `resolveTarget` says so when the target is added, and
 * `syncy sentinel` is how someone upgrades it. What this must never do is
 * silently treat it as equal to a uuid, which is what it used to do.
 */
export async function targetReachability(target: Target): Promise<Reachability> {
  if (target.identity !== undefined && target.identity !== "") {
    const v = await checkVolume(target.path, target.identity);
    if (v !== "ok") return v === "unreachable" ? "unreachable" : "mismatch";
    // The volume is right; the directory still has to exist on it.
    if (!existsSync(target.path)) return "unreachable";
    if (identityIsProof(target) || target.sentinel === undefined) return "ok";
    return checkSentinel(target.path, target.sentinel);
  }
  if (!existsSync(target.path)) return "unreachable";
  if (target.sentinel === undefined) return "missing";
  return checkSentinel(target.path, target.sentinel);
}

/**
 * Whether a target's recorded identity names the volume, or merely where it
 * was plugged in this time.
 *
 * A device path is the one identity `identify` can return that a different
 * disk will answer to tomorrow — /dev/diskN on macOS, /dev/sdb1 on Linux —
 * and it is what the mount source falls back to when the kernel publishes no
 * uuid. Everything else in that field is a name for the volume: a uuid, or a
 * network share's host and export.
 *
 * The shape is the test rather than a fourth `identityKind`, because it needs
 * no migration and cannot disagree with the value it is describing: a config
 * written before this existed gets the same answer as one written after.
 */
export function identityIsProof(target: Target): boolean {
  const id = target.identity ?? "";
  if (id === "") return false;
  return !id.startsWith("/dev/");
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
  /**
   * The exit code rsync actually returned, not syncy's own verdict about it.
   *
   * `null` when no rsync invocation happened at all — the "missing" outcome,
   * where the destination folder does not exist and nothing is spawned. Never
   * synthesized from `outcome`: history.jsonl claims to record "every rsync
   * invocation, with literal argv and exit code", and a code invented from the
   * verdict is not that.
   */
  readonly exitCode: number | null;
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
      exitCode: null,
    };
  }

  const argv = argvFor(config, unit, target, mode);
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
      if (item.flags[1] === "f") {
        nFiles += 1;
        opts.onFile?.(nFiles, item.name);
      }
    },
  });

  // Exit 24 ("some files vanished before they could be transferred") is
  // routine on a live archive — a file lands or moves while rsync is mid-walk
  // — and does not mean the check found anything wrong. Counting it as an
  // error made a perfectly healthy folder read as broken on any check that
  // raced an ordinary write, and buried the codes that do matter, like 23
  // (partial transfer), under noise that fired constantly. 24 falls through
  // to the normal summarize path below; every other non-zero code is still
  // an error.
  if (result.exitCode !== 0 && result.exitCode !== 24) {
    return {
      scan: { ...base, outcome: "error", nChanges: 0, nExtra: 0, bytesPending: 0 },
      items,
      argv,
      targetFingerprint: null,
      exitCode: result.exitCode,
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
    exitCode: result.exitCode,
  };
}

export function ensureLogDir(): string {
  const d = logDir();
  mkdirSync(d, { recursive: true });
  return d;
}
