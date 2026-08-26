import { existsSync } from "node:fs";

/**
 * One place to answer "which operating system is running syncy".
 *
 * Everything that differs between macOS and Linux — where rsync lives, where
 * the mount table lives, how a volume is identified, which probe tools exist —
 * branches on this. Keeping the branch in one module means the per-module code
 * states its two platform behaviours side by side instead of scattering
 * process.platform checks.
 */
export const IS_MACOS = process.platform === "darwin";
export const IS_LINUX = process.platform === "linux";

/**
 * The first candidate that exists, or null.
 *
 * The same pinning discipline rsync gets: absolute paths only, never resolved
 * from PATH, so a planted executable cannot be pulled into the process.
 */
export function resolveBin(candidates: readonly string[]): string | null {
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}
