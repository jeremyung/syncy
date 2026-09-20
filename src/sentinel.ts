import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_RSYNC } from "./rsync.ts";
import { makeStaging, removeStaging, stageFile } from "./staging.ts";

/**
 * The sentinel is the single most important safety feature (DESIGN.md section 2).
 *
 * `/Volumes/media` remains a writable directory on the boot disk when the share
 * is unmounted, and macOS remounts at `/Volumes/media-1` when a stale mount
 * lingers. Without this check an unattended rsync fills the startup disk with a
 * copy of the data it was meant to move off it.
 *
 * The file is built in syncy's own staging directory and delivered by rsync:
 * nothing lands in a target except through rsync.
 */
export const SENTINEL_NAME = ".syncy-dest-id";

export type SentinelStatus = "ok" | "missing" | "mismatch";

export function sentinelPath(root: string): string {
  return join(root, SENTINEL_NAME);
}

export function readSentinel(root: string): string | null {
  try {
    const v = readFileSync(sentinelPath(root), "utf8").trim();
    return v === "" ? null : v;
  } catch {
    return null;
  }
}

/**
 * Async twin of `readSentinel`, for the status path.
 *
 * `readFileSync` on a network mount that has died without unmounting blocks
 * the calling thread until the kernel gives up; on the event loop that is
 * the whole process. This read is issued to the runtime's file IO instead,
 * where the same stall blocks a worker thread, not the event loop — measured
 * against a blocking FIFO, the loop kept ticking the whole time — and
 * `targetReachability` bounds even that. The sync version stays:
 * `observeTargetSync` and the write boundary need the answer in the same
 * turn as the decision to spawn.
 */
export async function readSentinelAsync(root: string): Promise<string | null> {
  try {
    const v = (await Bun.file(sentinelPath(root)).text()).trim();
    return v === "" ? null : v;
  } catch {
    return null;
  }
}

export interface WriteSentinelOptions {
  readonly bin?: string;
  /** Provided id, for tests and for re-adopting a known target. */
  readonly id?: string;
}

/**
 * Writes a sentinel into a target root, via rsync.
 *
 * Returns the existing id untouched if the target already carries one, so
 * re-adding a target does not orphan the scans recorded against it.
 */
export async function writeSentinel(
  root: string,
  opts: WriteSentinelOptions = {},
): Promise<string> {
  const existing = readSentinel(root);
  if (existing !== null) return existing;

  const id = opts.id ?? randomUUID();
  const staging = makeStaging("sentinel");
  try {
    const staged = stageFile(staging, SENTINEL_NAME, id + "\n");

    const bin = opts.bin ?? DEFAULT_RSYNC;
    const proc = Bun.spawn([bin, "-a", staged, root.endsWith("/") ? root : root + "/"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    if (code !== 0) {
      throw new Error(
        `could not write the sentinel to ${root}: ${stderr.trim() || `exit ${code}`}`,
      );
    }
  } finally {
    removeStaging(staging);
  }

  const landed = readSentinel(root);
  if (landed !== id) {
    throw new Error(`the sentinel did not land at ${root}`);
  }
  return id;
}

export function checkSentinel(root: string, expected: string): SentinelStatus {
  const actual = readSentinel(root);
  if (actual === null) return "missing";
  return actual === expected ? "ok" : "mismatch";
}

/** Async twin of `checkSentinel`, mirroring its semantics exactly. */
export async function checkSentinelAsync(root: string, expected: string): Promise<SentinelStatus> {
  const actual = await readSentinelAsync(root);
  if (actual === null) return "missing";
  return actual === expected ? "ok" : "mismatch";
}
