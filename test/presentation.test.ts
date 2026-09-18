import { describe, expect, test } from "bun:test";
import type { Diff } from "../src/diff.ts";
import { behindSummary, presentCheckOutcome, presentDiffSummary } from "../src/presentation.ts";

describe("shared presentation contract", () => {
  test("a failed check cannot be overwritten by a finished summary", () => {
    const result = presentCheckOutcome({
      mode: "deep",
      scope: "all",
      selectedFolders: 2,
      total: 2,
      ran: 1,
      failed: [{ unit: "photos", target: "Archive", message: "rsync exited with code 12" }],
      skipped: [],
    });

    expect(result.level).toBe("failure");
    expect(result.summary).toContain("deep check failed");
    expect(result.summary).not.toContain("finished");
  });

  test("a batch with both a failure and a skip reports the failure, not the skip", () => {
    // Old TUI behaviour reported skips first; a failed job is the more
    // actionable fact, so it must win even when a destination was also
    // skipped in the same batch.
    const result = presentCheckOutcome({
      mode: "quick",
      scope: "all",
      selectedFolders: 2,
      total: 2,
      ran: 1,
      failed: [{ unit: "photos", target: "Archive", message: "rsync exited with code 12" }],
      skipped: [{ target: "Studio NAS", why: "mismatch" }],
    });

    expect(result.level).toBe("failure");
    expect(result.summary).toBe(
      "quick check failed · photos → Archive: failed — rsync exited with code 12",
    );
    expect(result.summary).not.toContain("nothing checked");
    expect(result.summary).not.toContain("skipped");
  });

  test("a fully skipped run says that nothing was checked", () => {
    const result = presentCheckOutcome({
      mode: "quick",
      scope: "all",
      selectedFolders: 1,
      total: 1,
      ran: 0,
      failed: [],
      skipped: [{ target: "Studio NAS", why: "mismatch" }],
    });

    expect(result.summary).toBe("nothing checked — Studio NAS different volume");
  });

  test("legacy directory-inclusive totals remain changes", () => {
    expect(behindSummary(12, undefined, undefined)).toBe("12 changes pending");
  });

  test("a measured file-only total is allowed to say files", () => {
    expect(behindSummary(14, 14, 12)).toBe("12 files not copied yet");
  });

  test("an absent difference record is distinct from a recorded clean check", () => {
    expect(presentDiffSummary(null)).toMatchObject({
      state: "no-record",
      title: "No check recorded",
      detail: "No recorded check for this destination. Run a check to record differences.",
      hasDifferences: false,
    });

    const clean: Diff = {
      version: 1,
      unit: "photos",
      target: "Archive",
      ts: 1,
      method: "quick",
      entries: [],
      truncated: 0,
      wholeFolderMissing: false,
    };
    expect(presentDiffSummary(clean)).toMatchObject({
      state: "clean",
      title: "No differences",
      detail: "The recorded check found no differences.",
      hasDifferences: false,
    });
  });

  test("a missing whole folder never renders as a clean difference result", () => {
    const missing: Diff = {
      version: 1,
      unit: "photos",
      target: "Archive",
      ts: 1,
      method: "quick",
      entries: [],
      truncated: 0,
      wholeFolderMissing: true,
    };

    expect(presentDiffSummary(missing)).toMatchObject({
      state: "whole-folder-missing",
      title: "Whole folder missing",
      hasDifferences: false,
    });
  });
});
