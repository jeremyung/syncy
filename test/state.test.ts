import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Fingerprint } from "../src/fingerprint.ts";
import {
  appendHistory,
  EMPTY_STATE,
  estimateMs,
  findScan,
  latestScan,
  loadState,
  MAX_HISTORY_BYTES,
  type Scan,
  type State,
  saveState,
  upsertScan,
} from "../src/state.ts";
import { makeFixtureDir, PROJECT_ROOT, removeFixtureDir } from "./helpers.ts";

const FP: Fingerprint = { nfiles: 1, bytes: 2, maxMtimeNs: "3" };

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

let dir: string;
beforeEach(() => {
  dir = makeFixtureDir("syncy-state");
});
afterEach(() => {
  removeFixtureDir(dir);
});

describe("persistence", () => {
  test("round-trips through the file", () => {
    const file = join(dir, "state.json");
    const state = upsertScan(EMPTY_STATE, scan());
    saveState(state, file);
    expect(loadState(file)).toEqual(state);
  });

  test("a missing file reads as empty rather than throwing", () => {
    expect(loadState(join(dir, "absent.json"))).toEqual(EMPTY_STATE);
  });

  test("leaves no temp files behind", () => {
    const file = join(dir, "state.json");
    saveState(upsertScan(EMPTY_STATE, scan()), file);
    saveState(upsertScan(EMPTY_STATE, scan({ ts: 2000 })), file);
    expect(readdirSync(dir)).toEqual(["state.json"]);
  });

  test("writes human-readable JSON, since the record is the product", () => {
    const file = join(dir, "state.json");
    saveState(upsertScan(EMPTY_STATE, scan()), file);
    const text = readFileSync(file, "utf8");
    expect(text).toContain("\n  ");
    expect(text.endsWith("\n")).toBe(true);
  });

  test("a corrupt file is refused loudly, never treated as empty", () => {
    // Silently starting from empty would mark every unit unchecked, which is
    // safe; but silently accepting half-parsed state would not be.
    const file = join(dir, "state.json");
    writeFileSync(file, "{not json");
    expect(() => loadState(file)).toThrow(/corrupt/);
  });

  test("an unknown version is refused", () => {
    const file = join(dir, "state.json");
    writeFileSync(file, JSON.stringify({ version: 2, scans: [] }));
    expect(() => loadState(file)).toThrow(/unsupported state version/);
  });
});

describe("a malformed scan is dropped, not trusted and not fatal", () => {
  /**
   * `loadState` used to hand back `obj["scans"] as Scan[]` unchecked — a scan
   * missing `fingerprint` type-checked at compile time and then threw inside
   * `estimateMs` mid-render, and a hand-edited record claiming
   * `{"method":"deep","outcome":"clean"}` was believed with no basis at all.
   * A corrupt record must cost a re-check, never a program that will not
   * start, so a bad entry is dropped rather than thrown.
   */
  test("a scan missing its fingerprint is dropped; a good sibling still loads", () => {
    const file = join(dir, "state.json");
    const good = scan({ unit: "photos/2019" });
    const { fingerprint: _drop, ...bad } = scan({ unit: "photos/2020" });
    writeFileSync(file, JSON.stringify({ version: 1, scans: [good, bad] }));
    const loaded = loadState(file);
    expect(loaded.scans).toHaveLength(1);
    expect(loaded.scans[0]?.unit).toBe("photos/2019");
  });

  test("the drop is reported through debug(), not silently discarded", async () => {
    const prevDebug = process.env["SYNCY_DEBUG"];
    const prevState = process.env["XDG_STATE_HOME"];
    const logDir = makeFixtureDir("syncy-state-log");
    process.env["SYNCY_DEBUG"] = "1";
    process.env["XDG_STATE_HOME"] = logDir;
    try {
      const { debugLogPath } = await import("../src/log.ts");
      const file = join(dir, "state.json");
      const { fingerprint: _drop, ...bad } = scan({ unit: "photos/2020" });
      writeFileSync(file, JSON.stringify({ version: 1, scans: [bad] }));
      loadState(file);
      const log = readFileSync(debugLogPath(), "utf8");
      expect(log).toContain("state.scan.dropped");
      expect(log).toContain("fingerprint");
    } finally {
      if (prevDebug === undefined) delete process.env["SYNCY_DEBUG"];
      else process.env["SYNCY_DEBUG"] = prevDebug;
      if (prevState === undefined) delete process.env["XDG_STATE_HOME"];
      else process.env["XDG_STATE_HOME"] = prevState;
      removeFixtureDir(logDir);
    }
  });

  test("malformed JSON still throws — only per-scan validation degrades", () => {
    const file = join(dir, "state.json");
    writeFileSync(file, "{not json");
    expect(() => loadState(file)).toThrow(/corrupt/);
  });

  test("a wrong version still throws — only per-scan validation degrades", () => {
    const file = join(dir, "state.json");
    writeFileSync(file, JSON.stringify({ version: 2, scans: [scan()] }));
    expect(() => loadState(file)).toThrow(/unsupported state version/);
  });
});

describe("scans are keyed by unit, target AND method", () => {
  test("a quick check does not evict the deep verify", () => {
    // The two-clock rule depends on both records coexisting.
    let s = upsertScan(EMPTY_STATE, scan({ method: "deep", ts: 1000 }));
    s = upsertScan(s, scan({ method: "quick", ts: 2000 }));
    expect(s.scans).toHaveLength(2);
    expect(findScan(s, "photos/2019", "nas", "deep", "s")!.ts).toBe(1000);
    expect(findScan(s, "photos/2019", "nas", "quick", "s")!.ts).toBe(2000);
  });

  test("re-running the same method replaces its record", () => {
    let s = upsertScan(EMPTY_STATE, scan({ method: "deep", ts: 1000 }));
    s = upsertScan(s, scan({ method: "deep", ts: 5000 }));
    expect(s.scans).toHaveLength(1);
    expect(findScan(s, "photos/2019", "nas", "deep", "s")!.ts).toBe(5000);
  });

  test("different targets are independent", () => {
    let s = upsertScan(EMPTY_STATE, scan({ target: "nas" }));
    s = upsertScan(s, scan({ target: "ext" }));
    expect(s.scans).toHaveLength(2);
  });

  test("latestScan picks the most recent of either method", () => {
    let s = upsertScan(EMPTY_STATE, scan({ method: "deep", ts: 1000 }));
    s = upsertScan(s, scan({ method: "quick", ts: 9000 }));
    expect(latestScan(s, "photos/2019", "nas", "s")!.method).toBe("quick");
  });

  test("latestScan ignores other units", () => {
    let s = upsertScan(EMPTY_STATE, scan({ unit: "a", ts: 9000 }));
    s = upsertScan(s, scan({ unit: "b", ts: 1000 }));
    expect(latestScan(s, "b", "nas", "s")!.ts).toBe(1000);
  });
});

describe("a scan is only evidence for the identity it was recorded against", () => {
  /**
   * `scan.sentinel` carries the identity of the volume the check actually ran
   * against, but nothing ever compared it back — scans were matched by
   * unit+target name alone. Remove a destination and add a different one
   * under the same name, and the old volume's clean verdicts kept reading as
   * evidence for the new one.
   */
  test("findScan ignores a scan recorded against a different identity", () => {
    const s = upsertScan(EMPTY_STATE, scan({ sentinel: "VOLUME-A-UUID" }));
    expect(findScan(s, "photos/2019", "nas", "deep", "VOLUME-B-UUID")).toBeUndefined();
    expect(findScan(s, "photos/2019", "nas", "deep", "VOLUME-A-UUID")).toBeDefined();
  });

  test("latestScan ignores a scan recorded against a different identity", () => {
    const s = upsertScan(EMPTY_STATE, scan({ sentinel: "VOLUME-A-UUID" }));
    expect(latestScan(s, "photos/2019", "nas", "VOLUME-B-UUID")).toBeUndefined();
    expect(latestScan(s, "photos/2019", "nas", "VOLUME-A-UUID")).toBeDefined();
  });

  test("an empty recorded identity never matches, even an empty requested one", () => {
    // Absence of provenance is not evidence — a record with nothing written
    // for its identity must not be treated as satisfying a lookup for "",
    // which is what a target with neither identity nor sentinel would resolve
    // to.
    const s = upsertScan(EMPTY_STATE, scan({ sentinel: "" }));
    expect(findScan(s, "photos/2019", "nas", "deep", "")).toBeUndefined();
  });

  // `identity` used to be optional here, so a caller that forgot to resolve
  // one silently got unfiltered matching — exactly the gap that let the
  // interactive Ledger keep showing a foreign volume's evidence after
  // evaluateUnit and the printed ledger were both fixed. It is a required
  // parameter now: a caller that omits it fails to compile, which is not
  // something this runtime suite can assert directly, but every call site
  // above and in status.ts/render.ts/Ledger.tsx passes one.
});

describe("history", () => {
  test("appends one JSON line per invocation", () => {
    const file = join(dir, "history.jsonl");
    appendHistory({ ts: 1, unit: "u", target: "nas", argv: ["-a"], exitCode: 0 }, file);
    appendHistory({ ts: 2, unit: "u", target: "nas", argv: ["-c"], exitCode: 1 }, file);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!).exitCode).toBe(1);
  });

  test("records the literal argv that ran", () => {
    const file = join(dir, "history.jsonl");
    const argv = ["-aAXc", "-n", "-i", "/src/", "/dst/"];
    appendHistory({ ts: 1, unit: "u", target: "nas", argv, exitCode: 0 }, file);
    expect(JSON.parse(readFileSync(file, "utf8").trim()).argv).toEqual(argv);
  });

  test("it rotates once it passes the cap, keeping one previous file", () => {
    // The record is append-only by design; the rotation is what keeps
    // append-only from growing without bound in a directory nobody watches.
    const file = join(dir, "history.jsonl");
    writeFileSync(file, "x".repeat(MAX_HISTORY_BYTES + 1));
    appendHistory({ ts: 1, unit: "u", target: "nas", argv: ["-a"], exitCode: 0 }, file);
    expect(existsSync(`${file}.1`), "previous history kept").toBe(true);
    expect(readFileSync(file, "utf8")).toContain('"unit":"u"');
    expect(statSync(file).size).toBeLessThan(MAX_HISTORY_BYTES);
  });

  test("a fresh history does not rotate", () => {
    const file = join(dir, "history.jsonl");
    appendHistory({ ts: 1, unit: "u", target: "nas", argv: ["-a"], exitCode: 0 }, file);
    expect(existsSync(`${file}.1`)).toBe(false);
  });
});

describe("estimating how long a check will take", () => {
  /**
   * The bar was keyed to the same folder's previous run, which meant a 13 gb
   * deep verify had to complete twice before its bar moved once. For an archive
   * checked occasionally that is never, so the bar did nothing in practice.
   */
  const fp = (bytes: number) => ({ nfiles: 900, bytes, maxMtimeNs: "1" });
  const scan = (over: Partial<Scan>): Scan => ({
    unit: "u",
    target: "nas",
    ts: 0,
    method: "deep",
    outcome: "clean",
    nChanges: 0,
    nExtra: 0,
    bytesPending: 0,
    fingerprint: fp(13e9),
    sentinel: "s",
    durationMs: 720_000,
    ...over,
  });
  const st = (scans: Scan[]): State => ({ version: 1, scans });

  test("one completed check gives every other folder an estimate", () => {
    const s = st([scan({})]);
    expect(estimateMs(s, "nas", "deep", 13e9)).toBe(720_000);
    // Twice the bytes, twice the wait.
    expect(estimateMs(s, "nas", "deep", 26e9)).toBe(1_440_000);
  });

  test("it will not guess for a destination it has never measured", () => {
    expect(estimateMs(st([scan({})]), "external", "deep", 13e9)).toBeUndefined();
  });

  test("it will not guess across methods", () => {
    // A quick check stats files; a deep verify reads them. Two orders of
    // magnitude apart, so a pooled rate would be confidently wrong.
    expect(estimateMs(st([scan({})]), "nas", "quick", 13e9)).toBeUndefined();
  });

  test("a folder that was absent teaches nothing about read speed", () => {
    // It was never read, so its duration is not a throughput sample.
    expect(
      estimateMs(st([scan({ outcome: "missing", durationMs: 40 })]), "nas", "deep", 13e9),
    ).toBeUndefined();
  });

  test("a failed check is not a sample either", () => {
    expect(
      estimateMs(st([scan({ outcome: "error", durationMs: 40 })]), "nas", "deep", 13e9),
    ).toBeUndefined();
  });

  test("records written before durations were tracked are skipped", () => {
    const old = scan({});
    delete (old as { durationMs?: number }).durationMs;
    expect(estimateMs(st([old]), "nas", "deep", 13e9)).toBeUndefined();
  });

  test("several samples pool into one rate", () => {
    const s = st([
      scan({ unit: "a" }),
      scan({ unit: "b", fingerprint: fp(26e9), durationMs: 1_440_000 }),
    ]);
    // 39 gb over 36 minutes; asking for 13 gb should return the same 12 minutes.
    expect(estimateMs(s, "nas", "deep", 13e9)).toBe(720_000);
  });

  test("nothing to estimate for an empty folder", () => {
    expect(estimateMs(st([scan({})]), "nas", "deep", 0)).toBeUndefined();
  });
});

describe("the mount table is not re-enumerated per destination", () => {
  /**
   * `/sbin/mount` stats every mount point; with an SMB share mounted it took
   * 1380 ms on the machine this was found on. Every destination check spawned
   * it separately, so a three-destination config paid that three times per
   * refresh and again in the sync pre-flight.
   */
  test("repeated identity checks do not each pay for a spawn", async () => {
    const { identify, forgetMountTable } = await import("../src/volume.ts");
    forgetMountTable();
    const first = Date.now();
    await identify(PROJECT_ROOT);
    const cold = Date.now() - first;

    const second = Date.now();
    for (let i = 0; i < 5; i++) await identify(PROJECT_ROOT);
    const warm = Date.now() - second;

    // Five cached lookups must cost less than one uncached one. Stated as a
    // ratio rather than a millisecond budget, so it holds on any machine.
    expect(warm, `cold ${cold}ms, five warm ${warm}ms`).toBeLessThan(Math.max(cold, 5));
  });

  test("forgetting the table makes the next call re-read it", async () => {
    // Reachability is exactly the check that must notice a drive going away,
    // so the cache has to be droppable.
    const { identify, forgetMountTable } = await import("../src/volume.ts");
    await identify(PROJECT_ROOT);
    forgetMountTable();
    expect(await identify(PROJECT_ROOT)).not.toBeNull();
  });
});
