/**
 * Filesystem detection for a target path (DESIGN.md section 7).
 *
 * Adding a target is the moment to learn what it is, because the answer changes
 * the rsync flags forever after. exFAT's two-second timestamp granularity makes
 * every file look perpetually changed without --modify-window=2.
 */

export interface MountEntry {
  readonly device: string;
  readonly mountPoint: string;
  readonly fstype: string;
  /** Mount options after the filesystem type, as `mount` prints them. */
  readonly flags: readonly string[];
  /**
   * True when the kernel calls this a local filesystem.
   *
   * The one bit that separates a disk from a network share, straight from the
   * kernel — no filesystem allow-list to keep up to date as new ones appear.
   */
  readonly local: boolean;
}

/** Parses BSD `mount` output: `device on /point (fstype, opts...)`. */
export function parseMount(output: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const line of output.split("\n")) {
    // The whole parenthesised list, not just the first item. `mount` reports
    //   //user@host/share on /Volumes/share (smbfs, nodev, nosuid, ...)
    //   /dev/disk4s1 on /Volumes/Archive (hfs, local, nodev, nosuid, ...)
    // and the `local` flag is the cheapest, most reliable way to tell a
    // network share from a disk — no diskutil, no filesystem allow-list to
    // keep current. Stopping at the first comma threw it away.
    const m = /^(.*?) on (.*?) \(([^)]*)\)/.exec(line.trim());
    if (m === null) continue;
    const flags = m[3]!
      .split(",")
      .map((f) => f.trim())
      .filter((f) => f !== "");
    const fstype = flags[0] ?? "unknown";
    entries.push({
      device: m[1]!,
      mountPoint: m[2]!,
      fstype,
      flags: flags.slice(1),
      local: flags.includes("local"),
    });
  }
  return entries;
}

/**
 * The mount entry whose mount point is the longest prefix of `path` — the
 * search `fstypeFor` and volume.ts's `mountFor` both need, since mounts nest
 * and the deepest one that still contains `path` is the one that governs it.
 *
 * Lives here, in the dependency-free module, so both callers can share this
 * one implementation without an import cycle (volume.ts already imports from
 * here; the reverse would not compile).
 *
 * The length compared is the *normalised* prefix's — trailing slashes
 * stripped — on both sides. Comparing it against a candidate's raw,
 * unnormalised `mountPoint.length` was a latent bug: a mount point recorded
 * with a trailing slash could then beat a longer, correct match by looking
 * one character longer than it actually was.
 */
export function mountEntryFor(
  path: string,
  entries: readonly MountEntry[],
): MountEntry | undefined {
  let best: MountEntry | undefined;
  let bestPrefixLen = -1;
  for (const e of entries) {
    const point = e.mountPoint.endsWith("/") ? e.mountPoint.slice(0, -1) : e.mountPoint;
    const prefix = point === "" ? "/" : point;
    if (path === prefix || path.startsWith(prefix === "/" ? "/" : prefix + "/")) {
      if (prefix.length > bestPrefixLen) {
        best = e;
        bestPrefixLen = prefix.length;
      }
    }
  }
  return best;
}

/** The longest matching mount point wins, since mounts nest. */
export function fstypeFor(path: string, entries: readonly MountEntry[]): string {
  return mountEntryFor(path, entries)?.fstype ?? "unknown";
}

/**
 * Timestamp granularity by filesystem. FAT-family filesystems round to two
 * seconds; everything else here is precise enough to leave at zero.
 */
export function modifyWindowFor(fstype: string): number {
  const f = fstype.toLowerCase();
  if (f.includes("exfat") || f.includes("msdos") || f.includes("fat")) return 2;
  return 0;
}

export const PSEUDO_FSTYPES: ReadonlySet<string> = new Set([
  "tmpfs",
  "devtmpfs",
  "devpts",
  "proc",
  "sysfs",
  "cgroup",
  "cgroup2",
  "pstore",
  "securityfs",
  "debugfs",
  "tracefs",
  "configfs",
  "fusectl",
  "mqueue",
  "hugetlbfs",
  "bpf",
  "autofs",
  "binfmt_misc",
  "rpc_pipefs",
  "nsfs",
  "ramfs",
  "efivarfs",
  "selinuxfs",
  "swap",
  "overlay",
  "squashfs",
  "fuse",
  "fuse.lxcfs",
  "fuse.portal",
]);

/**
 * Parses Linux `/proc/mounts`: `device mountpoint fstype options 0 0`.
 *
 * A space, tab or newline inside a mount point is octal-escaped (`\\040`,
 * `\\010`, `\\012`), so the line is split on raw whitespace first and each
 * field is unescaped afterwards — splitting on spaces alone would mangle a
 * mount point that contains one, and the unescape has to happen per field.
 *
 * `/proc/mounts` carries no `local` flag the way BSD `mount` does, so it is
 * derived: a network filesystem's device is the remote source
 * (`//server/share`, `host:/export`), never `/dev/...`, and everything that
 * is neither a block device nor a known pseudo-filesystem (zfs, a FUSE remote)
 * is reported as not local, which is the conservative answer.
 */
export function parseProcMounts(text: string): MountEntry[] {
  // Not named `unescape`: that is a deprecated global, and shadowing it is
  // exactly the kind of accident this parser is written to avoid.
  const unescapeField = (field: string): string =>
    field.replace(/\\([0-7]{3})/g, (_, octal: string) =>
      String.fromCharCode(Number.parseInt(octal, 8)),
    );
  const entries: MountEntry[] = [];
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/).map(unescapeField);
    if (parts.length < 3) continue;
    const device = parts[0]!;
    const mountPoint = parts[1]!;
    const fstype = parts[2]!;
    // A real line always has a device, an absolute mount point and a type.
    // Requiring the leading slash is what keeps "not a mount line" from
    // parsing as a mount at `a` of type `mount`.
    if (device === "" || mountPoint === "" || fstype === "" || !mountPoint.startsWith("/"))
      continue;
    const flags = (parts[3] ?? "")
      .split(",")
      .map((f) => f.trim())
      .filter((f) => f !== "");
    entries.push({
      device,
      mountPoint,
      fstype,
      flags,
      local: device.startsWith("/dev/") || PSEUDO_FSTYPES.has(fstype.toLowerCase()),
    });
  }
  return entries;
}

/** The longest matching mount point wins, since mounts nest. */
