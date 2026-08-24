import { describe, expect, test } from "bun:test";
import { type MountEntry, parseProcMounts } from "../src/fstype.ts";
import { classify, classifyLinuxDevice, isRemovableBlock, volumeUuidLinux } from "../src/volume.ts";

/**
 * The Linux side of volume identity, tested against a fixed /proc/mounts
 * table and an injected sysfs reader.
 *
 * The parsers and decisions are pure; the only real I/O is reading
 * /proc/mounts and the sysfs files, which is exactly what the reader
 * injection replaces. A machine without a second disk still gets the full
 * suite.
 */

describe("parsing /proc/mounts", () => {
  const MOUNTS = `tmpfs /run tmpfs rw,nosuid,nodev,size=6292836k 0 0
/dev/nvme1n1p2 / ext4 rw,relatime 0 0
//nas.local/media /mnt/media cifs rw,vers=3.11,uid=1000 0 0
archive.example:/exports/videos /mnt/nfs nfs rw,hard 0 0
/dev/loop0 /mnt/image squashfs ro 0 0
/dev/sdb1 /mnt/usb exfat rw 0 0
overlay /var/lib/docker/overlay2/x/merged overlay rw 0 0`;

  test("splits fields and keeps the options", () => {
    const entries = parseProcMounts(MOUNTS);
    expect(entries).toHaveLength(7);
    expect(entries[1]).toEqual({
      device: "/dev/nvme1n1p2",
      mountPoint: "/",
      fstype: "ext4",
      flags: ["rw", "relatime"],
      local: true,
    });
  });

  test("network shares are not local, whatever their device is", () => {
    const entries = parseProcMounts(MOUNTS);
    expect(entries.find((e) => e.mountPoint === "/mnt/media")?.local).toBe(false);
    expect(entries.find((e) => e.mountPoint === "/mnt/nfs")?.local).toBe(false);
  });

  test("a block device and a pseudo-filesystem are both local", () => {
    const entries = parseProcMounts(MOUNTS);
    expect(entries.find((e) => e.mountPoint === "/run")?.local).toBe(true);
    expect(entries.find((e) => e.mountPoint === "/mnt/usb")?.local).toBe(true);
  });

  test("octal-escaped spaces in a mount point survive", () => {
    const entries = parseProcMounts("/dev/sdd1 /mnt/odd\\040name vfat rw 0 0");
    expect(entries[0]?.mountPoint).toBe("/mnt/odd name");
  });

  test("a share whose name contains a space is one entry", () => {
    // In /proc/mounts a space in the mount source is octal-escaped.
    const entries = parseProcMounts("file:/remote\\040dir /mnt/remote fuse.sshfs rw 0 0");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.device).toBe("file:/remote dir");
    expect(entries[0]?.fstype).toBe("fuse.sshfs");
  });

  test("garbage lines yield nothing rather than a wrong entry", () => {
    expect(parseProcMounts("not a mount line\n\n   \n")).toEqual([]);
  });
});

const proc = (device: string, mountPoint: string, fstype: string, local: boolean): MountEntry => ({
  device,
  mountPoint,
  fstype,
  flags: [],
  local,
});

describe("classifying Linux mounts", () => {
  test("a network fstype is a share on any mount table", () => {
    expect(classify(proc("//nas.local/media", "/mnt/media", "cifs", false))).toBe("network");
    expect(classify(proc("archive.example:/exports", "/mnt/nfs", "nfs", false))).toBe("network");
    expect(classify(proc("file:/remote", "/mnt/ssh", "fuse.sshfs", false))).toBe("network");
  });

  test("loop devices are unknown: the vocabulary has no word for images", () => {
    // Loop devices back mounted disk images, not hardware. "external" and
    // "internal" are claims about hardware, and the VolumeKind vocabulary
    // dropped "image" (unreachable on macOS — see classify), so the honest
    // answer for a loop mount is unknown.
    expect(classifyLinuxDevice("/dev/loop0")).toBe("unknown");
  });

  test("no block device at all is not a destination", () => {
    expect(classifyLinuxDevice("overlay")).toBe("unknown");
    expect(classifyLinuxDevice("zfs")).toBe("unknown");
  });

  test("a mapper volume is an internal disk", () => {
    // `mapper` is not a block device name, so /sys has no removable bit for
    // it on any machine, which makes the answer stable rather than a probe.
    expect(classifyLinuxDevice("/dev/mapper/vg-lv")).toBe("internal");
  });

  test("removable comes from /sys, and no such file means not removable", () => {
    expect(isRemovableBlock("sdb1", () => "1")).toBe(true);
    expect(isRemovableBlock("sdb1", () => "0")).toBe(false);
    expect(isRemovableBlock("sdb1", () => null)).toBe(false);
    expect(isRemovableBlock("sdb1", () => " 1 ")).toBe(true);
  });
});

describe("volume UUID from sysfs", () => {
  // A mount point that cannot exist, so the devnum route never touches a real
  // device and only the injected reader answers.
  const ghost = (device: string, fstype: string): MountEntry =>
    proc(device, "/mnt/no/such/point", fstype, true);

  test("the uuid file wins for the device name", () => {
    const reader = (p: string): string | null =>
      p === "/sys/block/sdb1/uuid" ? "ABCD-1234-ABCD" : null;
    expect(volumeUuidLinux(ghost("/dev/sdb1", "ext4"), reader)).toBe("ABCD-1234-ABCD");
  });

  test("partuuid answers for FAT-family devices", () => {
    const reader = (p: string): string | null =>
      p === "/sys/block/sdb1/partuuid" ? "1122-3344" : null;
    expect(volumeUuidLinux(ghost("/dev/sdb1", "exfat"), reader)).toBe("1122-3344");
  });

  test("no published uuid means the caller falls back to the device path", () => {
    expect(volumeUuidLinux(ghost("/dev/sdb1", "xfs"), () => null)).toBeNull();
  });

  test("mapper names have no name-based route and no devnum on a ghost", () => {
    expect(
      volumeUuidLinux(ghost("/dev/mapper/vg-lv", "ext4"), () => "should-not-be-read"),
    ).toBeNull();
  });
});
