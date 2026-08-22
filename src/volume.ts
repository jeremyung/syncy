import { statfsSync } from "node:fs";
import { fstypeFor, parseMount, type MountEntry } from "./fstype.ts";

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
const NETWORK_FS = ["smbfs", "nfs", "afpfs", "webdav", "ftp", "cifs"];

export interface VolumeIdentity {
  /** A stable string for the volume: a volume uuid, or a mount source. */
  readonly id: string;
  /** Where it came from, for the setup screen to explain itself. */
  readonly kind: "volume-uuid" | "mount-source";
  readonly mountPoint: string;
  readonly fstype: string;
}

/** The mount entry whose mount point is the longest prefix of `path`. */
export function mountFor(path: string, entries: readonly MountEntry[]): MountEntry | undefined {
  let best: MountEntry | undefined;
  for (const e of entries) {
    const point = e.mountPoint.endsWith("/") ? e.mountPoint.slice(0, -1) : e.mountPoint;
    const prefix = point === "" ? "/" : point;
    if (path === prefix || path.startsWith(prefix === "/" ? "/" : prefix + "/")) {
      if (best === undefined || prefix.length > best.mountPoint.length) best = e;
    }
  }
  return best;
}

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

/** Volume UUID from diskutil, for filesystems that have one. */
export async function volumeUuid(mountPoint: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["/usr/sbin/diskutil", "info", mountPoint], {
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
  try {
    const proc = Bun.spawn(["/sbin/mount"], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const entries = parseMount(out);
    mountCache = { at: Date.now(), entries };
    return entries;
  } catch {
    return [];
  }
}

/**
 * The identity of whatever is mounted at `path` right now.
 *
 * Network shares have no volume uuid — diskutil declines them entirely — so
 * their mount source (`//user@host/share`) is the identity. It distinguishes a
 * different share mounted at the same point, which is what matters.
 */
export async function identify(path: string): Promise<VolumeIdentity | null> {
  const entries = await mountTable();
  const entry = mountFor(path, entries);
  if (entry === undefined) return null;

  const fstype = entry.fstype;
  if (isNetwork(fstype)) {
    return { id: entry.device, kind: "mount-source", mountPoint: entry.mountPoint, fstype };
  }
  const cacheKey = `${entry.device}\u0000${entry.mountPoint}`;
  const uuid = uuidCache.has(cacheKey)
    ? uuidCache.get(cacheKey)!
    : await volumeUuid(entry.mountPoint).then((u) => {
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
export type VolumeKind = "network" | "external" | "internal" | "image" | "unknown";

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
 */
export function classify(entry: MountEntry): VolumeKind {
  if (!entry.local) return isNetwork(entry.fstype) ? "network" : "unknown";
  // Disk images are backed by a synthesised device rather than real hardware.
  if (/^\/dev\/disk\d+/.test(entry.device) === false) return "image";
  return "internal";
}

/** A short label for a volume, for a list someone is picking from. */
export function describeVolume(v: MountedVolume): string {
  switch (v.kind) {
    case "network":
      return `network · ${v.device}`;
    case "external":
      return `external disk · ${v.fstype}`;
    case "internal":
      return `this mac · ${v.fstype}`;
    case "image":
      return `disk image · ${v.fstype}`;
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
    // Only volumes someone could plausibly point a destination at. Hidden
    // mount points are excluded: Time Machine keeps its snapshots under
    // /Volumes/.timemachine/… with names like a UUID inside a hostname, which
    // is noise in a list meant to be scanned by eye.
    if (e.mountPoint !== "/" && !e.mountPoint.startsWith("/Volumes/")) continue;
    if (e.mountPoint.split("/").some((seg) => seg.startsWith("."))) continue;
    let kind = classify(e);
    if (kind === "internal" && (await isExternal(e.mountPoint, e.device))) kind = "external";
    out.push({
      mountPoint: e.mountPoint,
      name: e.mountPoint === "/" ? "Macintosh HD" : e.mountPoint.slice("/Volumes/".length),
      kind,
      fstype: e.fstype,
      device: e.device,
      free: freeOf(e.mountPoint),
    });
  }
  // Network and external first: those are what an archive gets replicated to.
  const order: readonly VolumeKind[] = ["external", "network", "image", "internal", "unknown"];
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
