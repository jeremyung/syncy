import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { isNew, type Item } from "./itemize.ts";
import type { Fingerprint } from "./fingerprint.ts";
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

export function classify(item: Item): DiffKind | null {
  if (item.kind === "same") return null;
  if (item.kind === "extra") return "extra";
  if (item.kind === "metadata") return "metadata";
  // Shared with `summarize`, so the ledger's count and this listing can never
  // describe the same rsync run differently.
  return isNew(item) ? "new" : "changed";
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
  const all: DiffEntry[] = [];
  for (const it of items) {
    const kind = classify(it);
    if (kind === null) continue;
    all.push({
      kind,
      name: it.name,
      bytes: it.bytes,
      flags: it.flags,
      dir: kind !== "extra" && it.flags[1] === "d",
      sized: kind !== "extra",
    });
  }
  const totals: Record<DiffKind, number> = { new: 0, changed: 0, metadata: 0, extra: 0 };
  for (const e of all) totals[e.kind] += 1;
  return {
    version: 1,
    totals,
    unit,
    target,
    ts: opts.ts ?? Date.now(),
    method,
    entries: all.slice(0, MAX_ENTRIES),
    truncated: Math.max(0, all.length - MAX_ENTRIES),
    wholeFolderMissing: opts.wholeFolderMissing ?? false,
    ...(opts.source !== undefined ? { sourceHolds: opts.source } : {}),
    ...(opts.target != null ? { targetHolds: opts.target } : {}),
  };
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

/**
 * Returns null when there is no stored diff, which the view reports as "not
 * checked yet" rather than as "no differences" — the two are not the same.
 */
export function loadDiff(unit: string, target: string, dir: string = diffDir()): Diff | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(diffFile(unit, target, dir), "utf8"));
    if (typeof raw !== "object" || raw === null) return null;
    const d = raw as Diff;
    return d.version === 1 && Array.isArray(d.entries) ? d : null;
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
