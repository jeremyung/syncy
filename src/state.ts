import {
  appendFileSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Fingerprint } from "./fingerprint.ts";
import { debug } from "./log.ts";
import { historyFile, stateFile } from "./paths.ts";

/**
 * Two plain files, no database (DESIGN.md section 2).
 *
 * At one source root's subfolders times a couple of targets this is under 30
 * entries. Every argument for SQLite - concurrency, query planning, scale -
 * answers a problem this tool does not have. What matters more is that a tool
 * whose entire product is "trust my record" keeps a record you can cat, grep,
 * diff and back up without a client.
 */

export type Method = "quick" | "deep";
export type ScanOutcome = "clean" | "behind" | "missing" | "error";

export interface Scan {
  readonly unit: string;
  readonly target: string;
  readonly ts: number;
  readonly method: Method;
  readonly outcome: ScanOutcome;
  readonly nChanges: number;
  /** Of those, the ones absent from the destination entirely. */
  readonly nNew?: number;
  readonly nExtra: number;
  readonly bytesPending: number;
  readonly fingerprint: Fingerprint;
  readonly sentinel: string;
  /**
   * Wall-clock milliseconds the check took.
   *
   * The only honest basis for a deep-check progress bar. rsync reports nothing
   * usable while a checksum pass runs on large files, so the previous run's
   * duration is what the bar is measured against.
   */
  readonly durationMs?: number;
  readonly log?: string;
}

export interface State {
  readonly version: 1;
  readonly scans: readonly Scan[];
}

export const EMPTY_STATE: State = { version: 1, scans: [] };

/**
 * Validates one scan record loaded from disk, in the same hand-rolled style as
 * `parseConfig` (DESIGN.md §1, src/config.ts): every field checked, nothing
 * trusted just because it type-checked in a `.json` file that anyone can hand
 * edit or half-restore from a backup.
 *
 * Returns the reason as a string on failure rather than throwing — `loadState`
 * drops a bad record instead of raising, so the caller needs the reason for a
 * debug line, not an exception to catch.
 */
function validateScan(raw: unknown): Scan | string {
  if (typeof raw !== "object" || raw === null) return "not an object";
  const o = raw as Record<string, unknown>;

  const unit = o["unit"];
  const target = o["target"];
  const ts = o["ts"];
  const method = o["method"];
  const outcome = o["outcome"];
  const nChanges = o["nChanges"];
  const nExtra = o["nExtra"];
  const bytesPending = o["bytesPending"];
  const sentinel = o["sentinel"];
  const fingerprint = o["fingerprint"];
  const nNew = o["nNew"];
  const durationMs = o["durationMs"];
  const log = o["log"];

  if (typeof unit !== "string") return "unit is not a string";
  if (typeof target !== "string") return "target is not a string";
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "ts is not a finite number";
  if (method !== "quick" && method !== "deep") return `method is not "quick" or "deep"`;
  if (outcome !== "clean" && outcome !== "behind" && outcome !== "missing" && outcome !== "error") {
    return "outcome is not a recognised value";
  }
  if (typeof nChanges !== "number") return "nChanges is not a number";
  if (typeof nExtra !== "number") return "nExtra is not a number";
  if (typeof bytesPending !== "number") return "bytesPending is not a number";
  if (typeof sentinel !== "string") return "sentinel is not a string";

  if (typeof fingerprint !== "object" || fingerprint === null) return "fingerprint is not an object";
  const fp = fingerprint as Record<string, unknown>;
  const nfiles = fp["nfiles"];
  const bytes = fp["bytes"];
  const maxMtimeNs = fp["maxMtimeNs"];
  if (typeof nfiles !== "number") return "fingerprint.nfiles is not a number";
  if (typeof bytes !== "number") return "fingerprint.bytes is not a number";
  if (typeof maxMtimeNs !== "string") return "fingerprint.maxMtimeNs is not a string";

  if (nNew !== undefined && typeof nNew !== "number") return "nNew is not a number";
  if (durationMs !== undefined && typeof durationMs !== "number") return "durationMs is not a number";
  if (log !== undefined && typeof log !== "string") return "log is not a string";

  return {
    unit,
    target,
    ts,
    method,
    outcome,
    nChanges,
    nExtra,
    bytesPending,
    fingerprint: { nfiles, bytes, maxMtimeNs },
    sentinel,
    ...(nNew !== undefined ? { nNew } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(log !== undefined ? { log } : {}),
  };
}

export function loadState(file: string = stateFile()): State {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return EMPTY_STATE;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`state file is corrupt (${file}): ${(e as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null) throw new Error(`state file is corrupt (${file})`);
  const obj = raw as Record<string, unknown>;
  if (obj["version"] !== 1) {
    throw new Error(`unsupported state version in ${file}: ${String(obj["version"])}`);
  }
  if (!Array.isArray(obj["scans"])) {
    throw new Error(`state file is corrupt (${file}): scans is not an array`);
  }

  // Per-scan validation degrades gracefully where the checks above do not: a
  // corrupt individual record must cost a re-check, never a program that will
  // not start — a state file syncy cannot open is the one failure with no way
  // back in. Dropped records are reported through debug() rather than thrown
  // or returned, because there is no UI channel out of loadState; this is
  // deliberately quiet-but-recorded, not silent.
  const scans: Scan[] = [];
  (obj["scans"] as readonly unknown[]).forEach((entry, i) => {
    const result = validateScan(entry);
    if (typeof result === "string") {
      debug("state.scan.dropped", { file, index: i, reason: result });
      return;
    }
    scans.push(result);
  });
  return { version: 1, scans };
}

/**
 * Atomic: temp file in the same directory, fsync, rename.
 *
 * This is the worst file in the system to half-write. A torn verification
 * record is exactly the corruption that could make an unreplicated folder read
 * as `verified`.
 */
export function saveState(state: State, file: string = stateFile()): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.state.${process.pid}.${Date.now()}.tmp`);
  const body = JSON.stringify(state, null, 2) + "\n";
  const fd = openSync(tmp, "w", 0o644);
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

/**
 * Scans are identified by unit, target AND method.
 *
 * The two-clock rule (DESIGN.md section 5) needs the latest deep verify and the
 * latest quick check to coexist: a quick check run after a deep verify must not
 * evict the deep record, or the expensive clock would reset every time the
 * cheap one ran.
 */
export function upsertScan(state: State, scan: Scan): State {
  const next = state.scans.filter(
    (s) => !(s.unit === scan.unit && s.target === scan.target && s.method === scan.method),
  );
  next.push(scan);
  next.sort(
    (a, b) =>
      a.unit.localeCompare(b.unit) ||
      a.target.localeCompare(b.target) ||
      a.method.localeCompare(b.method),
  );
  return { version: 1, scans: next };
}

/**
 * Whether a recorded scan is evidence for a target resolving to `identity`.
 *
 * A scan is written against whatever volume the check actually ran on
 * (`scan.sentinel`), which was never compared back against anything — remove a
 * destination and add a different one under the same name, and the old
 * volume's clean verdicts were presented as evidence for the new one. An
 * empty recorded identity is treated as NOT matching: absence of provenance is
 * not evidence, so it can never satisfy a lookup.
 *
 * `identity` is required on every caller below (not optional, no default): an
 * optional identity that silently fell back to unfiltered matching is what let
 * the interactive Ledger keep showing a foreign volume's evidence after
 * `evaluateUnit` and the printed ledger were both fixed — a caller that
 * forgets to resolve one now fails to compile instead of quietly reading
 * wrong.
 */
function matchesIdentity(s: Scan, identity: string): boolean {
  return identity !== "" && s.sentinel === identity;
}

export function findScan(
  state: State,
  unit: string,
  target: string,
  method: Method,
  identity: string,
): Scan | undefined {
  return state.scans.find(
    (s) => s.unit === unit && s.target === target && s.method === method && matchesIdentity(s, identity),
  );
}

/** The most recent check of either method, which drives the cheap clock. */
export function latestScan(state: State, unit: string, target: string, identity: string): Scan | undefined {
  let best: Scan | undefined;
  for (const s of state.scans) {
    if (s.unit !== unit || s.target !== target) continue;
    if (!matchesIdentity(s, identity)) continue;
    if (best === undefined || s.ts > best.ts) best = s;
  }
  return best;
}

export interface HistoryEntry {
  readonly ts: number;
  readonly unit: string;
  readonly target: string;
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly log?: string;
}

/** Append-only, and separate from state so history writes can never endanger it. */
export function appendHistory(entry: HistoryEntry, file: string = historyFile()): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
}

/**
 * How long a check of this size is likely to take at this destination.
 *
 * Keyed to throughput, not to the same folder's previous run. Keying it to the
 * folder meant a 13 gb deep verify had to run twice before its bar moved once —
 * which for an archive that is checked occasionally is never. Throughput
 * generalises: one completed deep verify anywhere on a destination gives every
 * other folder on it an estimate, and a destination's read speed is the thing
 * that actually governs the wait.
 *
 * Deliberately per method and per destination. A quick check stats files and a
 * deep verify reads them; an SMD share and a local disk differ by two orders of
 * magnitude. Averaging across any of those would produce a confident wrong
 * number, which is worse than no bar.
 *
 * Deliberately NOT filtered by identity, unlike `findScan`/`latestScan`: this
 * estimates a destination's read throughput, not a verdict about a unit's
 * files. A volume swapped in under the same target name has its own, unknown
 * throughput, but the read speed of *some* drive at this target name is still
 * the best available guess until a sample exists for the new one.
 */
export function estimateMs(
  state: State,
  target: string,
  method: Method,
  bytes: number,
): number | undefined {
  if (bytes <= 0) return undefined;
  let sampleBytes = 0;
  let sampleMs = 0;
  for (const s of state.scans) {
    if (s.target !== target || s.method !== method) continue;
    if (s.durationMs === undefined || s.durationMs <= 0) continue;
    // A folder that was absent was never read, so its duration says nothing
    // about read speed.
    if (s.outcome === "missing" || s.outcome === "error") continue;
    if (s.fingerprint.bytes <= 0) continue;
    sampleBytes += s.fingerprint.bytes;
    sampleMs += s.durationMs;
  }
  if (sampleBytes <= 0 || sampleMs <= 0) return undefined;
  return Math.round((bytes * sampleMs) / sampleBytes);
}

/**
 * When a sync of this unit last reached this destination.
 *
 * The differences screen needs it to say which side of the last sync a missing
 * file falls on, which is the difference between an ordinary backlog and a file
 * that should already be there.
 *
 * Read from the history rather than from `state.json`, because a scan records
 * only checks: the scan records say when syncy last *looked*, and this has to
 * answer when it last *copied*. Exit 24 counts alongside 0 for the same reason
 * `checkUnit` treats it as success — files vanishing mid-run is routine on a
 * live archive and does not mean nothing was transferred.
 *
 * Returns null when nothing has ever synced, which the view reports as such
 * rather than dating everything from the epoch.
 */
export function lastSyncAt(
  unit: string,
  target: string,
  file: string = historyFile(),
): number | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null; // Nothing has ever synced; the file is written on first run.
  }
  let best: number | null = null;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue; // One torn line at the tail must not hide every sync before it.
    }
    if (typeof raw !== "object" || raw === null) continue;
    const o = raw as Record<string, unknown>;
    if (o["unit"] !== unit || o["target"] !== target) continue;
    if (o["exitCode"] !== 0 && o["exitCode"] !== 24) continue;
    const ts = o["ts"];
    if (typeof ts !== "number" || !Number.isFinite(ts)) continue;
    if (best === null || ts > best) best = ts;
  }
  return best;
}
