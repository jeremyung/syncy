import { Box, Text } from "ink";
import type { Config } from "../config.ts";
import { GLYPH, type CellState } from "../status.ts";
import { padEnd, truncate } from "../width.ts";
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

export function Mark({ config, theme, width, states, units }: MarkProps): React.ReactElement {
  const targets = config.targets;
  const label = units === undefined ? "no source yet" : `${units} folder${units === 1 ? "" : "s"}`;
  const room = Math.max(10, width - BOX_WIDTH - 18);

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
              <Text color={theme.ink}>{padEnd(truncate(t.name, 14), 15)}</Text>
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
