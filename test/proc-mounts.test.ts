import { describe, expect, test } from "bun:test";
import { type MountEntry, parseProcMounts } from "../src/fstype.ts";
import {
  classify,
  classifyLinuxDevice,
  isRemovableDevice,
  type LinuxVolumeIo,
  volumeUuidLinux,
} from "../src/volume.ts";

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

/**
 * A canned /sys and /dev/disk.
 *
 * Every path the Linux volume code touches goes through this, so a test
 * cannot pass by reading the machine it runs on — which is the whole reason
 * these decisions take an io object. An unlisted path does not exist:
 * `realpath` of an unknown path returns null, the way a path with nothing
 * behind it does — which is exactly the /dev/root case below.
 */
const io = (
  files: Record<string, string>,
  links: Record<string, string> = {},
  dirs: Record<string, string[]> = {},
  devnums: Record<string, number> = {},
): LinuxVolumeIo => ({
  readText: (path) => files[path] ?? null,
  list: (dir) => dirs[dir] ?? [],
  realpath: (path) => links[path] ?? null,
  deviceNumber: (path) => devnums[path] ?? null,
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
    expect(classifyLinuxDevice("/dev/loop0", io({}))).toBe("unknown");
  });

  test("no block device at all is not a destination", () => {
    expect(classifyLinuxDevice("overlay", io({}))).toBe("unknown");
    expect(classifyLinuxDevice("zfs", io({}))).toBe("unknown");
  });

  test("a mapper volume is asked about as the dm-N it resolves to", () => {
    // /dev/mapper/vg-lv is a symlink; /sys/class/block has no `mapper`. The
    // realpath is what has a removable bit, and an LVM volume's is 0.
    const links = { "/dev/mapper/vg-lv": "/dev/dm-0" };
    expect(
      classifyLinuxDevice(
        "/dev/mapper/vg-lv",
        io({ "/sys/class/block/dm-0/removable": "0" }, links),
      ),
    ).toBe("internal");
  });

  test("a USB partition is external: `removable` lives on the disk, not the partition", () => {
    // The bug this replaces: /sys/block/sdb1/removable was read, and neither
    // half of that path is right. /sys/block holds whole disks only, and a
    // partition publishes no `removable` of its own — so the file never
    // existed on any machine and every external disk read as internal.
    const usb = io({ "/sys/class/block/sdb1/../removable": "1" }, { "/dev/sdb1": "/dev/sdb1" });
    expect(isRemovableDevice("/dev/sdb1", usb)).toBe(true);
    expect(classifyLinuxDevice("/dev/sdb1", usb)).toBe("external");
  });

  test("a whole disk answers from its own directory", () => {
    expect(
      isRemovableDevice(
        "/dev/sdb",
        io({ "/sys/class/block/sdb/removable": "1" }, { "/dev/sdb": "/dev/sdb" }),
      ),
    ).toBe(true);
  });

  test("an internal partition is internal, and a missing file is not removable", () => {
    expect(
      isRemovableDevice(
        "/dev/nvme0n1p2",
        io(
          { "/sys/class/block/nvme0n1p2/../removable": "0" },
          { "/dev/nvme0n1p2": "/dev/nvme0n1p2" },
        ),
      ),
    ).toBe(false);
    expect(isRemovableDevice("/dev/sdb1", io({}, { "/dev/sdb1": "/dev/sdb1" }))).toBe(false);
  });

  test("the removable bit is trimmed: sysfs files end in a newline", () => {
    expect(
      isRemovableDevice(
        "/dev/sdb1",
        io({ "/sys/class/block/sdb1/../removable": " 1 " }, { "/dev/sdb1": "/dev/sdb1" }),
      ),
    ).toBe(true);
  });
});

describe("volume UUID on Linux", () => {
  const ghost = (device: string, fstype: string): MountEntry =>
    proc(device, "/mnt/no/such/point", fstype, true);

  test("the filesystem uuid comes from udev's by-uuid symlinks", () => {
    // Not from sysfs: a filesystem uuid lives in the superblock, and the
    // kernel publishes none for a block device. udev resolves it and links
    // it under /dev/disk/by-uuid, which is what `blkid` and every mount unit
    // on the machine already agree is the name for the volume.
    const found = io(
      {},
      { "/dev/disk/by-uuid/8f3b-ARCHIVE": "/dev/sdb1", "/dev/sdb1": "/dev/sdb1" },
      { "/dev/disk/by-uuid": ["8f3b-ARCHIVE", "other-volume"] },
    );
    expect(volumeUuidLinux(ghost("/dev/sdb1", "ext4"), found)).toBe("8f3b-ARCHIVE");
  });

  test("by-partuuid answers when the filesystem publishes no uuid", () => {
    const found = io(
      {},
      { "/dev/disk/by-partuuid/1122-3344": "/dev/sdb1", "/dev/sdb1": "/dev/sdb1" },
      { "/dev/disk/by-uuid": [], "/dev/disk/by-partuuid": ["1122-3344"] },
    );
    expect(volumeUuidLinux(ghost("/dev/sdb1", "exfat"), found)).toBe("1122-3344");
  });

  test("a link that resolves elsewhere is not this volume's uuid", () => {
    // The whole point of resolving both sides: by-uuid is full of entries,
    // and only the one pointing at *this* node names *this* volume.
    const other = io(
      {},
      { "/dev/disk/by-uuid/belongs-to-sda1": "/dev/sda1", "/dev/sdb1": "/dev/sdb1" },
      { "/dev/disk/by-uuid": ["belongs-to-sda1"] },
    );
    expect(volumeUuidLinux(ghost("/dev/sdb1", "ext4"), other)).toBeNull();
  });

  test("a device that publishes its own uuid answers without udev", () => {
    // An NVMe namespace and a device-mapper volume do have a uuid in sysfs,
    // which covers a machine running without udev. /sys/class/block, not
    // /sys/block: the latter holds whole disks only.
    const nvme = io(
      { "/sys/class/block/nvme0n1/uuid": "nvme-namespace-uuid" },
      {
        "/dev/nvme0n1": "/dev/nvme0n1",
      },
    );
    expect(volumeUuidLinux(ghost("/dev/nvme0n1", "ext4"), nvme)).toBe("nvme-namespace-uuid");

    const dm = io(
      { "/sys/class/block/dm-0/dm/uuid": "LVM-abc123" },
      {
        "/dev/mapper/vg-lv": "/dev/dm-0",
      },
    );
    expect(volumeUuidLinux(ghost("/dev/mapper/vg-lv", "ext4"), dm)).toBe("LVM-abc123");
  });

  test("a device with no node — /dev/root — is found by its device number", () => {
    // What the CI runners actually mount: an initramfs names the root
    // filesystem /dev/root and no such node exists, so resolving the name
    // gets nowhere. The mount's device number is real, and
    // /sys/dev/block/<major>:<minor> resolves to the kernel's own name for
    // it. Without this route the most likely mount on the machine has no
    // uuid at all — which is what CI reported. 8:1 is sda1.
    const runner = io(
      {},
      {
        "/sys/dev/block/8:1": "/sys/devices/pci0000:00/x/block/sda/sda1",
        "/dev/disk/by-uuid/root-fs-uuid": "/dev/sda1",
      },
      { "/dev/disk/by-uuid": ["root-fs-uuid"] },
      { "/": (8 << 8) | 1 },
    );
    expect(volumeUuidLinux(proc("/dev/root", "/", "ext4", true), runner)).toBe("root-fs-uuid");
  });

  test("nothing published means null, and the caller must not treat the path as proof", () => {
    expect(volumeUuidLinux(ghost("/dev/sdb1", "xfs"), io({}))).toBeNull();
  });

  test("a source that is not a device node has no uuid to look up", () => {
    expect(volumeUuidLinux(ghost("overlay", "overlay"), io({}))).toBeNull();
    expect(volumeUuidLinux(ghost("//nas/media", "cifs"), io({}))).toBeNull();
  });
});
