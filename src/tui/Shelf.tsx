import { Box, Text } from "ink";
import { bytes } from "../format.ts";
import type { UnitState } from "../status.ts";
import { unitToken, type Theme } from "./theme.ts";

/**
 * One block per folder, beside the wordmark, shaded by state.
 *
 * This is the one piece of the interface that is decorative as well as
 * informative, and it only earns that by being genuinely informative: the shape
 * of the shelf is the shape of the archive, and it changes as folders verify.
 *
 * The shading carries the meaning on its own — solid for verified down to a dot
 * for unknown — so it still reads under NO_COLOR, where the theme collapses to
 * the terminal's own palette.
 */

const BLOCK: Readonly<Record<UnitState, string>> = {
  verified: "█",
  unverified: "▓",
  behind: "▒",
  missing: "░",
  unchecked: "·",
  error: "!",
};

/** Longest shelf worth drawing; beyond this it stops being glanceable. */
export const MAX_BLOCKS = 28;

export interface ShelfProps {
  readonly states: readonly UnitState[];
  readonly theme: Theme;
}

/**
 * What is proven, out of the whole.
 *
 * A breakdown by state overflowed the line as soon as several states were
 * present — which is precisely when the ledger is most worth reading. One
 * phrase always fits, and the shelf beside it carries the distribution.
 */
export function verifiedPhrase(
  entries: ReadonlyArray<{ readonly state: UnitState; readonly size: number }>,
): string {
  const total = entries.reduce((a, e) => a + e.size, 0);
  const verified = entries
    .filter((e) => e.state === "verified")
    .reduce((a, e) => a + e.size, 0);
  return `${bytes(verified)} verified of ${bytes(total)}`;
}

/** A one-line summary of what the shelf shows, for the line beneath it. */
export function shelfSummary(states: readonly UnitState[]): string {
  if (states.length === 0) return "no folders yet";
  const counts = new Map<UnitState, number>();
  for (const s of states) counts.set(s, (counts.get(s) ?? 0) + 1);
  // Ordered worst-last, so the reassuring number is not the final word.
  const order: readonly UnitState[] = ["verified", "unverified", "behind", "missing", "unchecked", "error"];
  const parts = order
    .filter((s) => (counts.get(s) ?? 0) > 0)
    .map((s) => `${counts.get(s)!} ${s}`);
  const n = states.length;
  return `${n} folder${n === 1 ? "" : "s"} · ${parts.join(", ")}`;
}

export function Shelf({ states, theme }: ShelfProps): React.ReactElement {
  const shown = states.slice(0, MAX_BLOCKS);
  const overflow = states.length - shown.length;
  return (
    <Box>
      {shown.map((s, i) => (
        <Text key={i} color={theme[unitToken(s)]}>
          {BLOCK[s]}
        </Text>
      ))}
      {overflow > 0 ? <Text color={theme.dim}>{`+${overflow}`}</Text> : null}
    </Box>
  );
}
