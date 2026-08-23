import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { barFraction, clock, detailLine, Progress, progressLines, type RunProgress } from "../src/tui/Progress.tsx";
import { THEMES } from "../src/tui/theme.ts";
import { displayWidth } from "../src/width.ts";

/**
 * What the running-check line is allowed to claim.
 *
 * The display said `0/935 files · 0%` for twelve minutes while rsync was
 * working at 11 MB/s — a frozen counter reads as a hung machine, which is worse
 * than showing nothing. These tests hold the line to claiming only what has
 * been measured, and to never freezing.
 */

const NOW = 1_000_000;
const base: RunProgress = {
  unit: "holiday-2024",
  target: "NAS",
  mode: "deep",
  done: 0,
  total: 1,
  bytesDone: 0,
  bytesTotal: 13_000_000_000,
  startedAt: NOW,
  jobStartedAt: NOW,
  filesTotal: 935,
  unitBytes: 13_000_000_000,
};
const plain = (s: string | undefined): string => (s ?? "").replace(/\[[0-9;]*m/g, "");
const at = (p: RunProgress, ms: number): string => detailLine(p, NOW + ms);

describe("the detail claims a file count only when rsync gives one", () => {
  test("a count that is actually arriving is shown", () => {
    expect(at({ ...base, filesSeen: 312 }, 60_000)).toContain("312/935 files");
  });

  test("a silent check never shows 0/935 — the bug this replaces", () => {
    // rsync reports nothing for a deep check on large files until it finishes,
    // so this number would sit at zero for the entire run.
    const out = at(base, 164_000);
    expect(out).not.toContain("0/935");
    expect(out).not.toContain("0 files");
  });

  test("a silent deep check says what it is doing instead", () => {
    const out = at(base, 164_000);
    // bytes() is binary, so 13e9 renders as 12 gb.
    expect(out).toContain("12 gb");
    expect(out).toContain("2m 44s");
  });

  test("with no timing sample it says why there is no estimate", () => {
    // "reports at the end" described rsync's behaviour. What the reader can act
    // on is that syncy is measuring this run and will have a bar next time.
    expect(at(base, 164_000)).toContain("no estimate yet");
  });

  test("with a prior run it gives that as the expectation", () => {
    const out = at({ ...base, priorMs: 720_000 }, 164_000);
    expect(out).toContain("12m");
    expect(out).not.toContain("reports at the end");
  });

  test("a check that has only just started just shows the clock", () => {
    // Explaining itself in the first seconds would be noise on a quick check,
    // which finishes in about that long.
    expect(at(base, 1500)).toBe("1s");
  });

  test("the elapsed clock always advances, whatever else is unknown", () => {
    const seen = [0, 5_000, 60_000, 700_000].map((ms) => at(base, ms));
    expect(new Set(seen).size).toBe(seen.length);
  });
});

describe("the bar is measured against something real", () => {
  test("a single folder does not sit at 0% for the whole run", () => {
    // The byte fraction only moves when a folder completes, so with one folder
    // it is 0% until it is 100% — a light that turns on at the end.
    const f = barFraction({ ...base, priorMs: 720_000 }, NOW + 360_000);
    expect(f.fraction).toBeGreaterThan(0.4);
    expect(f.fraction).toBeLessThan(0.6);
  });

  test("an estimate is marked as one", () => {
    expect(barFraction({ ...base, priorMs: 720_000 }, NOW + 1000).estimated).toBe(true);
    expect(barFraction(base, NOW + 1000).estimated).toBe(false);
  });

  test("it never reaches 100% while the check is still running", () => {
    // Overrunning the estimate must not claim the work is done.
    const f = barFraction({ ...base, priorMs: 60_000 }, NOW + 600_000);
    expect(f.fraction).toBeLessThan(1);
  });

  test("without a prior run it falls back to bytes across folders", () => {
    const f = barFraction({ ...base, done: 1, total: 4, bytesDone: 6_500_000_000 }, NOW + 1000);
    expect(f.estimated).toBe(false);
    expect(f.fraction).toBeCloseTo(0.5, 1);
  });
});

describe("the bar reflects the whole run, not one folder repeated", () => {
  /**
   * REPRODUCED on a real run: five folders, each ~60s and each estimated at
   * 60s. `barFraction` measured `now - startedAt` — elapsed time for the
   * *whole run* — against `priorMs`, an estimate for one job. Measured
   * fractions before the fix: 10s into folder 1, 17%; 50s into folder 1,
   * 83%; 10s into folder 2, 99%; 10s into folder 4, still 99%. Once the run
   * had gone on longer than a single job's estimate, the bar pinned at the
   * 0.99 cap and stayed there for the rest of the run — a bar frozen near
   * full for most of an hour is the same complaint as one frozen at zero.
   */
  const unitSize = 12_000_000_000;
  const jobs = 5;
  const priorMs = 60_000;
  const runStart = NOW;

  // Job `i` (0-indexed) is estimated to run from runStart + i*priorMs to
  // runStart + (i+1)*priorMs, exactly matching the measured real run above.
  const progressFor = (i: number): RunProgress => ({
    ...base,
    done: i,
    total: jobs,
    bytesDone: i * unitSize,
    bytesTotal: jobs * unitSize,
    startedAt: runStart,
    jobStartedAt: runStart + i * priorMs,
    unitBytes: unitSize,
    priorMs,
  });
  const fractionAt = (jobIndex: number, intoJobMs: number): number =>
    barFraction(progressFor(jobIndex), runStart + jobIndex * priorMs + intoJobMs).fraction;

  test("the old formula's exact pathology does not reproduce", () => {
    // Before the fix, every one of these read 0.99 — the old formula only
    // ever looked at elapsed-since-run-start against a single job's estimate.
    expect(fractionAt(1, 10_000)).toBeLessThan(0.99);
    expect(fractionAt(3, 10_000)).toBeLessThan(0.99);
  });

  test("the bar keeps climbing deep into the run instead of pinning early", () => {
    const tenIntoFolder1 = fractionAt(0, 10_000);
    const tenIntoFolder2 = fractionAt(1, 10_000);
    const tenIntoFolder4 = fractionAt(3, 10_000);
    // Each later folder starts from more completed bytes than the last, so
    // the reading rises across the run rather than sitting still once
    // pinned.
    expect(tenIntoFolder2).toBeGreaterThan(tenIntoFolder1);
    expect(tenIntoFolder4).toBeGreaterThan(tenIntoFolder2);
  });

  test("ten seconds into folder 2 reflects one folder done, not the whole run's clock", () => {
    // One folder complete (1/5 = 20%) plus a sliver of the second
    // (10s of 60s ≈ 3.3% of one fifth) — nowhere near the 99% the old
    // now-minus-startedAt formula produced at this same instant.
    const f = fractionAt(1, 10_000);
    expect(f).toBeGreaterThan(0.2);
    expect(f).toBeLessThan(0.3);
  });

  test("ten seconds into folder 4 reflects three folders done", () => {
    // 3/5 = 60% plus a sliver of the fourth.
    const f = fractionAt(3, 10_000);
    expect(f).toBeGreaterThan(0.6);
    expect(f).toBeLessThan(0.7);
  });
});

describe("the rendered line", () => {
  const frame = (p: RunProgress, width: number, ms = 164_000): string[] => {
    const { lastFrame } = render(
      <Progress progress={p} now={NOW + ms} width={width} theme={THEMES.ansi} />,
    );
    return plain(lastFrame()).split("\n");
  };

  test("never wraps, at any width", () => {
    // A wrapped progress line sheared the ledger layout beneath it.
    for (const width of [76, 92, 120]) {
      for (const line of frame({ ...base, priorMs: 720_000 }, width)) {
        expect(displayWidth(line), `width ${width}: ${line}`).toBeLessThanOrEqual(width + 2);
      }
    }
  });

  test("names the folder, the destination and the mode", () => {
    const out = frame(base, 92).join("\n");
    expect(out).toContain("deep");
    expect(out).toContain("holiday-2024");
    expect(out).toContain("NAS");
  });

  test("the tilde marks an estimated bar", () => {
    expect(frame({ ...base, priorMs: 720_000 }, 92).join("\n")).toContain("~");
    expect(frame(base, 92).join("\n")).not.toContain("~");
  });
});

describe("the clock", () => {
  test("reads in minutes and seconds past a minute", () => {
    expect(clock(164_000)).toBe("2m 44s");
    expect(clock(9_000)).toBe("9s");
  });
  test("never goes negative on a clock skew", () => {
    expect(clock(-5000)).toBe("0s");
  });
});

describe("the bar is drawn only when it would mean something", () => {
  test("a lone folder with no timing sample gets no bar at all", () => {
    // It would read 0% for twelve minutes and then 100% — indistinguishable
    // from a hung program, which is what this line exists to rule out.
    expect(barFraction(base, NOW + 164_000).drawable).toBe(false);
  });

  test("a timing estimate makes it drawable", () => {
    expect(barFraction({ ...base, priorMs: 720_000 }, NOW + 1000).drawable).toBe(true);
  });

  test("several folders make it drawable without an estimate", () => {
    // Folders completing is real progress, even if none of them is timed.
    expect(barFraction({ ...base, total: 4 }, NOW + 1000).drawable).toBe(true);
  });

  test("the rendered line drops the bar rather than showing an empty one", () => {
    const { lastFrame } = render(
      <Progress progress={base} now={NOW + 164_000} width={92} theme={THEMES.ansi} />,
    );
    const out = plain(lastFrame());
    expect(out).not.toContain("0%");
    expect(out).not.toContain("────");
    expect(out).toContain("no estimate yet");
  });

  test("the ledger budgets exactly the lines Progress will use", () => {
    // The ledger hard-coded 2; the bar is now conditional, so an assumed
    // height would leave a blank row or, worse, overflow.
    expect(progressLines(base, NOW + 1000, false)).toBe(1);
    expect(progressLines(base, NOW + 1000, true)).toBe(2);
    expect(progressLines({ ...base, priorMs: 720_000 }, NOW + 1000, false)).toBe(2);
    expect(progressLines({ ...base, priorMs: 720_000 }, NOW + 1000, true)).toBe(3);
  });
});

describe("the detail line never contradicts the bar above it", () => {
  test("a folder-count bar is not captioned 'no estimate yet'", () => {
    // The bar was drawn from folders completing while the caption said there
    // was no estimate — two statements about the same run, disagreeing.
    const many = { ...base, total: 12, done: 4, bytesDone: 5e10, bytesTotal: 1.4e11 };
    expect(at(many, 900_000)).not.toContain("no estimate yet");
  });

  test("with no bar the caption explains the absence", () => {
    expect(at(base, 164_000)).toContain("no estimate yet");
  });

  test("with a timing sample the caption names the expected total", () => {
    expect(at({ ...base, priorMs: 720_000 }, 360_000)).toContain("of ~12m");
  });
});
