import { type Dirent, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Config, Target } from "./config.ts";
import { buildDiffFromAccumulator, createDiffAccumulator, type Diff } from "./diff.ts";
import { type Fingerprint, fingerprint } from "./fingerprint.ts";
import { isNew, parseItemizeLine } from "./itemize.ts";
import { logDir } from "./paths.ts";
import { argvFor, type Mode, RsyncError, runRsync } from "./rsync.ts";
import { checkSentinel, readSentinel, type SentinelStatus } from "./sentinel.ts";
import type { Method, Scan } from "./state.ts";
import { checkVolume, identifySync } from "./volume.ts";

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
 * Final write-boundary reachability check.
 *
 * The interactive ledger's reachability map is intentionally cached and may
 * be minutes old while a person reads the confirmation page. A sync must not
 * reuse that answer. This version reads the current mount table and identity
 * synchronously so `startSync` can run it immediately before `Bun.spawn`.
 */
export interface TargetObservation {
  readonly reachability: Reachability;
  /** Identity actually observed at the destination, or empty when absent. */
  readonly identity: string;
}

export type FailedReachability = Exclude<Reachability, "ok">;

/** A queued check reached its own fresh boundary and found no safe target. */
export class TargetCheckError extends RsyncError {
  readonly targetName: string;
  readonly reachability: FailedReachability;

  constructor(target: Target, reachability: FailedReachability) {
    super(`refusing to check: destination ${target.name} is ${reachability} at ${target.path}`);
    this.name = "TargetCheckError";
    this.targetName = target.name;
    this.reachability = reachability;
  }
}

function assertTargetReachable(
  target: Target,
  observation: TargetObservation,
): asserts observation is TargetObservation & { readonly reachability: "ok" } {
  if (observation.reachability !== "ok") {
    throw new TargetCheckError(target, observation.reachability);
  }
}

/** Fresh destination observation, with the provenance to stamp on a scan. */
export function observeTargetSync(target: Target): TargetObservation {
  if (target.identity !== undefined && target.identity !== "") {
    const found = identifySync(target.path);
    if (found === null) return { reachability: "unreachable", identity: "" };
    if (found.id !== target.identity) return { reachability: "mismatch", identity: found.id };
    if (!existsSync(target.path)) return { reachability: "unreachable", identity: found.id };
    if (identityIsProof(target) || target.sentinel === undefined) {
      return { reachability: "ok", identity: found.id };
    }
    return {
      reachability: checkSentinel(target.path, target.sentinel),
      identity: found.id,
    };
  }
  if (!existsSync(target.path)) return { reachability: "unreachable", identity: "" };
  if (target.sentinel === undefined) return { reachability: "missing", identity: "" };
  const actual = readSentinel(target.path);
  return {
    reachability: actual === null ? "missing" : actual === target.sentinel ? "ok" : "mismatch",
    identity: actual ?? "",
  };
}

export function targetReachabilitySync(target: Target): Reachability {
  return observeTargetSync(target).reachability;
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
  /** Bounded, streaming diff evidence from the itemize output. */
  readonly diff: Diff;
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
  /**
   * Aborts the rsync this check spawns.
   *
   * A check is read-only, so there is nothing to unwind — but it is also the
   * longest-running thing syncy does, and a deep verify reads both sides of
   * every file. Without this, quitting left the child running: the interface
   * was gone and the disks were not.
   */
  readonly signal?: AbortSignal;
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

  // The reachability map belongs to the ledger refresh and may be stale by
  // the time this queued check gets its turn. Establish that the destination
  // is still the recorded volume before even reading its unit. This also keeps
  // an unmounted path from being mistaken for a legitimate "missing" folder.
  const initialObservation = observeTargetSync(target);
  assertTargetReachable(target, initialObservation);

  const accumulator = createDiffAccumulator();

  // Nothing at the destination at all: report it directly rather than letting
  // rsync itemize the entire tree as pending.
  if (!existsSync(join(target.path, unit))) {
    // The observation used for the record is taken after the existence check,
    // so a target replaced while the queued job waited cannot stamp the old
    // identity into a new "missing" result.
    const observation = observeTargetSync(target);
    assertTargetReachable(target, observation);
    const base = {
      unit,
      target: target.name,
      ts: now,
      method: methodOf(mode),
      fingerprint: fp,
      sentinel: observation.identity,
    } as const;
    const diff = buildDiffFromAccumulator(unit, target.name, methodOf(mode), accumulator, {
      ts: now,
      wholeFolderMissing: true,
      source: fp,
    });
    return {
      scan: { ...base, outcome: "missing", nChanges: 0, nExtra: 0, bytesPending: 0 },
      diff,
      argv: [],
      targetFingerprint: null,
      exitCode: null,
    };
  }

  const argv = argvFor(config, unit, target, mode);
  // This is deliberately the last destination operation before runRsync.
  // Every check must re-read the mount table/identity at its own write-free
  // boundary: another queued check may have occupied the time since the map
  // was built, and a drive can be swapped during that interval.
  const observation = observeTargetSync(target);
  assertTargetReachable(target, observation);
  const base = {
    unit,
    target: target.name,
    ts: now,
    method: methodOf(mode),
    fingerprint: fp,
    sentinel: observation.identity,
  } as const;
  let nFiles = 0;
  let nChanges = 0;
  let nNew = 0;
  let nExtra = 0;
  let bytesPending = 0;
  const result = await runRsync(argv, {
    ...(opts.bin !== undefined ? { bin: opts.bin } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    onLine: (line) => {
      opts.onLine?.(line);
      const item = parseItemizeLine(line);
      if (item === null) return;
      accumulator.add(item);
      if (item.kind === "extra") {
        nExtra += 1;
      } else if (item.kind === "change") {
        nChanges += 1;
        if (isNew(item)) nNew += 1;
        // Directories carry a size but transfer no file content.
        if (item.flags[1] === "f") bytesPending += item.bytes;
      }
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
      diff: buildDiffFromAccumulator(unit, target.name, methodOf(mode), accumulator, {
        ts: now,
        source: fp,
      }),
      argv,
      targetFingerprint: null,
      exitCode: result.exitCode,
    };
  }

  // After rsync, not before: the walk is read-only and cheap next to a check,
  // but doing it first would delay the run for a number only shown afterwards.
  const targetFingerprint = fingerprint(join(target.path, unit), config.exclude);
  const diff = buildDiffFromAccumulator(unit, target.name, methodOf(mode), accumulator, {
    ts: now,
    source: fp,
    target: targetFingerprint,
  });
  return {
    scan: {
      ...base,
      durationMs: Date.now() - startedAt,
      outcome: nChanges === 0 ? "clean" : "behind",
      nChanges,
      nNew,
      nExtra,
      bytesPending,
    },
    diff,
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
