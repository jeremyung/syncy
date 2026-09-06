import { readFileSync } from "node:fs";
import { historyFile } from "./paths.ts";
import type { HistoryEntry } from "./state.ts";

const OPERATIONS = new Set(["quick", "deep", "sync"]);
const OUTCOMES = new Set(["started", "completed", "skipped", "failed", "cancelled", "missed"]);

export interface HistorySnapshotEntry {
  readonly ts: number;
  readonly unit: string;
  readonly target: string;
  readonly operation: "quick" | "deep" | "sync";
  readonly outcome: "started" | "completed" | "skipped" | "failed" | "cancelled" | "missed";
  readonly exitCode: number | null;
  readonly detail?: string;
  readonly log?: string;
}

function operationOf(entry: HistoryEntry): HistorySnapshotEntry["operation"] {
  if (entry.operation !== undefined) return entry.operation;
  if (entry.argv.some((part) => part.startsWith("--partial-dir="))) return "sync";
  if (entry.argv.includes("-c")) return "deep";
  return "quick";
}

function outcomeOf(entry: HistoryEntry): HistorySnapshotEntry["outcome"] {
  if (entry.outcome !== undefined) return entry.outcome;
  if (entry.exitCode === null) return "started";
  return entry.exitCode === 0 || entry.exitCode === 24 ? "completed" : "failed";
}

function parseEntry(line: string): HistoryEntry | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  if (
    typeof value.ts !== "number" ||
    !Number.isFinite(value.ts) ||
    typeof value.unit !== "string" ||
    typeof value.target !== "string" ||
    !Array.isArray(value.argv) ||
    !value.argv.every((part) => typeof part === "string") ||
    (value.exitCode !== null && typeof value.exitCode !== "number") ||
    (value.operation !== undefined &&
      (typeof value.operation !== "string" || !OPERATIONS.has(value.operation))) ||
    (value.outcome !== undefined &&
      (typeof value.outcome !== "string" || !OUTCOMES.has(value.outcome))) ||
    (value.detail !== undefined && typeof value.detail !== "string") ||
    (value.log !== undefined && typeof value.log !== "string")
  ) {
    return undefined;
  }
  return value as unknown as HistoryEntry;
}

/** Newest literal outcomes, with paired sync-start records collapsed. */
export function loadHistorySnapshot(
  limit = 200,
  file: string = historyFile(),
): HistorySnapshotEntry[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const entries = text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      const entry = parseEntry(line);
      return entry === undefined ? [] : [entry];
    });
  const completedLogs = new Set(
    entries.flatMap((entry) =>
      entry.log !== undefined && entry.exitCode !== null ? [entry.log] : [],
    ),
  );
  return entries
    .filter(
      (entry) =>
        !(entry.exitCode === null && entry.log !== undefined && completedLogs.has(entry.log)),
    )
    .reverse()
    .slice(0, Math.max(0, limit))
    .map((entry) => ({
      ts: entry.ts,
      unit: entry.unit,
      target: entry.target,
      operation: operationOf(entry),
      outcome: outcomeOf(entry),
      exitCode: entry.exitCode,
      ...(entry.detail === undefined ? {} : { detail: entry.detail }),
      ...(entry.log === undefined ? {} : { log: entry.log }),
    }));
}
