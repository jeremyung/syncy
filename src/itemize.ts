/**
 * Parser for rsync's --itemize-changes under --out-format='%i|%l|%n'.
 *
 * %i is the 11-character itemize string, %l the byte length, %n the name.
 * Deletions arrive as a literal `*deleting` in the %i field.
 */

export type ItemKind = "change" | "metadata" | "same" | "extra";

export interface Item {
  readonly flags: string;
  readonly bytes: number;
  readonly name: string;
  readonly kind: ItemKind;
}

export interface Summary {
  readonly nChanges: number;
  /**
   * Of those changes, the ones rsync would create from nothing.
   *
   * The distinction the ledger was getting wrong: a deep check reporting 504
   * changes was described as "504 files differ by content" purely because the
   * method was deep, when in fact none of them existed at the destination at
   * all. Those need different responses and are different facts.
   */
  readonly nNew: number;
  /** Items already present whose attributes differ. Not pending content. */
  readonly nMetadata: number;
  /** Items rsync looked at and found identical. Progress, not a problem. */
  readonly nSame: number;
  readonly nExtra: number;
  readonly bytesPending: number;
}

/**
 * rsync itemize: `YXcstpoguax`, where Y is the update kind and X the file type.
 *
 * Column 1 is what matters here. `>` `<` `c` `h` mean the item is being
 * transferred or created; `.` means it is NOT being updated and only attributes
 * differ. Counting a `.` entry as pending is how deleting one file at the
 * target made its parent directory report as a second change — the directory's
 * mtime moved, so rsync itemized `.d..t......` for it.
 */
const ITEMIZE = /^([<>ch.])([fdLDS])/;

export function parseItemizeLine(line: string): Item | null {
  const raw = line.trimEnd();
  if (raw === "") return null;

  const first = raw.indexOf("|");
  const last = raw.indexOf("|", first + 1);
  if (first < 0 || last < 0) return null;

  const flags = raw.slice(0, first).trim();
  const lenField = raw.slice(first + 1, last).trim();
  const name = raw.slice(last + 1);
  if (name === "") return null;

  // `*deleting` means the file exists at the destination but not at the source.
  // Under --dry-run this is informational only; extras never endanger source
  // data and so never prevent a `verified` status (DESIGN.md §3).
  if (flags.startsWith("*deleting")) {
    return { flags, bytes: 0, name, kind: "extra" };
  }
  const m = ITEMIZE.exec(flags);
  if (m === null) return null;

  const bytes = Number.parseInt(lenField, 10);
  return {
    flags,
    bytes: Number.isFinite(bytes) ? bytes : 0,
    name,
    // Column 1 of `.` means the item is not being updated. Under -vv rsync
    // emits one such line per file it has finished with, so the blank-flag
    // case is a progress tick rather than a difference: `.f         ` is
    // identical, `.f....t....` genuinely has an attribute that differs.
    kind: m[1] !== "." ? "change" : /[a-zA-Z]/.test(flags.slice(2)) ? "metadata" : "same",
  };
}

/**
 * Columns 3 onwards are all `+` when rsync is creating the item from nothing.
 * Anything else means it exists at the destination and some attribute differs.
 */
export function isNew(item: Item): boolean {
  const rest = item.flags.slice(2).trim();
  return rest !== "" && /^\+*$/.test(rest);
}

export function summarize(items: readonly Item[]): Summary {
  let nChanges = 0;
  let nNew = 0;
  let nMetadata = 0;
  let nSame = 0;
  let nExtra = 0;
  let bytesPending = 0;
  for (const it of items) {
    if (it.kind === "extra") {
      nExtra += 1;
    } else if (it.kind === "same") {
      nSame += 1;
    } else if (it.kind === "metadata") {
      nMetadata += 1;
    } else {
      nChanges += 1;
      if (isNew(it)) nNew += 1;
      // Directories carry a size but transfer nothing.
      if (it.flags[1] === "f") bytesPending += it.bytes;
    }
  }
  return { nChanges, nNew, nMetadata, nSame, nExtra, bytesPending };
}

/**
 * rsync's itemize string in words.
 *
 * `.f...p.....` is exact and unreadable without the manual open. The eleven
 * columns are `YXcstpoguax`: update kind, file type, then one letter per
 * attribute that differs. Only the attribute columns carry a reading — the
 * first two are already expressed by the listing's own glyph.
 */
const ATTRIBUTE_AT: Readonly<Record<number, string>> = {
  2: "checksum",
  3: "size",
  4: "time",
  5: "permissions",
  6: "owner",
  7: "group",
  9: "acl",
  10: "xattr",
};

export function explainFlags(flags: string): string | null {
  if (flags.startsWith("*")) return null; // `*deleting` is already words
  const found: string[] = [];
  for (const [at, name] of Object.entries(ATTRIBUTE_AT)) {
    const ch = flags[Number(at)];
    if (ch !== undefined && ch !== "." && ch !== " ") found.push(name);
  }
  if (found.length === 0) return null;
  // A creation sets every column to `+`; saying "checksum, size, time…" of a
  // file that does not exist yet would be noise dressed as detail.
  if (/^\++$/.test(flags.slice(2).trim())) return null;
  return found.join(", ");
}
