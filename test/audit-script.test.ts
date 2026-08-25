import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeFixtureDir, removeFixtureDir } from "./helpers.ts";

/**
 * The audit script is a guard, so the tests plant the leaks: a guard that
 * passes over a planted identifier has failed for the reason it exists. The
 * mount table is fed through SYNCY_AUDIT_MOUNT_TABLE, canned and format-based
 * (BSD and Linux shapes both, on any runner), so what is exercised is the
 * derivation and the scans, not this machine's mounts.
 *
 * The script is spawned under `sh` explicitly, which is what its own shebang
 * asks for: on Linux that is dash, where the old IFS=$'\n' was the literal
 * characters $, \, n — the tests would have caught that regression on the
 * platform it breaks. On macOS it is bash in sh-compat mode, which is what
 * catches the reverse: a GNU-only construct that never runs here.
 */

const SCRIPT = join(import.meta.dir, "..", "scripts", "audit-history.sh");

const LINUX_TABLE =
  [
    "/dev/nvme0n1p2 on / type ext4 (rw,relatime,errors=remount-ro)",
    "proc on /proc type proc (rw,nosuid,nodev)",
    "sysfs on /sys type sysfs (rw,nosuid,nodev)",
    "tmpfs on /run type tmpfs (rw,nosuid)",
    "cgroup2 on /sys/fs/cgroup type cgroup2 (rw,nosuid)",
    "devpts on /dev/pts type devpts (rw,nosuid)",
    "/dev/sdb1 on /media/user/Archive type vfat (rw,uid=1000)",
  ].join("\n") + "\n";

const LINUX_TABLE_CIFS =
  LINUX_TABLE + "//auditnas/share on /mnt/backup type cifs (rw,vers=3.11,uid=1000)\n";

const BSD_TABLE =
  [
    "/dev/disk3s3s1 on / (apfs, local, journaled, owner=root)",
    "devfs on /dev (devfs, local, nobrowse, multi-label)",
    "map auto_home on /System/Volumes/Data/home (autofs, nomount, map=auto_home)",
    "//backupbox/media on /Volumes/backup (smb, noatime, mount from backupbox)",
    "/dev/disk4s1 on /Volumes/Archive (hfs, local, journaled)",
  ].join("\n") + "\n";

const repos: string[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) removeFixtureDir(r);
});

const git = (repo: string, ...args: string[]): string =>
  Bun.spawnSync(["git", "-C", repo, ...args], {
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  }).stdout.toString();

function plantRepo(files: Record<string, string>, message: string): string {
  const repo = makeFixtureDir("syncy-audit");
  repos.push(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Fixture");
  git(repo, "config", "user.email", "fixture@example.com");
  for (const [name, body] of Object.entries(files)) writeFileSync(join(repo, name), body);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
  return repo;
}

function runAudit(repo: string, table: string): Promise<{ code: number; out: string }> {
  const tablePath = join(repo, ".audit-mount-table");
  writeFileSync(tablePath, table);
  const proc = Bun.spawn(["sh", SCRIPT], {
    cwd: repo,
    env: { ...process.env, SYNCY_AUDIT_MOUNT_TABLE: tablePath },
    stdout: "pipe",
    stderr: "pipe",
  });
  let out = "";
  const pump = async (s: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder();
    for await (const chunk of s) out += decoder.decode(chunk, { stream: true });
  };
  return Promise.all([proc.exited, pump(proc.stdout), pump(proc.stderr)]).then(([code]) => ({
    code: code as number,
    out,
  }));
}

const leaks = (out: string): string[] => out.split("\n").filter((l) => l.includes("LEAK"));

describe("audit-history.sh", () => {
  test("a clean repo passes, with pseudo-filesystem words in the tree", async () => {
    // proc, tmpfs and cgroup2 are Linux mount sources, not servers. As
    // patterns they would match "process" and friends all over any repo, so
    // the decoy file is the regression test for the old exclusion list.
    const repo = plantRepo(
      { "notes.txt": "the process runs on tmpfs under cgroup2 with a proc entry\n" },
      "notes",
    );
    const r = await runAudit(repo, LINUX_TABLE);
    expect(r.code).toBe(0);
    expect(r.out).toContain("OK");
    expect(leaks(r.out)).toHaveLength(0);
  });

  test("a Linux volume under /media is derived, not just macOS /Volumes", async () => {
    // The extraction that was written as a BRE with `\|`, which is a GNU
    // extension: under BSD sed it matched nothing and this leak walked
    // straight past the guard on the author's own machine. Planting the path
    // is the only way the alternation gets exercised on either sed.
    const repo = plantRepo({ "notes.txt": "the archive lives at /media/user/Archive\n" }, "notes");
    const r = await runAudit(repo, LINUX_TABLE);
    expect(r.code).toBe(1);
    expect(r.out).toContain("FAIL");
    expect(leaks(r.out).length).toBeGreaterThan(0);
  });

  test("a hidden mount point contributes no pattern", async () => {
    // Time Machine mounts at /Volumes/.timemachine/<host>/<uuid>/Data, which
    // is noise, not a volume anyone syncs to. The leading-dot exclusion used
    // to run against the bare leaf name; once the paths became whole it was
    // written `/\.$`, which only ever matches a line *ending* in "/." — so
    // it excluded nothing. The mount point is the bait: if it is still a
    // pattern, this clean repo fails.
    const repo = plantRepo(
      { "notes.txt": "snapshots live under /Volumes/.timemachine/box/1-A/Data\n" },
      "notes",
    );
    const r = await runAudit(
      repo,
      `${BSD_TABLE}//tm@timecapsule/backups on /Volumes/.timemachine/box/1-A/Data (smb, nobrowse)\n`,
    );
    expect(r.out).toContain("OK");
    expect(r.code).toBe(0);
  });

  test("a planted network server is caught, and only that", async () => {
    const repo = plantRepo(
      {
        "notes.txt": "backups land on //auditnas/share\n",
        "decoys.txt": "the process runs on tmpfs under cgroup2\n",
      },
      "notes",
    );
    const r = await runAudit(repo, LINUX_TABLE_CIFS);
    expect(r.code).toBe(1);
    expect(r.out).toContain("FAIL");
    // One tree hit and one blob hit, both the planted file. A shattering IFS
    // or a pseudo-filesystem "server" would add hits for the decoys.
    const l = leaks(r.out);
    expect(l).toHaveLength(2);
    for (const line of l) expect(line).toContain("notes");
    // The commit message was clean, and said so.
    expect(r.out).toContain("== commit messages ==\n  clean");
  });

  test("the macOS table shape yields its volumes and its server", async () => {
    const repo = plantRepo(
      {
        "volume-note.txt": "the archive is on /Volumes/Archive\n",
        "server-note.txt": "backups are on //backupbox/media\n",
      },
      "notes",
    );
    const r = await runAudit(repo, BSD_TABLE);
    expect(r.code).toBe(1);
    expect(r.out).toContain("FAIL");
    const l = leaks(r.out);
    // Two tree hits (one per pattern, different files) and two blob hits.
    expect(l).toHaveLength(4);
    expect(l.some((line) => line.includes("volume-note"))).toBe(true);
    expect(l.some((line) => line.includes("server-note"))).toBe(true);
    for (const line of l) expect(line).toContain("note");
  });

  test("a leak in commit history is caught, not just in the tree", async () => {
    // The incident that made this script: a hostname committed once survives
    // every later cleanup of the tip. The message is the leak, the tree is
    // clean.
    const repo = plantRepo(
      { "notes.txt": "clean content\n" },
      "moved //auditnas/share to the new box",
    );
    const r = await runAudit(repo, LINUX_TABLE_CIFS);
    expect(r.code).toBe(1);
    expect(r.out).toContain("FAIL");
    expect(r.out).toContain("moved //auditnas/share to the new box");
    // Only the message: the tree and the blobs are clean.
    expect(r.out).toContain("== working tree ==\n  clean");
    const l = leaks(r.out);
    expect(l).toHaveLength(1);
    expect(l[0]).toContain("auditnas");
  });
});
