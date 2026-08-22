import { mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { FIXTURE_ROOT, isInside, PROJECT_ROOT } from "./helpers.ts";

/**
 * Loaded before any test file (see bunfig.toml).
 *
 * syncy resolves its config, state, logs and history from XDG_CONFIG_HOME and
 * XDG_STATE_HOME, falling back to ~/.config and ~/.local/state. A single test
 * that forgets to override those would write into the user's real directories.
 *
 * Rather than rely on every test remembering, they are redirected here, once,
 * for the whole run. Individual tests still narrow them to their own fixture;
 * this is the floor, not a replacement.
 */

const XDG_ROOT = join(FIXTURE_ROOT, "xdg");

for (const [name, sub] of [
  ["XDG_CONFIG_HOME", "config"],
  ["XDG_STATE_HOME", "state"],
  ["XDG_DATA_HOME", "data"],
  ["XDG_CACHE_HOME", "cache"],
] as const) {
  const dir = join(XDG_ROOT, sub);
  if (!isInside(dir, PROJECT_ROOT)) {
    throw new Error(`refusing to run tests: ${name} would resolve outside the project (${dir})`);
  }
  mkdirSync(dir, { recursive: true });
  process.env[name] = dir;
}

/**
 * A snapshot of the user's real syncy directories, taken before any test runs.
 *
 * The point is not that they must be absent — a person using syncy legitimately
 * creates them — but that a test run must leave them exactly as it found them.
 */
export interface RealDirSnapshot {
  readonly path: string;
  readonly exists: boolean;
  readonly mtimeMs: number | null;
}

function snapshot(path: string): RealDirSnapshot {
  try {
    return { path, exists: true, mtimeMs: statSync(path).mtimeMs };
  } catch {
    return { path, exists: false, mtimeMs: null };
  }
}

const home = process.env["HOME"] ?? homedir();
export const REAL_DIRS: readonly RealDirSnapshot[] = [
  join(home, ".config/syncy"),
  join(home, ".local/state/syncy"),
].map(snapshot);

// Stash on globalThis so test files read the pre-run values, not fresh ones.
(globalThis as Record<string, unknown>)["__syncyRealDirs"] = REAL_DIRS;

/**
 * Diagnostics off by default. A test that enabled SYNCY_DEBUG globally would
 * write a log on every run; tests that want it set it themselves.
 */
delete process.env["SYNCY_DEBUG"];
