import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeFixtureDir, removeFixtureDir } from "./helpers.ts";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfig, type Config, type Target } from "../src/config.ts";
import { EMPTY_CONFIG, saveConfig, serializeConfig, withoutTarget, withTarget } from "../src/configio.ts";
import { fstypeFor, modifyWindowFor, parseMount } from "../src/fstype.ts";
import { completions, validateTargetPath } from "../src/tui/Setup.tsx";

let root: string;
beforeEach(() => {
  root = makeFixtureDir("syncy-setup");
});
afterEach(() => {
  removeFixtureDir(root);
});

const target = (over: Partial<Target> = {}): Target => ({
  name: "nas",
  path: "/Volumes/media/archive",
  required: true,
  sentinel: "9c41e0b2-dead-beef-0000-000000000000",
  fstype: "smbfs",
  modifyWindow: 0,
  flagsDrop: ["-X"],
  ...over,
});

describe("config serialisation", () => {
  test("round-trips through the parser unchanged", () => {
    const config: Config = withTarget(
      withTarget(EMPTY_CONFIG("/Users/you/Pictures/Archive"), target()),
      target({ name: "ext", path: "/Volumes/Archive", fstype: "apfs", flagsDrop: [] }),
    );
    expect(parseConfig(serializeConfig(config))).toEqual(config);
  });

  test("preserves the values that change rsync's behaviour", () => {
    const config = withTarget(
      EMPTY_CONFIG("/src"),
      target({ fstype: "exfat", modifyWindow: 2, flagsDrop: ["-A", "-X"] }),
    );
    const back = parseConfig(serializeConfig(config));
    expect(back.targets[0]!.modifyWindow).toBe(2);
    expect(back.targets[0]!.flagsDrop).toEqual(["-A", "-X"]);
  });

  test("escapes quotes and backslashes in paths", () => {
    const config = withTarget(EMPTY_CONFIG('/src/od"d'), target({ path: "/Volumes/back\\slash" }));
    const back = parseConfig(serializeConfig(config));
    expect(back.source).toBe('/src/od"d');
    expect(back.targets[0]!.path).toBe("/Volumes/back\\slash");
  });

  test("refuses to write a control character rather than corrupting the file", () => {
    const config = withTarget(EMPTY_CONFIG("/src\n[status]\nmin_targets = 0"), target());
    expect(() => serializeConfig(config)).toThrow(/control character/);
  });
});

describe("saveConfig", () => {
  test("writes a file the loader accepts", () => {
    const file = join(root, "config.toml");
    const config = withTarget(EMPTY_CONFIG(root), target());
    saveConfig(config, file);
    expect(parseConfig(readFileSync(file, "utf8"))).toEqual(config);
  });

  test("leaves no temp files behind", () => {
    const file = join(root, "config.toml");
    saveConfig(withTarget(EMPTY_CONFIG(root), target()), file);
    saveConfig(withTarget(EMPTY_CONFIG(root), target({ name: "other" })), file);
    expect(readdirSync(root)).toEqual(["config.toml"]);
  });

  test("refuses a config the loader would reject, leaving the old one intact", () => {
    const file = join(root, "config.toml");
    const good = withTarget(EMPTY_CONFIG("/src"), target());
    saveConfig(good, file);
    // A target nested inside the source root would fail to load.
    const bad = withTarget(EMPTY_CONFIG("/src"), target({ path: "/src/inside" }));
    expect(() => saveConfig(bad, file)).toThrow();
    expect(parseConfig(readFileSync(file, "utf8"))).toEqual(good);
  });

  test("can save with a single target, so setup can proceed one step at a time", () => {
    const file = join(root, "config.toml");
    const one = withTarget(EMPTY_CONFIG("/src"), target());
    expect(() => saveConfig(one, file)).not.toThrow();
    expect(parseConfig(readFileSync(file, "utf8")).targets).toHaveLength(1);
  });
});

describe("target list editing", () => {
  test("adding is idempotent by name", () => {
    let c = withTarget(EMPTY_CONFIG("/src"), target({ name: "nas", path: "/a" }));
    c = withTarget(c, target({ name: "nas", path: "/b" }));
    expect(c.targets).toHaveLength(1);
    expect(c.targets[0]!.path).toBe("/b");
  });

  test("targets stay sorted by name", () => {
    let c = withTarget(EMPTY_CONFIG("/src"), target({ name: "nas", path: "/a" }));
    c = withTarget(c, target({ name: "ext", path: "/b" }));
    expect(c.targets.map((t) => t.name)).toEqual(["ext", "nas"]);
  });

  test("removing leaves the others alone", () => {
    let c = withTarget(EMPTY_CONFIG("/src"), target({ name: "nas", path: "/a" }));
    c = withTarget(c, target({ name: "ext", path: "/b" }));
    expect(withoutTarget(c, "nas").targets.map((t) => t.name)).toEqual(["ext"]);
  });
});

describe("target path validation", () => {
  const config = { ...EMPTY_CONFIG("/does/not/matter"), source: "" } as Config;

  test("rejects a target inside the source root", () => {
    mkdirSync(join(root, "src/inside"), { recursive: true });
    const c: Config = { ...EMPTY_CONFIG(join(root, "src")) };
    expect(validateTargetPath(join(root, "src/inside"), c)).toBe("inside the source root");
  });

  test("rejects a target containing the source root", () => {
    mkdirSync(join(root, "src"), { recursive: true });
    const c: Config = { ...EMPTY_CONFIG(join(root, "src")) };
    expect(validateTargetPath(root, c)).toBe("contains the source root");
  });

  test("resolves a relative path rather than rejecting it", () => {
    // Config stores absolute paths, but refusing what the user plainly meant
    // is not the way to get there — expandPath resolves it instead.
    mkdirSync(join(root, "relative-target"), { recursive: true });
    const rel = join(root, "relative-target").replace(process.cwd() + "/", "");
    expect(validateTargetPath(rel, EMPTY_CONFIG(join(root, "src")))).toBeNull();
  });

  test("an empty path is refused", () => {
    expect(validateTargetPath("   ", config)).toBe("a path is required");
  });

  test("rejects a path that does not exist", () => {
    expect(validateTargetPath(join(root, "nope"), config)).toBe("no such directory");
  });

  test("rejects a file", () => {
    writeFileSync(join(root, "afile"), "x");
    expect(validateTargetPath(join(root, "afile"), config)).toBe("not a directory");
  });

  test("rejects a duplicate target", () => {
    mkdirSync(join(root, "dst"), { recursive: true });
    const c = withTarget(EMPTY_CONFIG("/src"), target({ path: join(root, "dst") }));
    expect(validateTargetPath(join(root, "dst"), c)).toBe("already a destination");
  });

  test("accepts a good path", () => {
    mkdirSync(join(root, "dst"), { recursive: true });
    expect(validateTargetPath(join(root, "dst"), EMPTY_CONFIG("/src"))).toBeNull();
  });
});

describe("path completion", () => {
  test("lists directories under a trailing slash", () => {
    mkdirSync(join(root, "alpha"), { recursive: true });
    mkdirSync(join(root, "beta"), { recursive: true });
    writeFileSync(join(root, "afile"), "x");
    const out = completions(root + "/");
    expect(out).toEqual([join(root, "alpha"), join(root, "beta")]);
  });

  test("filters by the typed stem", () => {
    mkdirSync(join(root, "archive"), { recursive: true });
    mkdirSync(join(root, "backup"), { recursive: true });
    expect(completions(join(root, "arc"))).toEqual([join(root, "archive")]);
  });

  test("hides dotfiles", () => {
    mkdirSync(join(root, ".hidden"), { recursive: true });
    mkdirSync(join(root, "shown"), { recursive: true });
    expect(completions(root + "/")).toEqual([join(root, "shown")]);
  });

  test("an unreadable path yields nothing rather than throwing", () => {
    expect(completions("/no/such/place/at/all")).toEqual([]);
  });

  test("respects the limit", () => {
    for (let i = 0; i < 10; i++) mkdirSync(join(root, `d${i}`), { recursive: true });
    expect(completions(root + "/", 3)).toHaveLength(3);
  });
});

describe("filesystem detection", () => {
  const MOUNT = `/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)
/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse)
//you@nas.local/media on /Volumes/media (smbfs, nodev, nosuid, mounted by you)
/dev/disk5s1 on /Volumes/Archive (exfat, local, nodev, nosuid)`;

  test("parses BSD mount output", () => {
    const entries = parseMount(MOUNT);
    expect(entries).toHaveLength(4);
    expect(entries[2]).toEqual({
      device: "//you@nas.local/media",
      mountPoint: "/Volumes/media",
      fstype: "smbfs",
      flags: ["nodev", "nosuid", "mounted by you"],
      local: false,
    });
  });

  test("the kernel's own local flag separates a disk from a share", () => {
    // The parser stopped at the first comma, so `local` — the one bit that
    // distinguishes them without a filesystem allow-list — was discarded.
    const entries = parseMount(MOUNT);
    expect(entries.find((e) => e.mountPoint === "/Volumes/media")?.local).toBe(false);
    expect(entries.find((e) => e.mountPoint === "/Volumes/Archive")?.local).toBe(true);
  });

  test("volumes are classified in the terms a person picking one cares about", async () => {
    const { classify, describeVolume } = await import("../src/volume.ts");
    const byPath = (p: string) => parseMount(MOUNT).find((e) => e.mountPoint === p)!;
    expect(classify(byPath("/Volumes/media"))).toBe("network");
    expect(classify(byPath("/Volumes/Archive"))).toBe("internal"); // until diskutil says external
    expect(
      describeVolume({
        mountPoint: "/Volumes/media", name: "media", kind: "network",
        fstype: "smbfs", device: "//you@nas.local/media", free: null,
      }),
    ).toBe("network · //you@nas.local/media");
  });

  test("finds the filesystem for a path inside a mount", () => {
    expect(fstypeFor("/Volumes/media/archive/2019", parseMount(MOUNT))).toBe("smbfs");
    expect(fstypeFor("/Volumes/Archive/photos", parseMount(MOUNT))).toBe("exfat");
  });

  test("the longest matching mount point wins, since mounts nest", () => {
    expect(fstypeFor("/System/Volumes/Data/Users/you", parseMount(MOUNT))).toBe("apfs");
  });

  test("falls back to the root mount", () => {
    expect(fstypeFor("/usr/local", parseMount(MOUNT))).toBe("apfs");
  });

  test("a sibling prefix is not a match", () => {
    expect(fstypeFor("/Volumes/mediatheque", parseMount(MOUNT))).toBe("apfs");
  });

  test("unparseable output yields unknown rather than a wrong answer", () => {
    expect(fstypeFor("/anything", parseMount("garbage"))).toBe("unknown");
  });

  test("FAT-family filesystems get a two-second modify window", () => {
    // Without this every file looks perpetually changed.
    for (const fs of ["exfat", "msdos", "ExFAT"]) expect(modifyWindowFor(fs)).toBe(2);
  });

  test("precise filesystems get no modify window", () => {
    for (const fs of ["apfs", "smbfs", "hfs", "unknown"]) expect(modifyWindowFor(fs)).toBe(0);
  });
});
