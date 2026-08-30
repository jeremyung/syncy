import { existsSync, statfsSync } from "node:fs";
import type { Config, Target } from "./config.ts";
import { timed, timedAsync } from "./log.ts";
import { checkBuild, DEFAULT_RSYNC } from "./rsync.ts";
import { targetReachability } from "./scan.ts";

/**
 * Pre-flight checks for a real sync (DESIGN.md section 6).
 *
 * These run before the confirm page renders, so the user reads the verdict of
 * every check rather than a bare "are you sure?". Nothing is implied: the page
 * states plainly that this is not a dry run.
 */

export type GuardName = "rsync" | "source" | "volume" | "space" | "dry run";

export interface GuardCheck {
  readonly name: GuardName;
  /** `false` blocks the launch. */
  readonly ok: boolean;
  /** `true` when the check passes but the user still needs to read it. */
  readonly warn?: boolean;
  readonly detail: string;
}

export interface Preflight {
  readonly checks: readonly GuardCheck[];
  readonly ok: boolean;
  readonly freeAfter: number | null;
}

/** Headroom over the pending bytes, for rsync's temp files and metadata. */
export const SPACE_MARGIN = 1.05;

export function freeBytes(path: string): number | null {
  try {
    const s = statfsSync(path);
    return Number(s.bsize) * Number(s.bavail);
  } catch {
    return null;
  }
}

/**
 * The invariant that matters most, restated as a user-visible check.
 *
 * `assertDeleteIsDryRun` already refuses at spawn time; this surfaces the same
 * fact on the page so a sync that *would* delete can never be launched by
 * someone who did not read that it deletes.
 */
export function deleteCheck(argv: readonly string[]): GuardCheck {
  const deletes = argv.some((a) => a === "--delete" || a.startsWith("--delete-"));
  const dryRun = argv.some(
    (a) => a === "-n" || a === "--dry-run" || (/^-[a-zA-Z]+$/.test(a) && a.includes("n")),
  );
  if (deletes && !dryRun) {
    return { name: "dry run", ok: false, detail: "argv contains --delete without --dry-run" };
  }
  if (dryRun) {
    return { name: "dry run", ok: true, detail: "yes — nothing will be written" };
  }
  return { name: "dry run", ok: true, warn: true, detail: `no — this writes to the target` };
}

export async function preflight(
  config: Config,
  target: Target,
  argv: readonly string[],
  bytesPending: number,
  bin: string = DEFAULT_RSYNC,
): Promise<Preflight> {
  const checks: GuardCheck[] = [];

  // Each check is timed separately. Pressing [s] felt slow and there was no way
  // to see which of these was responsible — every one of them can touch a
  // network share, where a call that is instant locally costs seconds.
  const build = await timedAsync("preflight.rsyncBuild", 200, () => checkBuild(bin));
  checks.push({
    name: "rsync",
    ok: build.ok,
    detail: build.ok ? `${build.version} at ${build.detail}` : build.detail,
  });

  checks.push({
    name: "source",
    ok: timed("preflight.sourceExists", 200, () => existsSync(config.source)),
    detail: config.source,
  });

  // Reachability is decided by the sentinel, never by the path existing: an
  // unmounted /Volumes/x is still a writable directory on the boot disk.
  const reach = await timedAsync("preflight.reachability", 200, () => targetReachability(target));
  checks.push({
    name: "volume",
    ok: reach === "ok",
    detail:
      reach === "ok"
        ? `${target.name} · ${(target.identity ?? target.sentinel ?? "").slice(0, 24)}`
        : `${reach} — refusing to write to ${target.path}`,
  });

  const free = timed("preflight.freeSpace", 200, () => freeBytes(target.path));
  const needed = Math.ceil(bytesPending * SPACE_MARGIN);
  checks.push({
    name: "space",
    ok: free === null ? false : free >= needed,
    detail:
      free === null
        ? "could not read free space at the destination"
        : `${needed} needed, ${free} available`,
  });

  checks.push(deleteCheck(argv));

  return {
    checks,
    ok: checks.every((c) => c.ok),
    freeAfter: free === null ? null : free - bytesPending,
  };
}
