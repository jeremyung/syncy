/** Ledger formatting: lowercase, right-aligned figures, never vague. */

const UNITS: ReadonlyArray<readonly [number, string, number]> = [
  [1024 ** 4, "tb", 1],
  [1024 ** 3, "gb", 0],
  [1024 ** 2, "mb", 0],
  [1024, "kb", 0],
];

export function bytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 b";
  for (const [scale, suffix, dp] of UNITS) {
    if (n >= scale) {
      const v = n / scale;
      // Keep one decimal below 10 so 1.2 tb does not collapse to 1 tb.
      return `${v < 10 ? v.toFixed(Math.max(dp, 1)) : v.toFixed(dp)} ${suffix}`;
    }
  }
  return `${n} b`;
}

export function count(n: number): string {
  return n.toLocaleString("en-US");
}

const DAY_MS = 86_400_000;

export function age(ts: number, now: number = Date.now()): string {
  const d = Math.floor((now - ts) / DAY_MS);
  if (d <= 0) return "today";
  if (d === 1) return "1d";
  return `${d}d`;
}

/** "today" reads wrong with a trailing "ago"; this is the phrase-safe form. */
export function ageAgo(ts: number, now: number = Date.now()): string {
  const a = age(ts, now);
  return a === "today" ? "today" : `${a} ago`;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * A date without a time, for spans where the hour is noise: "14 feb".
 *
 * The year appears only when it is not the current one. A file from April 2023
 * shown as "26 apr" beside a backlog from this February reads as six weeks old
 * when it is ten months old — and on this screen that difference is the whole
 * point of showing a date at all.
 */
export function day(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  const year = d.getFullYear() === new Date(now).getFullYear() ? "" : ` ${d.getFullYear()}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${year}`;
}

/**
 * A span of dates, collapsed when both ends land on the same day.
 *
 * A shoot arrives over an afternoon or a long weekend, so the useful reading is
 * "4–14 feb", not two timestamps a reader has to subtract in their head.
 */
export function span(from: number | null, to: number | null, now: number = Date.now()): string | null {
  if (from === null || to === null) return null;
  const a = day(from, now);
  const b = day(to, now);
  return a === b ? a : `${a}–${b}`;
}

export function stamp(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${day(ts)} · ${hh}:${mm}`;
}
