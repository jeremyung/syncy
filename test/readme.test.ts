import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Target } from "../src/config.ts";
import { buildArgv, type Mode } from "../src/rsync.ts";
import { PROJECT_ROOT } from "./helpers.ts";

/**
 * The README claims these are the only three commands syncy runs.
 *
 * A claim like that decays the moment a flag changes, and the README is the one
 * file nothing else references — so nothing fails when it goes stale. It had
 * already lost `-vv` from every command and was still advertising 347 tests
 * against a suite well past 500.
 */

const README = readFileSync(join(PROJECT_ROOT, "README.md"), "utf8");

const target = {
  name: "nas",
  path: "/dst",
  required: true,
  sentinel: "s",
  fstype: "smbfs",
  modifyWindow: 0,
  flagsDrop: [],
} as unknown as Target;

/** Flags only: paths and excludes are elided in the README with a `…`. */
const flags = (parts: readonly string[]): string[] =>
  parts.filter((a) => a.startsWith("-") && !a.startsWith("--exclude"));

/**
 * The documented flags for one mode.
 *
 * `sync` wraps onto a continuation line, which carries flags of its own, so
 * any indented line following the mode's line is folded in.
 */
function documented(mode: Mode): string[] {
  const lines = README.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^${mode}\\s+-`).test(l));
  expect(start, `no ${mode} line in the README command block`).toBeGreaterThanOrEqual(0);
  const folded = [lines[start]!];
  for (let i = start + 1; i < lines.length && /^\s{4,}-/.test(lines[i]!); i++) folded.push(lines[i]!);
  return flags(folded.join(" ").replace(new RegExp(`^${mode}`), "").trim().split(/\s+/));
}

describe("the README documents the commands that actually run", () => {
  for (const mode of ["quick", "deep", "sync"] as const) {
    test(`${mode} matches what buildArgv produces`, () => {
      expect(documented(mode)).toEqual(flags(buildArgv(mode, "/src", target, [".DS_Store"])));
    });
  }

  test("it still claims there is no fourth command", () => {
    expect(README).toContain("These three, and nothing else");
  });
});

describe("the README's test count is not wildly stale", () => {
  /**
   * Derived rather than pinned. Pinning an exact number makes every added test
   * fail this, which trains people to edit the number without reading why it
   * moved. Counting `test(` calls gives a lower bound — loops generate more at
   * runtime than appear in source — so the claim must sit above it.
   */
  const declared = readdirSync(join(PROJECT_ROOT, "test"))
    .filter((f) => f.endsWith(".test.ts") || f.endsWith(".test.tsx"))
    .reduce((n, f) => n + (readFileSync(join(PROJECT_ROOT, "test", f), "utf8").match(/\btest\(/g)?.length ?? 0), 0);

  test("there are tests to count", () => {
    expect(declared).toBeGreaterThan(100);
  });

  test("the advertised count is at least the number written down", () => {
    const claimed = Number(/bun test\s+#\s*(\d+) tests/.exec(README)?.[1]);
    expect(claimed, "the README no longer states a test count").toBeGreaterThan(0);
    expect(claimed).toBeGreaterThanOrEqual(declared);
    // And not so far above it that it is obviously a number from another era.
    expect(claimed).toBeLessThan(declared * 2);
  });
});
