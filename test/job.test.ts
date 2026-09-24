import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { recordScan, runCheckQueue } from "../src/check-runner.ts";
import type { Config } from "../src/config.ts";
import type { Fingerprint } from "../src/fingerprint.ts";
import { TargetCheckError } from "../src/scan.ts";
import { EMPTY_STATE, findScan, loadState, type Scan, type State } from "../src/state.ts";
import { makeFixtureDir, removeFixtureDir } from "./helpers.ts";

const FP: Fingerprint = {
  nfiles: 2,
  bytes: 8,
  maxMtimeNs: "1",
  digest: "source-digest",
  complete: true,
};

const target = {
  name: "archive",
  path: "/destination/archive",
  required: true,
  sentinel: "archive-id",
  fstype: "apfs",
  modifyWindow: 0,
  flagsDrop: [],
} as const;

const config: Config = {
  source: "/source",
  maxVerifyAgeDays: 30,
  maxQuickAgeDays: 7,
  minTargets: 1,
  exclude: [],
  targets: [target],
};

describe("queued checks revalidate destinations", () => {
  test("reports a destination lost at the fresh rsync boundary as skipped", async () => {
    const history: unknown[] = [];
    const events: string[] = [];
    const result = await runCheckQueue(
      config,
      EMPTY_STATE,
      "quick",
      [{ unit: "photos", bytes: 8, files: 2 }],
      {
        dependencies: {
          reachability: async () => new Map([[target.name, "ok"]]),
          check: async () => {
            throw new TargetCheckError(target, "unreachable");
          },
          loadState: () => EMPTY_STATE,
          saveState: () => {
            throw new Error("a skipped check must record no state");
          },
          saveDiff: () => {
            throw new Error("a skipped check must record no diff");
          },
          appendHistory: (entry) => history.push(entry),
        },
        onEvent: (event) => events.push(event.type),
        now: () => 1000,
      },
    );

    expect(result.ran).toBe(0);
    expect(result.skipped).toEqual([{ target: "archive", why: "unreachable" }]);
    expect(events).toEqual(["job.started", "job.skipped"]);
    expect(history).toEqual([
      expect.objectContaining({ target: "archive", outcome: "skipped", exitCode: null }),
    ]);
  });
});

describe("recordScan merges onto the state file as it is now", () => {
  /**
   * The bug this guards: the ledger held state.json in a useState initializer,
   * and a check run accumulated onto that copy, writing the whole thing back
   * after every job. An overnight deep `behind` recorded on disk was silently
   * replaced by the morning's quick `clean` applied to the stale copy, and
   * the row read `verified`. Losing evidence would be conservative;
   * resurrecting superseded evidence is not.
   *
   * So the merge base is the file as it is at record time — what `read()`
   * returns — never a copy the caller still holds.
   */

  let dir: string;
  let prevStateHome: string | undefined;

  beforeEach(() => {
    dir = makeFixtureDir("syncy-recordscan");
    prevStateHome = process.env["XDG_STATE_HOME"];
    process.env["XDG_STATE_HOME"] = dir;
  });

  afterEach(() => {
    if (prevStateHome === undefined) delete process.env["XDG_STATE_HOME"];
    else process.env["XDG_STATE_HOME"] = prevStateHome;
    removeFixtureDir(dir);
  });

  const scan = (over: Partial<Scan> = {}): Scan => ({
    unit: "photos/2019",
    target: "nas",
    ts: 1000,
    method: "deep",
    outcome: "clean",
    nChanges: 0,
    nExtra: 0,
    bytesPending: 0,
    fingerprint: FP,
    sentinel: "s",
    ...over,
  });

  test("a quick recorded after a deep keeps the deep, in the return and on disk", () => {
    // The overnight deep verify found the unit behind, and is recorded on
    // disk. The morning's quick check is recorded for the same pair.
    recordScan(scan({ method: "deep", outcome: "behind", nChanges: 4, nNew: 3, bytesPending: 48 }));
    const merged = recordScan(scan({ method: "quick", outcome: "clean", ts: 2000 }));

    // The returned State is the merged one: the deep record is still in it.
    expect(merged.scans).toHaveLength(2);
    expect(findScan(merged, "photos/2019", "nas", "deep", "s")?.outcome).toBe("behind");
    expect(findScan(merged, "photos/2019", "nas", "quick", "s")?.outcome).toBe("clean");

    // And it actually wrote: the deep record survives in state.json, not
    // only in the returned object.
    const onDisk = loadState();
    expect(onDisk).toEqual(merged);
    expect(findScan(onDisk, "photos/2019", "nas", "deep", "s")?.outcome).toBe("behind");
  });

  test("the merge base is exactly what read() returns, not an earlier view", () => {
    // Another writer recorded a scan since this one last saw the file.
    // Merging onto the earlier view would drop it on the way back.
    const foreign = scan({ unit: "other/2020", method: "deep", outcome: "behind", ts: 1500 });
    const read = (): State => ({ version: 1, scans: [foreign] });
    const merged = recordScan(scan({ method: "quick", outcome: "clean", ts: 2000 }), read);

    expect(findScan(merged, "other/2020", "nas", "deep", "s")?.outcome).toBe("behind");
    expect(findScan(merged, "photos/2019", "nas", "quick", "s")?.outcome).toBe("clean");
    // The foreign record is not just merged: it is written back with the new
    // scan, so the write cannot resurrect an earlier view of the file.
    expect(findScan(loadState(), "other/2020", "nas", "deep", "s")?.outcome).toBe("behind");
  });
});
