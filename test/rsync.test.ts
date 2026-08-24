import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseConfig, type Target } from "../src/config.ts";
import { explainFlags } from "../src/itemize.ts";
import { argvFor, assertDeleteIsDryRun, buildArgv, RsyncError } from "../src/rsync.ts";

const target = (over: Partial<Target> = {}): Target => ({
  name: "nas",
  path: "/Volumes/media/archive/photos/2019",
  required: true,
  sentinel: "s",
  fstype: "smbfs",
  modifyWindow: 0,
  flagsDrop: [],
  ...over,
});

describe("buildArgv", () => {
  test("quick check is a dry run that also surfaces extras", () => {
    const argv = buildArgv("quick", "/src/photos/2019", target(), []);
    expect(argv).toContain("-n");
    expect(argv).toContain("-i");
    expect(argv).toContain("--delete");
    expect(argv).not.toContain("-c");
  });

  test("deep verify checksums both sides and never deletes", () => {
    const argv = buildArgv("deep", "/src/photos/2019", target(), []);
    expect(argv).toContain("-c");
    expect(argv).toContain("-n");
    expect(argv).not.toContain("--delete");
  });

  test("sync writes, and never carries --delete", () => {
    const argv = buildArgv("sync", "/src/photos/2019", target(), []);
    expect(argv).not.toContain("-n");
    expect(argv).not.toContain("--delete");
  });

  test("sync uses --partial-dir, never bare -P", () => {
    // Bare --partial leaves a truncated file at the final path, which is exactly
    // what a later quick check compares by size and mtime.
    const argv = buildArgv("sync", "/src/x", target(), []);
    expect(argv).toContain("--partial-dir=.syncy-partial");
    expect(argv).not.toContain("-P");
    expect(argv).not.toContain("--partial");
  });

  test("flags_drop removes metadata flags the share cannot hold", () => {
    const argv = buildArgv("deep", "/src/x", target({ flagsDrop: ["-X"] }), []);
    expect(argv).toContain("-A");
    expect(argv).not.toContain("-X");
  });

  test("exFAT gets a modify window so timestamps stop looking changed", () => {
    const argv = buildArgv("quick", "/src/x", target({ fstype: "exfat", modifyWindow: 2 }), []);
    expect(argv).toContain("--modify-window=2");
  });

  test("directory arguments always carry a trailing slash", () => {
    const argv = buildArgv("sync", "/src/photos/2019", target(), []);
    const [src, dst] = argv.slice(-2);
    expect(src).toBe("/src/photos/2019/");
    expect(dst).toBe("/Volumes/media/archive/photos/2019/");
  });

  test("an already-slashed path is not double-slashed", () => {
    const argv = buildArgv("sync", "/src/x/", target({ path: "/dst/y/" }), []);
    expect(argv.slice(-2)).toEqual(["/src/x/", "/dst/y/"]);
  });

  test("syncy's own artefacts are always excluded", () => {
    const argv = buildArgv("sync", "/src/x", target(), [".DS_Store"]);
    expect(argv).toContain("--exclude=.syncy-*");
    expect(argv).toContain("--exclude=.DS_Store");
  });
});

describe("argvFor: one place that turns (config, unit, target) into a command", () => {
  /**
   * Five call sites used to build `{ ...target, path: join(target.path, unit)
   * }` independently before calling buildArgv, and Confirm.tsx did it with
   * template strings instead of join() — two constructions of the same paths
   * that happened to agree rather than being the same code. argvFor is now
   * the one place that does this.
   */
  const config = parseConfig(`
source = "/src"
exclude = [".DS_Store"]
[[target]]
name = "nas"
path = "/Volumes/media/archive"
sentinel = "s"
`);

  test("joins source and destination with the unit, the same way join() would", () => {
    const argv = argvFor(config, "photos/2019", target(), "sync");
    expect(argv.slice(-2)).toEqual([
      join("/src", "photos/2019") + "/",
      join(target().path, "photos/2019") + "/",
    ]);
  });

  test("is exactly what buildArgv produces from the equivalent manual construction", () => {
    for (const mode of ["quick", "deep", "sync"] as const) {
      const viaHelper = argvFor(config, "photos/2019", target(), mode);
      const viaManual = buildArgv(
        mode,
        join(config.source, "photos/2019"),
        { ...target(), path: join(target().path, "photos/2019") },
        config.exclude,
      );
      expect(viaHelper).toEqual(viaManual);
    }
  });

  test("carries the checksum option through, for the repair case", () => {
    const argv = argvFor(config, "photos/2019", target(), "sync", { checksum: true });
    expect(argv).toContain("-c");
  });

  test("carries exclude patterns through", () => {
    const argv = argvFor(config, "photos/2019", target(), "sync");
    expect(argv).toContain("--exclude=.DS_Store");
  });
});

describe("the --delete invariant", () => {
  test("accepts --delete alongside -n", () => {
    expect(() => assertDeleteIsDryRun(["-a", "-n", "--delete", "/a/", "/b/"])).not.toThrow();
  });

  test("accepts --delete alongside --dry-run", () => {
    expect(() => assertDeleteIsDryRun(["-a", "--dry-run", "--delete", "/a/", "/b/"])).not.toThrow();
  });

  test("accepts --delete when n is inside a combined short flag", () => {
    expect(() => assertDeleteIsDryRun(["-avn", "--delete", "/a/", "/b/"])).not.toThrow();
  });

  test("REFUSES --delete without a dry run", () => {
    expect(() => assertDeleteIsDryRun(["-a", "--delete", "/a/", "/b/"])).toThrow(RsyncError);
  });

  test("refuses --delete-during and friends without a dry run", () => {
    expect(() => assertDeleteIsDryRun(["-a", "--delete-during", "/a/", "/b/"])).toThrow(RsyncError);
  });

  test("does not mistake an unrelated flag containing n for a dry run", () => {
    expect(() => assertDeleteIsDryRun(["-a", "--numeric-ids", "--delete", "/a/", "/b/"])).toThrow(
      RsyncError,
    );
  });

  test("leaves argvs without --delete alone", () => {
    expect(() => assertDeleteIsDryRun(["-a", "/a/", "/b/"])).not.toThrow();
  });

  test("every generated argv satisfies the invariant", () => {
    for (const mode of ["quick", "deep", "sync"] as const) {
      expect(() => assertDeleteIsDryRun(buildArgv(mode, "/src/x", target(), []))).not.toThrow();
    }
  });
});

describe("a destination that cannot store permissions", () => {
  /**
   * An SMB share that maps every file to a fixed mode makes rsync report
   * `.f...p.....` for every file on every check — 2,508 of them on one folder
   * in real use. The content is identical and the difference can never be
   * resolved by syncing, so the flag has to come off.
   */
  const target = (flagsDrop: string[]) =>
    ({
      name: "t",
      path: "/d",
      required: true,
      sentinel: "s",
      fstype: "smbfs",
      modifyWindow: 0,
      flagsDrop,
    }) as unknown as Target;

  test("permissions are preserved by default", () => {
    expect(buildArgv("quick", "/s", target([]), [])).not.toContain("--no-perms");
  });

  test("dropping -p emits --no-perms, since -a implies it", () => {
    // Omitting a flag cannot remove it: `-a` turns `-p` back on.
    expect(buildArgv("quick", "/s", target(["-p"]), [])).toContain("--no-perms");
  });

  test("it applies to every mode, not just checks", () => {
    for (const mode of ["quick", "deep", "sync"] as const) {
      expect(buildArgv(mode, "/s", target(["-p"]), []), mode).toContain("--no-perms");
    }
  });

  test("dropping -p does not disturb the other metadata flags", () => {
    const argv = buildArgv("quick", "/s", target(["-p"]), []);
    expect(argv).toContain("-A");
    expect(argv).toContain("-X");
  });
});

describe("explaining an itemize string", () => {
  test("the common case reads as one word", () => {
    // `.f...p.....` is exact and unreadable without the rsync manual open.
    expect(explainFlags(".f...p.....")).toBe("permissions");
  });

  test("several differences are all named", () => {
    expect(explainFlags(".d..tp.....")).toBe("time, permissions");
    expect(explainFlags(">f.st......")).toBe("size, time");
  });

  test("a file being created from nothing is not itemised attribute by attribute", () => {
    // Every column is `+`; listing them would be noise dressed as detail.
    expect(explainFlags(">f+++++++++")).toBeNull();
  });

  test("an identical file and a deletion have nothing to explain", () => {
    expect(explainFlags(".f         ")).toBeNull();
    expect(explainFlags("*deleting")).toBeNull();
  });

  test("xattr and acl columns are read from the right positions", () => {
    expect(explainFlags(".f........x")).toBe("xattr");
    expect(explainFlags(".f.......a.")).toBe("acl");
  });
});
