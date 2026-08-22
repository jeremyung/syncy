import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { stateDir } from "./paths.ts";

/**
 * Scratch space inside syncy's own state directory.
 *
 * Policy (DESIGN.md section 2): syncy writes directly only within its own
 * config and state directories. Anything that lands in a source or target
 * directory gets there via rsync. Files that need to be delivered to a target —
 * the sentinel, the capability probe's payload — are built here first and
 * rsynced across.
 */

export const STAGING_PREFIX = "staging-";

export function stagingRoot(): string {
  return join(stateDir(), "staging");
}

/** A fresh scratch directory. Always inside the state directory, never a target. */
export function makeStaging(label: string): string {
  const root = stagingRoot();
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, `${STAGING_PREFIX}${label}-`));
  if (!isInsideStaging(dir)) {
    throw new Error(`refusing a staging directory outside the state directory: ${dir}`);
  }
  return dir;
}

/**
 * Writes a file into a staging directory.
 *
 * The only way syncy creates a file destined for a target. Keeping it here
 * means no other module needs a direct write call, which is what makes the
 * write-policy test meaningful rather than a list of exceptions.
 */
export function stageFile(dir: string, name: string, content: string): string {
  if (!isInsideStaging(dir)) {
    throw new Error(`refusing to stage a file outside the staging root: ${dir}`);
  }
  const path = join(dir, name);
  writeFileSync(path, content, { encoding: "utf8", mode: 0o644 });
  return path;
}

export function isInsideStaging(path: string): boolean {
  const a = resolve(path);
  const b = resolve(stagingRoot());
  return a !== b && a.startsWith(b.endsWith(sep) ? b : b + sep);
}

/**
 * Removes a staging directory, refusing anything outside the staging root.
 *
 * This is the guard that keeps a bug in a caller from turning into an rm of
 * something real.
 */
export function removeStaging(dir: string): void {
  if (!isInsideStaging(dir)) {
    throw new Error(`refusing to remove a path outside staging: ${dir}`);
  }
  rmSync(dir, { recursive: true, force: true });
}
