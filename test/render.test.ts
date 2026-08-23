import { describe, expect, test } from "bun:test";
import { parseConfig, type Config } from "../src/config.ts";
import { renderLedger, type LedgerRow } from "../src/render.ts";
import type { Scan, State } from "../src/state.ts";
import type { UnitStatus } from "../src/status.ts";

/**
 * `renderLedger` is the non-interactive ledger printer — the path `syncy
 * status` uses, and the only one that works over ssh. It carries its own copy
 * of the detail-line logic (`detailLines`/`describe` in src/render.ts), which
 * previously had two of the same bugs the interactive Ledger already had
 * fixed: it looked up scans without a target's identity, and it never passed
 * the known-extras count into the evidence line.
 */

const config: Config = parseConfig(`
source = "/src"
[[target]]
name = "ext"
path = "/ext"
sentinel = "s1"
`);

const NOW = Date.parse("2026-08-20T12:00:00Z");

const cell = (
  target: string,
  state: UnitStatus["cells"][number]["state"],
  nChanges = 0,
): UnitStatus["cells"][number] => ({
  target,
  state,
  reason: "r",
  nChanges,
  bytesPending: 0,
  nExtra: 0,
});

const scan = (over: Partial<Scan>): Scan => ({
  unit: "maui",
  target: "ext",
  ts: 1000,
  method: "quick",
  outcome: "clean",
  nChanges: 0,
  nExtra: 0,
  bytesPending: 0,
  fingerprint: { nfiles: 801, bytes: 10e9, maxMtimeNs: "1" },
  sentinel: "s1",
  ...over,
});

describe("the printed ledger carries a known extra through a later deep check", () => {
  /**
   * REPRODUCED: a quick check finds 5 extras; a later deep check reports the
   * unit behind (deep verifies carry no --delete, so it always reports
   * nExtra: 0). Before this fix the printed evidence line lost "5 extra at
   * destination" entirely, because `describe` never received the count
   * `knownExtras` exists to supply.
   */
  test('the evidence line still names "5 extra at destination"', () => {
    const state: State = {
      version: 1,
      scans: [
        scan({ method: "quick", ts: 1000, nExtra: 5 }),
        scan({ method: "deep", ts: 2000, nExtra: 0, outcome: "behind", nChanges: 3 }),
      ],
    };
    const rows: LedgerRow[] = [
      {
        status: {
          unit: "maui",
          state: "behind",
          reason: "ext 3 files pending",
          cells: [cell("ext", "behind", 3)],
        },
        size: 10e9,
      },
    ];
    const text = renderLedger({ rows, selected: 0, config, state, now: NOW });
    expect(text).toContain("5 extra at destination");
  });
});

describe("the printed ledger filters evidence to the target's current identity", () => {
  // The same class of bug fixed for evaluateUnit: a scan recorded against a
  // different volume must not be shown as this target's evidence.
  const identityConfig: Config = parseConfig(`
source = "/src"
[[target]]
name = "ext"
path = "/ext"
identity = "VOLUME-B-UUID"
`);

  test("a scan recorded under a different identity is not shown as deep verified", () => {
    const state: State = {
      version: 1,
      scans: [scan({ method: "deep", ts: 2000, sentinel: "VOLUME-A-UUID" })],
    };
    const rows: LedgerRow[] = [
      {
        status: { unit: "maui", state: "unchecked", reason: "r", cells: [cell("ext", "unchecked")] },
        size: 10e9,
      },
    ];
    const text = renderLedger({ rows, selected: 0, config: identityConfig, state, now: NOW });
    expect(text).not.toContain("deep verified");
    expect(text).toContain("never checked");
  });
});
