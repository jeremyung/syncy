import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Config, parseConfig } from "../src/config.ts";
import { fingerprint } from "../src/fingerprint.ts";
import { checkBuild, DEFAULT_RSYNC } from "../src/rsync.ts";
import { allReachability, checkUnit, listUnits, targetReachability } from "../src/scan.ts";
import { SENTINEL_NAME, writeSentinel } from "../src/sentinel.ts";
import { EMPTY_STATE, type State, upsertScan } from "../src/state.ts";
import { evaluateUnit } from "../src/status.ts";
import { makeFixtureDir, removeFixtureDir } from "./helpers.ts";

/**
 * End-to-end against the real rsync binary. These codify the behaviours that
 * decide whether it is safe to delete a folder, so they run the actual
 * subprocess rather than a stub.
 */

const build = await checkBuild(DEFAULT_RSYNC);
const describeRsync = build.ok ? describe : describe.skip;

let root: string;
let config: Config;
let prevStateHome: string | undefined;

const write = (p: string, body: string): void => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
};

beforeEach(async () => {
  root = makeFixtureDir("syncy-e2e");
  // Its own state directory, so staging is not shared with other test files.
  prevStateHome = process.env["XDG_STATE_HOME"];
  process.env["XDG_STATE_HOME"] = join(root, "state");
  for (const d of ["src", "ext", "nas"]) mkdirSync(join(root, d), { recursive: true });

  write(join(root, "src/photos-2019/a.txt"), "aaa");
  write(join(root, "src/photos-2019/b.txt"), "bbbb");
  write(join(root, "src/photos-2019/.DS_Store"), "junk");
  write(join(root, "src/photos-2024/c.txt"), "ccccc");

  const extId = await writeSentinel(join(root, "ext"));
  const nasId = await writeSentinel(join(root, "nas"));

  config = parseConfig(`
source = "${join(root, "src")}"
exclude = [".DS_Store"]

[status]
max_verify_age_days = 30
max_quick_age_days  = 7
min_targets         = 2

[[target]]
name = "ext"
path = "${join(root, "ext")}"
required = true
sentinel = "${extId}"

[[target]]
name = "nas"
path = "${join(root, "nas")}"
required = true
sentinel = "${nasId}"
`);
});

afterEach(() => {
  if (prevStateHome === undefined) delete process.env["XDG_STATE_HOME"];
  else process.env["XDG_STATE_HOME"] = prevStateHome;
  removeFixtureDir(root);
});

const target = (name: string) => config.targets.find((t) => t.name === name)!;

/** Replicate a unit to a target the way a real sync would. */
async function replicate(unit: string, name: string): Promise<void> {
  const dst = join(target(name).path, unit);
  mkdirSync(dst, { recursive: true });
  const proc = Bun.spawn(
    [DEFAULT_RSYNC, "-a", "--exclude=.DS_Store", join(config.source, unit) + "/", dst + "/"],
    { stdout: "pipe", stderr: "pipe" },
  );
  await proc.exited;
}

const evaluate = async (state: State, unit: string) =>
  evaluateUnit(config, state, {
    unit,
    fingerprint: fingerprint(join(config.source, unit), config.exclude),
    sentinels: await allReachability(config),
  });

describeRsync("units and reachability", () => {
  test("units are the immediate subfolders, sorted, dotfiles skipped", () => {
    mkdirSync(join(root, "src/.hidden"), { recursive: true });
    expect(listUnits(config.source)).toEqual(["photos-2019", "photos-2024"]);
  });

  test("a target with its sentinel present is reachable", async () => {
    expect(await targetReachability(target("ext"))).toBe("ok");
  });

  test("a target whose sentinel is gone is NOT reachable, though the path exists", async () => {
    // The disaster case: an unmounted /Volumes/x is still a writable directory.
    unlinkSync(join(target("ext").path, SENTINEL_NAME));
    expect(existsSync(target("ext").path)).toBe(true);
    expect(await targetReachability(target("ext"))).toBe("missing");
  });

  test("a different volume mounted at the same path is detected", async () => {
    writeFileSync(join(target("ext").path, SENTINEL_NAME), "some-other-uuid\n");
    expect(await targetReachability(target("ext"))).toBe("mismatch");
  });
});

describeRsync("check outcomes against real rsync", () => {
  test("an unreplicated unit is missing, without itemising the whole tree", async () => {
    const { scan, argv } = await checkUnit(config, "photos-2019", target("ext"), "quick");
    expect(scan.outcome).toBe("missing");
    expect(scan.nChanges).toBe(0);
    expect(argv).toEqual([]);
  });

  test("a fully replicated unit is clean", async () => {
    await replicate("photos-2019", "ext");
    const { scan } = await checkUnit(config, "photos-2019", target("ext"), "quick");
    expect(scan.outcome).toBe("clean");
    expect(scan.nChanges).toBe(0);
  });

  test("a partially replicated unit is behind, with a count and bytes", async () => {
    await replicate("photos-2019", "ext");
    unlinkSync(join(target("ext").path, "photos-2019/b.txt"));
    const { scan } = await checkUnit(config, "photos-2019", target("ext"), "quick");
    expect(scan.outcome).toBe("behind");
    expect(scan.nChanges).toBe(1);
    expect(scan.bytesPending).toBe(4);
  });

  test("excluded files do not make a unit look behind forever", async () => {
    // .DS_Store exists at the source and not the target; without the exclude
    // reaching rsync, this unit could never read clean.
    await replicate("photos-2019", "ext");
    const { scan } = await checkUnit(config, "photos-2019", target("ext"), "quick");
    expect(scan.outcome).toBe("clean");
  });

  test("files at the target but not the source are counted as extras, not changes", async () => {
    await replicate("photos-2019", "ext");
    write(join(target("ext").path, "photos-2019/orphan.txt"), "left over");
    const { scan } = await checkUnit(config, "photos-2019", target("ext"), "quick");
    // Extras never endanger source data, so they must not block a clean result.
    expect(scan.outcome).toBe("clean");
    expect(scan.nExtra).toBe(1);
  });

  test("the deep verify records the literal argv it ran", async () => {
    await replicate("photos-2019", "ext");
    const { argv } = await checkUnit(config, "photos-2019", target("ext"), "deep");
    expect(argv).toContain("-c");
    expect(argv).toContain("-n");
    expect(argv).not.toContain("--delete");
    expect(argv[argv.length - 1]!.endsWith("/")).toBe(true);
  });

  test("deep verify catches corruption that a quick check cannot see", async () => {
    await replicate("photos-2019", "ext");
    // Same size, same mtime, different bytes: silent bit rot.
    const victim = join(target("ext").path, "photos-2019/b.txt");
    const { mtimeMs, atimeMs } = await import("node:fs").then((fs) => fs.statSync(victim));
    writeFileSync(victim, "xxxx");
    const fs = await import("node:fs");
    fs.utimesSync(victim, new Date(atimeMs), new Date(mtimeMs));

    const quick = await checkUnit(config, "photos-2019", target("ext"), "quick");
    expect(quick.scan.outcome).toBe("clean");

    const deep = await checkUnit(config, "photos-2019", target("ext"), "deep");
    expect(deep.scan.outcome).toBe("behind");
  });
});

describeRsync("the ladder, end to end", () => {
  const bothVerified = async (): Promise<State> => {
    await replicate("photos-2019", "ext");
    await replicate("photos-2019", "nas");
    let state = EMPTY_STATE;
    for (const name of ["ext", "nas"]) {
      const { scan } = await checkUnit(config, "photos-2019", target(name), "deep");
      state = upsertScan(state, scan);
    }
    return state;
  };

  test("deep verified on both targets reaches verified", async () => {
    const state = await bothVerified();
    expect((await evaluate(state, "photos-2019")).state).toBe("verified");
  });

  test("quick-only on both targets stays unverified", async () => {
    await replicate("photos-2019", "ext");
    await replicate("photos-2019", "nas");
    let state = EMPTY_STATE;
    for (const name of ["ext", "nas"]) {
      const { scan } = await checkUnit(config, "photos-2019", target(name), "quick");
      state = upsertScan(state, scan);
    }
    const s = await evaluate(state, "photos-2019");
    expect(s.state).toBe("unverified");
    expect(s.reason).toContain("bytes unread");
  });

  test("editing the source after verifying demotes the unit", async () => {
    const state = await bothVerified();
    expect((await evaluate(state, "photos-2019")).state).toBe("verified");

    write(join(config.source, "photos-2019/new.txt"), "added later");
    const s = await evaluate(state, "photos-2019");
    expect(s.state).toBe("unverified");
    expect(s.reason).toContain("source changed");
  });

  test("a target going offline makes the unit unknown, never verified", async () => {
    const state = await bothVerified();
    unlinkSync(join(target("ext").path, SENTINEL_NAME));
    const s = await evaluate(state, "photos-2019");
    expect(s.state).toBe("unchecked");
    expect(s.reason).toContain("ext");
  });

  test("one target verified and the other missing is not verified", async () => {
    await replicate("photos-2019", "ext");
    let state = EMPTY_STATE;
    for (const name of ["ext", "nas"]) {
      const { scan } = await checkUnit(config, "photos-2019", target(name), "deep");
      state = upsertScan(state, scan);
    }
    const s = await evaluate(state, "photos-2019");
    expect(s.state).toBe("missing");
    expect(s.reason).toContain("nas");
  });

  test("a unit never checked anywhere is unknown, not missing", async () => {
    // Absence of evidence is not evidence of absence.
    expect((await evaluate(EMPTY_STATE, "photos-2024")).state).toBe("unchecked");
  });
});
