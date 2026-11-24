import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertLocalFolder,
  catalogFolders,
  folderCandidates,
  rememberLocalScan,
  trackFolder,
} from "../src/archive-catalog.ts";
import { archiveLedger } from "../src/archive-ledger.ts";
import { runCheckQueue } from "../src/check-runner.ts";
import { type Config, parseConfig } from "../src/config.ts";
import { fingerprint } from "../src/fingerprint.ts";
import { historyFile } from "../src/paths.ts";
import { SENTINEL_NAME } from "../src/sentinel.ts";
import { appendHistory, EMPTY_STATE, loadState, type Scan, type State } from "../src/state.ts";
import { makeFixtureDir, removeFixtureDir } from "./helpers.ts";

let root: string;
let config: Config;
let previous: string | undefined;
const reach = new Map([["backup", "ok"]] as const);
const ledger = (state: State = EMPTY_STATE, now = Date.now()) =>
  archiveLedger(config, state, reach, now);
beforeEach(() => {
  previous = process.env.XDG_STATE_HOME;
  root = makeFixtureDir("archive-catalog");
  process.env.XDG_STATE_HOME = join(root, "state");
  mkdirSync(join(root, "local", "photos"), { recursive: true });
  mkdirSync(join(root, "peer", "photos"), { recursive: true });
  writeFileSync(join(root, "peer", SENTINEL_NAME), "disk");
  config = parseConfig(
    "source=" +
      JSON.stringify(join(root, "local")) +
      '\n[[target]]\nname="backup"\npath=' +
      JSON.stringify(join(root, "peer")) +
      '\nsentinel="disk"',
  );
});
afterEach(() => {
  if (previous === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previous;
  removeFixtureDir(root);
});

function clean(unit: string): Scan {
  return {
    unit,
    target: "backup",
    ts: 100,
    method: "deep",
    outcome: "clean",
    nChanges: 0,
    nExtra: 0,
    bytesPending: 0,
    fingerprint: fingerprint(join(config.source, "photos")),
    sentinel: "disk",
  };
}

test("upgrade attributes a dated legacy scan only to its literal source, including rotated history", async () => {
  const historical = clean("archive");
  const ambiguous = clean("other");
  appendHistory(
    {
      unit: "archive",
      target: "backup",
      ts: 100,
      argv: ["-n", "-c", join(config.source, "archive") + "/", join(root, "peer", "archive") + "/"],
      exitCode: 0,
    },
    historyFile() + ".1",
  );
  const state: State = { version: 1, scans: [historical, ambiguous] };
  const first = ledger(state).records.find((r) => r.unit === "archive")!;
  expect(first.archive.localChecks).toEqual([{ target: "backup", at: 100 }]);
  expect(first.archive.local).toBe("unavailable");
  catalogFolders(config, 200, true);
  expect(ledger(state, 201).records.find((r) => r.unit === "archive")?.archive.local).toBe(
    "absent",
  );
  expect(ledger(state, 202).records.filter((r) => r.unit === "archive")).toHaveLength(1);
  const { candidates } = await folderCandidates(config, state, false);
  expect(candidates.find((c) => c.unit === "other")).toMatchObject({
    remembered: true,
    tracked: false,
    locations: [expect.stringContaining("source unconfirmed")],
  });
  trackFolder(config, "other");
  expect(ledger(state).records.find((r) => r.unit === "other")?.archive.localChecks).toEqual([]);
});

test("an earlier deep match remains dated evidence after a newer deep mismatch replaces it", () => {
  const scan = { ...clean("photos"), source: config.source };
  rememberLocalScan(scan);
  const newer: Scan = { ...scan, ts: 200, outcome: "behind", nChanges: 1 };
  rememberLocalScan(newer);
  catalogFolders(config, 300);
  renameSync(join(config.source, "photos"), join(root, "parked"));
  expect(ledger({ version: 1, scans: [newer] }, 400).records[0]?.archive.localChecks).toEqual([
    { target: "backup", at: 100 },
  ]);
});

test("a different directory at the same root is unavailable until explicitly rebound", () => {
  const state: State = { version: 1, scans: [{ ...clean("photos"), source: config.source }] };
  expect(ledger(state, 100).current.scans).toHaveLength(1);
  renameSync(config.source, join(root, "original"));
  mkdirSync(join(config.source, "photos"), { recursive: true });
  expect(ledger(state, 200).records[0]?.archive.local).toBe("unavailable");
  expect(() => assertLocalFolder(config, "photos")).toThrow(/unavailable/);
  catalogFolders(config, 300, true);
  const restored = ledger(state, 301);
  expect(restored.current.scans).toHaveLength(0);
  expect(restored.records[0]?.archive.label).toBe("Local copy present · awaiting check");
});

test("stopped folders stay in the picker and an offline destination reports its own blocker", async () => {
  catalogFolders(config);
  trackFolder(config, "photos", false);
  const off = { ...config.targets[0]!, name: "offline", path: join(root, "offline") };
  config = { ...config, targets: [...config.targets, off] };
  mkdirSync(join(root, "peer", "archived"));
  const { candidates, blocked } = await folderCandidates(config, EMPTY_STATE, true);
  expect(candidates.find((row) => row.unit === "photos")).toMatchObject({
    remembered: true,
    tracked: false,
    locations: ["Remembered", "backup"],
  });
  expect(candidates.find((row) => row.unit === "archived")).toMatchObject({
    remembered: false,
    tracked: false,
    locations: ["backup"],
  });
  expect(blocked).toHaveLength(1);
  expect(blocked[0]).toContain("offline");
  expect(ledger().records).toHaveLength(0);
  trackFolder(config, "archived");
  expect(ledger().records.map((r) => r.unit)).toEqual(["archived"]);
});

test("simultaneous catalog mutations in separate processes keep a single entry per folder", async () => {
  const code =
    'import {trackFolder} from "./src/archive-catalog.ts";const config=JSON.parse(process.argv[1]);trackFolder(config,process.argv[2]);';
  const children = ["new", "new", "second", "third"].map((unit) =>
    Bun.spawn([process.execPath, "-e", code, JSON.stringify(config), unit], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, XDG_STATE_HOME: join(root, "state") },
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  for (const child of children) {
    expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
  }
  expect(
    catalogFolders(config)
      .map((row) => row.unit)
      .sort(),
  ).toEqual(["new", "photos", "second", "third"]);
});

test("a legacy path from another root cannot attach that root's verification to this folder", () => {
  const scan = clean("photos");
  appendHistory({
    unit: "photos",
    target: "backup",
    ts: scan.ts,
    argv: ["-n", "-c", join(root, "former", "photos") + "/", join(root, "peer", "photos") + "/"],
    exitCode: 0,
  });
  expect(ledger({ version: 1, scans: [scan] }).current.scans).toEqual([]);
  expect(ledger({ version: 1, scans: [scan] }).records[0]?.archive.localChecks).toEqual([]);
});

test("a new folder at the old name requires new local evidence even with matching metadata", () => {
  const state: State = { version: 1, scans: [{ ...clean("photos"), source: config.source }] };
  expect(ledger(state, 100).current.scans).toHaveLength(1);
  renameSync(join(config.source, "photos"), join(root, "older"));
  mkdirSync(join(config.source, "photos"));
  const next = ledger(state, 200);
  expect(next.current.scans).toHaveLength(0);
  expect(next.records[0]?.archive.label).toBe("Local copy present · awaiting check");
});

test("a clock correction cannot revive an earlier scan when the original folder returns", () => {
  const previous = { ...clean("photos"), source: config.source, ts: 500 };
  rememberLocalScan(previous);
  const state: State = { version: 1, scans: [previous] };
  expect(ledger(state, 501).current.scans).toHaveLength(1);
  renameSync(join(config.source, "photos"), join(root, "parked"));
  catalogFolders(config, 200);
  renameSync(join(root, "parked"), join(config.source, "photos"));
  expect(ledger(state, 201).current.scans).toHaveLength(0);
  const fresh = { ...previous, ts: 205 };
  rememberLocalScan(fresh);
  expect(ledger({ version: 1, scans: [fresh] }, 206).current.scans).toEqual([fresh]);
});

test("a delayed local scan cannot be published for a replacement folder", () => {
  const prior = assertLocalFolder(config, "photos");
  const scan = { ...clean("photos"), source: config.source };
  renameSync(join(config.source, "photos"), join(root, "old-copy"));
  mkdirSync(join(config.source, "photos"));
  const next = ledger().records[0]!.archive;
  expect(next.localEpoch).toBeGreaterThan(prior);
  let published = false;
  expect(() =>
    rememberLocalScan(scan, prior, () => {
      published = true;
    }),
  ).toThrow("changed");
  expect(published).toBe(false);
  expect(ledger({ version: 1, scans: [scan] }).current.scans).toEqual([]);
});

test("a folder replaced at the recording phase cannot receive the completed check", async () => {
  const result = await runCheckQueue(
    config,
    EMPTY_STATE,
    "deep",
    [{ unit: "photos", bytes: 0, files: 0 }],
    {
      reachability: reach,
      onEvent(event) {
        if (event.type === "job.phase-changed" && event.phase === "recording-evidence") {
          renameSync(join(config.source, "photos"), join(root, "old-copy"));
          mkdirSync(join(config.source, "photos"));
        }
      },
    },
  );
  expect(result.failed).toMatchObject([
    { unit: "photos", message: expect.stringContaining("changed") },
  ]);
  expect(loadState().scans).toEqual([]);
  expect(ledger().records[0]!.archive.localChecks).toEqual([]);
});

test("a catalog path pointing outside the state directory cannot overwrite the other file", () => {
  const outside = join(root, "ordinary-file");
  writeFileSync(outside, "");
  mkdirSync(join(process.env.XDG_STATE_HOME!, "syncy"), { recursive: true });
  symlinkSync(outside, join(process.env.XDG_STATE_HOME!, "syncy", "archive-v1.sqlite"));
  expect(() => catalogFolders(config)).toThrow();
  expect(statSync(outside).size).toBe(0);
});

test("a stalled destination listing names the blocker without losing accessible folders", async () => {
  const other = join(root, "another");
  mkdirSync(other);
  writeFileSync(join(other, SENTINEL_NAME), "another");
  config = {
    ...config,
    targets: [
      ...config.targets,
      { ...config.targets[0]!, name: "slow", path: other, sentinel: "another" },
    ],
  };
  const { candidates, blocked } = await folderCandidates(config, EMPTY_STATE, true, {
    timeoutMs: 20,
    readDirectories: async (path) => (path === other ? new Promise<string[]>(() => {}) : ["found"]),
  });
  expect(candidates.find((c) => c.unit === "found")?.locations).toEqual(["backup"]);
  expect(blocked).toEqual(["slow · directory listing timed out"]);
});

test("an unconfirmed source can show observed folders without claiming a discovered folder is absent", () => {
  catalogFolders(config);
  trackFolder(config, "from-peer");
  const rows = ledger().records;
  expect(rows.find((row) => row.unit === "photos")?.archive.local).toBe("present");
  expect(rows.find((row) => row.unit === "from-peer")?.archive.label).toContain(
    "select the expected source",
  );
  catalogFolders(config, Date.now(), true);
  expect(ledger().records.find((row) => row.unit === "from-peer")?.archive.local).toBe("absent");
});

test("a review for a prior copy cannot authorize a replacement with the same name", () => {
  const reviewed = assertLocalFolder(config, "photos");
  renameSync(join(config.source, "photos"), join(root, "prior"));
  mkdirSync(join(config.source, "photos"));
  expect(() => assertLocalFolder(config, "photos", reviewed)).toThrow("changed after review");
});

test("legacy scans with indistinguishable timestamps and destinations stay unconfirmed", async () => {
  const scan = clean("photos");
  for (const source of [config.source, join(root, "previous-source")]) {
    appendHistory({
      ts: scan.ts,
      unit: scan.unit,
      target: scan.target,
      argv: ["-n", "-c", join(source, "photos") + "/", join(root, "peer", "photos") + "/"],
      exitCode: 0,
    });
  }
  const state: State = { version: 1, scans: [scan] };
  expect(ledger(state).current.scans).toEqual([]);
  const candidate = (await folderCandidates(config, state, false)).candidates.find(
    (c) => c.unit === "photos",
  );
  expect(candidate?.locations.some((location) => location.includes("source unconfirmed"))).toBe(
    true,
  );
});

test("a pair comparison from a formerly configured destination cannot migrate as a local check", () => {
  const scan = clean("photos");
  const entry = {
    ts: scan.ts,
    unit: scan.unit,
    target: scan.target,
    argv: ["-n", "-c", join(config.source, "photos") + "/", join(root, "peer", "photos") + "/"],
    exitCode: 0,
    comparisonEndpoints: ["first", "second"],
  };
  appendHistory(entry);
  expect(ledger({ version: 1, scans: [scan] }).current.scans).toEqual([]);
});

test("an incomplete legacy history line cannot grant evidence", () => {
  const scan = clean("photos");
  mkdirSync(join(process.env.XDG_STATE_HOME!, "syncy"), { recursive: true });
  writeFileSync(
    historyFile(),
    JSON.stringify({
      unit: "photos",
      target: "backup",
      ts: 100,
      argv: [false, "-n", "-c", join(config.source, "photos"), join(root, "peer", "photos")],
      exitCode: 0,
    }) + "\n",
  );
  expect(ledger({ version: 1, scans: [scan] }).current.scans).toEqual([]);
});
