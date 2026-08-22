/**
 * Display width, not byte length and not `.length`.
 *
 * The ledger is nothing but aligned columns, and every state glyph in it is
 * multibyte: `✓` is three bytes and one column. Padding with `.length` (or
 * printf's %-5s, which shears columns by padding on bytes) is the single
 * highest-risk detail in this build — see DESIGN.md §6.
 */

const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function codePointWidth(cp: number): number {
  // C0/C1 control characters occupy no column.
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  // Combining marks attach to the previous glyph.
  if (cp >= 0x0300 && cp <= 0x036f) return 0;
  if (cp === 0x200d || cp === 0xfe0f || cp === 0xfe0e) return 0;
  for (const [lo, hi] of WIDE) if (cp >= lo && cp <= hi) return 2;
  return 1;
}

/** Columns this string occupies in a monospace terminal. */
export function displayWidth(s: string): number {
  let total = 0;
  for (const { segment } of segmenter.segment(s)) {
    let w = 0;
    for (const ch of segment) {
      const cp = ch.codePointAt(0);
      if (cp === undefined) continue;
      // A grapheme cluster is as wide as its widest member, min 1 if visible.
      w = Math.max(w, codePointWidth(cp));
    }
    // An emoji presentation selector forces a wide rendering.
    if (segment.includes("️")) w = 2;
    total += w;
  }
  return total;
}

/** Truncate to `cols` display columns, appending `ellipsis` if it had to cut. */
export function truncate(s: string, cols: number, ellipsis = "…"): string {
  if (displayWidth(s) <= cols) return s;
  const budget = cols - displayWidth(ellipsis);
  let out = "";
  let w = 0;
  for (const { segment } of segmenter.segment(s)) {
    const sw = displayWidth(segment);
    if (w + sw > budget) break;
    out += segment;
    w += sw;
  }
  return out + ellipsis;
}

export function padEnd(s: string, cols: number): string {
  const pad = cols - displayWidth(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
}

export function padStart(s: string, cols: number): string {
  const pad = cols - displayWidth(s);
  return pad > 0 ? " ".repeat(pad) + s : s;
}

/** Pad to `cols`, truncating first if the string is too wide to fit. */
export function fit(s: string, cols: number): string {
  return padEnd(truncate(s, cols), cols);
}

/**
 * Truncate a path from the LEFT, keeping the tail.
 *
 * The informative part of a path is its leaf. Cutting the end leaves you
 * staring at `/var/folders/_c/z0zwd…` when what you needed was `…/Masters`.
 */
export function truncatePath(p: string, cols: number, ellipsis = "…"): string {
  if (displayWidth(p) <= cols) return p;
  const budget = cols - displayWidth(ellipsis);
  const segs = p.split("/");
  let tail = "";
  for (let i = segs.length - 1; i >= 0; i--) {
    const next = "/" + segs[i]! + tail;
    if (displayWidth(next) > budget) break;
    tail = next;
  }
  // A single segment longer than the budget still has to be cut somewhere.
  if (tail === "") {
    let out = "";
    for (const ch of [...p].reverse()) {
      if (displayWidth(ch + out) > budget) break;
      out = ch + out;
    }
    tail = out;
  }
  return ellipsis + tail;
}
