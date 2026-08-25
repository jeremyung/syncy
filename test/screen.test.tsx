import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { type Config, parseConfig } from "../src/config.ts";
import { EMPTY_CONFIG } from "../src/configio.ts";
import { EMPTY_STATE } from "../src/state.ts";
import type { UnitStatus } from "../src/status.ts";
import { Ledger, type Row } from "../src/tui/Ledger.tsx";
import { Setup } from "../src/tui/Setup.tsx";
import { THEMES } from "../src/tui/theme.ts";
import { measure } from "../src/tui/useScreen.ts";
import { displayWidth } from "../src/width.ts";
import { PROJECT_ROOT } from "./helpers.ts";

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

const row = (unit: string): Row => ({
  status: {
    unit,
    state: "verified",
    reason: "all destinations deep verified",
    cells: [
      { target: "ext", state: "verified", reason: "r", nChanges: 0, bytesPending: 0, nExtra: 0 },
      { target: "nas", state: "verified", reason: "r", nChanges: 0, bytesPending: 0, nExtra: 0 },
    ],
  } satisfies UnitStatus,
  size: 1024 ** 3,
});

const plain = (s: string | undefined): string => (s ?? "").replace(/\[[0-9;]*m/g, "");

function frame(rows: Row[], height?: number, width = 76): string[] {
  const { lastFrame } = render(
    <Ledger
      rows={rows}
      selected={0}
      config={config}
      state={EMPTY_STATE}
      theme={THEMES.ansi}
      width={width}
      {...(height === undefined ? {} : { height })}
      now={NOW}
      busy={null}
    />,
  );
  return plain(lastFrame()).split("\n");
}

describe("measure", () => {
  const fake = (columns: number, rows: number): NodeJS.WriteStream =>
    ({ columns, rows }) as NodeJS.WriteStream;

  test("uses the terminal size, less the ledger's margins", () => {
    expect(measure(fake(100, 40)).width).toBe(98);
    expect(measure(fake(100, 40)).rows).toBe(40);
  });

  test("never goes below the 76-column layout", () => {
    // Narrower than this and the columns cannot hold their content.
    expect(measure(fake(40, 20)).width).toBe(76);
  });

  test("caps the width so lines stay readable on a very wide terminal", () => {
    expect(measure(fake(400, 60)).width).toBe(110);
  });

  test("floors the row count so a tiny window still lays out", () => {
    expect(measure(fake(80, 3)).rows).toBe(12);
  });

  test("falls back to 80x24 when the size is unknown", () => {
    const m = measure(undefined);
    expect(m.columns).toBe(80);
    expect(m.rows).toBe(24);
  });
});

describe("the ledger fills the terminal", () => {
  const rows = [row("photos-2019"), row("photos-2024")];

  test("a short ledger is padded out to the full height", () => {
    // Two units would otherwise occupy a dozen lines at the top of a tall
    // window, with the footer floating in the middle of the screen.
    const lines = frame(rows, 30);
    expect(lines.length).toBeGreaterThanOrEqual(28);
  });

  test("the footer sits on the last line, not directly under the content", () => {
    const lines = frame(rows, 30);
    const last = lines.filter((l) => l.trim() !== "").pop() ?? "";
    expect(last).toContain("[q] check");
    const footerIndex = lines.findIndex((l) => l.includes("[q] check"));
    const legendIndex = lines.findIndex((l) => l.includes("✓ verified    ~"));
    expect(footerIndex).toBeGreaterThan(legendIndex);
    expect(footerIndex).toBeGreaterThan(20);
  });

  test("growing the window moves the footer down, not the rows", () => {
    const short = frame(rows, 20);
    const tall = frame(rows, 40);
    const rowIndex = (ls: string[]): number => ls.findIndex((l) => l.includes("photos-2019"));
    expect(rowIndex(short)).toBe(rowIndex(tall));
    expect(tall.length).toBeGreaterThan(short.length);
  });

  test("without a height it sizes to its content, for non-interactive output", () => {
    // `syncy status` prints and exits; padding to 24 rows there is noise.
    const lines = frame(rows);
    expect(lines.length).toBeLessThan(20);
  });

  test("every line still fits the width at any height", () => {
    for (const h of [14, 24, 40]) {
      for (const line of frame(rows, h)) {
        expect(displayWidth(line), `height ${h}: ${line}`).toBeLessThanOrEqual(78);
      }
    }
  });
});

describe("the key hints fit the narrowest supported window", () => {
  const sample = [row("photos-2019"), row("photos-2024")];
  // This has now wrapped twice: a hint longer than the layout pushes the tail
  // onto its own line and shears the footer.
  test("the hint line fits 76 columns", () => {
    const line = frame(sample, 30, 76)
      .map(plain)
      .find((l) => l.includes("[q]"))!;
    expect(displayWidth(line)).toBeLessThanOrEqual(78);
  });

  test("no footer line wraps at any supported width", () => {
    for (const w of [76, 90, 110]) {
      for (const line of frame(sample, 30, w).map(plain)) {
        expect(displayWidth(line), `width ${w}: ${line}`).toBeLessThanOrEqual(w + 2);
      }
    }
  });
});

describe("the alternate screen is entered and always restored", () => {
  const src = readFileSync(join(PROJECT_ROOT, "src/tui/index.tsx"), "utf8");

  test("enters the alternate buffer only when stdout is a tty", () => {
    expect(src).toContain("isTTY === true");
    expect(src).toContain("1049h");
  });

  test("restores on normal exit, on signals, and after an error", () => {
    // Leaving a terminal stuck in the alternate buffer with a hidden cursor is
    // the classic full-screen TUI failure.
    expect(src).toContain('process.once("exit", restore)');
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) expect(src).toContain(sig);
    expect(src).toContain(".finally(restore)");
  });

  test("shows the cursor again when it restores", () => {
    expect(src).toContain("SHOW_CURSOR + LEAVE_ALT");
  });

  test("handles ctrl-c itself rather than letting Ink exit abruptly", () => {
    expect(src).toContain("exitOnCtrlC: false");
  });
});

describe("enterFullscreen", () => {
  const fake = (isTTY: boolean) => {
    const writes: string[] = [];
    return { stream: { isTTY, write: (c: string) => writes.push(c) }, writes };
  };
  const ALT_IN = "\u001B[?1049h";
  const ALT_OUT = "\u001B[?1049l";
  const CURSOR_OFF = "\u001B[?25l";
  const CURSOR_ON = "\u001B[?25h";

  test("takes the alternate buffer and hides the cursor", async () => {
    const { enterFullscreen } = await import("../src/tui/index.tsx");
    const f = fake(true);
    enterFullscreen(f.stream);
    expect(f.writes.join("")).toContain(ALT_IN);
    expect(f.writes.join("")).toContain(CURSOR_OFF);
  });

  test("restore gives the screen and the cursor back, in that order", async () => {
    const { enterFullscreen } = await import("../src/tui/index.tsx");
    const f = fake(true);
    enterFullscreen(f.stream)();
    const all = f.writes.join("");
    expect(all).toContain(CURSOR_ON);
    expect(all).toContain(ALT_OUT);
    expect(all.indexOf(ALT_OUT)).toBeGreaterThan(all.indexOf(ALT_IN));
  });

  test("restore is idempotent, since several exit paths race to call it", async () => {
    const { enterFullscreen } = await import("../src/tui/index.tsx");
    const f = fake(true);
    const restore = enterFullscreen(f.stream);
    restore();
    restore();
    restore();
    expect(f.writes.join("").split(ALT_OUT).length - 1).toBe(1);
  });

  test("writes nothing at all when stdout is not a tty", async () => {
    // Piping `syncy` must not spray escape sequences into the pipe.
    const { enterFullscreen } = await import("../src/tui/index.tsx");
    const f = fake(false);
    enterFullscreen(f.stream)();
    expect(f.writes).toEqual([]);
  });
});

describe("every screen fills the terminal, not just the ledger", () => {
  // The bug this guards: only the ledger got the fill treatment, so setup,
  // confirm, job, help and evidence bunched into the top-left of a large
  // window with their keys floating mid-screen.
  const renderSetup = (w: number, h: number): string[] => {
    const { lastFrame } = render(
      <Setup
        config={{ ...EMPTY_CONFIG("/some/source") }}
        theme={THEMES.ansi}
        width={w}
        height={h}
        onChange={() => undefined}
        onExit={() => undefined}
      />,
    );
    return plain(lastFrame()).split("\n");
  };

  test("setup occupies the full height", () => {
    expect(renderSetup(110, 34).length).toBe(34);
  });

  test("setup pins its keys to the bottom line", () => {
    const lines = renderSetup(110, 34);
    expect(lines[lines.length - 1]).toContain("[s] source");
  });

  test("setup rules span the measured width, not a fixed 76", () => {
    const lines = renderSetup(110, 34);
    const rule = lines.find((l) => l.includes("────"))!;
    expect(displayWidth(rule)).toBe(112);
  });

  test("a taller window moves the footer down, not the content", () => {
    const short = renderSetup(110, 20);
    const tall = renderSetup(110, 40);
    const sourceRow = (ls: string[]): number => ls.findIndex((l) => l.includes("/some/source"));
    expect(sourceRow(short)).toBe(sourceRow(tall));
    expect(short[short.length - 1]).toContain("[s] source");
    expect(tall[tall.length - 1]).toContain("[s] source");
  });

  test("no line overflows the width at any size", () => {
    for (const [w, h] of [
      [76, 24],
      [110, 40],
      [90, 30],
    ] as const) {
      for (const line of renderSetup(w, h)) {
        expect(displayWidth(line), `${w}x${h}: ${line}`).toBeLessThanOrEqual(w + 2);
      }
    }
  });
});
