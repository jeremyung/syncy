import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import type { Config } from "../config.ts";
import {
  diffCounts,
  folderOf,
  groupDiff,
  splitBySync,
  GROUP_BY,
  type Diff,
  type DiffEntry,
  type DiffGroup,
  type DiffKind,
  type GroupBy,
  type SyncSplit,
} from "../diff.ts";
import { explainFlags } from "../itemize.ts";
import { ageAgo, bytes, count, day, span } from "../format.ts";
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
 * The flat listing that produced was still unreadable at the size that matters.
 * A folder 504 files behind drew 504 rows carrying two facts each — a name and
 * a size — under an itemize column that repeated `>f+++++++++` five hundred
 * times, because a creation has nothing else to say. Everything a reader
 * actually wanted was a property of the *set*: one shoot or five, raw files or
 * sidecars, a week's backlog or a year's. So the listing is grouped, each group
 * states those properties, and the file-by-file view is one keypress away for
 * when a name is what you need.
 *
 * The ordering changed with it. `ORDER` ranks kinds by what is at risk, which
 * put 504 routine creations above the single file whose attributes differed —
 * at row 505 of a windowed list, which is to say nowhere. Groups are ranked by
 * what is surprising instead (`groupDiff`), and the bulk backlog sinks.
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
 * How many entries a group may hold before it opens closed.
 *
 * Small groups behave exactly as the flat listing always did — there is nothing
 * to be gained by hiding four files behind a disclosure. Past this, the header
 * says more than the rows do.
 */
export const COLLAPSE_OVER = 8;

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
  /** When each destination last had a sync land, for the age split. */
  readonly lastSync?: ReadonlyMap<string, number | null>;
  /** The grouping the screen opens on. [b] cycles from wherever this leaves it. */
  readonly by?: GroupBy;
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

/** The fingerprint's newest mtime in milliseconds, or null when it holds none. */
function newestOf(ns: string | undefined): number | null {
  if (ns === undefined) return null;
  try {
    const ms = Number(BigInt(ns) / 1_000_000n);
    return ms > 0 ? ms : null;
  } catch {
    return null; // A hand-edited record; the lag line is not worth throwing for.
  }
}

/**
 * How far behind the destination's newest file is.
 *
 * Both fingerprints already recorded `maxMtimeNs` and nothing read them. It is
 * the cheapest true statement this screen can make: it needs no listing, no
 * itemize parsing and no cap, and it reframes a wall of five hundred red
 * plusses as the one sentence a reader wants — that nothing has landed here
 * since the third of February.
 */
export function lagLine(diff: Diff | null, now: number = Date.now()): string | null {
  const here = newestOf(diff?.sourceHolds?.maxMtimeNs);
  const there = newestOf(diff?.targetHolds?.maxMtimeNs);
  if (here === null || there === null) return null;
  const both = `newest here ${day(here, now)} · there ${day(there, now)}`;
  const days = Math.floor((here - there) / 86_400_000);
  if (days <= 0) return `${both} · level`;
  return `${both} · ${days === 1 ? "1 day" : `${days} days`} behind`;
}

/**
 * Which side of the last sync the pending files fall on.
 *
 * The distinction the screen could not previously draw, and the one that
 * decides whether anything is wrong. Files written since the last sync are a
 * backlog: nothing failed, the copy has not run. Files written before it and
 * still absent were skipped by something.
 *
 * Deliberately hedged. Mtimes survive camera imports, `cp -p` and restores, so
 * an old date does not prove a file was present when the sync ran — the wording
 * says which side of the line a file falls on and stops there.
 */
export function syncLine(split: SyncSplit, now: number): readonly string[] {
  const total = split.since + split.before + split.undated;
  if (total === 0) return [];
  if (split.lastSyncTs === null) return ["no sync has run here yet"];

  // One line, both counts. Two lines each opening with a number read as two
  // separate findings; they are one finding with a split in it. The totals are
  // left out because the summary line above states them — the only new fact
  // here is where the line falls.
  // "the 13 feb sync" rather than "the last sync (13 feb)": the date is the new
  // fact and the article is not. Five cells, and the line has to survive
  // truncation at 76 with all four clauses present.
  const when = `the ${day(split.lastSyncTs, now)} sync`;
  const parts: string[] = [];
  if (split.before > 0) parts.push(`${count(split.before)} predate ${when}`);
  if (split.since > 0) {
    parts.push(parts.length === 0 ? `all written since ${when}` : `${count(split.since)} after`);
  }
  if (split.undated > 0) parts.push(`${count(split.undated)} undated`);
  // The caveat earns its place only when something is on the older side of the
  // line, and only at this length: the reader knows what an mtime is, and a
  // sentence about camera imports would cost more width than the finding. It
  // goes last and must still fit — a hedge truncated off the end leaves the
  // number reading as a certainty.
  if (split.before > 0) parts.push("imports preserve dates");
  return [parts.join(" · ")];
}

/** Bytes rsync would transfer: files it would create or replace, not extras. */
export function pendingBytes(diff: Diff): number {
  return diff.entries
    .filter((e) => !e.dir && e.sized && (e.kind === "new" || e.kind === "changed"))
    .reduce((a, e) => a + e.bytes, 0);
}

/**
 * What a group is, in one line: how much, of what, from when.
 *
 * These are the facts a reader was previously expected to infer by scrolling.
 * The type mix is capped at three — beyond that it is a histogram, not a label.
 */
export function groupDetail(g: DiffGroup, now: number = Date.now()): string {
  // First, not last. The detail is truncated to the window, and this annotation
  // is the reason the group is at the top of the screen — trailing it behind
  // the type mix meant the one line that said "this is a gap, not a backlog"
  // was the first thing a narrow window threw away.
  const parts: string[] = g.before ? ["predates the last sync"] : [];
  parts.push(`${count(g.entries.length)} ${g.entries.length === 1 ? "file" : "files"}`);
  if (g.bytes > 0) parts.push(bytes(g.bytes));
  const types = g.types.slice(0, 3).map(([ext, n]) => `${ext} ${count(n)}`);
  if (g.types.length > 3) types.push(`+${g.types.length - 3} more`);
  if (types.length > 0) parts.push(types.join(" "));
  const when = span(g.oldest, g.newest, now);
  if (when !== null) parts.push(when);
  // One shared itemize string says the same thing on every row underneath it,
  // so it is said here instead and the rows drop the column entirely. Both the
  // reading and the raw string come up here — moving the column onto the header
  // is a change of place, and dropping the evidence to save width would be a
  // change of claim.
  if (g.flags !== null) {
    const why = explainFlags(g.flags);
    parts.push(why ?? (g.kind === "new" ? "all created new" : ""), g.flags);
  }
  return parts.filter((p) => p !== "").join(" · ");
}

/**
 * The cursor, in the ledger's own glyph, drawn inside the row's indent.
 *
 * Occupying space the indent already spends is what keeps every column aligned
 * between a selected row and its neighbours — a marker that pushed the row
 * right would make the listing jitter as the cursor moved through it.
 */
function cursorMark(selected: boolean, indent: number): string {
  return (selected ? "» " : "  ") + " ".repeat(Math.max(0, indent - 2));
}

function Entry({
  entry,
  theme,
  width,
  indent,
  strip,
  showFlags,
  now,
  selected,
}: {
  readonly entry: DiffEntry;
  readonly theme: Theme;
  readonly width: number;
  readonly now: number;
  readonly indent: number;
  /** The group's folder, dropped from the name because the header carries it. */
  readonly strip: string;
  readonly showFlags: boolean;
  readonly selected: boolean;
}): React.ReactElement {
  // Extras carry no size: rsync's `*deleting` line reports the name only.
  const size = !entry.sized ? "—" : entry.dir ? "dir" : bytes(entry.bytes);
  // The itemize string is exact and unreadable without the manual open, so the
  // plain reading sits beside it: `.f...p.....` next to "permissions". The raw
  // string stays because it is the evidence; the words are what make it useful.
  // Both drop out when every row in the group shares one string, which the group
  // header then states once — 504 identical columns are not evidence, they are
  // one piece of evidence copied 504 times.
  const why = showFlags ? explainFlags(entry.flags) : null;
  const WHY = 18;
  const flags = showFlags ? "  " + entry.flags : "";
  // Wide enough for a date carrying a year; a cross-year file is exactly the
  // one whose date the reader must not misread.
  const when = entry.mtime === undefined ? "" : "  " + padStart(day(entry.mtime, now), 11);
  const name =
    strip !== "" && entry.name.startsWith(strip + "/")
      ? entry.name.slice(strip.length + 1)
      : entry.name;
  const nameW = Math.max(
    14,
    width - indent - 2 - 10 - displayWidth(when) - displayWidth(flags) - (why === null ? 0 : WHY),
  );
  return (
    <Box>
      <Text color={theme.ink}>{cursorMark(selected, indent)}</Text>
      <Text color={theme[TOKEN[entry.kind]]}>{`${GLYPH[entry.kind]} `}</Text>
      <Text color={theme.ink} bold={selected}>{padEnd(truncatePath(name, nameW), nameW)}</Text>
      <Text color={theme.dim}>{padStart(size, 10)}</Text>
      <Text color={theme.dim}>{when}</Text>
      {why === null ? null : (
        <Text color={theme.unverified}>{"  " + padEnd(truncate(why, WHY - 2), WHY - 2)}</Text>
      )}
      <Text color={theme.rule}>{flags}</Text>
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
  | { readonly kind: "lag"; readonly text: string }
  | { readonly kind: "verdict"; readonly text: string; readonly alarm: boolean }
  | {
      readonly kind: "group";
      readonly target: string;
      readonly id: string;
      readonly group: DiffGroup;
      readonly open: boolean;
    }
  | {
      readonly kind: "entry";
      readonly target: string;
      readonly entry: DiffEntry;
      readonly indent: number;
      readonly strip: string;
      readonly showFlags: boolean;
    }
  | { readonly kind: "note"; readonly text: string }
  | { readonly kind: "blank" };

export interface RowOptions {
  readonly lastSync?: ReadonlyMap<string, number | null>;
  readonly by?: GroupBy;
  /** Group ids whose default open state the reader has flipped. */
  readonly toggled?: ReadonlySet<string>;
  readonly now?: number;
}

/** A group's identity, stable across re-renders so a toggle survives a refresh. */
export function groupId(target: string, key: string): string {
  return `${target}\u0000${key}`;
}

export function diffRows(
  targets: readonly string[],
  diffs: ReadonlyMap<string, Diff | null>,
  opts: RowOptions = {},
): DiffRow[] {
  const by = opts.by ?? "folder";
  const toggled = opts.toggled ?? new Set<string>();
  const now = opts.now ?? Date.now();
  const rows: DiffRow[] = [];
  for (const target of targets) {
    const diff = diffs.get(target) ?? null;
    rows.push({ kind: "header", target, diff });
    const magnitude = magnitudeLine(diff);
    if (magnitude !== null) rows.push({ kind: "magnitude", text: magnitude });
    const lag = lagLine(diff, now);
    if (lag !== null) rows.push({ kind: "lag", text: lag });

    if (diff === null) {
      rows.push({ kind: "blank" });
      continue;
    }

    const lastSync = opts.lastSync?.get(target) ?? null;
    for (const text of syncLine(splitBySync(diff, lastSync), now)) {
      rows.push({ kind: "verdict", text, alarm: text.includes("predate") });
    }

    if (by === "flat") {
      const entries = [...diff.entries].sort(
        (a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.name.localeCompare(b.name),
      );
      for (const entry of entries) {
        rows.push({ kind: "entry", target, entry, indent: 4, strip: "", showFlags: true });
      }
    } else {
      for (const group of groupDiff(diff.entries, by, lastSync, now)) {
        // A group of one has nothing to summarise: its header and its row would
        // carry the same facts twice. The entry stands on its own, with the
        // itemize column it would otherwise have surrendered to the header.
        const only = group.entries[0];
        if (group.entries.length === 1 && only !== undefined) {
          rows.push({ kind: "entry", target, entry: only, indent: 4, strip: "", showFlags: true });
          continue;
        }
        const id = groupId(target, group.key);
        const open = (group.entries.length <= COLLAPSE_OVER) !== toggled.has(id);
        rows.push({ kind: "group", target, id, group, open });
        if (!open) continue;
        // Only a folder group's label is a prefix of its entries' names; the
        // type and age groupings cut across directories, so nothing is stripped.
        const strip = by === "folder" && group.label !== "." ? group.label : "";
        const sorted = [...group.entries].sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of sorted) {
          rows.push({
            kind: "entry",
            target,
            entry,
            indent: 6,
            strip,
            showFlags: group.flags === null,
          });
        }
      }
    }

    if (diff.truncated > 0) {
      rows.push({ kind: "note", text: `… ${diff.truncated} more were not recorded (cap reached)` });
    }
    rows.push({ kind: "blank" });
  }
  return rows;
}

/**
 * The rows a cursor may land on: the ones that draw a selection.
 *
 * Headers, totals, the lag line and the sync split are statements, not targets.
 * While the cursor indexed every row, arrowing down from the top moved through
 * four or five of them with nothing on screen changing — the key appeared dead
 * until the cursor happened to reach the listing. Movement now steps between
 * the rows that can show they are selected, and the prose is scrolled past
 * rather than walked through.
 */
export function selectableRows(rows: readonly DiffRow[]): number[] {
  const out: number[] = [];
  rows.forEach((r, i) => {
    if (r.kind === "group" || r.kind === "entry") out.push(i);
  });
  return out;
}

/**
 * The nearest selectable row at or after `from`, else the last one.
 *
 * Needed on every read, not only on movement: opening a group or changing the
 * grouping rebuilds the list underneath a cursor that was an index into the
 * old one.
 */
export function snapTo(selectable: readonly number[], from: number): number {
  if (selectable.length === 0) return 0;
  for (const i of selectable) if (i >= from) return i;
  return selectable[selectable.length - 1]!;
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

function Group({
  row,
  theme,
  width,
  now,
  selected,
}: {
  readonly row: Extract<DiffRow, { kind: "group" }>;
  readonly theme: Theme;
  readonly width: number;
  readonly now: number;
  readonly selected: boolean;
}): React.ReactElement {
  const g = row.group;
  // A group small enough never to close gets no marker: a disclosure triangle
  // that does nothing is a promise the screen cannot keep.
  const marker = g.entries.length <= COLLAPSE_OVER ? " " : row.open ? "▾" : "▸";
  const labelW = Math.min(34, Math.max(16, Math.floor(width / 3)));
  return (
    <Box>
      <Text color={selected ? theme.ink : theme.rule}>{`${cursorMark(selected, 2)}${marker} `}</Text>
      <Text color={theme[TOKEN[g.kind]]}>{`${GLYPH[g.kind]} `}</Text>
      <Text color={theme.ink} bold={selected}>
        {padEnd(truncatePath(g.label, labelW), labelW)}
      </Text>
      <Text color={g.before ? theme.missing : theme.dim}>
        {"  " + truncate(groupDetail(g, now), Math.max(8, width - labelW - 8))}
      </Text>
    </Box>
  );
}

export function Diff(props: DiffProps): React.ReactElement {
  const { config, unit, diffs, theme, width, now, onClose } = props;
  const [by, setBy] = useState<GroupBy>(props.by ?? "folder");
  const [toggled, setToggled] = useState<ReadonlySet<string>>(() => new Set<string>());
  const rows = useMemo(
    () =>
      diffRows(
        config.targets.map((t) => t.name),
        diffs,
        {
          ...(props.lastSync === undefined ? {} : { lastSync: props.lastSync }),
          by,
          toggled,
          now,
        },
      ),
    [config.targets, diffs, props.lastSync, by, toggled, now],
  );
  const [cursor, setCursor] = useState(0);

  // Chrome is counted before the list is windowed. Ink drops overflow without
  // a word, so the list must be told how many lines it may actually use.
  const chrome = 2 + 1 + 4;
  const room = Math.max(3, (props.height ?? 40) - chrome);
  const selectable = useMemo(() => selectableRows(rows), [rows]);
  const at = snapTo(selectable, cursor);
  const nth = selectable.indexOf(at);
  const here = rows[at];
  /** Steps `n` selectable rows from where the cursor actually is. */
  const step = (n: number): void => {
    const to = selectable[Math.max(0, Math.min(selectable.length - 1, nth + n))];
    if (to !== undefined) setCursor(to);
  };

  useInput((input, key) => {
    if (key.escape || input === "e") return onClose();
    if (key.upArrow || input === "k") step(-1);
    else if (key.downArrow || input === "j") step(1);
    else if (key.pageUp || input === "u") step(-room);
    else if (key.pageDown || input === " " || input === "d") step(room);
    else if (input === "g") setCursor(0);
    else if (input === "G") setCursor(rows.length);
    else if (key.return && here?.kind === "group") {
      // A flip is recorded, not a state. A group's default is a property of its
      // size, so a re-check that grows one past the threshold still finds it
      // closed, and a reader who opened it still finds it open.
      const id = here.id;
      // The cursor stays on the group it opened, which is where the reader is
      // looking; the rows it reveals appear below it.
      setCursor(at);
      setToggled((t) => {
        const next = new Set(t);
        if (!next.delete(id)) next.add(id);
        return next;
      });
    } else if (input === "b") {
      // The cursor indexes rows that are about to be rebuilt, so it returns to
      // the top rather than pointing at an unrelated file.
      setBy((b) => GROUP_BY[(GROUP_BY.indexOf(b) + 1) % GROUP_BY.length]!);
      setCursor(0);
    }
  });

  const { start, end } = windowFor(at, rows.length, room);
  const shown = rows.slice(start, end);
  // Counted from the record, not from the rows on screen. Counting rows was
  // right while every difference was one row and became a lie the moment a
  // group could be closed: five hundred collapsed files reported "0
  // differences", which is the opposite of what the screen exists to say.
  const entryCount = [...diffs.values()].reduce((n, d) => n + (d?.entries.length ?? 0), 0);
  const shownOf = `${entryCount} ${entryCount === 1 ? "difference" : "differences"}`;
  const position =
    rows.length <= room
      ? shownOf
      : `${shownOf}   ${start + 1}–${end} of ${rows.length}   [↑↓] scroll  [g]/[G] ends`;

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
          <Text color={theme.dim}>
            {"  " +
              truncate(
                `[esc] back   [enter] open a group   [b] by ${by}   nothing here deletes anything`,
                width - 2,
              )}
          </Text>
        </Box>
      }
    >
      {config.targets.length === 0 ? (
        <Text color={theme.dim}>{"  no destinations configured"}</Text>
      ) : null}
      {shown.map((r, i) => {
        const row = start + i;
        const key = `${row}`;
        if (r.kind === "blank") return <Text key={key}> </Text>;
        if (r.kind === "note")
          return (
            <Text key={key} color={theme.rule}>
              {"    " + r.text}
            </Text>
          );
        if (r.kind === "magnitude" || r.kind === "lag") {
          return (
            <Text key={key} color={theme.dim}>
              {"  " + truncate(r.text, width - 2)}
            </Text>
          );
        }
        if (r.kind === "verdict") {
          return (
            <Text key={key} color={r.alarm ? theme.missing : theme.ink}>
              {"  " + truncate(r.text, width - 2)}
            </Text>
          );
        }
        if (r.kind === "group") {
          return (
            <Group key={key} row={r} theme={theme} width={width} now={now} selected={row === at} />
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
        return (
          <Entry
            key={key}
            entry={r.entry}
            theme={theme}
            width={width}
            now={now}
            indent={r.indent}
            strip={r.strip}
            showFlags={r.showFlags}
            selected={row === at}
          />
        );
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
  lastSync?: ReadonlyMap<string, number | null>,
): string {
  const out: string[] = [`differences · ${unit}`, ""];
  for (const t of config.targets) {
    const diff = diffs.get(t.name) ?? null;
    out.push(`${t.name}  ${summaryLine(diff, now)}`);
    const lag = lagLine(diff, now);
    if (lag !== null) out.push(`  ${lag}`);
    if (diff !== null) {
      const at = lastSync?.get(t.name) ?? null;
      for (const line of syncLine(splitBySync(diff, at), now)) out.push(`  ${line}`);
    }
    for (const e of diff?.entries ?? []) {
      const size = !e.sized ? "—" : e.dir ? "dir" : bytes(e.bytes);
      const when = e.mtime === undefined ? "" : `  ${day(e.mtime, now)}`;
      out.push(`  ${GLYPH[e.kind]} ${e.name}  ${size}${when}  ${e.flags}`);
    }
    if ((diff?.truncated ?? 0) > 0) out.push(`  … ${diff!.truncated} more not recorded`);
    out.push("");
  }
  return out.join("\n");
}

// Kept for the tests, which assert the legend and the listing agree.
export { LABEL as DIFF_LABELS, GLYPH as DIFF_GLYPHS, ORDER as DIFF_ORDER, displayWidth, folderOf };
