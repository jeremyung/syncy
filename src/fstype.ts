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
    const flags = m[3]!.split(",").map((f) => f.trim()).filter((f) => f !== "");
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

/** The longest matching mount point wins, since mounts nest. */
export function fstypeFor(path: string, entries: readonly MountEntry[]): string {
  let best: MountEntry | undefined;
  for (const e of entries) {
    const point = e.mountPoint.endsWith("/") ? e.mountPoint.slice(0, -1) : e.mountPoint;
    const prefix = point === "" ? "/" : point;
    if (path === prefix || path.startsWith(prefix === "/" ? "/" : prefix + "/")) {
      if (best === undefined || prefix.length > best.mountPoint.length) best = e;
    }
  }
  return best?.fstype ?? "unknown";
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

export async function detectFstype(path: string): Promise<string> {
  try {
    const proc = Bun.spawn(["/sbin/mount"], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return fstypeFor(path, parseMount(out));
  } catch {
    return "unknown";
  }
}
