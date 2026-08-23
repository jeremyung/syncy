import { Box, Text } from "ink";
import type { Config } from "../config.ts";
import { ageAgo, bytes, stamp } from "../format.ts";
import { findScan, latestScan, type State } from "../state.ts";
import { evidencePhrase, GLYPH, knownExtras, type UnitStatus } from "../status.ts";
import { displayWidth, padEnd, padStart, truncate } from "../width.ts";
import { Forklift, forkliftRows } from "./Forklift.tsx";
import { Progress, progressLines, type RunProgress } from "./Progress.tsx";
import { Shelf, verifiedPhrase } from "./Shelf.tsx";
import { cellToken, unitToken, type Theme } from "./theme.ts";

/**
 * Columns are padded with displayWidth, never with .length or Ink's flexbox.
 * The state glyphs are multibyte and this layout is nothing but aligned
 * columns, so the padding is done explicitly and the result handed to Ink as
 * pre-sized strings.
 */

const FOLDER = 25;
const SIZE = 8;

export interface Row {
  readonly status: UnitStatus;
  readonly size: number;
  /** Files in the folder, so a check can report progress through it. */
  readonly files?: number;
}

export interface LedgerProps {
  readonly rows: readonly Row[];
  readonly selected: number;
  readonly config: Config;
  readonly state: State;
  readonly theme: Theme;
  readonly width: number;
  /** Terminal rows to fill. Omit to size to content. */
  readonly height?: number;
  readonly now: number;
  readonly busy: string | null;
  /** A check in flight, shown on its row and in the footer. */
  readonly running?: RunProgress | null;
  /** Advances the forklift; it only moves while something is running. */
  readonly frame?: number;
  /** A keypress that was refused, so the refusal is visible rather than silent. */
  readonly notice?: string | null;
}

/**
 * Key hints, fitted to the window rather than counted by hand.
 *
 * This line has overflowed 76 columns three times, each time by someone (me)
 * adding a hint and adding up the characters wrong. So it is measured: hints
 * are dropped from the least important end until the line fits, and [?] is
 * never dropped because it is how the rest are discovered.
 */
const HINTS: readonly string[] = [
  "[enter] diff",
  "[q] check",
  "[d] verify",
  "[s] sync",
  // What "[q]/[Q] check" left unsaid. A capital is not self-explanatory, and
  // the shift rule is one sentence that covers both keys — so it is worth more
  // of this line than a second glyph pair was.
  "[shift] all",
  "[p] cmds",
];
const LAST_HINT = "[?] keys";

export function hintLine(width: number): string {
  const room = width - 2;
  for (let n = HINTS.length; n > 0; n--) {
    const line = [...HINTS.slice(0, n), LAST_HINT].join("   ");
    if (displayWidth(line) <= room) return line;
  }
  return LAST_HINT;
}

function leaders(name: string, w: number): string {
  const head = truncate(name, w - 2) + " ";
  const pad = w - displayWidth(head);
  return pad > 0 ? head + ".".repeat(pad) : head;
}

export function Ledger(props: LedgerProps): React.ReactElement {
  const { rows, selected, config, state, theme, width, now } = props;
  const names = config.targets.map((t) => t.name);
  const cellW = names.map((n) => Math.max(displayWidth(n), 4) + 2);
  const fixed = 2 + FOLDER + 1 + SIZE + 3 + cellW.reduce((a, b) => a + b, 0);
  const statusW = Math.max(12, width - fixed + 2);
  const rule = (ch: string): string => ch.repeat(width);

  const selectedRow = rows[selected];

  /**
   * Only as many rows as fit.
   *
   * Ink clips an overflowing column by dropping whole elements, silently — the
   * forklift lost a row and the column header vanished entirely once the
   * progress bar appeared. The chrome around the rows is a known height, so the
   * rows are windowed to what is left and the remainder is named.
   */
  /**
   * The window budget, shed in priority order when it will not fit.
   *
   * `room` used to be forced to at least one row even when the chrome already
   * filled the window. The total then exceeded the height and Ink resolved it
   * by dropping lines and running their remnants together — a progress line
   * reading "…is still running 00s", where `00s` was the tail of a detail line
   * that had been deleted. Silent overflow is the recurring failure in this
   * layout; the fix is for the layout to fit by construction, and to give up
   * its least important parts first when it cannot.
   */
  const detailLines = config.targets.length;

  // What the screen is for, and cannot give up. Counted against `Footer`'s
  // actual output rather than from memory: the summary row, the blank beneath
  // it, and then either the two progress lines plus any refusal notice, or the
  // single hint/busy line.
  const core =
    2 +
    (props.running != null
      ? progressLines(props.running, props.now, props.notice != null)
      : 1);

  // Shed in increasing order of importance. The legend is a reference; the
  // detail block restates one row; the mark is decoration; the column header
  // labels rows that may not be there anyway.
  const OPTIONAL: readonly (readonly [string, number])[] = [
    ["legend", 2], // the dotted rule and the glyph row
    ["detail", detailLines],
    ["mark", 3], // two mark rows and the gap beneath
    ["header", 2], // the column header and its rule
    ["rowRule", 1], // the rule below the rows
    ["gap", 1], // the blank above the footer
  ];

  const budget = props.height ?? Number.MAX_SAFE_INTEGER;
  const keep = new Set(OPTIONAL.map(([name]) => name));
  let used = core + OPTIONAL.reduce((a, [, n]) => a + n, 0);
  // Drop whole pieces until the layout fits. Ink resolves overflow by deleting
  // lines and welding the remnants together — a notice once rendered as
  // "…is still running 00s", where `00s` was the tail of a deleted line — so
  // the layout has to fit by construction rather than hope the window is tall.
  for (const [name, n] of OPTIONAL) {
    if (used <= budget) break;
    keep.delete(name);
    used -= n;
  }
  const showLegend = keep.has("legend");
  const showDetail = keep.has("detail");
  const showMark = keep.has("mark");
  const showHeader = keep.has("header");
  const showRowRule = keep.has("rowRule");
  const showGap = keep.has("gap");

  const chrome = used;
  const room =
    props.height === undefined
      ? rows.length
      : Math.max(0, Math.min(rows.length, props.height - chrome));
  const start = Math.max(0, Math.min(selected - Math.floor(room / 2), rows.length - room));
  const shown = rows.slice(Math.max(0, start), Math.max(0, start) + room);
  const hidden = rows.length - shown.length;
  // Rendered on the footer in the next commit; kept live here so this
  // commit (adding noUnusedLocals) does not have to delete the count the
  // layout's own doc comment says the remainder is named with.
  void hidden;

  return (
    // Fills the terminal: the ledger sits at the top, and a flexible spacer
    // pushes the legend and footer to the bottom edge, so the layout does not
    // jump as rows are added or filtered away.
    <Box flexDirection="column" height={props.height} width={width + 2}>
      {/* The forklift sits left of the title and moves only while a check or a
          sync is running, so motion on this screen means work is happening. */}
      {!showMark ? null : (
      <Box>
        <Forklift theme={theme} frame={props.frame ?? 0} moving={props.running != null} />
        <Box flexDirection="column">
          <Box>
            <Text color={theme.ink}>
              {"    " + padEnd("syncy", width - 32 - displayWidth(forkliftRows(0, false)[0] ?? ""))}
            </Text>
            <Text color={theme.dim}>{`archive ledger · ${stamp(now).split(" · ")[0]}`}</Text>
          </Box>
          <Text> </Text>
        </Box>
      </Box>
      )}
      {/* Air between the mark and the table, so the header does not crowd it. */}
      {!showMark ? null : <Text> </Text>}

      {!showHeader ? null : (
        <>
          <Box>
            <Text color={theme.dim}>
              {"  " + padEnd("folder", FOLDER) + " " + padStart("size", SIZE) + "   "}
              {names.map((n, i) => padEnd(n, cellW[i]!)).join("")}
              {"status"}
            </Text>
          </Box>
          <Text color={theme.rule}>{"  " + rule("─")}</Text>
        </>
      )}

      {shown.map((row) => {
        const idx = rows.indexOf(row);
        const isSel = idx === selected;
        // The row a check is on. A `⋯` in one destination cell was the only
        // sign, which is too quiet to find in a list of twelve — the question
        // "which one is it working on?" should be answerable at a glance.
        const isRunning = props.running?.unit === row.status.unit;
        const reason = isRunning
          ? // While a check runs, the row's recorded state is the *previous*
            // verdict. Showing it unchanged reads as a result rather than as
            // history, so the row says what is happening instead.
            `${props.running!.mode} check running · ${props.running!.target}`
          : row.status.state === "verified"
            ? "verified"
            : `${row.status.state} · ${row.status.reason}`;
        return (
          <Box key={row.status.unit}>
            {/* Selection and activity are different facts and get different
                marks, so a check running on an unselected row still shows. */}
            <Text color={isRunning ? theme.unverified : isSel ? theme.figure : theme.dim}>
              {isRunning ? "▸ " : isSel ? "» " : "  "}
            </Text>
            <Text
              color={isRunning ? theme.unverified : isSel ? theme.figure : theme.ink}
              bold={isSel || isRunning}
            >
              {leaders(row.status.unit, FOLDER)}
            </Text>
            <Text color={theme.figure}>{" " + padStart(bytes(row.size), SIZE) + "   "}</Text>
            {names.map((n, i) => {
              const cell = row.status.cells.find((c) => c.target === n);
              // The row keeps showing its work even after the cursor moves on.
              const busyHere =
                props.running?.unit === row.status.unit && props.running.target === n;
              if (busyHere) {
                return (
                  <Text key={n} color={theme.unverified}>
                    {padEnd("⋯", cellW[i]!)}
                  </Text>
                );
              }
              const glyph = cell === undefined ? "?" : GLYPH[cell.state];
              const suffix = cell !== undefined && cell.state === "behind" ? String(cell.nChanges) : "";
              const token = cell === undefined ? "unchecked" : cellToken(cell.state);
              return (
                <Text key={n} color={theme[token]}>
                  {padEnd(glyph + suffix, cellW[i]!)}
                </Text>
              );
            })}
            <Text color={isRunning ? theme.unverified : theme[unitToken(row.status.state)]}>
              {truncate(reason, statusW)}
            </Text>
          </Box>
        );
      })}

      {!showRowRule ? null : <Text color={theme.rule}>{"  " + rule("─")}</Text>}

      {/* Strictness governs the verdict, not the display: an unreachable target
          still shows when it last verified. */}
      {!showDetail ? null : selectedRow === undefined ? (
        <Text color={theme.dim}>{"  no subfolders under the source root"}</Text>
      ) : (
        config.targets.map((t, i) => {
          const deep = findScan(state, selectedRow.status.unit, t.name, "deep");
          const last = latestScan(state, selectedRow.status.unit, t.name);
          const prefix = i === 0 ? padEnd(truncate(selectedRow.status.unit, 17), 18) : padEnd("", 18);
          return (
            <Box key={t.name}>
              <Text color={theme.ink}>{"  " + prefix}</Text>
              <Text color={theme.dim}>{padEnd(t.name, 5) + " "}</Text>
              <Text color={theme.dim}>
                {evidencePhrase(deep, last, now, { stamp, ageAgo }, knownExtras(state, selectedRow.status.unit, t.name)?.count)}
              </Text>
            </Box>
          );
        })
      )}

      {/* Absorbs the leftover rows so the footer stays on the bottom line. */}
      <Box flexGrow={1} />

      {/* The legend is a reference, not a fact about this archive, so it is
          the first thing given up when the window is too short. */}
      {showLegend ? (
        <>
          <Text color={theme.rule}>{"  " + rule("·")}</Text>
          <Box>
            <Text color={theme.verified}>{"  ✓ verified"}</Text>
            <Text color={theme.unverified}>{"    ~ unverified"}</Text>
            <Text color={theme.behind}>{"    ▲ behind"}</Text>
            <Text color={theme.missing}>{"    ✗ missing"}</Text>
            <Text color={theme.unchecked}>{"    ? unchecked"}</Text>
          </Box>
        </>
      ) : null}
      {!showGap ? null : <Text> </Text>}

      <Footer {...props} />
    </Box>
  );
}

function Footer(props: LedgerProps): React.ReactElement {
  const { rows, theme, busy, width } = props;
  const states = rows.map((r) => r.status.state);
  const entries = rows.map((r) => ({ state: r.status.state, size: r.size }));

  // Three facts, one measure each: the scale of the archive, the bytes by
  // state, and the shape. The counts by state were the same information a
  // second way, and the shelf already carries it.
  const scale = `  ${rows.length} folder${rows.length === 1 ? "" : "s"}`;
  const phrase = verifiedPhrase(entries);
  const blocks = Math.min(states.length, 28);
  const gap = Math.max(2, width + 2 - displayWidth(scale) - displayWidth(phrase) - blocks - 4);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.dim}>{scale}</Text>
        <Text color={theme.verified}>{"    " + phrase}</Text>
        <Text>{" ".repeat(gap)}</Text>
        <Shelf states={states} theme={theme} />
      </Box>
      <Text> </Text>
      {props.running != null ? (
        <Progress
          progress={props.running}
          now={props.now}
          width={props.width}
          theme={theme}
          notice={props.notice ?? null}
        />
      ) : busy === null ? (
        <Text color={theme.dim}>{"  " + hintLine(props.width)}</Text>
      ) : (
        // Truncated: an untruncated command wrapped across three lines and
        // sheared the layout.
        <Text color={theme.unverified}>{"  " + truncate(busy, props.width - 2)}</Text>
      )}
    </Box>
  );
}
