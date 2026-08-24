import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateDir } from "./paths.ts";

/**
 * Diagnostics, off unless asked for.
 *
 * A TUI cannot print to stdout while Ink owns the screen, so when syncy seems
 * to hang there is nowhere for it to say why. This writes to a file instead.
 * Enable with SYNCY_DEBUG=1; the log is append-only and safe to delete.
 */

export const debugLogPath = (): string => join(stateDir(), "debug.log");

const enabled = (): boolean => {
  const v = process.env["SYNCY_DEBUG"];
  return v !== undefined && v !== "" && v !== "0";
};

let warned = false;

/**
 * Rotate at this size, keeping one previous file.
 *
 * Diagnostics are worth leaving on — a full run writes about fifty lines and
 * costs under two milliseconds — but only if they cannot grow without bound in
 * a directory the user is not watching. Two megabytes holds weeks of runs and
 * is still greppable.
 */
export const MAX_LOG_BYTES = 2 * 1024 * 1024;

/** Rolls the log over when it gets large, keeping exactly one previous file. */
function rotate(file: string): void {
  try {
    if (statSync(file).size < MAX_LOG_BYTES) return;
  } catch {
    return; // No file yet, nothing to rotate.
  }
  try {
    renameSync(file, `${file}.1`);
  } catch {
    // A failed rotation must not stop the program logging, or lose the entry.
  }
}

export function debug(message: string, detail?: Record<string, unknown>): void {
  if (!enabled()) return;
  try {
    const file = debugLogPath();
    mkdirSync(dirname(file), { recursive: true });
    rotate(file);
    const suffix = detail === undefined ? "" : " " + JSON.stringify(detail);
    appendFileSync(file, `${new Date().toISOString()} ${message}${suffix}\n`, "utf8");
  } catch {
    // Diagnostics must never take the program down. Complain once to stderr,
    // which is harmless even under Ink, then stay quiet.
    if (!warned) {
      warned = true;
      process.stderr.write("syncy: could not write the debug log\n");
    }
  }
}

/** Times an async call. Same contract as `timed`, for anything that awaits. */
export async function timedAsync<T>(
  label: string,
  slowMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  if (!enabled()) return fn();
  const started = Date.now();
  try {
    return await fn();
  } finally {
    const took = Date.now() - started;
    debug(`${took >= slowMs ? "slow: " : ""}${label}`, { ms: took });
  }
}

/** Times a synchronous call and logs anything slow enough to look like a hang. */
export function timed<T>(label: string, slowMs: number, fn: () => T): T {
  if (!enabled()) return fn();
  const started = Date.now();
  try {
    return fn();
  } finally {
    const took = Date.now() - started;
    if (took >= slowMs) debug(`slow: ${label}`, { ms: took });
    else debug(label, { ms: took });
  }
}
