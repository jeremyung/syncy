import type { Config } from "./config.ts";
import { ageAgo, bytes, stamp } from "./format.ts";
import type { Scan, State } from "./state.ts";
import { latestScan, findScan } from "./state.ts";
import { evidencePhrase, GLYPH, knownExtras, targetIdentity, type UnitStatus } from "./status.ts";
import { shelfSummary } from "./tui/Shelf.tsx";
import { displayWidth, fit, padEnd, padStart, truncate } from "./width.ts";

/**
 * The archival ledger (DESIGN.md section 6).
 *
 * Leader dots, lowercase, ruled lines, right-aligned figures. Every column is
 * padded by display width, never by .length — the state glyphs are multibyte.
 */

const MIN_WIDTH = 76;
const MAX_WIDTH = 110;
const FOLDER = 25;
const SIZE = 8;

export function terminalWidth(): number {
  const cols = process.stdout.columns ?? MIN_WIDTH;
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, cols - 2));
}

function leaders(name: string, w: number): string {
  const head = truncate(name, w - 2) + " ";
  const pad = w - displayWidth(head);
  return pad > 0 ? head + ".".repeat(pad) : head;
}

const rule = (w: number, ch = "─"): string => "  " + ch.repeat(w);

/** Mirrors the Ink Shelf, so the printed ledger and the interactive one agree. */
const BLOCK: Readonly<Record<UnitStatus["state"], string>> = {
  verified: "█",
  unverified: "▓",
  behind: "▒",
  missing: "░",
  unchecked: "·",
  error: "!",
};

export interface LedgerRow {
  readonly status: UnitStatus;
  readonly size: number;
}

export interface LedgerView {
  readonly rows: readonly LedgerRow[];
  readonly selected: number;
  readonly config: Config;
  readonly state: State;
  readonly now: number;
  readonly freeBytes?: number;
}

export function renderLedger(view: LedgerView): string {
  const W = terminalWidth();
  const names = view.config.targets.map((t) => t.name);
  const cellW = names.map((n) => Math.max(displayWidth(n), 4) + 2);
  const fixed = 2 + FOLDER + 1 + SIZE + 3 + cellW.reduce((a, b) => a + b, 0);
  const statusW = Math.max(12, W - fixed + 2);

  const out: string[] = [];
  const states = view.rows.map((r) => r.status.state);
  const blocks = states.map((s) => BLOCK[s]).join("");
  const dateLine = `archive ledger · ${stamp(view.now).split(" · ")[0]} ${new Date(view.now).getFullYear()}`;
  const wordmark = "  syncy  " + blocks;
  out.push(wordmark + " ".repeat(Math.max(1, W + 2 - displayWidth(wordmark) - displayWidth(dateLine))) + dateLine);
  out.push("         " + shelfSummary(states));
  out.push("");

  // Header
  let head = "  " + padEnd("folder", FOLDER) + " " + padStart("size", SIZE) + "   ";
  names.forEach((n, i) => (head += padEnd(n, cellW[i]!)));
  head += "status";
  out.push(head);
  out.push(rule(W));

  view.rows.forEach((row, idx) => {
    const mark = idx === view.selected ? "»" : " ";
    let line = mark + " " + leaders(row.status.unit, FOLDER) + " " + padStart(bytes(row.size), SIZE) + "   ";
    names.forEach((n, i) => {
      const cell = row.status.cells.find((c) => c.target === n);
      const glyph = cell === undefined ? "?" : GLYPH[cell.state];
      const suffix = cell !== undefined && cell.state === "behind" ? String(cell.nChanges) : "";
      line += padEnd(glyph + suffix, cellW[i]!);
    });
    const reason = row.status.state === "verified" ? "verified" : `${row.status.state} · ${row.status.reason}`;
    line += truncate(reason, statusW);
    out.push(line);
  });

  out.push(rule(W));
  out.push(...detailLines(view));
  out.push(rule(W, "·"));
  out.push("  " + names.map(() => "").join("") + legend());
  out.push("");
  out.push("  " + footer(view, W));
  return out.join("\n");
}

function legend(): string {
  return "✓ verified    ~ unverified    ▲ behind    ✗ missing    ? unchecked";
}

/**
 * The detail line is how verify ages survive the compaction to one glyph per
 * cell. Strictness governs the verdict, not the display: an unreachable target
 * still shows when it last verified and when it was last seen.
 */
function detailLines(view: LedgerView): string[] {
  const row = view.rows[view.selected];
  if (row === undefined) return ["  no subfolders under the source root"];
  const label = truncate(row.status.unit, 18);
  const out: string[] = [];
  view.config.targets.forEach((t, i) => {
    // Filtered to the identity this target resolves to now, or the printed
    // ledger — the path that works over ssh — keeps showing a foreign
    // volume's evidence after a remove-and-re-add under the same name.
    const identity = targetIdentity(t);
    const deep = findScan(view.state, row.status.unit, t.name, "deep", identity);
    const last = latestScan(view.state, row.status.unit, t.name, identity);
    // A deep verify carries no --delete and always reports zero extras, so
    // the count comes from the quick check that could actually see them —
    // `describe` accepts this precisely so a deep check does not read as
    // having erased a known extra. This parameter existed and was never
    // passed, so the printed ledger's evidence line lost "N extra at
    // destination" the moment a deep check followed a quick one that found
    // extras.
    const extras = knownExtras(view.state, row.status.unit, t.name, identity)?.count;
    const prefix = i === 0 ? padEnd(label, 18) : padEnd("", 18);
    out.push(`  ${prefix}${padEnd(t.name, 5)} ${describe(deep, last, view.now, extras)}`);
  });
  const fp = row.status.cells.length > 0 ? view.rows[view.selected] : undefined;
  if (fp !== undefined) {
    out.push(`  ${padEnd("", 18)}${padEnd("", 5)} ${bytes(row.size)} on disk`);
  }
  return out;
}

const describe = (
  deep: Scan | undefined,
  last: Scan | undefined,
  now: number,
  extras?: number,
): string => evidencePhrase(deep, last, now, { stamp, ageAgo }, extras);

function footer(view: LedgerView, W: number): string {
  const total = view.rows.reduce((a, r) => a + r.size, 0);
  const verified = view.rows.filter((r) => r.status.state === "verified").reduce((a, r) => a + r.size, 0);
  const awaiting = view.rows.filter((r) => r.status.state === "unchecked").reduce((a, r) => a + r.size, 0);

  const left = `${view.rows.length} units · ${bytes(total)}`;
  const mid = `${bytes(verified)} verified`;
  const right = awaiting > 0 ? `${bytes(awaiting)} awaiting` : view.freeBytes !== undefined ? `boot ${bytes(view.freeBytes)} free` : "";
  const gap = Math.max(2, Math.floor((W - displayWidth(left + mid + right)) / 2));
  return fit(left, displayWidth(left) + gap) + fit(mid, displayWidth(mid) + gap) + right;
}
