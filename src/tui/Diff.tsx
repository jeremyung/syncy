import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import type { Config } from "../config.ts";
import { diffCounts, type Diff, type DiffEntry, type DiffKind } from "../diff.ts";
import { explainFlags } from "../itemize.ts";
import { ageAgo, bytes, count } from "../format.ts";
import { displayWidth, padEnd, padStart, truncate, truncatePath } from "../width.ts";
import { Rule, Screen } from "./Screen.tsx";
import type { Theme } from "./theme.ts";

/**
 * The differences themselves, per destination.
 *
 * "504 files pending" is a number nobody can act on: it does not say whether
 * one folder never copied or five hundred files changed, and it gives no way to
 * tell a real gap from a stale record. This lists them, in the same words the
 * status column uses, with rsync's own itemize string alongside so the claim is
 * checkable rather than asserted.
 *
 * Nothing here offers to delete. Extras — files at the destination with no
 * counterpart at the source — are shown because they are worth knowing about,
 * and left alone because removing them is not this tool's business.
 */

/** The order differences are listed in: what is at risk first. */
const ORDER: readonly DiffKind[] = ["new", "changed", "metadata", "extra"];

const LABEL: Readonly<Record<DiffKind, string>> = {
  new: "not at destination",
  changed: "content differs",
  metadata: "attributes differ",
  extra: "only at destination",
};

/** A glyph per kind, so the list reads without colour. */
const GLYPH: Readonly<Record<DiffKind, string>> = {
  new: "+",
  changed: "≠",
  metadata: "·",
  extra: "−",
};

/** The same meanings in fewer columns, for a narrow window. */
const SHORT: Readonly<Record<DiffKind, string>> = {
  new: "absent",
  changed: "differs",
  metadata: "attributes",
  extra: "extra",
};

const TOKEN: Readonly<Record<DiffKind, "missing" | "behind" | "dim" | "unverified">> = {
  new: "missing",
  changed: "behind",
  metadata: "dim",
  extra: "unverified",
};

/**
 * The legend, in the widest wording that fits.
 *
 * The full labels wrapped at 76 columns and Ink broke "destination" across two
 * lines, which cost a row of the listing. Choosing by measurement rather than
 * by counting characters is the only version of this that stays correct as the
 * labels change.
 */
export function legendLine(width: number): string {
  const full = ORDER.map((k) => `${GLYPH[k]} ${LABEL[k]}`).join("   ");
  const short = ORDER.map((k) => `${GLYPH[k]} ${SHORT[k]}`).join("   ");
  return displayWidth(full) <= width - 2 ? full : short;
}

export interface DiffProps {
  readonly config: Config;
  readonly unit: string;
  /** One entry per configured target; null means no check has been recorded. */
  readonly diffs: ReadonlyMap<string, Diff | null>;
  readonly theme: Theme;
  readonly width: number;
  readonly height?: number;
  readonly now: number;
  readonly onClose: () => void;
}

/** The one-line summary for a destination, or why there is nothing to show. */
export function summaryLine(diff: Diff | null, now: number): string {
  if (diff === null) return "never checked — run a check to see what differs";
  if (diff.wholeFolderMissing) return "the whole folder is absent from this destination";
  const c = diffCounts(diff);
  const parts = ORDER.filter((k) => c[k] > 0).map((k) => `${c[k]} ${LABEL[k]}`);
  const when = `${diff.method} check ${ageAgo(diff.ts, now)}`;
  if (parts.length === 0) return `no differences · ${when}`;
  // The byte total is what decides whether this is a five-minute sync or an
  // overnight one, so it belongs next to the count rather than a screen away.
  const size = pendingBytes(diff);
  const total = size > 0 ? ` · ${bytes(size)} to copy` : "";
  return `${parts.join(" · ")}${total} · ${when}`;
}

/**
 * Source against destination, so the listing has a scale to be read against.
 *
 * "504 not at destination" is a count without a denominator: it reads the same
 * whether the folder holds 505 files or fifty thousand. Both sides are
 * measured — the destination by a read-only walk during the check, because
 * rsync reports the source length for every item and never the destination's.
 */
export function magnitudeLine(diff: Diff | null): string | null {
  const src = diff?.sourceHolds;
  if (diff === null || src === undefined) return null;
  const dst = diff.targetHolds;
  const here = `source ${count(src.nfiles)} files · ${bytes(src.bytes)}`;
  if (dst === undefined) return `${here}   destination not measured`;
  const there = `destination ${count(dst.nfiles)} files · ${bytes(dst.bytes)}`;
  const gapFiles = src.nfiles - dst.nfiles;
  const gapBytes = src.bytes - dst.bytes;
  if (gapFiles === 0 && gapBytes === 0) return `${here}   ${there}   identical totals`;

  // Each dimension is described in its own direction rather than signed. A
  // destination can hold more than the source and still be behind — extras are
  // never deleted — so "short by −504" was both a double negative and unable to
  // express the mixed case at all.
  const parts: string[] = [];
  if (gapFiles > 0) parts.push(`${count(gapFiles)} files short`);
  else if (gapFiles < 0) parts.push(`${count(-gapFiles)} files extra`);
  if (gapBytes > 0) parts.push(`${bytes(gapBytes)} short`);
  else if (gapBytes < 0) parts.push(`${bytes(-gapBytes)} extra`);
  return `${here}   ${there}   ${parts.join(" · ")}`;
}

/** Bytes rsync would transfer: files it would create or replace, not extras. */
export function pendingBytes(diff: Diff): number {
  return diff.entries
    .filter((e) => !e.dir && e.sized && (e.kind === "new" || e.kind === "changed"))
    .reduce((a, e) => a + e.bytes, 0);
}

function Entry({
  entry,
  theme,
  width,
}: {
  readonly entry: DiffEntry;
  readonly theme: Theme;
  readonly width: number;
}): React.ReactElement {
  // The itemize string is fixed-width and the size column is narrow, so the
  // name gets everything left over and is truncated in the middle: the tail of
  // a path identifies a file far better than its head.
  // Extras carry no size: rsync's `*deleting` line reports the name only.
  const size = !entry.sized ? "—" : entry.dir ? "dir" : bytes(entry.bytes);
  // The itemize string is exact and unreadable without the manual open, so the
  // plain reading sits beside it: `.f...p.....` next to "permissions". The raw
  // string stays because it is the evidence; the words are what make it useful.
  const why = explainFlags(entry.flags);
  const WHY = 18;
  const nameW = Math.max(14, width - 4 - 12 - 2 - 9 - (why === null ? 0 : WHY));
  return (
    <Box>
      <Text color={theme[TOKEN[entry.kind]]}>{`    ${GLYPH[entry.kind]} `}</Text>
      <Text color={theme.ink}>{padEnd(truncatePath(entry.name, nameW), nameW)}</Text>
      <Text color={theme.dim}>{padStart(size, 10)}</Text>
      {why === null ? null : (
        <Text color={theme.unverified}>{"  " + padEnd(truncate(why, WHY - 2), WHY - 2)}</Text>
      )}
      <Text color={theme.rule}>{"  " + entry.flags}</Text>
    </Box>
  );
}

/**
 * One flat list across every destination, so one scroll position serves them
 * all. Sectioning the window per target meant a folder with 504 differences
 * showed a fixed dozen and hid the rest with no way to reach them.
 */
export type DiffRow =
  | { readonly kind: "header"; readonly target: string; readonly diff: Diff | null }
  | { readonly kind: "magnitude"; readonly text: string }
  | { readonly kind: "entry"; readonly target: string; readonly entry: DiffEntry }
  | { readonly kind: "note"; readonly text: string }
  | { readonly kind: "blank" };

export function diffRows(
  targets: readonly string[],
  diffs: ReadonlyMap<string, Diff | null>,
): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const target of targets) {
    const diff = diffs.get(target) ?? null;
    rows.push({ kind: "header", target, diff });
    const magnitude = magnitudeLine(diff);
    if (magnitude !== null) rows.push({ kind: "magnitude", text: magnitude });
    const entries =
      diff === null
        ? []
        : [...diff.entries].sort(
            (a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.name.localeCompare(b.name),
          );
    for (const entry of entries) rows.push({ kind: "entry", target, entry });
    if ((diff?.truncated ?? 0) > 0) {
      rows.push({ kind: "note", text: `… ${diff!.truncated} more were not recorded (cap reached)` });
    }
    rows.push({ kind: "blank" });
  }
  return rows;
}

/** Keeps the cursor on screen, scrolling only when it would otherwise leave. */
export function windowFor(
  cursor: number,
  count: number,
  room: number,
): { readonly start: number; readonly end: number } {
  if (count <= room) return { start: 0, end: count };
  const start = Math.max(0, Math.min(cursor - Math.floor(room / 2), count - room));
  return { start, end: start + room };
}

export function Diff(props: DiffProps): React.ReactElement {
  const { config, unit, diffs, theme, width, now, onClose } = props;
  const rows = useMemo(
    () => diffRows(config.targets.map((t) => t.name), diffs),
    [config.targets, diffs],
  );
  const [cursor, setCursor] = useState(0);

  // Chrome is counted before the list is windowed. Ink drops overflow without
  // a word, so the list must be told how many lines it may actually use.
  const chrome = 2 + 1 + 4;
  const room = Math.max(3, (props.height ?? 40) - chrome);
  const last = Math.max(0, rows.length - 1);

  useInput((input, key) => {
    if (key.escape || input === "e") return onClose();
    if (key.upArrow || input === "k") setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow || input === "j") setCursor((c) => Math.min(last, c + 1));
    else if (key.pageUp || input === "u") setCursor((c) => Math.max(0, c - room));
    else if (key.pageDown || input === " " || input === "d") setCursor((c) => Math.min(last, c + room));
    else if (input === "g") setCursor(0);
    else if (input === "G") setCursor(last);
  });

  const { start, end } = windowFor(cursor, rows.length, room);
  const shown = rows.slice(start, end);
  const entryCount = rows.filter((r) => r.kind === "entry").length;
  const position =
    rows.length <= room
      ? `${entryCount} ${entryCount === 1 ? "difference" : "differences"}`
      : `${start + 1}–${end} of ${rows.length}   [↑↓] scroll  [g]/[G] ends`;

  return (
    <Screen
      title={`syncy · differences · ${unit}`}
      width={width}
      {...(props.height === undefined ? {} : { height: props.height })}
      theme={theme}
      footer={
        <Box flexDirection="column">
          <Rule width={width} theme={theme} char="·" />
          <Text color={theme.dim}>{"  " + legendLine(width)}</Text>
          <Text color={theme.dim}>{"  " + truncate(position, width - 2)}</Text>
          <Text color={theme.dim}>{"  [esc] back   nothing here deletes anything"}</Text>
        </Box>
      }
    >
      {config.targets.length === 0 ? (
        <Text color={theme.dim}>{"  no destinations configured"}</Text>
      ) : null}
      {shown.map((r, i) => {
        const key = `${start + i}`;
        if (r.kind === "blank") return <Text key={key}> </Text>;
        if (r.kind === "note") return <Text key={key} color={theme.rule}>{"    " + r.text}</Text>;
        if (r.kind === "magnitude") {
          return (
            <Text key={key} color={theme.dim}>{"  " + truncate(r.text, width - 2)}</Text>
          );
        }
        if (r.kind === "header") {
          return (
            <Box key={key}>
              <Text color={theme.ink}>{"  " + padEnd(r.target, 12)}</Text>
              {/* Truncated, not wrapped: a wrapped summary pushed the listing
                  down a line and cost a file from the bottom of it. */}
              <Text color={theme.dim}>{truncate(summaryLine(r.diff, now), width - 14)}</Text>
            </Box>
          );
        }
        return <Entry key={key} entry={r.entry} theme={theme} width={width} />;
      })}
    </Screen>
  );
}

/** The screen as plain text, for the clipboard. */
export function diffText(
  config: Config,
  unit: string,
  diffs: ReadonlyMap<string, Diff | null>,
  now: number,
): string {
  const out: string[] = [`differences · ${unit}`, ""];
  for (const t of config.targets) {
    const diff = diffs.get(t.name) ?? null;
    out.push(`${t.name}  ${summaryLine(diff, now)}`);
    for (const e of diff?.entries ?? []) {
      const size = !e.sized ? "—" : e.dir ? "dir" : bytes(e.bytes);
      out.push(`  ${GLYPH[e.kind]} ${e.name}  ${size}  ${e.flags}`);
    }
    if ((diff?.truncated ?? 0) > 0) out.push(`  … ${diff!.truncated} more not recorded`);
    out.push("");
  }
  return out.join("\n");
}

// Kept for the tests, which assert the legend and the listing agree.
export { LABEL as DIFF_LABELS, GLYPH as DIFF_GLYPHS, ORDER as DIFF_ORDER, displayWidth };
