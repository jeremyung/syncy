import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { type Config, parseConfig } from "../src/config.ts";
import type { Fingerprint } from "../src/fingerprint.ts";
import { EMPTY_STATE, type Scan, type State } from "../src/state.ts";
import { evaluateUnit } from "../src/status.ts";
import { Ledger, type Row } from "../src/tui/Ledger.tsx";
import { THEMES } from "../src/tui/theme.ts";

/**
 * Targets are data, not code.
 *
 * syncy has no notion of an "external drive" or a "nas" — only of N named
 * destinations. These assert that any count and any naming works, and in
 * particular that a single-destination setup can reach `verified`, which it
 * could not while `min_targets` defaulted to 2.
 */

const NOW = Date.parse("2026-08-21T12:00:00Z");
const FP: Fingerprint = { nfiles: 1, bytes: 1024, maxMtimeNs: "1" };

function configWith(names: readonly string[], extra = ""): Config {
  return parseConfig(
    `source = "/src"\n${extra}` +
      names
        .map((n, i) => `[[target]]\nname = "${n}"\npath = "/dest-${i}"\nsentinel = "s${i}"\n`)
        .join(""),
  );
}

/** State where every target has a fresh, clean deep verify. */
function allVerified(config: Config): State {
  const scans: Scan[] = config.targets.map((t) => ({
    unit: "u",
    target: t.name,
    ts: NOW,
    method: "deep",
    outcome: "clean",
    nChanges: 0,
    nExtra: 0,
    bytesPending: 0,
    fingerprint: FP,
    sentinel: t.sentinel ?? "",
  }));
  return { version: 1, scans };
}

const evaluate = (config: Config, state: State) =>
  evaluateUnit(
    config,
    state,
    {
      unit: "u",
      fingerprint: FP,
      sentinels: new Map(config.targets.map((t) => [t.name, "ok" as const])),
    },
    NOW,
  );

describe("any number of targets", () => {
  test("a single target can reach verified", () => {
    // The whole point: one backup drive is a legitimate setup. This was
    // impossible while min_targets defaulted to 2.
    const config = configWith(["my-one-drive"]);
    expect(evaluate(config, allVerified(config)).state).toBe("verified");
  });

  test("min_targets defaults to 1, not 2", () => {
    expect(configWith(["a"]).minTargets).toBe(1);
  });

  test("two, three and five targets all reach verified when all are clean", () => {
    for (const n of [2, 3, 5]) {
      const names = Array.from({ length: n }, (_, i) => `dest-${i}`);
      const config = configWith(names);
      expect(evaluate(config, allVerified(config)).state, `${n} targets`).toBe("verified");
    }
  });

  test("every required target must be verified, however many there are", () => {
    const config = configWith(["a", "b", "c"]);
    const state = allVerified(config);
    // Drop one target's scan: the unit must not still read verified.
    const partial: State = { version: 1, scans: state.scans.filter((s) => s.target !== "c") };
    const status = evaluate(config, partial);
    expect(status.state).not.toBe("verified");
    expect(status.reason).toContain("c");
  });

  test("a config with no targets can never reach verified", () => {
    // The dangerous case an empty roll-up would otherwise produce.
    const status = evaluateUnit(
      configWith([]),
      EMPTY_STATE,
      { unit: "u", fingerprint: FP, sentinels: new Map() },
      NOW,
    );
    expect(status.state).not.toBe("verified");
  });

  test("min_targets can still demand more than are verified", () => {
    // Someone with three destinations who insists on at least three.
    const config = configWith(["a", "b", "c"], "[status]\nmin_targets = 3\n");
    const state = allVerified(config);
    const partial: State = { version: 1, scans: state.scans.filter((s) => s.target !== "c") };
    expect(evaluate(config, partial).state).not.toBe("verified");
  });

  test("optional targets do not count toward the floor or hold a unit back", () => {
    const config = parseConfig(`
source = "/src"
[[target]]
name = "primary"
path = "/d0"
sentinel = "s0"
[[target]]
name = "spare"
path = "/d1"
sentinel = "s1"
required = false
`);
    // Only `primary` is verified; `spare` has never been checked.
    const state: State = {
      version: 1,
      scans: allVerified(config).scans.filter((s) => s.target === "primary"),
    };
    expect(evaluate(config, state).state).toBe("verified");
  });
});

describe("targets can be named anything", () => {
  const plain = (s: string | undefined): string => (s ?? "").replace(/\[[0-9;]*m/g, "");

  function frame(names: readonly string[], width = 110): string {
    const config = configWith(names);
    const row: Row = {
      status: {
        unit: "photos-2019",
        state: "verified",
        reason: "all destinations deep verified",
        cells: config.targets.map((t) => ({
          target: t.name,
          state: "verified" as const,
          reason: "r",
          nChanges: 0,
          bytesPending: 0,
          nExtra: 0,
        })),
      },
      size: 1024 ** 3,
    };
    const { lastFrame } = render(
      <Ledger
        rows={[row]}
        selected={0}
        config={config}
        state={EMPTY_STATE}
        theme={THEMES.ansi}
        width={width}
        now={NOW}
        busy={null}
      />,
    );
    return plain(lastFrame());
  }

  test("each target gets its own column, headed by its name", () => {
    const out = frame(["laptop-backup", "offsite", "archive-drive"]);
    for (const n of ["laptop-backup", "offsite", "archive-drive"]) {
      expect(out).toContain(n);
    }
  });

  test("one target renders one column", () => {
    const out = frame(["solo"]);
    expect(out).toContain("solo");
  });

  test("five targets render five columns", () => {
    const names = ["alpha", "beta", "gamma", "delta", "epsilon"];
    const out = frame(names, 140);
    for (const n of names) expect(out).toContain(n);
  });

  test("names shorter than the column width still align", () => {
    // A one-character name must not collapse the column it heads.
    const out = frame(["a", "bb", "ccc"]);
    // The shelf summary also says "folder"; the header is the row with the
    // column titles on it.
    const header = out.split("\n").find((l) => l.includes("size") && l.includes("status"))!;
    expect(header).toContain("a");
    expect(header).toContain("bb");
    expect(header).toContain("ccc");
  });

  test("the engine contains no reference to any particular target name", async () => {
    // Guards against a special case creeping in for "nas" or "external".
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { PROJECT_ROOT } = await import("./helpers.ts");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) files.push(p);
      }
    };
    walk(join(PROJECT_ROOT, "src"));
    // Comments are prose and may legitimately mention a NAS — the measurements
    // behind several decisions were taken against one. The rule is about code.
    const stripComments = (s: string): string =>
      s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

    for (const f of files) {
      const src = stripComments(readFileSync(f, "utf8"));
      // "nas" has no second meaning here, so its presence is always a smell.
      expect(/\bnas\b/i.test(src), `${f} names a specific destination`).toBe(false);
      // "external" does: a volume can be an external disk, which is a fact
      // about hardware and not about anyone's naming. What must never appear
      // is a destination being special-cased by name.
      const byName = src.match(/\.name\s*[=!]==\s*"[^"]*"/g) ?? [];
      expect(byName, `${f} branches on a destination's name`).toEqual([]);
    }
  });
});
