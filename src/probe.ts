import { rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_RSYNC } from "./rsync.ts";
import { makeStaging, removeStaging, stageFile } from "./staging.ts";

/**
 * Capability probe (DESIGN.md section 8).
 *
 * Before trusting -A/-X against an SMB share, measure it. Without this you get
 * the classic failure mode: -X cannot persist, every verify reports the same
 * files as changed forever, and nothing ever reaches `verified` with no
 * explanation offered.
 *
 * The payload is built in syncy's staging directory and delivered by rsync —
 * the same path a real sync takes, which is the only way the measurement means
 * anything. The one direct write into a target is removing the probe directory
 * afterwards, and that is scoped to a path syncy created and named.
 */

export const PROBE_DIR = ".syncy-probe";

export interface ProbeResult {
  readonly xattrs: boolean;
  readonly acls: boolean;
  /**
   * Whether POSIX permission bits survive the round trip.
   *
   * The same failure this probe was written for, in a mode it did not test.
   * An SMB share that maps every file to a fixed mode makes rsync report
   * `.f...p.....` for every file, on every check, forever — 2,508 of them on
   * one folder here. Content identical, permissions unreproducible, and the
   * listing permanently full of differences that can never be resolved.
   */
  readonly perms: boolean;
  /** Flags to drop for this target, derived from what actually survived. */
  readonly flagsDrop: readonly string[];
  readonly detail: string;
}

const XATTR_NAME = "com.syncy.probe";
const XATTR_VALUE = "v1";

async function run(argv: readonly string[]): Promise<{ code: number | null; out: string }> {
  const proc = Bun.spawn(argv as string[], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { code, out };
}

export async function probeTarget(targetRoot: string, bin: string = DEFAULT_RSYNC): Promise<ProbeResult> {
  const staging = makeStaging("probe");
  const landedDir = join(targetRoot, PROBE_DIR);

  try {
    const file = stageFile(staging, "probe.txt", "syncy capability probe\n");
    // A mode with bits a permissive share is unlikely to reproduce by accident.
    await run(["/bin/chmod", "0640", file]);

    await run(["/usr/bin/xattr", "-w", XATTR_NAME, XATTR_VALUE, file]);
    // An ALLOW ace, deliberately. A "deny delete" ace tests the same capability
    // but then blocks the probe's own cleanup, leaving undeletable files behind
    // in the user's target.
    await run(["/bin/chmod", "+a", "everyone allow read", file]);

    const sync = await run([bin, "-a", "-A", "-X", staging + "/", landedDir + "/"]);
    if (sync.code !== 0) {
      // Refusing the whole transfer is itself the answer: drop both flags.
      return {
        xattrs: false,
        acls: false,
        perms: false,
        flagsDrop: ["-A", "-X", "-p"],
        detail: "rsync could not transfer metadata to this target",
      };
    }

    const landed = join(landedDir, "probe.txt");
    const xattrList = await run(["/usr/bin/xattr", "-l", landed]);
    const aclList = await run(["/bin/ls", "-le", landed]);

    const xattrs = xattrList.out.includes(XATTR_NAME);
    const acls = /\d+:\s/.test(aclList.out);
    // Compared against what was sent, not against a fixed expectation: a share
    // that reports 0640 back is preserving permissions whatever else it does.
    const perms = modeOf(landed) === modeOf(file);

    const flagsDrop: string[] = [];
    if (!acls) flagsDrop.push("-A");
    if (!xattrs) flagsDrop.push("-X");
    if (!perms) flagsDrop.push("-p");

    const missing = [
      ...(acls ? [] : ["acls"]),
      ...(xattrs ? [] : ["xattrs"]),
      ...(perms ? [] : ["permissions"]),
    ];
    return {
      xattrs,
      acls,
      perms,
      flagsDrop,
      detail:
        missing.length === 0
          ? "acls, xattrs and permissions all survive"
          : `does not preserve ${missing.join(", ")}`,
    };
  } catch (e) {
    return {
      xattrs: false,
      acls: false,
      perms: false,
      flagsDrop: ["-A", "-X", "-p"],
      detail: `probe failed: ${(e as Error).message}`,
    };
  } finally {
    removeStaging(staging);
    removeProbeDir(landedDir);
  }
}

/**
 * Removes the probe directory from a target.
 *
 * The only direct removal syncy performs outside its own state directory, so it
 * refuses any path that is not exactly a `.syncy-probe` directory. Strips ACLs
 * first, since cleanup must not be blocked by the very thing being measured.
 */
export function removeProbeDir(dir: string): void {
  if (!dir.endsWith(`/${PROBE_DIR}`)) {
    throw new Error(`refusing to remove a path that is not a probe directory: ${dir}`);
  }
  try {
    Bun.spawnSync(["/bin/chmod", "-R", "-N", dir]);
  } catch {
    // No acls to strip, or chmod is unavailable; the removal below still tries.
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Leave a diagnosable directory rather than throwing out of a finally.
  }
}

/** The permission bits of a path, or null if it cannot be read. */
function modeOf(path: string): number | null {
  try {
    return statSync(path).mode & 0o7777;
  } catch {
    return null;
  }
}
