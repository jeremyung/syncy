import { readFileSync, statfsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  fstypeFor,
  type MountEntry,
  mountEntryFor,
  PSEUDO_FSTYPES,
  parseMount,
  parseProcMounts,
} from "./fstype.ts";
import { IS_LINUX, IS_MACOS } from "./platform.ts";

/**
 * Identifying a destination without writing anything to it.
 *
 * The sentinel file is the stronger check, but it costs a file on the user's
 * volume. This asks the operating system instead: which volume is actually
 * mounted at this path, and is it the one recorded when the target was added?
 *
 * What it catches — a different volume mounted at the same path, and nothing
 * mounted at all, which is the case that would otherwise fill the boot disk.
 * What it misses — the same volume with the target directory deleted and
 * recreated. The sentinel catches that; this cannot.
 */

/** Filesystems with no block device, identified by their mount source instead. */
const NETWORK_FS = ["smbfs", "nfs", "afpfs", "webdav", "ftp", "cifs", "sshfs", "9p"];

export interface VolumeIdentity {
  /** A stable string for the volume: a volume uuid, or a mount source. */
  readonly id: string;
  /** Where it came from, for the setup screen to explain itself. */
  readonly kind: "volume-uuid" | "mount-source";
  readonly mountPoint: string;
  readonly fstype: string;
}

/**
 * The mount entry whose mount point is the longest prefix of `path`.
 *
 * This and `fstypeFor` used to carry the same eight-line search independently
 * — one returning the entry, one just its `fstype` — and both compared a
 * normalised prefix's length against a candidate's raw `mountPoint.length`,
 * which a trailing slash could win unfairly. The search now lives once, in
 * fstype.ts (`mountEntryFor`), with the comparison fixed there; this is that
 * same function under the name this module's callers use.
 */
export const mountFor = mountEntryFor;

export const isNetwork = (fstype: string): boolean =>
  NETWORK_FS.some((f) => fstype.toLowerCase().includes(f));

/**
 * Volume UUIDs, cached by the device backing the mount point.
 *
 * `diskutil info` costs about 150 ms and was run on every reachability check.
 * A volume's UUID cannot change while it is mounted, so the only thing this
 * must not do is answer for a *different* volume — which is why the key is the
 * device, not the path. Swap the disk and the device string changes, so the
 * lookup misses and diskutil runs again.
 */
const uuidCache = new Map<string, string | null>();

/** Drops cached volume identities. For tests. */
export function forgetVolumeUuids(): void {
  uuidCache.clear();
}

/** Volume UUID from diskutil (macOS) or sysfs (Linux), for filesystems that have one. */
async function volumeUuid(entry: MountEntry): Promise<string | null> {
  if (IS_LINUX) return volumeUuidLinux(entry);
  try {
    const proc = Bun.spawn(["/usr/sbin/diskutil", "info", entry.mountPoint], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const m = /Volume UUID:\s*([0-9A-Fa-f-]{8,})/.exec(out);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Read a sysfs file, or null when it does not exist or is empty.
 *
 * Sysfs is how Linux publishes volume facts — a UUID per filesystem, a
 * `removable` bit per block device — as plain files, in the spirit this
 * project keeps its own record in. The reader is injectable so the decisions
 * built on top of it can be tested without a matching piece of hardware.
 */
export function readSysText(path: string): string | null {
  try {
    const v = readFileSync(path, "utf8").trim();
    return v === "" ? null : v;
  } catch {
    return null;
  }
}

/**
 * Volume UUID on Linux, from the kernel's own sysfs — the equivalent of what
 * diskutil answers on macOS.
 *
 * Two routes, because containers and namespaced systems filter `/sys/block`
 * down to whatever the process sees: the device name first (`/sys/block/sdb1`
 * holds `uuid` for ext4/xfs/btrfs and `partuuid` for FAT-family), then the
 * devnum from `stat`, which resolves through `/sys/dev/block` on systems where
 * the name-based path does not exist.
 *
 * Null when the kernel publishes no UUID for the device (LVM without one, some
 * loop images). The caller falls back to the device path as a mount-source
 * identity, which still separates one volume from another.
 */
export function volumeUuidLinux(
  entry: MountEntry,
  readText: (path: string) => string | null = readSysText,
): string | null {
  const candidates: string[] = [];
  const name = entry.device.startsWith("/dev/") ? entry.device.slice("/dev/".length) : null;
  if (name !== null && name !== "" && !name.includes("/")) {
    candidates.push(join("/sys/block", name, "uuid"));
    candidates.push(join("/sys/block", name, "partuuid"));
  }
  try {
    const dev = statSync(entry.mountPoint).dev;
    const maj = (dev >> 8) & 0xfff;
    const min = (dev & 0xff) | ((dev >> 12) & 0xfff00);
    candidates.push(join("/sys/dev/block", `${maj}:${min}`, "uuid"));
    candidates.push(join("/sys/dev/block", `${maj}:${min}`, "partuuid"));
  } catch {
    // The mount point is gone or unreadable; the name-based route above stands.
  }
  for (const c of candidates) {
    const v = readText(c);
    if (v !== null) return v;
  }
  return null;
}

/**
 * The mount table, cached for a moment.
 *
 * `/sbin/mount` stats every mount point, and enumerating an SMB share takes
 * over a second on a machine with one mounted — measured at 1380 ms. Every
 * destination check spawned it separately, so a three-destination config paid
 * that three times per refresh, and again in the sync pre-flight.
 *
 * The window is deliberately short. The table is exactly the thing that changes
 * when a drive is plugged in or a share drops, and reachability is the check
 * that must notice; a long cache would report a volume as present after it had
 * gone. One second is enough to collapse the calls within a single operation
 * and too short to outlive one.
 */
const MOUNT_TABLE_TTL_MS = 1000;
let mountCache: { readonly at: number; readonly entries: MountEntry[] } | null = null;

/** Drops the cached table. For tests, and for anything that must not reuse it. */
export function forgetMountTable(): void {
  mountCache = null;
  uuidCache.clear();
}

async function mountTable(): Promise<MountEntry[]> {
  const now = Date.now();
  if (mountCache !== null && now - mountCache.at < MOUNT_TABLE_TTL_MS) return mountCache.entries;
  let entries: MountEntry[] = [];
  if (IS_LINUX) {
    // /proc/mounts is the kernel's own table, already in memory: no spawn, and
    // no stall enumerating a dead share the way `mount` can.
    try {
      entries = parseProcMounts(readFileSync("/proc/mounts", "utf8"));
    } catch {
      entries = [];
    }
  } else {
    try {
      const proc = Bun.spawn(["/sbin/mount"], { stdout: "pipe", stderr: "pipe" });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      entries = parseMount(out);
    } catch {
      entries = [];
    }
  }
  mountCache = { at: Date.now(), entries };
  return entries;
}

/**
 * The identity of whatever is mounted at `path` right now.
 *
 * Network shares have no volume uuid — diskutil declines them entirely — so
 * their mount source (`//user@host/share`) is the identity. It distinguishes a
 * different share mounted at the same point, which is what matters.
 *
 * `entries`, when given, is used in place of the real mount table. Every real
 * absolute path matches at least the root mount, so "the volume cannot be
 * identified" is otherwise untestable without spawning a destination with
 * nothing mounted there at all — this is the seam that lets that refusal path
 * be exercised directly, the way `fstypeFor` already accepts a MountEntry
 * list instead of reading `/sbin/mount` itself.
 */
export async function identify(
  path: string,
  entries?: readonly MountEntry[],
): Promise<VolumeIdentity | null> {
  const table = entries ?? (await mountTable());
  const entry = mountFor(path, table);
  if (entry === undefined) return null;

  const fstype = entry.fstype;
  if (isNetwork(fstype)) {
    return { id: entry.device, kind: "mount-source", mountPoint: entry.mountPoint, fstype };
  }
  const cacheKey = `${entry.device}\u0000${entry.mountPoint}`;
  const uuid = uuidCache.has(cacheKey)
    ? uuidCache.get(cacheKey)!
    : await volumeUuid(entry).then((u) => {
        uuidCache.set(cacheKey, u);
        return u;
      });
  return uuid === null
    ? { id: entry.device, kind: "mount-source", mountPoint: entry.mountPoint, fstype }
    : { id: uuid, kind: "volume-uuid", mountPoint: entry.mountPoint, fstype };
}

export type VolumeStatus = "ok" | "mismatch" | "unreachable";

/**
 * Compares what is mounted now against what was recorded.
 *
 * An unmounted destination resolves to whatever volume owns the mount point —
 * usually the boot disk — whose identity will not match, so the dangerous case
 * reports `mismatch` rather than slipping through as `ok`.
 */
export async function checkVolume(path: string, expected: string): Promise<VolumeStatus> {
  const found = await identify(path);
  if (found === null) return "unreachable";
  return found.id === expected ? "ok" : "mismatch";
}

/** Reuses the parsed mount table for a filesystem lookup, avoiding a second spawn. */
export async function fstypeOf(path: string): Promise<string> {
  return fstypeFor(path, await mountTable());
}

/** What a mounted volume is, in the terms someone choosing a destination cares about. */
export type VolumeKind = "network" | "external" | "internal" | "unknown";

export interface MountedVolume {
  readonly mountPoint: string;
  readonly name: string;
  readonly kind: VolumeKind;
  readonly fstype: string;
  /** The server and share for a network mount, the device node otherwise. */
  readonly device: string;
  /** Free bytes, or null when the volume cannot be measured. */
  readonly free: number | null;
}

/**
 * Classifies a mount without asking diskutil.
 *
 * `mount` already reports everything needed to separate a network share from a
 * disk: the kernel's own `local` flag. diskutil is only consulted to tell an
 * external disk from an internal one, which is a slower question and a less
 * important one — and it declines network mounts outright ("Could not find
 * disk"), so calling it for those would be a spawn spent to learn nothing.
 *
 * This used to have a third local case: a `/dev/diskN` mismatch read as a disk
 * image. macOS attaches disk images at `/dev/diskN` too — the same synthesised
 * numbering real hardware gets — so that branch could never fire; every disk
 * image on this machine classified as an internal disk regardless. Telling
 * the two apart for real needs `hdiutil info` (attached-image devices are
 * listed by device node, matched against `entry.device`), which is the kind
 * of extra spawn this function exists specifically to avoid paying for every
 * local volume. Not worth it for a listing whose only consumer is "which
 * volume did you mean" — removed rather than left unreachable.
 */
export function classify(entry: MountEntry): VolumeKind {
  if (!entry.local) return isNetwork(entry.fstype) ? "network" : "unknown";
  if (IS_MACOS) return "internal";
  return classifyLinuxDevice(entry.device);
}

/**
 * Local disks on Linux, from the device node, then /sys.
 *
 * Loop devices back mounted disk images rather than hardware. "external" and
 * "internal" are claims about hardware, and the vocabulary no longer has a
 * word for "image" (it was removed as unreachable on macOS — DESIGN.md §10),
 * so a loop mount is the one local device class that is honestly unknown.
 */
export function classifyLinuxDevice(device: string): VolumeKind {
  if (device.startsWith("/dev/loop")) return "unknown";
  if (!device.startsWith("/dev/")) return "unknown";
  const name = device.slice("/dev/".length).split("/")[0] ?? "";
  return isRemovableBlock(name) ? "external" : "internal";
}

/**
 * `/sys/block/<name>/removable` is `1` for USB and similar hot-pluggable
 * disks. The read is trimmed: sysfs files end in a newline, and a reader that
 * returns surrounding whitespace must not read as "not removable".
 */
export function isRemovableBlock(
  name: string,
  readText: (path: string) => string | null = readSysText,
): boolean {
  return (readText(join("/sys/block", name, "removable")) ?? "").trim() === "1";
}

/** A short label for a volume, for a list someone is picking from. */
export function describeVolume(v: MountedVolume): string {
  switch (v.kind) {
    case "network":
      return `network · ${v.device}`;
    case "external":
      return `external disk · ${v.fstype}`;
    case "internal":
      // The boot volume, in the words the platform uses for it.
      return `${IS_MACOS ? "this mac" : "this computer"} · ${v.fstype}`;
    default:
      return v.fstype;
  }
}

/**
 * External or internal, from diskutil, cached by device.
 *
 * Only asked for local disks: diskutil declines network mounts outright, so
 * calling it for those spends a spawn to learn nothing.
 */
const locationCache = new Map<string, boolean>();

async function isExternal(mountPoint: string, device: string): Promise<boolean> {
  // On Linux classify() has already asked /sys the same question, so this is
  // the no-op branch rather than a second, slower measurement.
  if (IS_LINUX) return false;
  const hit = locationCache.get(device);
  if (hit !== undefined) return hit;
  try {
    const proc = Bun.spawn(["/usr/sbin/diskutil", "info", mountPoint], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const external = /Device Location:\s*External/i.test(out);
    locationCache.set(device, external);
    return external;
  } catch {
    return false;
  }
}

/**
 * Every mounted volume a destination could live on, classified.
 *
 * Volume names give no clue what they are, and two can differ by a single
 * letter and a capital — a network share and a USB disk mounted side by side.
 * Choosing between them by name alone requires already knowing. Listing them
 * with what they actually are removes the guess.
 */
export async function mountedVolumes(): Promise<MountedVolume[]> {
  const entries = await mountTable();
  const out: MountedVolume[] = [];
  for (const e of entries) {
    // Only volumes someone could plausibly point a destination at.
    //
    // macOS: that means the boot volume and /Volumes/* — Time Machine keeps
    // its snapshots under /Volumes/.timemachine/… with names like a UUID
    // inside a hostname, which the hidden-segment check below removes.
    //
    // Linux: the mount table lists the kernel's own filesystems too, and
    // /proc/mounts on a real box is dozens of lines — so pseudo-filesystems
    // are filtered out here, and anything still unclassifiable (a FUSE mount
    // with no block device, zfs) is dropped rather than offered as a
    // destination of unknown character. Typed paths are not affected: this
    // list only annotates completions.
    if (e.mountPoint === "") continue;
    if (IS_MACOS) {
      if (e.mountPoint !== "/" && !e.mountPoint.startsWith("/Volumes/")) continue;
    } else {
      if (PSEUDO_FSTYPES.has(e.fstype.toLowerCase())) continue;
    }
    if (e.mountPoint.split("/").some((seg) => seg.startsWith("."))) continue;
    let kind = classify(e);
    if (IS_LINUX && kind === "unknown") continue;
    if (kind === "internal" && (await isExternal(e.mountPoint, e.device))) kind = "external";
    out.push({
      mountPoint: e.mountPoint,
      name:
        e.mountPoint === "/"
          ? IS_MACOS
            ? "Macintosh HD"
            : "root"
          : IS_MACOS
            ? e.mountPoint.slice("/Volumes/".length)
            : e.mountPoint,
      kind,
      fstype: e.fstype,
      device: e.device,
      free: freeOf(e.mountPoint),
    });
  }
  // Network and external first: those are what an archive gets replicated to.
  const order: readonly VolumeKind[] = ["external", "network", "internal", "unknown"];
  return out.sort(
    (a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.name.localeCompare(b.name),
  );
}

function freeOf(path: string): number | null {
  try {
    const s = statfsSync(path);
    return Number(s.bsize) * Number(s.bavail);
  } catch {
    return null;
  }
}
