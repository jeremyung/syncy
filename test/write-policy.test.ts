import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeFixtureDir, removeFixtureDir, PROJECT_ROOT } from "./helpers.ts";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfig, type Config, type Target } from "../src/config.ts";
import { PROBE_DIR, probeTarget, removeProbeDir } from "../src/probe.ts";
import { buildArgv, checkBuild, DEFAULT_RSYNC, OUT_FORMAT, PARTIAL_DIR } from "../src/rsync.ts";
import { SENTINEL_NAME, writeSentinel } from "../src/sentinel.ts";
import { isInsideStaging, makeStaging, removeStaging, stagingRoot } from "../src/staging.ts";
import { startSync } from "../src/sync.ts";

/**
 * The write policy: syncy writes directly only inside its own config and state
 * directories. Everything that lands in a source or target directory gets there
 * via rsync.
 *
 * The single exception is removing the probe directory, which is scoped by name
 * to a path syncy itself created.
 */

const build = await checkBuild(DEFAULT_RSYNC);
const describeRsync = build.ok ? describe : describe.skip;

let root: string;
let prevStateHome: string | undefined;

beforeEach(() => {
  root = makeFixtureDir("syncy-policy");
  mkdirSync(join(root, "src/unit-a"), { recursive: true });
  mkdirSync(join(root, "dst"), { recursive: true });
  writeFileSync(join(root, "src/unit-a/a.txt"), "aaa");
  prevStateHome = process.env["XDG_STATE_HOME"];
  process.env["XDG_STATE_HOME"] = join(root, "state");
});

afterEach(() => {
  if (prevStateHome === undefined) delete process.env["XDG_STATE_HOME"];
  else process.env["XDG_STATE_HOME"] = prevStateHome;
  removeFixtureDir(root);
});

const target = (over: Partial<Target> = {}): Target => ({
  name: "dst",
  path: join(root, "dst"),
  required: true,
  sentinel: "s",
  fstype: "apfs",
  modifyWindow: 0,
  flagsDrop: [],
  ...over,
});

describe("no source file writes outside the allowed modules", () => {
  // Matched only sync node:fs calls by name, so it was blind to every other
  // way this runtime can put bytes on disk: `Bun.write(`, the `.writer()`
  // streaming handle `sync.ts` actually uses for its per-transfer log,
  // `node:fs/promises` imports, and the bare async `writeFile`/`appendFile`.
  // src/sync.ts:79 writes through `Bun.file(logPath).writer()` and passed
  // this guard silently — not because the write was allowed, but because the
  // guard could not see it.
  const WRITE_CALLS =
    /\b(writeFileSync|appendFileSync|mkdirSync|mkdtempSync|renameSync|rmSync|unlinkSync|openSync|copyFileSync|symlinkSync|truncateSync|utimesSync|writeFile|appendFile|Bun\.write)\s*\(|\.writer\s*\(\)|from\s+["']node:fs\/promises["']/;

  /**
   * Modules permitted to write, and why.
   *
   * `staging` and the state/config writers own syncy's own directories.
   * `probe` removes only its own probe directory. Anything else appearing here
   * is a new direct write and needs justifying.
   */
  const ALLOWED = new Set([
    "configio.ts", // the config file syncy owns
    "state.ts", // state.json and history.jsonl
    "log.ts", // the debug log
    "staging.ts", // scratch inside the state directory
    "paths.ts", // path construction only
    "cli.ts", // `syncy init` writes the starter config
    "scan.ts", // creates the log directory
    "diff.ts", // per-folder difference listings, inside the state directory
    "sync.ts", // the per-transfer log, inside the state directory
    // Permitted for removeProbeDir only, which refuses any path not named
    // `.syncy-probe`. It performs no writes.
    "probe.ts",
  ]);

  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) files.push(p);
    }
  };
  walk(join(PROJECT_ROOT, "src"));

  test("there are source files to check", () => {
    expect(files.length).toBeGreaterThan(15);
  });

  for (const file of files) {
    const name = file.slice(join(PROJECT_ROOT, "src").length + 1);
    if (ALLOWED.has(name.split("/").pop()!)) continue;
    test(`${name} performs no direct filesystem writes`, () => {
      const src = readFileSync(file, "utf8");
      const offenders = src
        .split("\n")
        .map((line, i) => ({ line: line.trim(), n: i + 1 }))
        .filter(({ line }) => WRITE_CALLS.test(line) && !line.startsWith("//") && !line.startsWith("*"));
      expect(
        offenders.map((o) => `${name}:${o.n} ${o.line}`),
        `${name} writes directly; deliver it through rsync or justify it in the allow list`,
      ).toEqual([]);
    });
  }
});

describe("staging is confined to the state directory", () => {
  test("a staging directory is inside the state directory, never a target", () => {
    const dir = makeStaging("test");
    expect(isInsideStaging(dir)).toBe(true);
    expect(dir.startsWith(join(root, "state"))).toBe(true);
    expect(dir.startsWith(join(root, "dst"))).toBe(false);
    removeStaging(dir);
  });

  test("removal refuses a path outside staging", () => {
    expect(() => removeStaging(join(root, "dst"))).toThrow(/outside staging/);
    expect(() => removeStaging(stagingRoot())).toThrow(/outside staging/);
    expect(() => removeStaging(PROJECT_ROOT)).toThrow(/outside staging/);
  });
});

describe("probe directory removal is scoped by name", () => {
  test("refuses anything that is not a probe directory", () => {
    // The only direct removal syncy performs outside its own state directory.
    for (const bad of [join(root, "dst"), join(root, "src"), "/", join(root, "dst/photos")]) {
      expect(() => removeProbeDir(bad)).toThrow(/not a probe directory/);
    }
  });

  test("accepts a real probe directory", () => {
    const dir = join(root, "dst", PROBE_DIR);
    mkdirSync(dir, { recursive: true });
    expect(() => removeProbeDir(dir)).not.toThrow();
    expect(existsSync(dir)).toBe(false);
  });
});

describeRsync("everything that lands in a target arrives via rsync", () => {
  test("the sentinel is delivered by rsync, not written directly", async () => {
    const id = await writeSentinel(join(root, "dst"));
    expect(readFileSync(join(root, "dst", SENTINEL_NAME), "utf8").trim()).toBe(id);
  });

  test("adopting a target twice keeps the original id", async () => {
    // Re-adding a target must not orphan the scans recorded against it.
    const first = await writeSentinel(join(root, "dst"));
    const second = await writeSentinel(join(root, "dst"));
    expect(second).toBe(first);
  });

  test("the sentinel leaves no staging behind", async () => {
    await writeSentinel(join(root, "dst"));
    const staging = stagingRoot();
    expect(!existsSync(staging) || readdirSync(staging).length === 0).toBe(true);
  });

  test("the probe stages outside the target and cleans up after itself", async () => {
    const before = readdirSync(join(root, "dst")).sort();
    const result = await probeTarget(join(root, "dst"));
    const after = readdirSync(join(root, "dst")).sort();
    expect(after).toEqual(before);
    expect(result.detail).toBeTruthy();
  }, 15_000);

  test("a sync does not pre-create the destination; rsync does", async () => {
    const config: Config = parseConfig(
      `source = "${join(root, "src")}"\n[[target]]\nname="dst"\npath="${join(root, "dst")}"\nsentinel="s"\n`,
    );
    const dest = join(root, "dst", "unit-a");
    expect(existsSync(dest)).toBe(false);
    const h = startSync(config, "unit-a", target());
    await h.done;
    expect(existsSync(join(dest, "a.txt"))).toBe(true);
  });

  test("a failed sync leaves nothing at the destination", async () => {
    // rsync creating the destination means a refused transfer creates nothing.
    const config: Config = parseConfig(
      `source = "${join(root, "src")}"\n[[target]]\nname="dst"\npath="${join(root, "dst")}"\nsentinel="s"\n`,
    );
    // Bun.spawn raises synchronously when the binary is missing; the Job view
    // catches it. What matters here is that nothing was created first.
    expect(() => startSync(config, "unit-a", target(), { bin: "/nonexistent/rsync" })).toThrow();
    expect(existsSync(join(root, "dst", "unit-a"))).toBe(false);
  });
});

describe("the rsync arguments, stated exactly", () => {
  // Built inside each test: a describe body runs at collection time, before
  // beforeEach has created the fixture, so `root` would still be undefined.
  const exclude = [".DS_Store"];

  test("quick check", () => {
    expect(buildArgv("quick", "/src/u", target(), exclude)).toEqual([
      "-a",
      "-A",
      "-X",
      "-n",
      "-i",
      // -vv makes rsync report every file as it finishes with it, which is the
      // only source of progress inside a folder.
      "-vv",
      `--out-format=${OUT_FORMAT}`,
      "--delete",
      "--exclude=.syncy-*",
      "--exclude=.DS_Store",
      "/src/u/",
      `${target().path}/`,
    ]);
  });

  test("deep verify", () => {
    expect(buildArgv("deep", "/src/u", target(), exclude)).toEqual([
      "-a",
      "-A",
      "-X",
      "-c",
      "-n",
      "-i",
      "-vv",
      `--out-format=${OUT_FORMAT}`,
      "--exclude=.syncy-*",
      "--exclude=.DS_Store",
      "/src/u/",
      `${target().path}/`,
    ]);
  });

  test("sync", () => {
    expect(buildArgv("sync", "/src/u", target(), exclude)).toEqual([
      "-a",
      "-A",
      "-X",
      "-i",
      `--out-format=${OUT_FORMAT}`,
      `--partial-dir=${PARTIAL_DIR}`,
      "--exclude=.syncy-*",
      "--exclude=.DS_Store",
      "/src/u/",
      `${target().path}/`,
    ]);
  });

  test("only the quick check ever carries --delete, and only with -n", () => {
    for (const mode of ["quick", "deep", "sync"] as const) {
      const argv = buildArgv(mode, "/src/u", target(), exclude);
      if (argv.includes("--delete")) expect(argv).toContain("-n");
    }
  });

  test("no mode carries -P, --partial, --inplace or --remove-source-files", () => {
    // Each of these could leave a truncated file or remove source data.
    for (const mode of ["quick", "deep", "sync"] as const) {
      const argv = buildArgv(mode, "/src/u", target(), exclude);
      for (const forbidden of ["-P", "--partial", "--inplace", "--remove-source-files", "--force"]) {
        expect(argv, `${mode} carries ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  test("exFAT adds a modify window, and nothing else does", () => {
    expect(buildArgv("sync", "/src/u", target({ modifyWindow: 2 }), [])).toContain(
      "--modify-window=2",
    );
    expect(buildArgv("sync", "/src/u", target(), []).some((a) => a.startsWith("--modify-window"))).toBe(
      false,
    );
  });

  test("flags_drop removes only the metadata flags", () => {
    const argv = buildArgv("sync", "/src/u", target({ flagsDrop: ["-A", "-X"] }), []);
    expect(argv).not.toContain("-A");
    expect(argv).not.toContain("-X");
    expect(argv).toContain("-a");
  });
});
