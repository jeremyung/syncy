import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeFixtureDir, removeFixtureDir } from "./helpers.ts";
import { parseConfig, type Config, type Target } from "../src/config.ts";
import { checkUnit } from "../src/scan.ts";
import { appendHistory } from "../src/state.ts";

/**
 * `checkUnit` records the exit code rsync actually returned, not a code
 * invented from syncy's own verdict, and treats rsync's exit 24 — "some
 * files vanished before they could be transferred" — as routine on a live
 * archive rather than as an error.
 *
 * A fake "rsync" stands in for the real one: the exit code has to be exactly
 * what the test says, and a small, static fixture cannot be relied on to make
 * the real binary return 23 or 24 on demand.
 */

let root: string;
beforeEach(() => {
  root = makeFixtureDir("syncy-scan");
});
afterEach(() => {
  removeFixtureDir(root);
});

/** A script standing in for rsync: ignores its argv, prints `lines`, exits `code`. */
function fakeRsync(code: number, lines: readonly string[] = []): string {
  const bin = join(root, `fake-rsync-${code}-${Math.random().toString(36).slice(2)}.sh`);
  const body =
    "#!/bin/sh\n" + lines.map((l) => `printf '%s\\n' '${l}'\n`).join("") + `exit ${code}\n`;
  writeFileSync(bin, body);
  chmodSync(bin, 0o755);
  return bin;
}

function makeConfig(): Config {
  return parseConfig(`
source = "${join(root, "src")}"

[[target]]
name = "ext"
path = "${join(root, "ext")}"
sentinel = "s1"
`);
}

/** A unit that already exists at both the source and the destination. */
function setUpUnit(config: Config): Target {
  mkdirSync(join(config.source, "photos"), { recursive: true });
  const target = config.targets[0]!;
  mkdirSync(join(target.path, "photos"), { recursive: true });
  return target;
}

describe("checkUnit records the exit code rsync actually returned", () => {
  test("a non-zero code is recorded literally, not folded to 1", async () => {
    const config = makeConfig();
    const target = setUpUnit(config);
    const { exitCode, scan } = await checkUnit(config, "photos", target, "quick", {
      bin: fakeRsync(5),
    });
    expect(exitCode).toBe(5);
    expect(scan.outcome).toBe("error");
  });

  test("the code reaches history.jsonl unchanged", async () => {
    // The bug: App.tsx and cli.ts wrote `scan.outcome === "error" ? 1 : 0` —
    // syncy's own verdict, not the number rsync returned.
    const config = makeConfig();
    const target = setUpUnit(config);
    const { exitCode, argv, scan } = await checkUnit(config, "photos", target, "quick", {
      bin: fakeRsync(5),
    });
    const file = join(root, "history.jsonl");
    appendHistory({ ts: scan.ts, unit: "photos", target: target.name, argv, exitCode }, file);
    const written = JSON.parse(readFileSync(file, "utf8").trim());
    expect(written.exitCode).toBe(5);
  });

  test("exit 0 is unaffected", async () => {
    const config = makeConfig();
    const target = setUpUnit(config);
    const { exitCode, scan } = await checkUnit(config, "photos", target, "quick", {
      bin: fakeRsync(0),
    });
    expect(exitCode).toBe(0);
    expect(scan.outcome).toBe("clean");
  });

  test("exit 23 — partial transfer — is still an error", async () => {
    // Distinguished on purpose from 24: 23 means rsync could not finish
    // sending some files, which is a real problem the run should surface.
    const config = makeConfig();
    const target = setUpUnit(config);
    const { exitCode, scan } = await checkUnit(config, "photos", target, "quick", {
      bin: fakeRsync(23),
    });
    expect(exitCode).toBe(23);
    expect(scan.outcome).toBe("error");
  });
});

describe("exit 24 — files vanished mid-walk — is not an error", () => {
  /**
   * rsync returns 24 when a file it saw while building its list is gone by
   * the time it gets to it — routine on an archive that is still being
   * written to while a check reads it. Counting every non-zero exit as an
   * error made a perfectly healthy folder read as broken on any check that
   * raced an ordinary write.
   */
  test("a clean result under exit 24 is reported clean, not error", async () => {
    const config = makeConfig();
    const target = setUpUnit(config);
    const { exitCode, scan } = await checkUnit(config, "photos", target, "quick", {
      bin: fakeRsync(24),
    });
    expect(exitCode).toBe(24);
    expect(scan.outcome).toBe("clean");
  });

  test("itemized changes under exit 24 still report behind, not error", async () => {
    const config = makeConfig();
    const target = setUpUnit(config);
    const { scan } = await checkUnit(config, "photos", target, "quick", {
      bin: fakeRsync(24, [">f+++++++++|5|new.txt"]),
    });
    expect(scan.outcome).toBe("behind");
    expect(scan.nChanges).toBe(1);
  });
});
