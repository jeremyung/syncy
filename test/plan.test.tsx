import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfig, type Config } from "../src/config.ts";
import { buildArgv, checkBuild, DEFAULT_RSYNC } from "../src/rsync.ts";
import { writeSentinel } from "../src/sentinel.ts";
import { startSync } from "../src/sync.ts";
import { deviations, Plan, planText } from "../src/tui/Plan.tsx";
import { THEMES } from "../src/tui/theme.ts";
import { makeFixtureDir, removeFixtureDir } from "./helpers.ts";

/**
 * The plan screen exists so `q` and `d` are not opaque.
 *
 * Its whole value rests on being generated from the same `buildArgv` the
 * executor calls — a screen that described the commands in prose would
 * eventually lie about them.
 */

const config: Config = parseConfig(`
source = "/src"
exclude = [".DS_Store"]
[[target]]
name = "ext"
path = "/dest/ext"
sentinel = "s1"
[[target]]
name = "nas"
path = "/dest/nas"
sentinel = "s2"
flags_drop = ["-X"]
`);

const plain = (s: string | undefined): string => (s ?? "").replace(/\[[0-9;]*m/g, "");

function frame(unit = "photos-2024", width = 120): string {
  const { lastFrame } = render(
    <Plan
      config={config}
      unit={unit}
      theme={THEMES.ansi}
      width={width}
      onClose={() => undefined}
      onCopy={() => undefined}
    />,
  );
  return plain(lastFrame());
}

describe("the plan names every mode and what it costs", () => {
  test("lists quick, deep and sync with their keys", () => {
    const f = frame();
    for (const s of ["[q] quick check", "[d] deep verify", "[s] sync"]) {
      expect(f).toContain(s);
    }
  });

  test("says which one writes, and that the others do not", () => {
    const f = frame();
    // On screen the column is terse; the copyable text spells it out.
    expect(f).toContain("WRITES");
    // Each command appears once now, so q and d contribute one each.
    expect(f.match(/reads only/g)?.length).toBe(2);
    expect(planText(config, "u")).toContain("WRITES to the destination");
    expect(planText(config, "u")).toContain("writes nothing");
  });

  test("gives the cost of each, so deep is not run by accident over smb", () => {
    const f = frame();
    expect(f).toContain("compares size and date");
    expect(f).toContain("checksums every byte");
  });

  test("states plainly that nothing has run", () => {
    expect(frame()).toContain("none of these have run");
  });

  test("lists every destination, once, under the commands", () => {
    const f = frame();
    expect(f).toContain("ext");
    expect(f).toContain("nas");
    expect(f).toContain("from ");
    expect(f).toContain("to   ");
  });

  test("shows each command once, not once per destination", () => {
    // The flags are identical across targets, so repeating all three per
    // target buried the one thing worth reading.
    const f = frame();
    expect((f.match(/\[q\] quick check/g) ?? []).length).toBe(1);
    expect((f.match(/\[d\] deep verify/g) ?? []).length).toBe(1);
    expect((f.match(/\[s\] sync/g) ?? []).length).toBe(1);
  });

  test("defends --delete where it appears, rather than leaving it alarming", () => {
    const f = frame();
    expect(f).toContain("--delete here lists, it does not delete");
    expect(f).toContain("dry run");
  });

  test("says the sync carries no --delete at all", () => {
    expect(frame()).toContain("carries no --delete");
  });

  test("names a destination whose flags differ from the rest", () => {
    // Showing the flags once is only honest if a target that deviates is
    // called out — the nas target here drops -X.
    const d = deviations(config, "u");
    expect(d).toHaveLength(1);
    expect(d[0]!.name).toBe("nas");
    expect(d[0]!.why).toContain("dropping -X");
    expect(frame()).toContain("nas differs");
  });

  test("says nothing about deviation when the flags all agree", () => {
    const same = parseConfig(
      `source = "/src"\n` +
        ["a", "b"].map((n, i) => `[[target]]\nname = "${n}"\npath = "/d${i}"\nsentinel = "s${i}"\n`).join(""),
    );
    expect(deviations(same, "u")).toEqual([]);
  });

  test("says so when nothing is configured yet", () => {
    const empty = parseConfig(`source = "/src"\n`);
    const { lastFrame } = render(
      <Plan
        config={empty}
        unit="u"
        theme={THEMES.ansi}
        width={100}
        onClose={() => undefined}
        onCopy={() => undefined}
      />,
    );
    expect(plain(lastFrame())).toContain("no destinations configured");
  });
});

describe("a repair sync shows the checksum flag it will actually run with", () => {
  /**
   * A repair sync (launched when a deep verify found drift by content) runs
   * with -c, added by sync.ts's `checksum: true`. This screen's own doc
   * comment claims the commands "cannot drift from what happens" — which was
   * false for exactly this flag: planText/flagsFor never took a checksum
   * option at all, so a target in repair state showed the same command as one
   * that was not.
   */
  test("the on-screen sync command carries -c for a target that needs it", () => {
    // Deep verify always carries -c regardless of repair state, so the
    // assertion has to be scoped to the sync line specifically.
    const syncLine = (text: string): string =>
      text.split("\n").find((l) => l.includes("--partial-dir"))!;

    expect(syncLine(frame("photos-2024", 120))).not.toContain(" -c ");

    const { lastFrame } = render(
      <Plan
        config={config}
        unit="photos-2024"
        needsChecksum={new Set(["ext"])}
        theme={THEMES.ansi}
        width={120}
        onClose={() => undefined}
        onCopy={() => undefined}
      />,
    );
    const withRepair = plain(lastFrame());
    expect(syncLine(withRepair)).toContain(" -c ");
    expect(withRepair).toContain("checksum");
  });

  test("deviations() flags a target needing checksum repair, even with otherwise identical flags", () => {
    const same = parseConfig(
      `source = "/src"\n` +
        ["a", "b"].map((n, i) => `[[target]]\nname = "${n}"\npath = "/d${i}"\nsentinel = "s${i}"\n`).join(""),
    );
    const d = deviations(same, "u", new Set(["b"]));
    expect(d).toHaveLength(1);
    expect(d[0]!.name).toBe("b");
    expect(d[0]!.why).toContain("checksum repair");
  });

  test("planText's sync line for a repairing target carries -c; a non-repairing one does not", () => {
    const text = planText(config, "photos-2024", new Set(["ext"]));
    const syncLines = text.split("\n").filter((l) => l.includes("--partial-dir"));
    expect(syncLines).toHaveLength(2); // one per target: ext, nas
    expect(syncLines[0]).toContain(" -c "); // ext: repairing
    expect(syncLines[1]).not.toContain(" -c "); // nas: not
  });
});

describe("the commands shown are the commands that run", () => {
  test("planText reproduces buildArgv exactly, for every mode and target", () => {
    // The guarantee. If these ever diverge, the screen is lying.
    const text = planText(config, "photos-2024");
    for (const t of config.targets) {
      for (const mode of ["quick", "deep", "sync"] as const) {
        const argv = buildArgv(
          mode,
          join(config.source, "photos-2024"),
          { ...t, path: join(t.path, "photos-2024") },
          config.exclude,
        );
        expect(text).toContain(`${DEFAULT_RSYNC} ${argv.join(" ")}`);
      }
    }
  });

  test("the quick command carries --delete and -n together", () => {
    const text = planText(config, "u");
    const quick = text.split("\n").find((l) => l.includes("--delete"))!;
    expect(quick).toContain("-n");
  });

  test("the sync command carries neither --delete nor -n", () => {
    const text = planText(config, "u");
    const sync = text.split("\n").find((l) => l.includes("--partial-dir"))!;
    expect(sync).not.toContain("--delete");
    expect(sync).not.toContain(" -n ");
  });

  test("the deep command checksums", () => {
    const text = planText(config, "u");
    expect(text.split("\n").some((l) => l.includes(" -c ") && l.includes(" -n "))).toBe(true);
  });

  test("paths are the real source and destination for the unit", () => {
    const text = planText(config, "photos-2024");
    expect(text).toContain("/src/photos-2024/");
    expect(text).toContain("/dest/ext/photos-2024/");
    expect(text).toContain("/dest/nas/photos-2024/");
  });

  test("the copyable text labels which command is which", () => {
    const text = planText(config, "u");
    expect(text).toContain("# quick check — writes nothing");
    expect(text).toContain("# sync — WRITES to the destination");
    expect(text).toContain("# target: ext");
  });
});

describe("the rendered screen shows real flags", () => {
  test("the on-screen command begins with the pinned rsync binary", () => {
    expect(frame()).toContain(DEFAULT_RSYNC);
  });

  test("source and destination are labelled rather than left as bare paths", () => {
    const f = frame();
    expect(f).toContain("from ");
    expect(f).toContain("to ");
    expect(f).toContain("/photos-2024/");
  });

  test("no line overflows the width", () => {
    for (const w of [80, 100, 140]) {
      for (const line of frame("photos-2024", w).split("\n")) {
        expect(line.length, `width ${w}: ${line}`).toBeLessThanOrEqual(w + 2);
      }
    }
  });
});

describe("the plan fits the window", () => {
  const many = parseConfig(
    `source = "/src"\n` +
      ["a", "b", "c", "d", "e", "f"]
        .map((n, i) => `[[target]]\nname = "${n}"\npath = "/d${i}"\nsentinel = "s${i}"\n`)
        .join(""),
  );

  function sized(height: number): string[] {
    const { lastFrame } = render(
      <Plan
        config={many}
        unit="u"
        theme={THEMES.ansi}
        width={100}
        height={height}
        onClose={() => undefined}
        onCopy={() => undefined}
      />,
    );
    return plain(lastFrame()).split("\n");
  }

  test("never renders taller than the window it was given", () => {
    // Ink clips an overflowing column by dropping whole elements silently.
    for (const h of [24, 30, 40]) {
      expect(sized(h).length, `height ${h}`).toBeLessThanOrEqual(h);
    }
  });

  test("grouping by command keeps six destinations on one screen", () => {
    const out = sized(30).join("\n");
    for (const n of ["a", "b", "c", "d", "e", "f"]) expect(out).toContain(n);
  });

  test("the copyable text still carries every destination", () => {
    const text = planText(many, "u");
    for (const n of ["a", "b", "c", "d", "e", "f"]) expect(text).toContain(`# target: ${n}`);
  });
});

const build = await checkBuild(DEFAULT_RSYNC);
const describeRsync = build.ok ? describe : describe.skip;

describeRsync("what Plan renders is what startSync actually spawns", () => {
  /**
   * argvFor is now the one function both Plan and the executor go through, so
   * this is provable directly against the real executor rather than against
   * another copy of the same construction — the guarantee planText's doc
   * comment claims, checked against the thing it claims parity with.
   */
  let root: string;
  let real: Config;

  beforeEach(async () => {
    root = makeFixtureDir("syncy-plan-parity");
    mkdirSync(join(root, "dst"), { recursive: true });
    mkdirSync(join(root, "src/photos-2024"), { recursive: true });
    writeFileSync(join(root, "src/photos-2024/a.txt"), "aaa");
    const id = await writeSentinel(join(root, "dst"));
    real = parseConfig(`
source = "${join(root, "src")}"
[[target]]
name = "dst"
path = "${join(root, "dst")}"
sentinel = "${id}"
`);
  });

  afterEach(() => removeFixtureDir(root));

  test("the repair command Plan shows carries the same -c startSync spawns", async () => {
    const text = planText(real, "photos-2024", new Set(["dst"]));
    const syncLine = text.split("\n").find((l) => l.includes("--partial-dir"))!;
    expect(syncLine).toContain(" -c ");

    const h = startSync(real, "photos-2024", real.targets[0]!, { checksum: true });
    expect(h.argv).toContain("-c");
    expect(syncLine).toContain(h.argv.join(" "));
    h.cancel();
    await h.done;
  });

  test("without a repair pending, Plan's command matches startSync's plain one — no -c on either", async () => {
    const text = planText(real, "photos-2024");
    const syncLine = text.split("\n").find((l) => l.includes("--partial-dir"))!;
    expect(syncLine).not.toContain(" -c ");

    const h = startSync(real, "photos-2024", real.targets[0]!);
    expect(h.argv).not.toContain("-c");
    expect(syncLine).toContain(h.argv.join(" "));
    h.cancel();
    await h.done;
  });
});
