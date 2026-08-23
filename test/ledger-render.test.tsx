import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { parseConfig, type Config } from "../src/config.ts";
import { EMPTY_STATE, upsertScan, type Scan, type State } from "../src/state.ts";
import type { UnitStatus } from "../src/status.ts";
import { Ledger, type Row } from "../src/tui/Ledger.tsx";
import { THEMES } from "../src/tui/theme.ts";
import { displayWidth } from "../src/width.ts";

/**
 * Renders real Ink frames and measures them. Column alignment is the highest
 * risk detail in this build (DESIGN.md section 6) and every state glyph is
 * multibyte, so this asserts on the output rather than on the padding helpers.
 */

const config: Config = parseConfig(`
source = "/src"
[[target]]
name = "ext"
path = "/ext"
sentinel = "s1"
[[target]]
name = "nas"
path = "/nas"
sentinel = "s2"
`);

const NOW = Date.parse("2026-08-20T12:00:00Z");

const status = (unit: string, state: UnitStatus["state"], cells: UnitStatus["cells"]): UnitStatus => ({
  unit,
  state,
  reason: "a reason that is long enough to need truncating in a narrow column",
  cells,
});

const cell = (target: string, state: Row["status"]["cells"][number]["state"], nChanges = 0) => ({
  target,
  state,
  reason: "r",
  nChanges,
  bytesPending: 0,
  nExtra: 0,
});

const rows: Row[] = [
  {
    status: status("photos-2019", "verified", [cell("ext", "verified"), cell("nas", "verified")]),
    size: 412 * 1024 ** 3,
  },
  {
    status: status("photos-2024", "behind", [cell("ext", "verified"), cell("nas", "behind", 143)]),
    size: 210 * 1024 ** 3,
  },
  {
    status: status("projects-archive", "unchecked", [cell("ext", "unchecked"), cell("nas", "verified")]),
    size: 44 * 1024 ** 3,
  },
  {
    status: status("video-raw", "missing", [cell("ext", "missing"), cell("nas", "missing")]),
    size: 1.2 * 1024 ** 4,
  },
];

const scan = (over: Partial<Scan>): Scan => ({
  unit: "photos-2019",
  target: "ext",
  ts: NOW - 3 * 86_400_000,
  method: "deep",
  outcome: "clean",
  nChanges: 0,
  nExtra: 0,
  bytesPending: 0,
  fingerprint: { nfiles: 1, bytes: 1, maxMtimeNs: "1" },
  sentinel: "s1",
  ...over,
});

function frame(state: State = EMPTY_STATE, selected = 0, width = 76): string[] {
  const { lastFrame } = render(
    <Ledger
      rows={rows}
      selected={selected}
      config={config}
      state={state}
      theme={THEMES.ansi}
      width={width}
      now={NOW}
      busy={null}
    />,
  );
  return (lastFrame() ?? "").split("\n");
}

// Strip ANSI so measurements are of glyphs, not escape sequences.
const plain = (s: string): string => s.replace(/\[[0-9;]*m/g, "");

describe("ledger frames", () => {
  test("every unit appears, in the order given", () => {
    const text = plain(frame().join("\n"));
    for (const r of rows) expect(text).toContain(r.status.unit);
    const positions = rows.map((r) => text.indexOf(r.status.unit));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  test("the glyph columns land on identical offsets across every row", () => {
    // The bug this guards: padding by byte length or .length instead of
    // display width shears the columns, and every glyph here is multibyte.
    const lines = frame().map(plain);
    // Leader dots identify a data row; the detail line also names the unit.
    const dataRows = lines.filter((l) => l.includes("....."));
    expect(dataRows).toHaveLength(rows.length);

    const offsets = dataRows.map((l) => {
      const m = /(✓|~|▲|✗|\?)/.exec(l);
      return m === null ? -1 : displayWidth(l.slice(0, m.index));
    });
    expect(offsets).not.toContain(-1);
    expect(new Set(offsets).size).toBe(1);
  });

  test("rules and data rows agree on width", () => {
    const lines = frame().map(plain);
    const rule = lines.find((l) => l.includes("────"));
    expect(rule).toBeDefined();
    const ruleWidth = displayWidth(rule!);
    for (const r of rows) {
      const line = lines.find((l) => l.includes(r.status.unit))!;
      expect(displayWidth(line)).toBeLessThanOrEqual(ruleWidth);
    }
  });

  test("no line exceeds the requested width", () => {
    for (const width of [76, 90, 110]) {
      for (const line of frame(EMPTY_STATE, 0, width).map(plain)) {
        expect(displayWidth(line), `width ${width}: ${line}`).toBeLessThanOrEqual(width + 2);
      }
    }
  });

  test("the behind count rides with its glyph", () => {
    expect(plain(frame().join("\n"))).toContain("▲143");
  });

  test("figures are right-aligned in the size column", () => {
    const lines = frame().map(plain);
    const ends = rows.map((r) => {
      const line = lines.find((l) => l.includes(r.status.unit))!;
      return displayWidth(line.slice(0, line.indexOf("gb") >= 0 ? line.indexOf("gb") : line.indexOf("tb")));
    });
    expect(new Set(ends).size).toBe(1);
  });

  test("the legend names every state", () => {
    const text = plain(frame().join("\n"));
    for (const word of ["verified", "unverified", "behind", "missing", "unchecked"]) {
      expect(text).toContain(word);
    }
  });

  test("the selection marker moves with the selected index", () => {
    expect(plain(frame(EMPTY_STATE, 0).find((l) => l.includes("photos-2019"))!)).toContain("»");
    expect(plain(frame(EMPTY_STATE, 2).find((l) => l.includes("photos-2019"))!)).not.toContain("»");
    expect(plain(frame(EMPTY_STATE, 2).find((l) => l.includes("projects-archive"))!)).toContain("»");
  });
});

describe("the detail line", () => {
  test("shows the selected unit's history, not the first row's", () => {
    const text = plain(frame(EMPTY_STATE, 2).join("\n"));
    expect(text).toContain("projects-archive");
  });

  test("an unchecked target still shows when it last verified", () => {
    // Strictness governs the verdict, not the display.
    const state = upsertScan(EMPTY_STATE, scan({ unit: "projects-archive", target: "ext" }));
    const text = plain(frame(state, 2).join("\n"));
    expect(text).toContain("deep verified");
  });

  test("a target never checked says so plainly", () => {
    expect(plain(frame(EMPTY_STATE, 0).join("\n"))).toContain("never checked");
  });

  test("a quick-only target says the bytes were never read", () => {
    const state = upsertScan(EMPTY_STATE, scan({ method: "quick", ts: NOW }));
    expect(plain(frame(state, 0).join("\n"))).toContain("bytes never read");
  });
});

describe("the footer states facts, never actions", () => {
  test("states what is proven out of the whole, in one phrase", () => {
    // A breakdown by state overflowed the line once several states were
    // present, so it collapsed to one phrase with the shelf carrying the rest.
    const line = plain(frame().join("\n"))
      .split("\n")
      .find((l) => l.includes("verified of"))!;
    expect(line).toMatch(/\d+ (b|kb|mb|gb|tb) verified of \d/);
    expect(line).toContain("folders");
  });

  test("the footer says each fact once", () => {
    const line = plain(frame().join("\n"))
      .split("\n")
      .find((l) => l.includes("verified of"))!;
    // "12 units" alongside "12 folders", and bytes alongside counts, were the
    // same facts twice over.
    expect(line).not.toContain("units");
    expect(line.match(/verified/g)?.length).toBe(1);
  });

  test("contains no deletion language anywhere in the frame", () => {
    // The UI has no deletion affordance at all.
    const text = plain(frame().join("\n")).toLowerCase();
    for (const word of ["rm -rf", "delete", "release", "reclaim", "releasable"]) {
      expect(text, `frame mentions "${word}"`).not.toContain(word);
    }
  });
});

describe("the ledger fits the window it is given", () => {
  /**
   * Ink resolves overflow by dropping lines and running the remnants together.
   * A refusal notice once rendered as "…is still running 00s", where `00s` was
   * the tail of a detail line that had been deleted. The layout has to fit by
   * construction rather than trusting the terminal to be tall enough.
   */
  const running = {
    unit: "photos-2019", target: "ext", mode: "deep" as const, done: 0, total: 1,
    bytesDone: 0, bytesTotal: 13e9, startedAt: NOW - 164_000,
    filesTotal: 935, unitBytes: 13e9, priorMs: 720_000,
  };
  const NOTICE = "[d] ignored — the deep check on photos-2019 is still running";

  const render1 = (height: number, extra: Record<string, unknown>): string[] => {
    const { lastFrame } = render(
      <Ledger rows={rows} selected={0} config={config} state={EMPTY_STATE} theme={THEMES.ansi}
        width={92} height={height} now={NOW} busy={null} {...extra} />,
    );
    return (lastFrame() ?? "").split("\n");
  };

  for (const [label, extra] of [
    ["idle", {}],
    ["running", { running }],
    ["running with a refusal", { running, notice: NOTICE }],
  ] as const) {
    test(`${label}: never renders more lines than the window has`, () => {
      for (let h = 8; h <= 30; h++) {
        expect(render1(h, extra).length, `height ${h}`).toBeLessThanOrEqual(h);
      }
    });

    test(`${label}: never merges two lines into one`, () => {
      for (let h = 8; h <= 30; h++) {
        for (const line of render1(h, extra)) {
          // The signature of an Ink drop: a line's tail welded onto the next.
          expect(line, `height ${h}: ${line}`).not.toMatch(/still running\s+\S/);
          expect(line, `height ${h}: ${line}`).not.toMatch(/%\s+deep /);
        }
      }
    });
  }

  test("a refusal survives even a window too short for the legend", () => {
    // The notice is the message; the legend is a reference. If one has to go,
    // it is not the one explaining why the keypress did nothing.
    const lines = render1(14, { running, notice: NOTICE });
    expect(lines.join("\n")).toContain("ignored");
  });

  test("the legend comes back when there is room", () => {
    expect(render1(30, { running, notice: NOTICE }).join("\n")).toContain("✓ verified");
  });
});

describe("a window too short for every row names what it could not draw", () => {
  /**
   * The layout doc comment above the row-windowing code states the contract:
   * rows are windowed to what is left, and the remainder is named. It never
   * was — `hidden` was computed and dropped on the floor, so folders that did
   * not fit the window vanished from the ledger without a trace. This is the
   * "interface knowing something the user does not" failure class.
   */
  const eightRows: Row[] = Array.from({ length: 8 }, (_, i) => ({
    status: status(`folder-${i}`, "unchecked", [cell("ext", "unchecked"), cell("nas", "unchecked")]),
    size: (i + 1) * 1024 ** 3,
  }));

  const render8 = (width: number): string[] => {
    const { lastFrame } = render(
      <Ledger rows={eightRows} selected={0} config={config} state={EMPTY_STATE} theme={THEMES.ansi}
        width={width} height={12} now={NOW} busy={null} />,
    );
    return plain(lastFrame() ?? "").split("\n");
  };

  for (const width of [76, 92, 120]) {
    test(`width ${width}: the footer states how many folders are not drawn`, () => {
      const lines = render8(width);
      const drawn = lines.filter((l) => l.includes(".....")).length;
      expect(drawn).toBeLessThan(eightRows.length);
      const hidden = eightRows.length - drawn;
      const footer = lines.find((l) => l.includes("folders") && l.includes("not shown"));
      expect(footer, lines.join("\n")).toBeDefined();
      expect(footer).toContain(`${hidden} not shown`);
    });

    test(`width ${width}: no line exceeds the requested width`, () => {
      for (const line of render8(width)) {
        expect(displayWidth(line), `width ${width}: ${line}`).toBeLessThanOrEqual(width + 2);
      }
    });
  }
});

describe("the folder list shows which folder a check is on", () => {
  /**
   * A `⋯` in one destination cell was the only sign, which is too quiet to find
   * in a list of twelve. "Which one is it working on?" should be answerable
   * without reading the footer.
   */
  const running = {
    unit: "photos-2019", target: "nas", mode: "deep" as const, done: 1, total: 2,
    bytesDone: 0, bytesTotal: 13e9, startedAt: NOW - 292_000,
    filesTotal: 900, unitBytes: 78e9, priorMs: 600_000,
  };
  const lines = (selected: number): string[] => {
    const { lastFrame } = render(
      <Ledger rows={rows} selected={selected} config={config} state={EMPTY_STATE}
        theme={THEMES.ansi} width={92} height={30} now={NOW} busy={null} running={running} />,
    );
    return plain(lastFrame() ?? "").split("\n");
  };
  const rowFor = (ls: string[], unit: string): string =>
    ls.find((l) => l.includes(unit) && l.includes("....."))!;

  test("the running row carries its own mark", () => {
    expect(rowFor(lines(0), "photos-2019").startsWith("▸")).toBe(true);
  });

  test("the mark is distinct from the selection mark", () => {
    // A check can run on a row the cursor is not on; one mark for two facts
    // would make those indistinguishable.
    const ls = lines(2);
    expect(rowFor(ls, "photos-2019").startsWith("▸")).toBe(true);
    expect(ls.some((l) => l.startsWith("»"))).toBe(true);
  });

  test("the running row says what is happening, not its previous verdict", () => {
    // The recorded state is the *last* result; showing it unchanged while a
    // check runs reads as a fresh result rather than as history.
    expect(rowFor(lines(0), "photos-2019")).toContain("deep check running");
    expect(rowFor(lines(0), "photos-2019")).toContain("nas");
  });

  test("rows that are not running are untouched", () => {
    const other = rowFor(lines(0), "photos-2024");
    expect(other).not.toContain("running");
    expect(other.startsWith("▸")).toBe(false);
  });

  test("with nothing running no row claims to be", () => {
    const { lastFrame } = render(
      <Ledger rows={rows} selected={0} config={config} state={EMPTY_STATE}
        theme={THEMES.ansi} width={92} height={30} now={NOW} busy={null} />,
    );
    const out = plain(lastFrame() ?? "");
    expect(out).not.toContain("check running");
    expect(out.split("\n").some((l) => l.startsWith("▸"))).toBe(false);
  });
});
