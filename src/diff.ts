import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { Fingerprint } from "./fingerprint.ts";
import { type Item, isNew } from "./itemize.ts";
import { diffDir } from "./paths.ts";

/**
 * What a check actually found, kept so the ledger can show it (DESIGN.md §4).
 *
 * The counts in `state.json` say *how many* files are pending; they cannot say
 * which, and "504 files pending" is not something anyone can act on or trust.
 * rsync already itemizes every one of them during the check, so the list costs
 * nothing extra to produce — it was simply being discarded when the check
 * finished. This writes it down.
 *
 * Stored per unit and target in its own file rather than in `state.json`,
 * because it is bulky, entirely derived, and safe to lose: deleting the diff
 * directory costs a re-check, never a verification record.
 */

/** What kind of difference this is, in the user's terms rather than rsync's. */
export type DiffKind =
  /** Not at the destination at all. */
  | "new"
  /** At the destination, but the content differs. */
  | "changed"
  /** Same content; permissions, times or ownership differ. */
  | "metadata"
  /** At the destination and not at the source. Never deleted by syncy. */
  | "extra";

export interface DiffEntry {
  readonly kind: DiffKind;
  readonly name: string;
  readonly bytes: number;
  /** rsync's raw itemize string, so the evidence view can show its working. */
  readonly flags: string;
  /**
   * True for directories, which transfer no content. Never set for extras:
   * rsync reports those as the literal `*deleting`, whose second character is
   * a `d` that means nothing — reading it as the type flag labelled every
   * extra file a directory.
   */
  readonly dir: boolean;
  /** False for extras, where rsync reports no size at all. */
  readonly sized: boolean;
  /**
   * The source file's mtime, epoch milliseconds. Absent on extras, which have
   * no source file, and on records written before %M was captured — which the
   * views report as "undated" rather than guessing.
   */
  readonly mtime?: number;
}

export interface Diff {
  readonly version: 1;
  /**
   * Counts of everything found, before the storage cap.
   *
   * `entries` is capped at MAX_ENTRIES, so counting it reported "1000
   * attributes differ" for a folder where 2508 did — the cap masquerading as a
   * measurement. Absent on records written before this was tracked.
   */
  readonly totals?: Readonly<Record<DiffKind, number>>;
  readonly unit: string;
  readonly target: string;
  readonly ts: number;
  readonly method: string;
  /** Every difference found, capped at MAX_ENTRIES. */
  readonly entries: readonly DiffEntry[];
  /** How many were dropped by the cap, so the view can say so. */
  readonly truncated: number;
  /** Set when the destination folder does not exist, so nothing was itemized. */
  readonly wholeFolderMissing: boolean;
  /** What the source holds, so the listing can be read against the whole. */
  readonly sourceHolds?: Fingerprint;
  /** What the destination actually holds. Absent on records written earlier. */
  readonly targetHolds?: Fingerprint;
}

/**
 * The cap on stored entries.
 *
 * A folder that is behind by more than this is not one anyone reads file by
 * file — they read the first screen and run a sync. The count in `state.json`
 * remains exact regardless; only the listing is capped.
 */
export const MAX_ENTRIES = 1000;

/**
 * Bounded streaming state for an itemize pass.
 *
 * A check can visit hundreds of thousands of files. Keeping every parsed
 * `Item` and then mapping it to a second `DiffEntry[]` made peak memory grow
 * with the archive even though the differences screen stores only the first
 * MAX_ENTRIES. This accumulator keeps exact totals while retaining only the
 * entries the screen can display.
 */
export interface DiffAccumulator {
  readonly entries: readonly DiffEntry[];
  readonly totals: Readonly<Record<DiffKind, number>>;
  readonly truncated: number;
  readonly add: (item: Item) => void;
}

function entryFromItem(item: Item, kind: DiffKind): DiffEntry {
  return {
    kind,
    name: item.name,
    bytes: item.bytes,
    flags: item.flags,
    dir: kind !== "extra" && item.flags[1] === "d",
    sized: kind !== "extra",
    ...(item.mtime !== null ? { mtime: item.mtime } : {}),
  };
}

/** Creates a collector that never stores more than MAX_ENTRIES differences. */
export function createDiffAccumulator(): DiffAccumulator {
  const entries: DiffEntry[] = [];
  const totals: Record<DiffKind, number> = { new: 0, changed: 0, metadata: 0, extra: 0 };
  let total = 0;
  return {
    entries,
    totals,
    get truncated() {
      return Math.max(0, total - MAX_ENTRIES);
    },
    add(item) {
      const kind = classify(item);
      if (kind === null) return;
      totals[kind] += 1;
      total += 1;
      if (entries.length < MAX_ENTRIES) entries.push(entryFromItem(item, kind));
    },
  };
}

export function classify(item: Item): DiffKind | null {
  if (item.kind === "same") return null;
  if (item.kind === "extra") return "extra";
  if (item.kind === "metadata") return "metadata";
  // Shared with `summarize`, so the ledger's count and this listing can never
  // describe the same rsync run differently.
  return isNew(item) ? "new" : "changed";
}

export function buildDiffFromAccumulator(
  unit: string,
  target: string,
  method: string,
  accumulator: DiffAccumulator,
  opts: {
    readonly ts?: number;
    readonly wholeFolderMissing?: boolean;
    readonly source?: Fingerprint;
    readonly target?: Fingerprint | null;
  } = {},
): Diff {
  return {
    version: 1,
    totals: { ...accumulator.totals },
    unit,
    target,
    ts: opts.ts ?? Date.now(),
    method,
    entries: accumulator.entries.slice(),
    truncated: accumulator.truncated,
    wholeFolderMissing: opts.wholeFolderMissing ?? false,
    ...(opts.source !== undefined ? { sourceHolds: opts.source } : {}),
    ...(opts.target != null ? { targetHolds: opts.target } : {}),
  };
}

export function buildDiff(
  unit: string,
  target: string,
  method: string,
  items: readonly Item[],
  opts: {
    readonly ts?: number;
    readonly wholeFolderMissing?: boolean;
    readonly source?: Fingerprint;
    readonly target?: Fingerprint | null;
  } = {},
): Diff {
  const accumulator = createDiffAccumulator();
  for (const item of items) accumulator.add(item);
  return buildDiffFromAccumulator(unit, target, method, accumulator, opts);
}

/**
 * A filename that cannot escape the diff directory.
 *
 * Unit names come from the source directory listing, so `..` or a slash in one
 * would otherwise steer a write outside syncy's own state. Everything outside a
 * conservative set is percent-encoded.
 */
export function diffFile(unit: string, target: string, dir: string = diffDir()): string {
  const safe = (s: string): string =>
    s
      .replace(/[^A-Za-z0-9._-]/g, (c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0"))
      // Separators are already encoded, so `..` cannot traverse — but leaving
      // it in the filename means reasoning about that every time this is read.
      .replace(/\.\./g, "%2e%2e");
  return join(dir, `${safe(target)}__${safe(unit)}.json`);
}

export function saveDiff(diff: Diff, dir: string = diffDir()): void {
  mkdirSync(dir, { recursive: true });
  const file = diffFile(diff.unit, diff.target, dir);
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o644);
  try {
    writeSync(fd, JSON.stringify(diff) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

/** True when a raw JSON value has every field `buildDiff` puts on a `DiffEntry`. */
function isValidEntry(raw: unknown): raw is DiffEntry {
  if (typeof raw !== "object" || raw === null) return false;
  const o = raw as Record<string, unknown>;
  return (
    (o["kind"] === "new" ||
      o["kind"] === "changed" ||
      o["kind"] === "metadata" ||
      o["kind"] === "extra") &&
    typeof o["name"] === "string" &&
    typeof o["bytes"] === "number" &&
    typeof o["flags"] === "string" &&
    typeof o["dir"] === "boolean" &&
    typeof o["sized"] === "boolean" &&
    (o["mtime"] === undefined || (typeof o["mtime"] === "number" && Number.isFinite(o["mtime"])))
  );
}

/**
 * Returns null when there is no stored diff, which the view reports as "not
 * checked yet" rather than as "no differences" — the two are not the same.
 *
 * A diff is explicitly derived and safe to lose (unlike state.json), so the
 * treatment here is proportionate rather than identical to `loadState`'s: a
 * malformed ENTRY inside an otherwise-valid record is dropped in place, so it
 * costs one row of the listing rather than crashing the differences screen or
 * discarding the whole record.
 */
export function loadDiff(unit: string, target: string, dir: string = diffDir()): Diff | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(diffFile(unit, target, dir), "utf8"));
    if (typeof raw !== "object" || raw === null) return null;
    const d = raw as Diff;
    if (d.version !== 1 || !Array.isArray(d.entries)) return null;
    return { ...d, entries: d.entries.filter(isValidEntry) };
  } catch {
    return null;
  }
}

/**
 * Counts by kind, for the summary line above the listing.
 *
 * Prefers the recorded totals, which predate the storage cap. Falls back to
 * counting stored entries only for records written before totals existed —
 * where the number will be short by whatever the cap dropped, but is the only
 * number there is.
 */
export function diffCounts(diff: Diff): Readonly<Record<DiffKind, number>> {
  if (diff.totals !== undefined) return diff.totals;
  const out: Record<DiffKind, number> = { new: 0, changed: 0, metadata: 0, extra: 0 };
  for (const e of diff.entries) out[e.kind] += 1;
  return out;
}

/**
 * When a difference was written, relative to the last sync that ran.
 *
 * This is the distinction the screen existed to make and could not: a file
 * absent from the destination and written *since* the last sync is an ordinary
 * backlog — nothing has gone wrong, the copy simply has not happened yet. A
 * file absent from the destination that was written *before* the last sync
 * should already be there. Something skipped it: an exclude rule that matches
 * more than intended, a permissions failure, an interrupted run.
 *
 * "before" is a reason to look, not proof of a fault. Mtimes are preserved by
 * camera imports, `cp -p` and restored backups, so a genuinely new file can
 * carry an old date. The wording throughout says which side of the sync a file
 * falls on and never claims to know why.
 */
export type SyncAge = "since" | "before" | "undated";

export function ageAgainstSync(entry: DiffEntry, lastSyncTs: number | null): SyncAge {
  if (lastSyncTs === null || entry.mtime === undefined) return "undated";
  return entry.mtime >= lastSyncTs ? "since" : "before";
}

export interface SyncSplit {
  readonly since: number;
  readonly before: number;
  readonly undated: number;
  readonly lastSyncTs: number | null;
}

/**
 * The split across everything a sync would copy — `new` and `changed` only.
 *
 * Extras are at the destination and not the source, and metadata differences
 * are already present at both; neither is a file waiting to be copied, so
 * neither belongs in a count that answers "why is this not there yet".
 */
export function splitBySync(diff: Diff, lastSyncTs: number | null): SyncSplit {
  let since = 0;
  let before = 0;
  let undated = 0;
  for (const e of diff.entries) {
    if (e.kind !== "new" && e.kind !== "changed") continue;
    const age = ageAgainstSync(e, lastSyncTs);
    if (age === "since") since += 1;
    else if (age === "before") before += 1;
    else undated += 1;
  }
  return { since, before, undated, lastSyncTs };
}

/** How the listing is divided up. `flat` is the original file-by-file listing. */
export type GroupBy = "folder" | "type" | "age" | "flat";

export const GROUP_BY: readonly GroupBy[] = ["folder", "type", "age", "flat"];

/** The directory part of an entry's name, or "" for one at the unit's root. */
export function folderOf(name: string): string {
  const cut = name.replace(/\/+$/, "").lastIndexOf("/");
  return cut < 0 ? "" : name.slice(0, cut);
}

/** The extension, lowercased and with its dot, or "" for a name without one. */
export function typeOf(entry: DiffEntry): string {
  if (entry.dir) return "";
  const base = entry.name.slice(entry.name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

/** Age buckets, coarse enough that a shoot lands in one and reads as one. */
const BUCKETS: readonly (readonly [string, number])[] = [
  ["today", 1],
  ["this week", 7],
  ["this month", 31],
  ["this year", 365],
];

export function ageBucket(mtime: number | undefined, now: number): string {
  if (mtime === undefined) return "undated";
  const days = (now - mtime) / 86_400_000;
  for (const [label, within] of BUCKETS) {
    if (days < within) return label;
  }
  return "older";
}

export interface DiffGroup {
  readonly key: string;
  readonly label: string;
  readonly kind: DiffKind;
  readonly entries: readonly DiffEntry[];
  /** Bytes a sync would move for this group; zero for extras and directories. */
  readonly bytes: number;
  /** Extensions by frequency, most common first. */
  readonly types: readonly (readonly [string, number])[];
  readonly oldest: number | null;
  readonly newest: number | null;
  /** The shared itemize string when every entry has the same one, else null. */
  readonly flags: string | null;
  /** True when every entry in the group predates the last sync. */
  readonly before: boolean;
}

/**
 * The listing, divided.
 *
 * Grouped by kind first and always: the glyph, the wording and the urgency all
 * belong to the kind, and a folder holding both a creation and a content
 * difference is holding two unrelated facts. Within a kind, `new` and `changed`
 * are divided again by which side of the last sync they fall on, so the handful
 * that should already be at the destination cannot hide inside a group of five
 * hundred that are merely waiting.
 */
export function groupDiff(
  entries: readonly DiffEntry[],
  by: GroupBy,
  lastSyncTs: number | null,
  now: number,
): DiffGroup[] {
  const buckets = new Map<string, DiffEntry[]>();
  const labels = new Map<string, string>();
  const sides = new Map<string, boolean>();
  for (const e of entries) {
    const age = ageAgainstSync(e, lastSyncTs);
    // Only the copyable kinds are split by the sync: an extra or an attribute
    // difference is not waiting to be copied, so "before the last sync" says
    // nothing about it.
    const side =
      (e.kind === "new" || e.kind === "changed") && age === "before" ? "before" : "since";
    const label =
      by === "folder"
        ? folderOf(e.name) || "."
        : by === "type"
          ? typeOf(e) || "no extension"
          : ageBucket(e.mtime, now);
    const key = `${e.kind}\u0000${side}\u0000${label}`;
    labels.set(key, label);
    sides.set(key, side === "before");
    const at = buckets.get(key);
    if (at === undefined) buckets.set(key, [e]);
    else at.push(e);
  }

  const out: DiffGroup[] = [];
  for (const [key, list] of buckets) {
    let bytes = 0;
    let oldest: number | null = null;
    let newest: number | null = null;
    const types = new Map<string, number>();
    let flags: string | null = list[0]!.flags;
    for (const e of list) {
      if (e.sized && !e.dir) bytes += e.bytes;
      if (e.mtime !== undefined) {
        if (oldest === null || e.mtime < oldest) oldest = e.mtime;
        if (newest === null || e.mtime > newest) newest = e.mtime;
      }
      const t = typeOf(e);
      if (t !== "") types.set(t, (types.get(t) ?? 0) + 1);
      if (flags !== e.flags) flags = null;
    }
    out.push({
      key,
      label: labels.get(key)!,
      kind: list[0]!.kind,
      entries: list,
      bytes,
      types: [...types].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
      oldest,
      newest,
      flags,
      before: sides.get(key)!,
    });
  }
  return out.sort(
    (a, b) => rank(a) - rank(b) || b.bytes - a.bytes || a.label.localeCompare(b.label),
  );
}

/**
 * What a group is worth looking at first.
 *
 * Not the same order as the legend. The legend lists kinds by what is at risk;
 * this ranks groups by what is surprising, and those come apart badly at scale.
 * A folder of 504 creations from yesterday outranked one file whose content
 * differs, purely because "not at destination" sorts before "content differs" —
 * so the single interesting row landed at position 505 of a windowed list and
 * was, in practice, unreachable. The bulk backlog is the least surprising thing
 * on the screen and now sorts near the bottom.
 */
function rank(g: DiffGroup): number {
  if (g.before) return 0; // should already be at the destination, and is not
  if (g.kind === "changed") return 1;
  if (g.kind === "metadata") return 2;
  if (g.kind === "new") return 3; // the ordinary backlog
  return 4; // extras, which syncy never acts on
}
