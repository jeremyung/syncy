import { Box, Text } from "ink";
import type { Config } from "../config.ts";
import { type CellState, GLYPH } from "../status.ts";
import { displayWidth, padEnd, truncate } from "../width.ts";
import { cellToken, type Theme } from "./theme.ts";

/**
 * The replication mark: one source, N destinations, each with its live state.
 *
 * Drawn from the tool's own glyph vocabulary so it doubles as the legend rather
 * than competing with it, and from the real configuration rather than a generic
 * picture — it earns its place by showing something true.
 *
 * Shown where someone is asking "what is this?": the help screen, and the empty
 * state before anything is configured. Never above the ledger, which is a
 * screen of fact and needs no illustration.
 */

export interface MarkProps {
  readonly config: Config;
  readonly theme: Theme;
  readonly width: number;
  /** Live state per destination, when known. */
  readonly states?: ReadonlyMap<string, CellState>;
  /** Folder count for the source box; omitted when nothing is configured. */
  readonly units?: number;
}

const BOX_WIDTH = 15;

/** The indent, the connector and the space after it, drawn before each glyph. */
const LEAD = "             " + "└──▶" + " ";
/** The state glyph and the gap between it and the name. */
const GLYPH_COL = "?  ";
/** The destination-name column, padded to this regardless of the name's width. */
const NAME_COL = 15;

export function Mark({ config, theme, width, states, units }: MarkProps): React.ReactElement {
  const targets = config.targets;
  const label = units === undefined ? "no source yet" : `${units} folder${units === 1 ? "" : "s"}`;
  // Budgeted by measuring the chrome rather than counting it. This was
  // `width - BOX_WIDTH - 18`, which is three columns short of what the row
  // actually draws — the box width is not the indent, and the glyph column was
  // left out of the sum entirely. A destination whose name is multibyte and
  // whose path is long then rendered past the right edge, where Ink drops the
  // line and welds what is left to its neighbour. The same arithmetic slip
  // AGENTS.md records against the key hint line, which overflowed three times
  // for the same reason: it was added up by hand.
  const room = Math.max(
    10,
    // +2 for the indent every screen in this interface is drawn inside;
    // the same budget the ledger, plan and differences screens use.
    width + 2 - displayWidth(LEAD) - displayWidth(GLYPH_COL) - NAME_COL,
  );

  const connector = (i: number): string => (i === targets.length - 1 ? "└──▶" : "├──▶");

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.dim}>{"  source  "}</Text>
        <Text color={theme.rule}>{"┌" + "─".repeat(BOX_WIDTH) + "┐"}</Text>
      </Box>
      <Box>
        <Text color={theme.dim}>{"          "}</Text>
        <Text color={theme.rule}>{"│"}</Text>
        <Text color={theme.figure}>{padEnd(" " + truncate(label, BOX_WIDTH - 1), BOX_WIDTH)}</Text>
        <Text color={theme.rule}>{"│"}</Text>
      </Box>
      <Box>
        <Text color={theme.dim}>{"          "}</Text>
        <Text color={theme.rule}>{"└──┬" + "─".repeat(BOX_WIDTH - 3) + "┘"}</Text>
      </Box>

      {targets.length === 0 ? (
        <Box>
          <Text color={theme.rule}>{"             └──▶ "}</Text>
          <Text color={theme.dim}>{"no destinations yet"}</Text>
        </Box>
      ) : (
        targets.map((t, i) => {
          const state = states?.get(t.name);
          const token = state === undefined ? "unchecked" : cellToken(state);
          return (
            <Box key={t.name}>
              <Text color={theme.rule}>{"             " + connector(i) + " "}</Text>
              <Text color={theme[token]}>{(state === undefined ? "?" : GLYPH[state]) + "  "}</Text>
              <Text color={theme.ink}>{padEnd(truncate(t.name, NAME_COL - 1), NAME_COL)}</Text>
              <Text color={theme.dim}>{truncate(t.path, room)}</Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}

/** The state ladder, as one line. */
export function Legend({ theme }: { readonly theme: Theme }): React.ReactElement {
  const order: readonly CellState[] = ["verified", "unverified", "behind", "missing", "unchecked"];
  return (
    <Box>
      {order.map((s) => (
        <Text key={s} color={theme[cellToken(s)]}>
          {`  ${GLYPH[s]} ${s}`}
        </Text>
      ))}
    </Box>
  );
}
