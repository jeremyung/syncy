import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/**
 * Every fixture lives inside the project directory.
 *
 * Tests here create real files, run real rsync, and write real sentinels. That
 * is deliberate — the behaviours worth testing are the ones that touch the
 * filesystem — so the containment has to be structural rather than a
 * convention: nothing this suite creates may land outside the repo, where it
 * could be mistaken for, or collide with, real data.
 */

/** The repo root: this file lives in <root>/test. */
export const PROJECT_ROOT = resolve(import.meta.dir, "..");

/** All fixtures go here. Gitignored, and safe to delete at any time. */
export const FIXTURE_ROOT = join(PROJECT_ROOT, ".test-tmp");

/** True when `path` is inside `root` — the containment check, not a string match. */
export function isInside(path: string, root: string): boolean {
  const a = resolve(path);
  const b = resolve(root);
  return a !== b && a.startsWith(b.endsWith(sep) ? b : b + sep);
}

/**
 * A fresh fixture directory inside the project.
 *
 * Throws rather than returning a path outside the project, so a future edit
 * cannot quietly reintroduce writes to the system temp directory or anywhere
 * else on the machine.
 */
export function makeFixtureDir(prefix: string): string {
  mkdirSync(FIXTURE_ROOT, { recursive: true });
  const dir = mkdtempSync(join(FIXTURE_ROOT, prefix.endsWith("-") ? prefix : prefix + "-"));
  if (!isInside(dir, PROJECT_ROOT)) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`refusing a fixture outside the project: ${dir}`);
  }
  return dir;
}

/** Removes a fixture, refusing anything that is not one of ours. */
export function removeFixtureDir(dir: string): void {
  if (!isInside(dir, FIXTURE_ROOT)) {
    throw new Error(`refusing to remove a path outside the fixture root: ${dir}`);
  }
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Polls until `predicate` holds, rather than sleeping a fixed duration.
 *
 * These tests spawn real rsync, so a fixed `await sleep(2500)` is a bet on how
 * busy the machine is. Under a full-suite run that bet loses occasionally, and
 * the failure looks like a product bug rather than a slow subprocess. Polling
 * finishes as soon as the condition is true and fails with a useful message
 * when it never is.
 */
export async function waitFor(
  predicate: () => boolean,
  options: { readonly timeout?: number; readonly interval?: number; readonly what?: string } = {},
): Promise<void> {
  const timeout = options.timeout ?? 15_000;
  const interval = options.interval ?? 25;
  const deadline = Date.now() + timeout;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeout}ms waiting for ${options.what ?? "a condition"}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}
