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
  return { version: 1, scans: obj["scans"] as Scan[] };
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

export function findScan(
  state: State,
  unit: string,
  target: string,
  method: Method,
): Scan | undefined {
  return state.scans.find((s) => s.unit === unit && s.target === target && s.method === method);
}

/** The most recent check of either method, which drives the cheap clock. */
export function latestScan(state: State, unit: string, target: string): Scan | undefined {
  let best: Scan | undefined;
  for (const s of state.scans) {
    if (s.unit !== unit || s.target !== target) continue;
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
