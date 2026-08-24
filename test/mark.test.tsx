import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { parseConfig, type Config } from "../src/config.ts";
import type { CellState, UnitState } from "../src/status.ts";
import { Mark } from "../src/tui/Mark.tsx";
import { forkliftRows } from "../src/tui/Forklift.tsx";
import { Shelf, shelfSummary, MAX_BLOCKS } from "../src/tui/Shelf.tsx";
import { THEMES } from "../src/tui/theme.ts";
import { displayWidth } from "../src/width.ts";

/**
 * The two pieces of visual identity.
 *
 * Both are drawn from real data rather than being ornament, which is the only
 * reason they belong in a tool whose demeanour is meant to be exacting and
 * unhurried. These tests hold them to that: they must show what is true.
 */

const plain = (s: string | undefined): string => (s ?? "").replace(/\[[0-9;]*m/g, "");

const configWith = (names: readonly string[]): Config =>
  parseConfig(
    `source = "/src"\n` +
      names.map((n, i) => `[[target]]\nname = "${n}"\npath = "/dest/${n}"\nsentinel = "s${i}"\n`).join(""),
  );

function mark(names: readonly string[], states?: ReadonlyMap<string, CellState>, units = 5): string {
  const { lastFrame } = render(
    <Mark
      config={configWith(names)}
      theme={THEMES.ansi}
      width={90}
      units={units}
      {...(states === undefined ? {} : { states })}
    />,
  );
  return plain(lastFrame());
}

describe("the replication mark shows the real configuration", () => {
  test("names every destination", () => {
    const out = mark(["external", "nas", "offsite"]);
    for (const n of ["external", "nas", "offsite"]) expect(out).toContain(n);
  });

  test("counts the source folders", () => {
    expect(mark(["a"], undefined, 12)).toContain("12 folders");
  });

  test("uses the singular for one folder", () => {
    expect(mark(["a"], undefined, 1)).toContain("1 folder");
    expect(mark(["a"], undefined, 1)).not.toContain("1 folders");
  });

  test("carries each destination's live state glyph", () => {
    const out = mark(
      ["external", "nas"],
      new Map<string, CellState>([
        ["external", "verified"],
        ["nas", "behind"],
      ]),
    );
    expect(out).toContain("✓");
    expect(out).toContain("▲");
  });

  test("falls back to unchecked when no state is known", () => {
    expect(mark(["external"])).toContain("?");
  });

  test("says so when nothing is configured", () => {
    const { lastFrame } = render(
      <Mark config={parseConfig(`source = "/src"\n`)} theme={THEMES.ansi} width={90} />,
    );
    const out = plain(lastFrame());
    expect(out).toContain("no destinations yet");
    expect(out).toContain("no source yet");
  });

  test("the box and its connectors line up at any destination count", () => {
    for (const n of [1, 2, 5]) {
      const names = Array.from({ length: n }, (_, i) => `d${i}`);
      const lines = mark(names).split("\n").filter((l) => l.trim() !== "");
      const box = lines.filter((l) => l.includes("│") || l.includes("┌") || l.includes("└"));
      const offsets = box.map((l) => l.indexOf("┌") + l.indexOf("│") + l.indexOf("└"));
      expect(offsets.length, `${n} destinations`).toBeGreaterThan(0);
      // Every arrow hangs from the same column as the box's stem.
      const stem = lines.find((l) => l.includes("┬"))!.indexOf("┬");
      for (const l of lines.filter((x) => x.includes("▶"))) {
        expect(l.indexOf("├") >= 0 ? l.indexOf("├") : l.indexOf("└")).toBe(stem);
      }
    }
  });

  test("no line overflows the width", () => {
    for (const line of mark(["a-very-long-destination-name", "b"]).split("\n")) {
      expect(displayWidth(line)).toBeLessThanOrEqual(92);
    }
  });
});

describe("the shelf is the archive's shape", () => {
  const states = (s: readonly UnitState[]): string => {
    const { lastFrame } = render(<Shelf states={s} theme={THEMES.ansi} />);
    return plain(lastFrame());
  };

  test("one block per folder", () => {
    expect(states(["verified", "behind", "missing"]).trim()).toHaveLength(3);
  });

  test("shading runs solid to absent, so it reads without colour", () => {
    // Under NO_COLOR the theme collapses to the terminal's palette, so the
    // shading has to carry the meaning on its own.
    const out = states(["verified", "unverified", "behind", "missing", "unchecked"]).trim();
    expect(out).toBe("█▓▒░·");
  });

  test("an empty archive draws nothing", () => {
    expect(states([]).trim()).toBe("");
  });

  test("a very long shelf is capped and says by how much", () => {
    const many: UnitState[] = Array.from({ length: MAX_BLOCKS + 7 }, () => "verified");
    expect(states(many)).toContain("+7");
  });
});

describe("the shelf summary states counts, worst last", () => {
  test("names each state present, with its count", () => {
    const s = shelfSummary(["verified", "verified", "behind", "missing"]);
    expect(s).toBe("4 folders · 2 verified, 1 behind, 1 missing");
  });

  test("omits states that are not present", () => {
    expect(shelfSummary(["verified"])).toBe("1 folder · 1 verified");
  });

  test("says so when there is nothing yet", () => {
    expect(shelfSummary([])).toBe("no folders yet");
  });

  test("puts the reassuring number first and the worst last", () => {
    // A summary that ended on "2 verified" would read as reassurance.
    const s = shelfSummary(["missing", "verified", "unchecked"]);
    expect(s.indexOf("verified")).toBeLessThan(s.indexOf("missing"));
    expect(s.indexOf("missing")).toBeLessThan(s.indexOf("unchecked"));
  });
});

describe("the forklift moves only while work is happening", () => {
  test("standing still is the idle state, whatever the frame", () => {
    // Motion on this screen has to mean something, or it is just decoration.
    const a = forkliftRows(0, false).join("\n");
    for (const f of [1, 2, 3, 5, 9]) {
      expect(forkliftRows(f, false).join("\n"), `frame ${f}`).toBe(a);
    }
  });

  test("it never stalls while work is running", () => {
    // Every frame differs from the one before it, so the mark never looks
    // frozen mid-run. There are three distinct poses, not four: the halfway
    // rung is shared by the way up and the way down.
    const pose = (f: number) => forkliftRows(f, true).join("\n");
    for (let f = 1; f < 8; f++) expect(pose(f), `frame ${f}`).not.toBe(pose(f - 1));
    expect(new Set(Array.from({ length: 8 }, (_, f) => pose(f))).size).toBe(3);
  });

  test("the cycle returns to where it started, so it loops cleanly", () => {
    expect(forkliftRows(4, true)).toEqual(forkliftRows(0, true));
  });

  test("the crate is always on the mast — it never vanishes", () => {
    // It changes height as the lift raises it, but there is always a load.
    for (const moving of [true, false]) {
      for (let f = 0; f < 8; f++) {
        expect(["▄", "█", "▀"], `frame ${f}`).toContain(forkliftRows(f, moving)[0]![0]!);
      }
    }
  });

  test("the crate rises and comes back down, rather than jumping to the top", () => {
    // Height in half-cells: on the forks, halfway up, at the top.
    const height = (f: number) => ["▄", "█", "▀"].indexOf(forkliftRows(f, true)[0]![0]!);
    expect(Array.from({ length: 5 }, (_, f) => height(f))).toEqual([0, 1, 2, 1, 0]);
  });

  test("the wheels and the crate move in the same cycle, or it reads as two marks", () => {
    // A lift that moved while the wheels stood still would not read as one machine.
    const wheelsChanged = forkliftRows(1, true)[1] !== forkliftRows(0, true)[1];
    const crateChanged = forkliftRows(1, true)[0] !== forkliftRows(0, true)[0];
    expect(wheelsChanged && crateChanged).toBe(true);
  });

  test("at rest the crate sits down on the forks", () => {
    // Idle has to be a pose a real forklift holds, not a frozen mid-lift.
    expect(forkliftRows(0, false)[0]?.[0]).toBe("▄");
  });

  test("every row is the same width, or the header would shear", () => {
    for (const moving of [true, false]) {
      for (let f = 0; f < 8; f++) {
        const widths = new Set(forkliftRows(f, moving).map((r) => displayWidth(r)));
        expect(widths.size, `frame ${f} moving=${moving}`).toBe(1);
      }
    }
  });

  test("it stays two rows by four columns, so the header stays short", () => {
    const rows = forkliftRows(0, true);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(displayWidth(r)).toBe(4);
  });

  test("the tail steps down behind the cab — a flat back reads as a bar", () => {
    for (let f = 0; f < 8; f++) {
      expect(forkliftRows(f, true)[0]?.endsWith("▄"), `frame ${f}`).toBe(true);
    }
  });

  test("the forks are always drawn — they are the defining feature", () => {
    // The first attempt had none, and read as a box beside another box.
    for (const moving of [true, false]) {
      for (let f = 0; f < 8; f++) expect(forkliftRows(f, moving)[1], `frame ${f}`).toContain("┻");
    }
  });

  test("the mast stands between the crate and the body", () => {
    expect(forkliftRows(0, true)[0]).toContain("┃");
  });
});
