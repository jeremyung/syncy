import { rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { IS_MACOS, resolveBin } from "./platform.ts";
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

const XATTR_VALUE = "v1";

/**
 * The probe's extended attribute, by platform namespace.
 *
 * macOS stores it as `com.syncy.probe`. Linux allows unprivileged processes to
 * write only the `user.` namespace, and a dot in the name after the prefix is
 * refused by the kernel, hence the single word.
 */
const XATTR_NAME = IS_MACOS ? "com.syncy.probe" : "user.syncyprobe";

/**
 * The tools a capability probe needs, in argv form.
 *
 * macOS answers with the BSD tools: `xattr` for extended attributes, and
 * `chmod +a` / `ls -le` for ACLs. Linux uses the `attr` and `acl` packages —
 * `setfattr`/`getfattr` and `setfacl`/`getfacl`. Both are pinned to absolute
 * paths, /usr/bin first (merged-usr distros) and /bin for the older layout.
 *
 * When a tool is not installed, `missing` names the capability it cannot
 * measure, and the probe skips both the set and the get for it: a missing
 * tool means the capability is *unmeasurable*, which the result reports as
 * such and resolves by dropping the flag — the safe outcome, honestly
 * labelled, and one that cannot take down the measurement of the others.
 */
interface ProbeTools {
  readonly setXattr: readonly string[];
  readonly getXattr: readonly string[];
  readonly setAcl: readonly string[];
  readonly getAcl: readonly string[];
  readonly stripAcl: readonly string[];
  /** Which capabilities could not be measured because their tools are absent. */
  readonly missing: readonly string[];
}

function probeTools(): ProbeTools {
  if (IS_MACOS) {
    return {
      setXattr: ["/usr/bin/xattr", "-w", XATTR_NAME, XATTR_VALUE],
      getXattr: ["/usr/bin/xattr", "-l"],
      setAcl: ["/bin/chmod", "+a", "everyone allow read"],
      getAcl: ["/bin/ls", "-le"],
      stripAcl: ["/bin/chmod", "-R", "-N"],
      missing: [],
    };
  }
  const missing: string[] = [];
  const setfattr = resolveBin(["/usr/bin/setfattr", "/bin/setfattr"]);
  const getfattr = resolveBin(["/usr/bin/getfattr", "/bin/getfattr"]);
  const setfacl = resolveBin(["/usr/bin/setfacl", "/bin/setfacl"]);
  const getfacl = resolveBin(["/usr/bin/getfacl", "/bin/getfacl"]);
  if (setfattr === null || getfattr === null) missing.push("xattrs");
  if (setfacl === null || getfacl === null) missing.push("acls");
  return {
    setXattr: [setfattr ?? "setfattr", "-n", XATTR_NAME, "-v", XATTR_VALUE],
    getXattr: [getfattr ?? "getfattr"],
    // `nobody` exists on every Linux box; an entry for it tests exactly what
    // an `everyone` ACE tests on macOS.
    setAcl: [setfacl ?? "setfacl", "-m", "u:nobody:rx"],
    getAcl: [getfacl ?? "getfacl", "--omit-header"],
    stripAcl: [setfacl ?? "setfacl", "-R", "-b"],
    missing,
  };
}

async function run(argv: readonly string[]): Promise<{ code: number | null; out: string }> {
  const proc = Bun.spawn(argv as string[], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { code, out };
}

export async function probeTarget(
  targetRoot: string,
  bin: string = DEFAULT_RSYNC,
): Promise<ProbeResult> {
  const staging = makeStaging("probe");
  const landedDir = join(targetRoot, PROBE_DIR);
  const tools = probeTools();

  try {
    const file = stageFile(staging, "probe.txt", "syncy capability probe\n");
    // A mode with bits a permissive share is unlikely to reproduce by accident.
    await run(["/bin/chmod", "0640", file]);

    // A failed *set* means the capability could not be exercised, which is
    // reported as unmeasured rather than claimed as "not preserved": a
    // read-only filesystem fails the set, not the preservation.
    const xattrSet = tools.missing.includes("xattrs")
      ? 1
      : (await run([...tools.setXattr, file])).code;
    const aclSet = tools.missing.includes("acls") ? 1 : (await run([...tools.setAcl, file])).code;
    const xattrMeasured = xattrSet === 0;
    const aclMeasured = aclSet === 0;

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
    // The get is skipped, not run against a missing tool, for a capability
    // that was not measured: Bun.spawn throws on a nonexistent binary, and a
    // probe that fails on an absent getfattr must not lose the permissions
    // answer it could have given.
    let xattrs = false;
    let acls = false;
    if (xattrMeasured) {
      const xattrList = await run([...tools.getXattr, landed]);
      xattrs = xattrList.out.includes(XATTR_NAME);
    }
    if (aclMeasured) {
      const aclList = await run([...tools.getAcl, landed]);
      // macOS: `ls -le` prints ACL entries as numbered lines. Linux: getfacl
      // prints named entries as `user:nobody:r-x`; the base three entries
      // have an empty name, so the non-empty name is what distinguishes a
      // real ACL.
      acls = IS_MACOS
        ? /\d+:\s/.test(aclList.out)
        : /(?:user|group):[^:\s]+:[-rwx]+/.test(aclList.out);
    }
    // Compared against what was sent, not against a fixed expectation: a share
    // that reports 0640 back is preserving permissions whatever else it does.
    const perms = modeOf(landed) === modeOf(file);

    const flagsDrop: string[] = [];
    if (!acls) flagsDrop.push("-A");
    if (!xattrs) flagsDrop.push("-X");
    if (!perms) flagsDrop.push("-p");

    const missing: string[] = [];
    const unmeasured: string[] = [];
    // A failed *set* (or an absent tool) means the capability could not be
    // exercised. That is reported as unmeasured, not folded into "does not
    // preserve": a read-only filesystem fails the set, not the preservation.
    if (tools.missing.includes("xattrs") || !xattrMeasured) unmeasured.push("xattrs");
    if (tools.missing.includes("acls") || !aclMeasured) unmeasured.push("acls");
    if (!unmeasured.includes("acls") && !acls) missing.push("acls");
    if (!unmeasured.includes("xattrs") && !xattrs) missing.push("xattrs");
    if (!perms) missing.push("permissions");
    return {
      xattrs,
      acls,
      perms,
      flagsDrop,
      detail:
        missing.length === 0 && unmeasured.length === 0
          ? "acls, xattrs and permissions all survive"
          : [
              ...(missing.length === 0 ? [] : [`does not preserve ${missing.join(", ")}`]),
              ...(unmeasured.length === 0 ? [] : [`could not measure ${unmeasured.join(", ")}`]),
            ].join(" · "),
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
    // macOS: BSD `chmod -N` strips the ACL entries. Linux: setfacl -b does.
    if (IS_MACOS) {
      Bun.spawnSync(["/bin/chmod", "-R", "-N", dir]);
    } else {
      const setfacl = resolveBin(["/usr/bin/setfacl", "/bin/setfacl"]);
      if (setfacl !== null) Bun.spawnSync([setfacl, "-R", "-b", dir]);
    }
  } catch {
    // No acls to strip, or the tool is unavailable; the removal below still tries.
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
