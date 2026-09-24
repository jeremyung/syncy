import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "./helpers.ts";

/**
 * The engine does not depend on the interface, and one function holds the lease.
 *
 * `syncy engine add-destination` identified and probed a destination through
 * functions that lived in the setup screen's Ink component file, and the
 * plain-text ledger took its summary line from the shelf component. Neither was
 * a defect yet; both meant a headless command loaded interface code, and that
 * an edit to a screen could change what the engine does.
 *
 * The acquire, refusal, heartbeat, signal and release sequence around the
 * job-owner lease was written out six times, each with its own copy of the
 * refusal message. It now lives in `withJobOwnership`, and nothing else in
 * `src/` may take a lease directly.
 */

const SRC = join(PROJECT_ROOT, "src");

/** Engine modules: the top level of `src/`, excluding the interface directory. */
const engineFiles = readdirSync(SRC).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));

/** Every source file under `src/`, as a path relative to it. */
const allFiles = readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter(
  (f) => f.endsWith(".ts") || f.endsWith(".tsx"),
);

/** Module specifiers named by `import … from` and `import(…)`, comments aside. */
function importsOf(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const found: string[] = [];
  for (const m of code.matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/g)) {
    found.push((m[1] ?? m[2])!);
  }
  return found;
}

describe("the engine does not import the interface", () => {
  test("there are engine modules to read", () => {
    expect(engineFiles.length).toBeGreaterThan(10);
    expect(engineFiles).toContain("cli.ts");
  });

  test("only the CLI's startTui import reaches into src/tui", () => {
    const offending: string[] = [];
    for (const file of engineFiles) {
      for (const spec of importsOf(readFileSync(join(SRC, file), "utf8"))) {
        if (!spec.startsWith("./tui/")) continue;
        if (file === "cli.ts" && spec === "./tui/index.tsx") continue;
        offending.push(`${file} imports ${spec}`);
      }
    }
    expect(offending).toEqual([]);
  });

  test("the CLI takes only startTui from the interface", () => {
    const cli = readFileSync(join(SRC, "cli.ts"), "utf8");
    const lines = cli.split("\n").filter((line) => /from\s+["']\.\/tui\//.test(line));
    expect(lines).toEqual([`import { startTui } from "./tui/index.tsx";`]);
  });
});

describe("one place acquires the job-owner lease", () => {
  test("acquireJobOwner is called only from withJobOwnership", () => {
    const calls: string[] = [];
    for (const file of allFiles) {
      const source = readFileSync(join(SRC, file), "utf8");
      source.split("\n").forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return;
        if (/\bacquireJobOwner\s*\(/.test(line) && !/function\s+acquireJobOwner\b/.test(line)) {
          calls.push(`${file}:${i + 1}`);
        }
      });
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.startsWith("job-owner.ts:")).toBe(true);
    const owner = readFileSync(join(SRC, "job-owner.ts"), "utf8");
    const body = owner.slice(owner.indexOf("export function withJobOwnership"));
    expect(body).toMatch(/\bacquireJobOwner\s*\(/);
  });
});
