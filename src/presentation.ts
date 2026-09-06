import type { Diff, DiffKind } from "./diff.ts";
import type { Reachability } from "./scan.ts";
import type { Scan } from "./state.ts";

/**
 * Presentation facts shared by every interface.
 *
 * These functions deliberately return words, rather than colours or view
 * objects. The engine establishes evidence; each client may lay it out
 * differently, but must not invent a second vocabulary for that evidence.
 */
export interface ReachabilityPresentation {
  readonly reachability: Reachability;
  readonly phrase: string;
}

/** The canonical destination words used by the ledger and job results. */
export function presentReachability(reachability: Reachability): ReachabilityPresentation {
  return {
    reachability,
    phrase:
      reachability === "unreachable"
        ? "not connected"
        : reachability === "missing"
          ? "no sentinel found"
          : reachability === "mismatch"
            ? "different volume"
            : "connected",
  };
}

export interface DifferencePresentation {
  readonly state: "clean" | "behind" | "missing" | "error";
  readonly summary: string;
  readonly nChanges: number;
  readonly nFiles?: number;
  readonly nNew?: number;
  readonly nExtra: number;
  readonly bytesPending: number;
}

/** The evidence-backed summary for one check result. */
export function presentDifference(
  scan: Pick<Scan, "outcome" | "nChanges" | "nFiles" | "nNew" | "nExtra" | "bytesPending">,
): DifferencePresentation {
  const summary =
    scan.outcome === "behind"
      ? behindSummary(scan.nChanges, scan.nNew, scan.nFiles)
      : scan.outcome === "missing"
        ? "never copied"
        : scan.outcome === "error"
          ? "last check failed — rerun with SYNCY_DEBUG=1"
          : "size and date match, bytes unread";
  return {
    state: scan.outcome,
    summary,
    nChanges: scan.nChanges,
    ...(scan.nFiles === undefined ? {} : { nFiles: scan.nFiles }),
    ...(scan.nNew === undefined ? {} : { nNew: scan.nNew }),
    nExtra: scan.nExtra,
    bytesPending: scan.bytesPending,
  };
}

/** Current ledger wording for a behind result, without guessing its cause. */
export function behindSummary(
  nChanges: number,
  nNew: number | undefined,
  nFiles: number | undefined,
): string {
  // Older scans did not retain a file-only count. Their change total includes
  // directories, so calling it a file count would claim more than was read.
  const subject = nFiles === undefined ? `${nChanges} changes` : `${nFiles} files`;
  if (nNew === undefined) return `${subject} pending`;
  if (nNew === nChanges) return `${subject} not copied yet`;
  if (nNew === 0) return `${subject} differ by content`;
  // nNew predates the file-only split and may itself include directories.
  // Keep its unit explicit rather than presenting it as a file total.
  return nFiles === undefined
    ? `${nNew} changes not copied, ${nChanges - nNew} differ by content`
    : `${subject} pending · ${nNew} changes not copied, ${nChanges - nNew} differ by content`;
}

export interface EvidencePresentation {
  readonly summary: string;
  readonly lastCheckedAt?: number;
  readonly deepVerifiedAt?: number;
  /** True only when this evidence was recorded against the target now mounted. */
  readonly currentTarget: boolean;
}

/** Canonical compact evidence line used below the ledger. */
export function presentEvidence(
  deep: Scan | undefined,
  last: Scan | undefined,
  now: number,
  fmt: { stamp: (ts: number) => string; ageAgo: (ts: number, now: number) => string },
  extras?: number,
): EvidencePresentation {
  if (last === undefined) return { summary: "never checked", currentTarget: false };
  const parts: string[] = [];
  if (last.method === "quick") parts.push(`quick check ${fmt.ageAgo(last.ts, now)}`);
  if (deep !== undefined && deep.outcome === "clean")
    parts.push(`deep verified ${fmt.stamp(deep.ts)}`);
  else parts.push("bytes never read");
  const nExtra = extras ?? last.nExtra;
  if (nExtra > 0) parts.push(`${nExtra} extra at destination`);
  return {
    summary: parts.join(" · "),
    lastCheckedAt: last.ts,
    ...(deep?.outcome === "clean" ? { deepVerifiedAt: deep.ts } : {}),
    currentTarget: true,
  };
}

export interface DiffSummary {
  readonly counts: Readonly<Record<DiffKind, number>>;
  readonly parts: readonly {
    readonly kind: DiffKind;
    readonly count: number;
    readonly label: string;
  }[];
  readonly copyableFiles: number;
  readonly hasDifferences: boolean;
}

/** Shared risk order and words for all difference listings. */
export const DIFFERENCE_KIND_ORDER: readonly DiffKind[] = ["new", "changed", "metadata", "extra"];

export const DIFFERENCE_LABEL: Readonly<Record<DiffKind, string>> = {
  new: "not at destination",
  changed: "content differs",
  metadata: "attributes differ",
  extra: "only at destination",
};

export const DIFFERENCE_SHORT_LABEL: Readonly<Record<DiffKind, string>> = {
  new: "absent",
  changed: "differs",
  metadata: "attributes",
  extra: "extra",
};

/** A file total for sync progress; directories never inflate it. */
export function presentDiffSummary(diff: Diff): DiffSummary {
  const counts =
    diff.totals ??
    (() => {
      const total: Record<DiffKind, number> = { new: 0, changed: 0, metadata: 0, extra: 0 };
      for (const entry of diff.entries) total[entry.kind] += 1;
      return total;
    })();
  const copyableFiles = diff.entries.filter(
    (entry) => (entry.kind === "new" || entry.kind === "changed") && !entry.dir,
  ).length;
  return {
    counts,
    parts: DIFFERENCE_KIND_ORDER.filter((kind) => counts[kind] > 0).map((kind) => ({
      kind,
      count: counts[kind],
      label: DIFFERENCE_LABEL[kind],
    })),
    copyableFiles,
    hasDifferences: Object.values(counts).some((count) => count > 0),
  };
}

export interface CheckOutcomePresentation {
  readonly summary: string;
  readonly level: "success" | "warning" | "failure" | "cancelled";
}

/** A batch result says failures before it says what happened to the rest. */
export function presentCheckOutcome(input: {
  readonly mode: "quick" | "deep";
  readonly scope: "selected" | "all";
  readonly selectedUnit?: string;
  readonly selectedFolders: number;
  readonly total: number;
  readonly ran: number;
  readonly failed: readonly {
    readonly unit: string;
    readonly target: string;
    readonly message: string;
  }[];
  readonly skipped: readonly {
    readonly target: string;
    readonly why: Exclude<Reachability, "ok">;
  }[];
}): CheckOutcomePresentation {
  if (input.failed.length > 0) {
    const failures = input.failed.map(
      (failure) => `${failure.unit} → ${failure.target}: failed — ${failure.message}`,
    );
    return { summary: `${input.mode} check failed · ${failures.join(", ")}`, level: "failure" };
  }
  if (input.ran === 0 && input.skipped.length > 0) {
    return {
      summary: `nothing checked — ${input.skipped.map((skip) => `${skip.target} ${presentReachability(skip.why).phrase}`).join(", ")}`,
      level: "warning",
    };
  }
  if (input.skipped.length > 0) {
    return {
      summary:
        `${input.mode} check finished · ${input.ran} of ${input.total} · skipped ` +
        input.skipped
          .map((skip) => `${skip.target} (${presentReachability(skip.why).phrase})`)
          .join(", "),
      level: "warning",
    };
  }
  return {
    summary:
      input.scope === "all"
        ? `${input.mode} check finished · ${input.selectedFolders} folders`
        : `${input.mode} check finished · ${input.selectedUnit ?? ""}`,
    level: "success",
  };
}
