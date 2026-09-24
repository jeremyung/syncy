import type { UnitState } from "./status.ts";

/**
 * The words beneath the shelf, kept apart from the shelf itself.
 *
 * The plain-text ledger prints this line too, and it used to import it from
 * the Ink component file, so printing the ledger without a terminal UI still
 * loaded an interface module. It is pure counting, so it lives here.
 */

/** A one-line summary of what the shelf shows, for the line beneath it. */
export function shelfSummary(states: readonly UnitState[]): string {
  if (states.length === 0) return "no folders yet";
  const counts = new Map<UnitState, number>();
  for (const s of states) counts.set(s, (counts.get(s) ?? 0) + 1);
  // Ordered worst-last, so the reassuring number is not the final word.
  const order: readonly UnitState[] = [
    "verified",
    "unverified",
    "behind",
    "missing",
    "unchecked",
    "error",
  ];
  const parts = order.filter((s) => (counts.get(s) ?? 0) > 0).map((s) => `${counts.get(s)!} ${s}`);
  const n = states.length;
  return `${n} folder${n === 1 ? "" : "s"} · ${parts.join(", ")}`;
}
