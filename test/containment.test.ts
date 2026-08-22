import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { FIXTURE_ROOT, isInside, makeFixtureDir, PROJECT_ROOT, removeFixtureDir } from "./helpers.ts";

/**
 * Enforces that the suite never writes outside the project.
 *
 * These tests create real files, spawn real rsync and write real sentinels.
 * That is the point — the behaviours worth testing are the ones that touch the
 * filesystem — but it means containment must be checked, not assumed.
 */

const created: string[] = [];
afterEach(() => {
  for (const d of created.splice(0)) removeFixtureDir(d);
});

describe("fixture containment", () => {
  test("fixtures land inside the project", () => {
    const dir = makeFixtureDir("containment");
    created.push(dir);
    expect(isInside(dir, PROJECT_ROOT)).toBe(true);
    expect(isInside(dir, FIXTURE_ROOT)).toBe(true);
  });

  test("fixtures are not in the system temp directory", () => {
    const dir = makeFixtureDir("containment");
    created.push(dir);
    for (const forbidden of ["/var/folders", "/tmp", "/private/tmp", "/private/var/folders"]) {
      expect(dir.startsWith(forbidden), `fixture escaped to ${forbidden}`).toBe(false);
    }
  });

  test("each call gets a distinct directory", () => {
    const a = makeFixtureDir("containment");
    const b = makeFixtureDir("containment");
    created.push(a, b);
    expect(a).not.toBe(b);
  });

  test("removal refuses a path outside the fixture root", () => {
    // The guard that stops a bad edit from rm -rf'ing something real.
    expect(() => removeFixtureDir(PROJECT_ROOT)).toThrow(/outside the fixture root/);
    expect(() => removeFixtureDir("/Users")).toThrow(/outside the fixture root/);
    expect(() => removeFixtureDir(FIXTURE_ROOT)).toThrow(/outside the fixture root/);
  });

  test("removal actually removes", () => {
    const dir = makeFixtureDir("containment");
    expect(existsSync(dir)).toBe(true);
    removeFixtureDir(dir);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("isInside", () => {
  test("a directory is not inside itself", () => {
    expect(isInside("/a/b", "/a/b")).toBe(false);
  });
  test("true descendants", () => {
    expect(isInside("/a/b/c", "/a/b")).toBe(true);
  });
  test("a sibling sharing a name prefix is not inside", () => {
    expect(isInside("/a/bc", "/a/b")).toBe(false);
  });
  test("a parent is not inside its child", () => {
    expect(isInside("/a", "/a/b")).toBe(false);
  });
});

describe("no test file reaches for the system temp directory", () => {
  // A grep-level guard: the helper can only contain what goes through it.
  const testFiles = readdirSync(import.meta.dir).filter(
    (f) => (f.endsWith(".test.ts") || f.endsWith(".test.tsx")) && f !== "containment.test.ts",
  );

  test("there are test files to check", () => {
    expect(testFiles.length).toBeGreaterThan(5);
  });

  for (const file of testFiles) {
    test(`${file} does not import tmpdir or hardcode a temp path`, () => {
      const src = readFileSync(join(import.meta.dir, file), "utf8");
      expect(src, `${file} imports tmpdir`).not.toContain("tmpdir");
      expect(src, `${file} hardcodes /var/folders`).not.toContain("/var/folders");
      expect(src, `${file} hardcodes /tmp/`).not.toContain('"/tmp/');
    });
  }
});

describe("syncy's own directories are redirected into the project", () => {
  // The preload (bunfig.toml) does this once for the whole run, so a test that
  // forgets to override them cannot write to ~/.config/syncy or
  // ~/.local/state/syncy.
  for (const name of ["XDG_CONFIG_HOME", "XDG_STATE_HOME"] as const) {
    test(`${name} points inside the project`, () => {
      const value = process.env[name];
      expect(value, `${name} is unset — the preload did not run`).toBeDefined();
      expect(isInside(value!, PROJECT_ROOT), `${name} = ${value}`).toBe(true);
    });
  }

  test("the resolved config and state paths are inside the project", async () => {
    const { configFile, stateFile, logDir, historyFile, diffDir } = await import("../src/paths.ts");
    for (const p of [configFile(), stateFile(), logDir(), historyFile(), diffDir()]) {
      expect(isInside(p, PROJECT_ROOT), p).toBe(true);
    }
  });

  test("the test run leaves the user's real syncy directories exactly as it found them", () => {
    // The assertion that actually matters. Absence is not the property being
    // checked — someone using syncy legitimately creates these — so this
    // compares against a snapshot taken by the preload before any test ran.
    const before = (globalThis as Record<string, unknown>)["__syncyRealDirs"] as
      | ReadonlyArray<{ path: string; exists: boolean; mtimeMs: number | null }>
      | undefined;
    expect(before, "the preload did not run").toBeDefined();

    for (const snap of before!) {
      const existsNow = existsSync(snap.path);
      expect(existsNow, `${snap.path} was created by a test run`).toBe(snap.exists);
      if (snap.exists && existsNow) {
        expect(statSync(snap.path).mtimeMs, `${snap.path} was modified by a test run`).toBe(
          snap.mtimeMs!,
        );
      }
    }
  });
});

describe("no test names a path that actually exists on this machine", () => {
  /**
   * The guard the other checks cannot give.
   *
   * Fictional absolute paths are fine and widely used here: `/Users/you/…` and
   * `/Volumes/media/…` exercise config parsing and argv construction without
   * ever reaching the filesystem. What must never appear is a path that is real
   * on the machine running the suite — someone pasting their own config into a
   * test is how a suite starts operating on a live archive, and every other
   * guard here would pass while it did.
   */
  const testFiles = readdirSync(import.meta.dir).filter(
    (f) => (f.endsWith(".test.ts") || f.endsWith(".test.tsx")) && f !== "containment.test.ts",
  );

  const home = process.env["HOME"] ?? "";
  const mounted = (() => {
    try {
      return readdirSync("/Volumes").map((v) => `/Volumes/${v}`);
    } catch {
      return [];
    }
  })();

  test("there is something to check against", () => {
    expect(testFiles.length).toBeGreaterThan(5);
    expect(home).not.toBe("");
  });

  for (const file of testFiles) {
    test(`${file} names no real home or volume path`, () => {
      const src = readFileSync(join(import.meta.dir, file), "utf8");
      const literals = [...src.matchAll(/["'`](\/(?:[A-Za-z0-9._ -]+\/?)+)["'`]/g)].map((m) => m[1]!);
      const offenders = literals.filter((lit) => {
        const abs = resolve(lit);
        // Paths inside the project are the point of the fixture helpers.
        if (abs === PROJECT_ROOT || isInside(abs, PROJECT_ROOT)) return false;
        if (isInside(abs, home) || abs === home) return true;
        return mounted.some((v) => abs === v || isInside(abs, v));
      });
      expect(
        offenders,
        `${file} names a path that exists on this machine; use a fixture instead`,
      ).toEqual([]);
    });
  }
});

describe("the diff store writes inside the project during tests", () => {
  // saveDiff defaults to the resolved state directory rather than taking a
  // path, so this is the check that the default is the redirected one.
  test("a diff saved with no explicit directory lands inside the project", async () => {
    const { buildDiff, saveDiff, diffFile } = await import("../src/diff.ts");
    const { diffDir } = await import("../src/paths.ts");
    saveDiff(buildDiff("containment-probe", "containment-target", "quick", []));
    const written = diffFile("containment-probe", "containment-target");
    expect(isInside(written, PROJECT_ROOT), written).toBe(true);
    expect(existsSync(written)).toBe(true);
    rmSync(written, { force: true });
    expect(isInside(diffDir(), PROJECT_ROOT)).toBe(true);
  });
});

describe("the fixture root is ignored by git", () => {
  test(".gitignore covers it, so fixtures never get committed", () => {
    const ignore = readFileSync(resolve(PROJECT_ROOT, ".gitignore"), "utf8");
    expect(ignore).toContain(".test-tmp");
  });
});

describe("the debug log does not grow without limit", () => {
  /**
   * Diagnostics are worth leaving on permanently — a full run costs under two
   * milliseconds — but only if the file cannot swell unnoticed in a directory
   * nobody watches. One real log reached 4.5 MB.
   */
  test("it rotates once it passes the cap, keeping one previous file", async () => {
    const dir = makeFixtureDir("syncy-logrot");
    const prevState = process.env["XDG_STATE_HOME"];
    const prevDebug = process.env["SYNCY_DEBUG"];
    process.env["XDG_STATE_HOME"] = dir;
    process.env["SYNCY_DEBUG"] = "1";
    try {
      const { debug, debugLogPath, MAX_LOG_BYTES } = await import("../src/log.ts");
      const file = debugLogPath();
      expect(isInside(file, PROJECT_ROOT), file).toBe(true);
      debug("first");
      writeFileSync(file, "x".repeat(MAX_LOG_BYTES + 1));
      debug("after the cap");
      expect(existsSync(`${file}.1`), "previous log kept").toBe(true);
      expect(readFileSync(file, "utf8")).toContain("after the cap");
      expect(statSync(file).size).toBeLessThan(MAX_LOG_BYTES);
    } finally {
      if (prevState === undefined) delete process.env["XDG_STATE_HOME"];
      else process.env["XDG_STATE_HOME"] = prevState;
      if (prevDebug === undefined) delete process.env["SYNCY_DEBUG"];
      else process.env["SYNCY_DEBUG"] = prevDebug;
      removeFixtureDir(dir);
    }
  });
});
