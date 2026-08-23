import { describe, expect, test } from "bun:test";
import type { Config, Target } from "../src/config.ts";
import type { Fingerprint } from "../src/fingerprint.ts";
import type { Scan, State } from "../src/state.ts";
import { behindReason, cellState, evaluateUnit, rollUp, type Cell, knownExtras, evidencePhrase } from "../src/status.ts";

const NOW = Date.parse("2026-08-20T12:00:00Z");
const DAY = 86_400_000;
const daysAgo = (n: number): number => NOW - n * DAY;

const FP: Fingerprint = { nfiles: 100, bytes: 1000, maxMtimeNs: "111" };
const FP_CHANGED: Fingerprint = { nfiles: 101, bytes: 1100, maxMtimeNs: "222" };

const target = (name: string, required = true): Target => ({
  name,
  path: `/Volumes/${name}`,
  required,
  sentinel: `sent-${name}`,
  fstype: "apfs",
  modifyWindow: 0,
  flagsDrop: [],
});

const scan = (over: Partial<Scan> = {}): Scan => ({
  unit: "photos/2019",
  target: "nas",
  ts: daysAgo(1),
  method: "deep",
  outcome: "clean",
  nChanges: 0,
  nExtra: 0,
  bytesPending: 0,
  fingerprint: FP,
  sentinel: "sent-nas",
  ...over,
});

const cell = (over: Partial<Parameters<typeof cellState>[0]> = {}): Cell =>
  cellState({
    target: target("nas"),
    sentinel: "ok",
    fingerprintNow: FP,
    deep: scan(),
    quick: scan({ method: "quick" }),
    latest: scan({ method: "quick" }),
    now: NOW,
    maxVerifyAgeDays: 30,
    maxQuickAgeDays: 7,
    ...over,
  });

describe("cell state ladder", () => {
  test("verified when both clocks are fresh and the source is unchanged", () => {
    expect(cell().state).toBe("verified");
  });

  test("unchecked when the target cannot be seen, however recent the verify", () => {
    // Rule 5 is strict by explicit decision: an unreachable target cannot
    // support a verified status.
    const c = cell({ sentinel: "unreachable" });
    expect(c.state).toBe("unchecked");
    expect(c.reason).toBe("not connected");
  });

  test("unchecked when a different volume is mounted at the path", () => {
    expect(cell({ sentinel: "mismatch" }).state).toBe("unchecked");
  });

  test("unchecked when the sentinel file is absent", () => {
    // The disaster case: an unmounted /Volumes/x is still a writable directory
    // on the boot disk.
    expect(cell({ sentinel: "missing" }).state).toBe("unchecked");
  });

  test("unchecked when nothing has ever been scanned", () => {
    const c = cell({ deep: undefined, quick: undefined, latest: undefined });
    expect(c.state).toBe("unchecked");
    expect(c.reason).toBe("never checked");
  });

  test("missing when the unit was never copied", () => {
    const s = scan({ outcome: "missing", method: "quick" });
    expect(cell({ latest: s, quick: s, deep: undefined }).state).toBe("missing");
  });

  test("behind reports the pending count and bytes", () => {
    const s = scan({ outcome: "behind", method: "quick", nChanges: 143, bytesPending: 8_400_000_000 });
    const c = cell({ latest: s, quick: s });
    expect(c.state).toBe("behind");
    expect(c.nChanges).toBe(143);
    expect(c.bytesPending).toBe(8_400_000_000);
    expect(c.reason).toBe("143 files pending");
  });

  test("error surfaces rather than being swallowed as unknown", () => {
    const s = scan({ outcome: "error", method: "quick" });
    expect(cell({ latest: s, quick: s }).state).toBe("error");
  });
});

describe("the two clocks", () => {
  test("quick-only is unverified however recent", () => {
    const q = scan({ method: "quick", ts: NOW });
    const c = cell({ deep: undefined, quick: q, latest: q });
    expect(c.state).toBe("unverified");
    // States what the quick check proved, not what it skipped.
    expect(c.reason).toBe("size and date match, bytes unread");
  });

  test("a fresh deep verify satisfies the cheap clock by itself", () => {
    // A deep verify is strictly stronger than a quick check; it must not need a
    // separate quick check to keep the short clock happy.
    const d = scan({ method: "deep", ts: daysAgo(2) });
    expect(cell({ deep: d, quick: undefined, latest: d }).state).toBe("verified");
  });

  test("an expired deep verify falls back to unverified", () => {
    const d = scan({ method: "deep", ts: daysAgo(40) });
    const q = scan({ method: "quick", ts: daysAgo(1) });
    const c = cell({ deep: d, quick: q, latest: q });
    expect(c.state).toBe("unverified");
    expect(c.reason).toContain("deep verify expired");
  });

  test("a stale cheap clock demotes even a fresh deep verify", () => {
    const d = scan({ method: "deep", ts: daysAgo(20) });
    const c = cell({ deep: d, quick: undefined, latest: d });
    expect(c.state).toBe("unverified");
    expect(c.reason).toContain("last checked 20d ago");
  });

  test("a quick check after a deep verify keeps the unit verified", () => {
    const d = scan({ method: "deep", ts: daysAgo(20) });
    const q = scan({ method: "quick", ts: daysAgo(1) });
    expect(cell({ deep: d, quick: q, latest: q }).state).toBe("verified");
  });

  test("a quick check finding drift overrides an older clean deep verify", () => {
    const d = scan({ method: "deep", ts: daysAgo(5) });
    const q = scan({ method: "quick", ts: daysAgo(1), outcome: "behind", nChanges: 3 });
    expect(cell({ deep: d, quick: q, latest: q }).state).toBe("behind");
  });
});

describe("source changes invalidate at any age", () => {
  test("a source edited since the last check is unverified", () => {
    const c = cell({ fingerprintNow: FP_CHANGED });
    expect(c.state).toBe("unverified");
    expect(c.reason).toBe("source changed since last check");
  });

  test("a source edited since the deep verify is unverified even if quick is clean", () => {
    const d = scan({ method: "deep", ts: daysAgo(3), fingerprint: FP });
    const q = scan({ method: "quick", ts: daysAgo(1), fingerprint: FP_CHANGED });
    const c = cell({ deep: d, quick: q, latest: q, fingerprintNow: FP_CHANGED });
    expect(c.state).toBe("unverified");
    expect(c.reason).toBe("source changed since deep verify");
  });
});

describe("cellState: staleRecords marks evidence made against a different volume", () => {
  test("staleRecords overrides an otherwise-clean latest scan", () => {
    // evaluateUnit sets staleRecords when it filtered out every scan for this
    // unit+target because none matched the current identity; cellState must
    // not fall through to reading `latest` as if it were fresh evidence.
    const c = cell({ staleRecords: true, latest: undefined, deep: undefined, quick: undefined });
    expect(c.state).toBe("unchecked");
    expect(c.reason).toBe("the records here were made against a different volume");
  });

  test("staleRecords is distinct from never having been checked at all", () => {
    const neverChecked = cell({ deep: undefined, quick: undefined, latest: undefined });
    expect(neverChecked.reason).toBe("never checked");
    const stale = cell({ staleRecords: true, deep: undefined, quick: undefined, latest: undefined });
    expect(stale.reason).not.toBe("never checked");
  });
});

describe("evaluateUnit refuses a record made against a different volume", () => {
  /**
   * The bug: `scan.sentinel` records the identity of the volume a check
   * actually ran against, but nothing ever read it back — scans were matched
   * to targets by name alone. Remove a destination and add a different one
   * under the same name, and the old volume's clean deep verify was presented
   * as evidence for the new one: `evaluateUnit` returned `verified` for a
   * volume it had never checked.
   */
  const identityTarget = (name: string, identity: string): Target => ({
    name,
    path: `/Volumes/${name}`,
    required: true,
    identity,
    fstype: "apfs",
    modifyWindow: 0,
    flagsDrop: [],
  });

  const config: Config = {
    source: "/src",
    maxVerifyAgeDays: 30,
    maxQuickAgeDays: 7,
    minTargets: 1,
    exclude: [],
    targets: [identityTarget("ext", "VOLUME-B-UUID")],
  };

  test("a clean deep scan recorded against the old volume is not evidence for the new one", () => {
    const state: State = {
      version: 1,
      scans: [scan({ unit: "u", target: "ext", method: "deep", sentinel: "VOLUME-A-UUID" })],
    };
    const s = evaluateUnit(
      config,
      state,
      { unit: "u", fingerprint: FP, sentinels: new Map([["ext", "ok"]]) },
      NOW,
    );
    expect(s.state).toBe("unchecked");
    expect(s.reason).toContain("different volume");
  });

  test("the happy path still verifies when the identity matches", () => {
    const state: State = {
      version: 1,
      scans: [scan({ unit: "u", target: "ext", method: "deep", sentinel: "VOLUME-B-UUID" })],
    };
    const s = evaluateUnit(
      config,
      state,
      { unit: "u", fingerprint: FP, sentinels: new Map([["ext", "ok"]]) },
      NOW,
    );
    expect(s.state).toBe("verified");
  });

  test("a target proven by sentinel file rather than identity still works", () => {
    const sentinelConfig: Config = { ...config, targets: [target("nas")] };
    const state: State = {
      version: 1,
      scans: [scan({ unit: "u", target: "nas", method: "deep", sentinel: "sent-nas" })],
    };
    const s = evaluateUnit(
      sentinelConfig,
      state,
      { unit: "u", fingerprint: FP, sentinels: new Map([["nas", "ok"]]) },
      NOW,
    );
    expect(s.state).toBe("verified");
  });
});

describe("unit roll-up precedence", () => {
  const mk = (targetName: string, state: Cell["state"]): Cell => ({
    target: targetName,
    state,
    reason: "r",
    nChanges: 0,
    bytesPending: 0,
    nExtra: 0,
  });
  const required = new Set(["ext", "nas"]);

  test("all verified rolls up to verified", () => {
    expect(rollUp("u", [mk("ext", "verified"), mk("nas", "verified")], required).state).toBe("verified");
  });

  test("a known failure outranks an unchecked target", () => {
    // "We checked and it is not replicated" is more informative than
    // "we could not check".
    const s = rollUp("u", [mk("ext", "unchecked"), mk("nas", "missing")], required);
    expect(s.state).toBe("missing");
  });

  test("an unchecked target outranks verified", () => {
    const s = rollUp("u", [mk("ext", "unchecked"), mk("nas", "verified")], required);
    expect(s.state).toBe("unchecked");
  });

  test("behind outranks unverified", () => {
    expect(rollUp("u", [mk("ext", "unverified"), mk("nas", "behind")], required).state).toBe("behind");
  });

  test("optional targets never hold a unit back", () => {
    const s = rollUp("u", [mk("ext", "verified"), mk("nas", "verified"), mk("spare", "missing")], required);
    expect(s.state).toBe("verified");
  });

  test("the roll-up names which target caused it", () => {
    const s = rollUp("u", [mk("ext", "verified"), mk("nas", "behind")], required);
    expect(s.reason).toContain("nas");
  });
});

describe("evaluateUnit", () => {
  const config: Config = {
    source: "/src",
    maxVerifyAgeDays: 30,
    maxQuickAgeDays: 7,
    minTargets: 2,
    exclude: [],
    targets: [target("ext"), target("nas")],
  };

  const stateWith = (scans: Scan[]): State => ({ version: 1, scans });

  test("two verified targets clear the unit", () => {
    const state = stateWith([
      scan({ unit: "u", target: "ext", method: "deep", ts: daysAgo(2), sentinel: "sent-ext" }),
      scan({ unit: "u", target: "nas", method: "deep", ts: daysAgo(2), sentinel: "sent-nas" }),
    ]);
    const s = evaluateUnit(
      config,
      state,
      { unit: "u", fingerprint: FP, sentinels: new Map([["ext", "ok"], ["nas", "ok"]]) },
      NOW,
    );
    expect(s.state).toBe("verified");
  });

  test("one detached drive makes the unit unknown, not verified", () => {
    const state = stateWith([
      scan({ unit: "u", target: "ext", method: "deep", ts: daysAgo(2) }),
      scan({ unit: "u", target: "nas", method: "deep", ts: daysAgo(2) }),
    ]);
    const s = evaluateUnit(
      config,
      state,
      { unit: "u", fingerprint: FP, sentinels: new Map([["ext", "unreachable"], ["nas", "ok"]]) },
      NOW,
    );
    expect(s.state).toBe("unchecked");
    expect(s.reason).toContain("ext");
  });

  test("min_targets is enforced independently of how many are configured", () => {
    const oneRequired: Config = { ...config, targets: [target("ext"), target("nas", false)] };
    const state = stateWith([
      scan({ unit: "u", target: "ext", method: "deep", ts: daysAgo(2), sentinel: "sent-ext" }),
      scan({ unit: "u", target: "nas", method: "deep", ts: daysAgo(2), sentinel: "sent-nas" }),
    ]);
    const s = evaluateUnit(
      oneRequired,
      state,
      { unit: "u", fingerprint: FP, sentinels: new Map([["ext", "ok"], ["nas", "ok"]]) },
      NOW,
    );
    expect(s.state).toBe("unverified");
    expect(s.reason).toContain("only 1 of 2");
  });
});

describe("a config with no targets can never report verified", () => {
  // Zero targets is a legitimate state during setup. The danger would be an
  // empty roll-up reading as "all targets verified", which is why min_targets
  // is floored at 1 and enforced here.
  const empty: Config = {
    source: "/src",
    maxVerifyAgeDays: 30,
    maxQuickAgeDays: 7,
    minTargets: 1,
    exclude: [],
    targets: [],
  };

  test("an un-targeted unit is not verified", () => {
    const s = evaluateUnit(
      empty,
      { version: 1, scans: [] },
      { unit: "u", fingerprint: FP, sentinels: new Map() },
      NOW,
    );
    expect(s.state).not.toBe("verified");
    expect(s.reason).toContain("0 of 1");
  });
});

describe("behind says what the files actually are", () => {
  const scan = (over: Partial<Scan>): Scan => ({
    unit: "u", target: "t", ts: 0, method: "deep", outcome: "behind",
    nChanges: 504, nExtra: 0, bytesPending: 0,
    fingerprint: { nfiles: 1, bytes: 1, maxMtimeNs: "1" }, sentinel: "s", ...over,
  });

  test("files absent from the destination are not called content differences", () => {
    // The bug: a deep check reporting 504 changes was described as "504 files
    // differ by content" purely because the method was deep, while the
    // evidence screen — from the same rsync run — said "not at destination".
    expect(behindReason(scan({ nNew: 504 }))).toBe("504 files not copied yet");
  });

  test("genuine content differences are named as such", () => {
    expect(behindReason(scan({ nChanges: 12, nNew: 0 }))).toBe("12 files differ by content");
  });

  test("a mix is broken down rather than flattened", () => {
    expect(behindReason(scan({ nChanges: 504, nNew: 492 }))).toBe(
      "492 not copied, 12 differ by content",
    );
  });

  test("a record written before the breakdown existed falls back, not invents", () => {
    expect(behindReason(scan({}))).toBe("504 files pending");
  });
});

describe("a deep verify must not erase a known extra", () => {
  /**
   * `--delete` appears only in the quick check, so a deep verify always reports
   * `nExtra: 0` — not because the extras are gone, but because it never looked.
   * Reading the count from whichever scan is newest therefore made running a
   * deep check delete the knowledge that a destination held an extra file.
   */
  const fp = { nfiles: 801, bytes: 10e9, maxMtimeNs: "1" };
  const scan = (over: Partial<Scan>): Scan => ({
    unit: "maui", target: "external", ts: 1000, method: "quick", outcome: "clean",
    nChanges: 0, nExtra: 0, bytesPending: 0, fingerprint: fp, sentinel: "s", ...over,
  });

  test("the quick check's count survives a later deep verify", () => {
    const state: State = {
      version: 1,
      scans: [
        scan({ method: "quick", ts: 1000, nExtra: 1 }),
        scan({ method: "deep", ts: 2000, nExtra: 0 }),
      ],
    };
    expect(knownExtras(state, "maui", "external")?.count).toBe(1);
  });

  test("no quick check means nothing is claimed either way", () => {
    const state: State = { version: 1, scans: [scan({ method: "deep", ts: 2000 })] };
    expect(knownExtras(state, "maui", "external")).toBeNull();
  });

  test("a quick check that found none reports none", () => {
    const state: State = { version: 1, scans: [scan({ method: "quick", nExtra: 0 })] };
    expect(knownExtras(state, "maui", "external")).toBeNull();
  });

  test("the evidence line names them, and calls them a destination", () => {
    const last = scan({ method: "deep", ts: 2000, nExtra: 0 });
    const line = evidencePhrase(last, last, 3000, {
      stamp: () => "22 aug", ageAgo: () => "today",
    }, 1);
    expect(line).toContain("1 extra at destination");
  });

  test("extras still never block verified", () => {
    // They cannot endanger source data, so they are reported and not counted
    // against the verdict (DESIGN.md section 3).
    const line = evidencePhrase(scan({ method: "deep" }), scan({ method: "deep" }), 3000, {
      stamp: () => "22 aug", ageAgo: () => "today",
    }, 4);
    expect(line).toContain("deep verified");
  });
});
