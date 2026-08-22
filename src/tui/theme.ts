import type { CellState, UnitState } from "../status.ts";

/**
 * Semantic tokens, never raw colours (DESIGN.md section 6).
 *
 * Components reference `verified` or `rule`; only this file knows a hex value.
 * That indirection is what makes the ansi theme cost nothing — it is simply
 * another implementation of the same token set. Verified against Claude Code's
 * own binary, which ships six themes over one token vocabulary.
 *
 * The neutral ramp is warm-tinted, never grey: the paper feeling of the ledger
 * comes from warm ink and rules, not from a painted background. syncy never
 * paints the canvas, which is why light and dark are separate themes rather
 * than a runtime guess.
 */

export type Token =
  | "ink"
  | "dim"
  | "rule"
  | "figure"
  | "verified"
  | "unverified"
  | "behind"
  | "missing"
  | "unchecked"
  | "error";

export type Theme = Readonly<Record<Token, string>>;

const dark: Theme = {
  ink: "#e8e6df",
  dim: "#8a8781",
  rule: "#4a4843",
  figure: "#f7f5ee",
  verified: "#8fc573",
  unverified: "#d4a24c",
  behind: "#d4a24c",
  missing: "#c96a5f",
  // Deliberately colourless. An unreachable drive is an absence of
  // information, not a finding; colouring it would make it look like one.
  unchecked: "#8a8781",
  error: "#c96a5f",
};

const light: Theme = {
  ink: "#26241f",
  dim: "#6d6a63",
  rule: "#c3c2b7",
  figure: "#141310",
  verified: "#3f7a2e",
  unverified: "#8a6516",
  behind: "#8a6516",
  missing: "#a33b30",
  unchecked: "#6d6a63",
  error: "#a33b30",
};

/** The escape hatch: same tokens, mapped onto the terminal's own 16 slots. */
const ansi: Theme = {
  ink: "white",
  dim: "gray",
  rule: "gray",
  figure: "whiteBright",
  verified: "green",
  unverified: "yellow",
  behind: "yellow",
  missing: "red",
  unchecked: "gray",
  error: "red",
};

export const THEMES = { dark, light, ansi } as const;
export type ThemeName = keyof typeof THEMES;

/**
 * Resolution order: explicit env var, then NO_COLOR, then the conservative
 * default. Terminal.app has no truecolor, so the hex values downsample to the
 * 256 cube; the ansi theme exists for when that is not good enough.
 */
export function resolveTheme(env: NodeJS.ProcessEnv = process.env): Theme {
  const name = env["SYNCY_THEME"]?.trim().toLowerCase();
  if (name === "light" || name === "dark" || name === "ansi") return THEMES[name];
  if (env["NO_COLOR"] !== undefined && env["NO_COLOR"] !== "") return THEMES.ansi;
  return THEMES.dark;
}

const CELL_TOKEN: Readonly<Record<CellState, Token>> = {
  verified: "verified",
  unverified: "unverified",
  behind: "behind",
  missing: "missing",
  unchecked: "unchecked",
  error: "error",
};

const UNIT_TOKEN: Readonly<Record<UnitState, Token>> = {
  verified: "verified",
  unverified: "unverified",
  behind: "behind",
  missing: "missing",
  unchecked: "unchecked",
  error: "error",
};

export const cellToken = (s: CellState): Token => CELL_TOKEN[s];
export const unitToken = (s: UnitState): Token => UNIT_TOKEN[s];
