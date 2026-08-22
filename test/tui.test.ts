import { describe, expect, test } from "bun:test";
import { GLYPH, type CellState, type UnitState } from "../src/status.ts";
import { cellToken, resolveTheme, THEMES, unitToken, type Token } from "../src/tui/theme.ts";
import { displayWidth } from "../src/width.ts";

/**
 * The token indirection is what makes multiple themes cost nothing, so the
 * tests assert the contract rather than any particular colour value.
 */

const CELL_STATES: readonly CellState[] = [
  "verified",
  "unverified",
  "behind",
  "missing",
  "unchecked",
  "error",
];

const UNIT_STATES: readonly UnitState[] = [
  "verified",
  "unverified",
  "behind",
  "missing",
  "unchecked",
  "error",
];

describe("theme tokens", () => {
  test("every theme implements every token", () => {
    const tokens: readonly Token[] = [
      "ink",
      "dim",
      "rule",
      "figure",
      "verified",
      "unverified",
      "behind",
      "missing",
      "unchecked",
      "error",
    ];
    for (const [name, theme] of Object.entries(THEMES)) {
      for (const token of tokens) {
        expect(theme[token], `${name}.${token}`).toBeTruthy();
      }
    }
  });

  test("every cell state maps to a token", () => {
    for (const s of CELL_STATES) expect(THEMES.dark[cellToken(s)]).toBeTruthy();
  });

  test("every unit state maps to a token", () => {
    for (const s of UNIT_STATES) expect(THEMES.dark[unitToken(s)]).toBeTruthy();
  });

  test("unknown reuses the deliberately colourless unchecked token", () => {
    // An unreachable drive is an absence of information, not a finding.
    expect(unitToken("unchecked")).toBe("unchecked");
    expect(THEMES.dark.unchecked).toBe(THEMES.dark.dim);
    expect(THEMES.light.unchecked).toBe(THEMES.light.dim);
  });

  test("neutrals are warm-tinted, never pure grey or pure black and white", () => {
    for (const name of ["dark", "light"] as const) {
      for (const token of ["ink", "dim", "rule", "figure"] as const) {
        const hex = THEMES[name][token];
        expect(hex).toMatch(/^#[0-9a-f]{6}$/);
        const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
        expect(r === g && g === b, `${name}.${token} is neutral grey`).toBe(false);
        expect(hex).not.toBe("#000000");
        expect(hex).not.toBe("#ffffff");
      }
    }
  });

  test("the ansi theme uses named slots, so it inherits the user's palette", () => {
    for (const value of Object.values(THEMES.ansi)) {
      expect(value.startsWith("#")).toBe(false);
    }
  });
});

describe("theme resolution", () => {
  test("an explicit name wins", () => {
    expect(resolveTheme({ SYNCY_THEME: "light" })).toBe(THEMES.light);
    expect(resolveTheme({ SYNCY_THEME: "ANSI" })).toBe(THEMES.ansi);
  });

  test("NO_COLOR falls back to the terminal's own palette", () => {
    expect(resolveTheme({ NO_COLOR: "1" })).toBe(THEMES.ansi);
  });

  test("an empty NO_COLOR is not set", () => {
    expect(resolveTheme({ NO_COLOR: "" })).toBe(THEMES.dark);
  });

  test("an unknown name falls back rather than throwing", () => {
    expect(resolveTheme({ SYNCY_THEME: "solarized" })).toBe(THEMES.dark);
  });

  test("the default needs no environment at all", () => {
    expect(resolveTheme({})).toBe(THEMES.dark);
  });
});

describe("glyphs", () => {
  test("every cell state has a glyph", () => {
    for (const s of CELL_STATES) expect(GLYPH[s]).toBeTruthy();
  });

  test("all glyphs are exactly one display column", () => {
    // The whole ledger layout depends on this.
    for (const s of CELL_STATES) expect(displayWidth(GLYPH[s])).toBe(1);
  });

  test("glyphs are distinct from one another", () => {
    const seen = new Set(CELL_STATES.map((s) => GLYPH[s]));
    expect(seen.size).toBe(CELL_STATES.length);
  });

  test("no glyph is an emoji", () => {
    // Emoji are double-width and would shear every column.
    for (const s of CELL_STATES) {
      expect(/\p{Extended_Pictographic}/u.test(GLYPH[s]), `${s} is pictographic`).toBe(false);
    }
  });
});
