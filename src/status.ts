import type { Config, Target } from "./config.ts";
import { sameFingerprint, type Fingerprint } from "./fingerprint.ts";
import type { SentinelStatus } from "./sentinel.ts";
import { latestScan, findScan, type Scan, type State } from "./state.ts";

/**
 * The status ladder (DESIGN.md sections 4 and 5).
 *
 * Five states, each mapping to exactly one action. Status describes the state
 * of the files; it never prescribes what to do about them.
 */

export type CellState = "verified" | "unverified" | "behind" | "missing" | "unchecked" | "error";
export type UnitState = "verified" | "unverified" | "behind" | "missing" | "unchecked" | "error";

export const GLYPH: Readonly<Record<CellState, string>> = {
  verified: "✓",
  unverified: "~",
  behind: "▲",
  missing: "✗",
  unchecked: "?",
  error: "!",
};

export interface Cell {
  readonly target: string;
  readonly state: CellState;
  readonly reason: string;
  readonly nChanges: number;
  readonly bytesPending: number;
  readonly nExtra: number;
  /**
   * The drift was found by a deep verify, so a plain sync will not fix it.
   *
   * Bit rot leaves size and mtime intact, so rsync's default quick check skips
   * exactly the file that needs replacing. Syncing such a folder without `-c`
   * reports success and changes nothing.
   */
  readonly needsChecksum?: boolean;
}

export interface UnitStatus {
  readonly unit: string;
  readonly state: UnitState;
  readonly reason: string;
  readonly cells: readonly Cell[];
}

const DAY_MS = 86_400_000;
const ageDays = (ts: number, now: number): number => Math.floor((now - ts) / DAY_MS);

function agePhrase(ts: number, now: number): string {
  const d = ageDays(ts, now);
  if (d <= 0) return "today";
  if (d === 1) return "1d ago";
  return `${d}d ago`;
}

export interface CellInput {
  readonly target: Target;
  readonly sentinel: SentinelStatus | "unreachable";
  readonly fingerprintNow: Fingerprint;
  readonly deep: Scan | undefined;
  readonly quick: Scan | undefined;
  readonly latest: Scan | undefined;
  readonly now: number;
  readonly maxVerifyAgeDays: number;
  readonly maxQuickAgeDays: number;
}

/**
 * What "behind" means for this destination, in the terms the evidence supports.
 *
 * `nNew` is absent on records written before it was tracked, in which case this
 * falls back to the older, weaker phrasing rather than inventing a breakdown.
 */
export function behindReason(latest: Scan): string {
  const n = latest.nChanges;
  const isNew = latest.nNew;
  if (isNew === undefined) return `${n} files pending`;
  if (isNew === n) return `${n} files not copied yet`;
  if (isNew === 0) return `${n} files differ by content`;
  return `${isNew} not copied, ${n - isNew} differ by content`;
}

/**
 * The evidence line for one destination: what has been established, and when.
 *
 * Written once and used by both the ledger and the text renderer, which
 * previously carried the same logic separately and could drift.
 *
 * Leads with what a check proved rather than what it skipped. "never
 * checksummed" describes an absence; a quick check is real evidence — every
 * file present, sizes and dates matching — and saying so makes the ladder
 * legible: quick proves the shape, deep proves the bytes.
 */
export function evidencePhrase(
  deep: Scan | undefined,
  last: Scan | undefined,
  now: number,
  fmt: { stamp: (ts: number) => string; ageAgo: (ts: number, now: number) => string },
): string {
  if (last === undefined) return "never checked";
  const parts: string[] = [];
  if (last.method === "quick") parts.push(`quick check ${fmt.ageAgo(last.ts, now)}`);
  parts.push(
    deep !== undefined && deep.outcome === "clean"
      ? `deep verified ${fmt.stamp(deep.ts)}`
      : "bytes never read",
  );
  if (last.nExtra > 0) parts.push(`${last.nExtra} extra at target`);
  return parts.join(" · ");
}

export function cellState(input: CellInput): Cell {
  const base = { target: input.target.name, nChanges: 0, bytesPending: 0, nExtra: 0 };

  // Rule 5 is strict: a target that cannot be seen right now cannot support a
  // `verified` status, regardless of how recently it verified clean.
  if (input.sentinel !== "ok") {
    const reason =
      input.sentinel === "unreachable"
        ? "not connected"
        : input.sentinel === "missing"
          ? "no sentinel here — not mounted, or the wrong volume"
          // Two causes, and the message has to cover both: a different volume
          // mounted at the same path, or the directory recreated since it was
          // added. Either way this is not the directory that was registered.
          : "not the directory that was registered — re-add it in setup";
    return { ...base, state: "unchecked", reason };
  }

  const latest = input.latest;
  if (latest === undefined) return { ...base, state: "unchecked", reason: "never checked" };

  if (latest.outcome === "error") {
    return { ...base, state: "error", reason: "last check failed — rerun with SYNCY_DEBUG=1" };
  }
  if (latest.outcome === "missing") {
    return { ...base, state: "missing", reason: "never copied" };
  }
  if (latest.outcome === "behind") {
    const byChecksum = latest.method === "deep";
    return {
      ...base,
      state: "behind",
      // Says what the files actually are, not what the method was. A deep
      // check reporting 504 changes was described as "504 files differ by
      // content" because the method was deep — when in fact none of them
      // existed at the destination. The evidence distinguishes the two, so
      // this does too.
      reason: behindReason(latest),
      nChanges: latest.nChanges,
      bytesPending: latest.bytesPending,
      nExtra: latest.nExtra,
      ...(byChecksum ? { needsChecksum: true } : {}),
    };
  }

  // The most recent check came back clean. Now the two clocks.
  const extra = { ...base, nExtra: latest.nExtra };

  if (!sameFingerprint(latest.fingerprint, input.fingerprintNow)) {
    return { ...extra, state: "unverified", reason: "source changed since last check" };
  }
  if (ageDays(latest.ts, input.now) > input.maxQuickAgeDays) {
    return { ...extra, state: "unverified", reason: `last checked ${agePhrase(latest.ts, input.now)}` };
  }

  const deep = input.deep;
  if (deep === undefined || deep.outcome !== "clean") {
    // "never checksummed" said what had not happened, not what had. A quick
    // check is real evidence — every file is present and matches in size and
    // modification time — it just cannot see inside the bytes.
    return { ...extra, state: "unverified", reason: "size and date match, bytes unread" };
  }
  if (!sameFingerprint(deep.fingerprint, input.fingerprintNow)) {
    return { ...extra, state: "unverified", reason: "source changed since deep verify" };
  }
  if (ageDays(deep.ts, input.now) > input.maxVerifyAgeDays) {
    return {
      ...extra,
      state: "unverified",
      reason: `deep verify expired - ${agePhrase(deep.ts, input.now)}`,
    };
  }

  return { ...extra, state: "verified", reason: `deep verified ${agePhrase(deep.ts, input.now)}` };
}

/**
 * Worst known problem wins; `unknown` only when nothing is known to be wrong
 * and something could not be checked.
 *
 * "We checked and it is not replicated" is more informative than "we could not
 * check", so a definite failure outranks an unchecked target. But an unchecked
 * target outranks `verified`, because a conclusion cannot be drawn from
 * evidence that is missing.
 */
const PRECEDENCE: readonly CellState[] = ["error", "missing", "behind", "unverified", "unchecked"];

export function rollUp(unit: string, cells: readonly Cell[], required: ReadonlySet<string>): UnitStatus {
  const relevant = cells.filter((c) => required.has(c.target));
  for (const state of PRECEDENCE) {
    const hit = relevant.find((c) => c.state === state);
    if (hit !== undefined) {
      return {
        unit,
        state,
        reason: `${hit.target} ${hit.reason}`,
        cells,
      };
    }
  }
  return { unit, state: "verified", reason: "all destinations deep verified", cells };
}

export interface UnitEvaluation {
  readonly unit: string;
  readonly fingerprint: Fingerprint;
  readonly sentinels: ReadonlyMap<string, SentinelStatus | "unreachable">;
}

export function evaluateUnit(
  config: Config,
  state: State,
  ev: UnitEvaluation,
  now: number = Date.now(),
): UnitStatus {
  const cells = config.targets.map((target) => {
    const sentinel = ev.sentinels.get(target.name) ?? "unreachable";
    const input: CellInput = {
      target,
      sentinel,
      fingerprintNow: ev.fingerprint,
      deep: findScan(state, ev.unit, target.name, "deep"),
      quick: findScan(state, ev.unit, target.name, "quick"),
      latest: latestScan(state, ev.unit, target.name),
      now,
      maxVerifyAgeDays: config.maxVerifyAgeDays,
      maxQuickAgeDays: config.maxQuickAgeDays,
    };
    return cellState(input);
  });

  const required = new Set(config.targets.filter((t) => t.required).map((t) => t.name));
  const status = rollUp(ev.unit, cells, required);

  // min_targets is a floor on how many required targets must actually be
  // verified, independent of how many are configured.
  if (status.state === "verified") {
    const verified = cells.filter((c) => required.has(c.target) && c.state === "verified").length;
    if (verified < config.minTargets) {
      return {
        ...status,
        state: "unverified",
        reason: `only ${verified} of ${config.minTargets} required targets verified`,
      };
    }
  }
  return status;
}

/** A reachability status in the words the ledger already uses. */
export function reachWord(r: "ok" | "missing" | "mismatch" | "unreachable"): string {
  return r === "unreachable"
    ? "not connected"
    : r === "missing"
      ? "no sentinel found"
      : r === "mismatch"
        ? "different volume"
        : "ok";
}
