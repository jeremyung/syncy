import { constants, Database } from "bun:sqlite";
import {
  type BigIntStats,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Config } from "./config.ts";
import { parseHistoryEntry } from "./engine-history.ts";
import { day } from "./format.ts";
import { historyFile, stateDir } from "./paths.ts";
import { presentReachability } from "./presentation.ts";
import { allReachability, observeTargetSync, REACHABILITY_TIMEOUT_MS } from "./scan.ts";
import type { Scan, State } from "./state.ts";
import { identifySync } from "./volume.ts";

export type LocalPresence = "present" | "absent" | "unavailable";

export interface CatalogFolder {
  unit: string;
  active: number;
  local: LocalPresence;
  problem?: "unconfirmed" | "different-root" | "unreadable";
  /** Start of the current local copy's observation period, in epoch milliseconds. */
  since: number;
}

export function requireFolderName(unit: string): void {
  if (
    typeof unit !== "string" ||
    !unit ||
    unit.startsWith(".") ||
    unit !== basename(unit) ||
    unit.includes("\0")
  ) {
    throw new Error("Choose an immediate, visible folder under the configured root");
  }
}

// A refresh can observe a returning folder while a different client resumes tracking.
// Transactions keep both observations, independently of the local scan file's writer.
export function withArchiveStore<T>(work: (db: Database) => T): T {
  mkdirSync(stateDir(), { recursive: true });
  const path = join(realpathSync(stateDir()), "archive-v1.sqlite");
  const db = new Database(
    path,
    constants.SQLITE_OPEN_CREATE | constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_NOFOLLOW,
  );
  try {
    db.exec("PRAGMA busy_timeout=5000");
    return db
      .transaction(() => {
        const version = db
          .query<{ user_version: number }, []>("PRAGMA user_version")
          .get()!.user_version;
        if (version > 4) throw new Error("The archive catalog needs a newer version of syncy");
        if (version < 4) {
          db.exec(`
          CREATE TABLE IF NOT EXISTS history_origins (source TEXT,unit TEXT,target TEXT,method TEXT,ts INTEGER,
            PRIMARY KEY(unit,target,method,ts,source));
          CREATE TABLE IF NOT EXISTS bindings (source TEXT PRIMARY KEY,identity TEXT,confirmed INTEGER DEFAULT 0);
          CREATE TABLE IF NOT EXISTS folders (source TEXT,unit TEXT,active INTEGER DEFAULT 1,
            local TEXT DEFAULT 'unavailable',since INTEGER DEFAULT 0,PRIMARY KEY(source,unit));
          CREATE TABLE IF NOT EXISTS folder_objects (source TEXT,unit TEXT,object TEXT,PRIMARY KEY(source,unit));
          CREATE TABLE IF NOT EXISTS verified_locally (source TEXT,unit TEXT,target TEXT,identity TEXT,at INTEGER,
            PRIMARY KEY(source,unit,target,identity));
          CREATE TABLE IF NOT EXISTS pair_checks (source TEXT,unit TEXT,profile TEXT,method TEXT,superseded INTEGER DEFAULT 0,
            evidence TEXT NOT NULL,PRIMARY KEY(source,unit,profile,method));
          CREATE TABLE IF NOT EXISTS scan_receipts (source TEXT,unit TEXT,target TEXT,method TEXT,identity TEXT,
            ts INTEGER,epoch INTEGER,PRIMARY KEY(source,unit,target,method,identity));
          PRAGMA user_version=4;
        `);
        }
        return work(db);
      })
      .immediate();
  } finally {
    db.close();
  }
}

function namesAt(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

/** Only the literal, absolute source operand identifies the source of a legacy scan. */
function migrateHistory(db: Database, source: string): void {
  const enroll = db.prepare("INSERT OR IGNORE INTO folders(source,unit) VALUES(?,?)");
  const attribute = db.prepare("INSERT OR IGNORE INTO history_origins VALUES(?,?,?,?,?)");
  for (const path of [historyFile() + ".1", historyFile()]) {
    let contents: string;
    try {
      contents = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const line of contents.split("\n")) {
      const record = parseHistoryEntry(line);
      if (!record || record.comparisonEndpoints) continue;
      try {
        requireFolderName(record.unit);
      } catch {
        continue;
      }
      const operand = record.argv.at(-2);
      const receiver = record.argv.at(-1);
      if (
        typeof operand !== "string" ||
        !isAbsolute(operand) ||
        basename(resolve(operand)) !== record.unit ||
        typeof receiver !== "string" ||
        !isAbsolute(receiver) ||
        basename(resolve(receiver)) !== record.unit
      )
        continue;
      const origin = dirname(resolve(operand));
      if (origin === source) enroll.run(source, record.unit);
      if (
        record.argv.includes("-n") &&
        typeof record.target === "string" &&
        Number.isFinite(record.ts) &&
        Number.isInteger(record.exitCode)
      ) {
        attribute.run(
          origin,
          record.unit,
          record.target,
          record.argv.includes("-c") ? "deep" : "quick",
          record.ts,
        );
      }
    }
  }
}

function recordVerification(db: Database, scan: Scan, source: string): void {
  if (
    scan.method !== "deep" ||
    scan.outcome !== "clean" ||
    !scan.sentinel ||
    scan.fingerprint.complete === false
  )
    return;
  db.run(
    `INSERT INTO verified_locally VALUES(?,?,?,?,?) ON CONFLICT(source,unit,target,identity)
    DO UPDATE SET at=excluded.at WHERE excluded.at>verified_locally.at`,
    [source, scan.unit, scan.target, scan.sentinel, scan.ts],
  );
}

/** The mutable scan file holds the latest result. Keep the dated last good comparison as well. */
export function rememberLocalScan(scan: Scan): void;
export function rememberLocalScan<T>(
  scan: Scan,
  expectedEpoch: number | undefined,
  persist: () => T,
): T;
export function rememberLocalScan<T>(
  scan: Scan,
  expectedEpoch?: number,
  persist?: () => T,
): T | undefined {
  if (!scan.source) return persist?.();
  const source = scan.source;
  requireFolderName(scan.unit);
  return withArchiveStore((db) => {
    if (expectedEpoch !== undefined) {
      const current = db
        .query(
          "SELECT 1 FROM folders WHERE source=? AND unit=? AND since=? AND local='present' AND active=1",
        )
        .get(source, scan.unit, expectedEpoch);
      if (!current)
        throw new Error(scan.unit + " · local copy changed before the check was recorded");
    }
    db.run("INSERT OR IGNORE INTO folders(source,unit,local) VALUES(?,?,'present')", [
      source,
      scan.unit,
    ]);
    db.run(
      `INSERT OR REPLACE INTO scan_receipts(source,unit,target,method,identity,ts,epoch)
      SELECT source,unit,?,?,?,?,since FROM folders WHERE source=? AND unit=?`,
      [scan.target, scan.method, scan.sentinel, scan.ts, source, scan.unit],
    );
    recordVerification(db, scan, source);
    return persist?.();
  });
}

export function verifiedLocalDates(db: Database, source: string) {
  return db
    .query<{ unit: string; target: string; identity: string; at: number }, [string]>(
      "SELECT unit,target,identity,at FROM verified_locally WHERE source=?",
    )
    .all(source);
}

/** Bind the directory as well as its volume, including on systems that only expose a device path. */
function rootStat(source: string): { dev: bigint; ino: bigint } | null {
  try {
    const st = statSync(source, { bigint: true });
    return st.isDirectory() ? st : null;
  } catch {
    return null;
  }
}

function rootIdentity(source: string, ino: bigint): string | null {
  let physical: string;
  try {
    physical = realpathSync(source);
  } catch {
    return null;
  }
  const volume = identifySync(physical);
  return volume ? JSON.stringify([volume.id, ino.toString()]) : null;
}

function rememberObject(db: Database, source: string, unit: string, object: string): boolean {
  const previous = db
    .query<{ object: string }, [string, string]>(
      "SELECT object FROM folder_objects WHERE source=? AND unit=?",
    )
    .get(source, unit);
  if (previous?.object === object) return false;
  db.run("INSERT OR REPLACE INTO folder_objects VALUES(?,?,?)", [source, unit, object]);
  return previous !== null;
}

function rows(db: Database, source: string) {
  return db
    .query<CatalogFolder, [string]>(
      "SELECT unit,active,local,since FROM folders WHERE source=? ORDER BY unit",
    )
    .all(source);
}

export function observeCatalog(
  db: Database,
  config: Config,
  now: number,
  confirmRoot = false,
  state?: State,
): CatalogFolder[] {
  const source = config.source;
  if (!source) return [];
  let binding = db
    .query<{ identity: string | null; confirmed: number }, [string]>(
      "SELECT identity,confirmed FROM bindings WHERE source=?",
    )
    .get(source);
  if (!binding) {
    migrateHistory(db, source);
    db.run("INSERT INTO bindings(source) VALUES(?)", [source]);
    binding = { identity: null, confirmed: 0 };
  }
  // A source-stamped state file can outlive the auxiliary catalog (e.g. a restored backup).
  if (state) {
    const enroll = db.prepare("INSERT OR IGNORE INTO folders(source,unit) VALUES(?,?)");
    for (const scan of state.scans) {
      if (scan.source !== source) continue;
      try {
        requireFolderName(scan.unit);
      } catch {
        continue;
      }
      enroll.run(source, scan.unit);
    }
  }
  const previous = rows(db, source);
  const before = rootStat(source);
  let names: string[] | undefined;
  let problem: CatalogFolder["problem"] = "unreadable";
  let identity: string | null = null;
  if (before) {
    try {
      names = namesAt(source);
    } catch {
      /* An unreadable root proves no absence. */
    }
    const after = rootStat(source);
    if (after && before.ino === after.ino && before.dev === after.dev)
      identity = rootIdentity(source, after.ino);
    if (!confirmRoot && binding.identity && identity && identity !== binding.identity) {
      problem = "different-root";
      names = undefined;
    }
  }
  if (!names || !identity) {
    if (confirmRoot) throw new Error("Could not identify and read the selected source root");
    return previous.map((row) => ({ ...row, local: "unavailable", problem }));
  }

  // On upgrade the mount path may already be empty, or contain unrelated folders on
  // the boot disk. Presence is observable; absence of a migrated folder needs either
  // an earlier positive observation on this root or an explicit source selection.
  const replacement = !!binding.identity && binding.identity !== identity;
  const confirmed = confirmRoot || !!binding.confirmed;
  if (confirmRoot || names.length) {
    db.run(
      "UPDATE bindings SET identity=?,confirmed=? WHERE source=? AND (identity IS NOT ? OR confirmed!=?)",
      [identity, Number(confirmed), source, identity, Number(confirmed)],
    );
  }
  const seen = new Set(names);
  const insert = db.prepare(
    "INSERT OR IGNORE INTO folders(source,unit,local,since) VALUES(?,?,'present',?)",
  );
  const replacedUnits = new Set<string>();
  const inspectFailed = new Set<string>();
  for (const name of seen) {
    insert.run(source, name, replacement ? now : 0);
    try {
      const st = lstatSync(join(source, name), { bigint: true });
      if (!st.isDirectory()) {
        inspectFailed.add(name);
        continue;
      }
      if (rememberObject(db, source, name, st.ino.toString())) replacedUnits.add(name);
    } catch {
      inspectFailed.add(name);
    }
  }
  const update = db.prepare("UPDATE folders SET local=?,since=? WHERE source=? AND unit=?");
  for (const row of previous) {
    const local = seen.has(row.unit)
      ? "present"
      : confirmed || row.local !== "unavailable"
        ? "absent"
        : "unavailable";
    if (
      inspectFailed.has(row.unit) ||
      (row.local === local && !replacement && !replacedUnits.has(row.unit))
    )
      continue;
    // An unknown migrated entry can still own attributable historical scans. Only a
    // proven absence, or explicit rebinding to another root, starts a new epoch.
    const since =
      replacement || replacedUnits.has(row.unit) || (local === "present" && row.local === "absent")
        ? Math.max(now, row.since + 1)
        : row.since;
    update.run(local, since, source, row.unit);
  }
  return rows(db, source).map((row) =>
    inspectFailed.has(row.unit)
      ? { ...row, local: "unavailable", problem: "unreadable" }
      : row.local === "unavailable"
        ? { ...row, problem: "unconfirmed" }
        : row,
  );
}

export function catalogFolders(
  config: Config,
  now = Date.now(),
  confirmRoot = false,
): CatalogFolder[] {
  if (!config.source) return [];
  return withArchiveStore((db) => observeCatalog(db, config, now, confirmRoot));
}

export function trackFolder(config: Config, unit: string, active = true): void {
  requireFolderName(unit);
  if (!config.source) throw new Error("Choose a source root first");
  withArchiveStore((db) => {
    db.run(
      `INSERT INTO folders(source,unit,active) VALUES(?,?,?) ON CONFLICT(source,unit)
      DO UPDATE SET active=excluded.active WHERE active!=excluded.active`,
      [config.source, unit, Number(active)],
    );
  });
}

export function isTracked(config: Config, unit: string): boolean {
  requireFolderName(unit);
  return withArchiveStore(
    (db) =>
      !!db
        .query("SELECT 1 FROM folders WHERE source=? AND unit=? AND active=1")
        .get(config.source, unit),
  );
}

export interface FolderCandidate {
  unit: string;
  locations: string[];
  tracked: boolean;
  remembered: boolean;
}
function scanOrigin(db: Database, scan: Scan): string | null {
  const match = db
    .query<{ count: number; source: string | null }, [string, string, string, number]>(
      "SELECT COUNT(*) AS count, MIN(source) AS source FROM history_origins WHERE unit=? AND target=? AND method=? AND ts=?",
    )
    .get(scan.unit, scan.target, scan.method, scan.ts);
  return match?.count === 1 ? match.source : null;
}

interface DiscoveryOptions {
  readonly destinations?: readonly string[];
  readonly readDirectories?: (root: string) => Promise<string[]>;
  readonly timeoutMs?: number;
}

async function discoverNames(root: string, options: DiscoveryOptions): Promise<string[]> {
  const read =
    options.readDirectories ??
    (async (path) =>
      (await readdir(path, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(root),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("directory listing timed out")),
          options.timeoutMs ?? REACHABILITY_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export async function folderCandidates(
  config: Config,
  state: State,
  discover: boolean,
  options: DiscoveryOptions = {},
) {
  const { folders, ambiguous } = withArchiveStore((db) => ({
    folders: observeCatalog(db, config, Date.now(), false, state),
    ambiguous: state.scans.filter((scan) => scan.source === undefined && !scanOrigin(db, scan)),
  }));
  const candidates = new Map<string, FolderCandidate>();
  const blocked: string[] = [];
  for (const folder of folders)
    candidates.set(folder.unit, {
      unit: folder.unit,
      locations: ["Remembered"],
      remembered: true,
      tracked: !!folder.active,
    });
  for (const scan of ambiguous) {
    try {
      requireFolderName(scan.unit);
    } catch {
      continue;
    }
    const entry = candidates.get(scan.unit) ?? {
      unit: scan.unit,
      locations: [],
      remembered: true,
      tracked: false,
    };
    const description =
      "Prior " +
      scan.method +
      " check · " +
      scan.target +
      " · " +
      day(scan.ts) +
      " · " +
      scan.outcome +
      " · source unconfirmed";
    entry.locations.push(description);
    candidates.set(scan.unit, entry);
  }
  if (discover) {
    const selected =
      options.destinations === undefined
        ? config.targets
        : config.targets.filter((t) => options.destinations?.includes(t.name));
    for (const name of new Set(options.destinations)) {
      if (!selected.some((t) => t.name === name)) blocked.push(name + " · unknown destination");
    }
    const reach = await allReachability({ ...config, targets: selected });
    const results = await Promise.all(
      selected.map(async (target) => {
        try {
          const status = reach.get(target.name) ?? "unreachable";
          if (status !== "ok") throw new Error(presentReachability(status).phrase);
          const units = await discoverNames(target.path, options);
          const current = observeTargetSync(target).reachability;
          if (current !== "ok") throw new Error(presentReachability(current).phrase);
          return { name: target.name, units };
        } catch (error) {
          return {
            name: target.name,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
    for (const result of results) {
      if (result.error !== undefined) {
        blocked.push(result.name + " · " + result.error);
        continue;
      }
      for (const unit of result.units ?? []) {
        const entry = candidates.get(unit) ?? {
          unit,
          locations: [],
          remembered: false,
          tracked: false,
        };
        entry.locations.push(result.name);
        candidates.set(unit, entry);
      }
    }
  }
  return {
    candidates: [...candidates.values()].sort((a, b) => a.unit.localeCompare(b.unit)),
    blocked,
  };
}

export function attributedScans(
  db: Database,
  config: Config,
  state: State,
  folders: CatalogFolder[],
  currentOnly: boolean,
): State {
  const starts = new Map(
    folders
      .filter((row) => !currentOnly || (!!row.active && row.local === "present"))
      .map((row) => [row.unit, row.since]),
  );

  const receipt = db.query(
    `SELECT 1 FROM scan_receipts WHERE source=? AND unit=? AND target=? AND method=? AND identity=? AND ts=? AND epoch=?`,
  );
  const scans = new Map<string, Scan>();
  for (const scan of state.scans) {
    if (
      scan.source !== config.source &&
      (scan.source !== undefined || scanOrigin(db, scan) !== config.source)
    )
      continue;
    recordVerification(db, scan, config.source);
    const epoch = starts.get(scan.unit);
    if (epoch === undefined) continue;
    // A scan timestamp alone cannot prove which incarnation it read. Wall clocks
    // can move backward. A returned folder must have a receipt for this epoch.
    if (
      currentOnly &&
      epoch > 0 &&
      !receipt.get(
        config.source,
        scan.unit,
        scan.target,
        scan.method,
        scan.sentinel,
        scan.ts,
        epoch,
      )
    )
      continue;
    const key = JSON.stringify([scan.unit, scan.target, scan.method, scan.sentinel]);
    if ((scans.get(key)?.ts ?? -Infinity) <= scan.ts) scans.set(key, scan);
  }
  return { version: 1, scans: [...scans.values()] };
}

export function sourceEvidence(
  config: Config,
  state: State,
  folders: CatalogFolder[],
  currentOnly: boolean,
): State {
  return withArchiveStore((db) => attributedScans(db, config, state, folders, currentOnly));
}

/** Return the observation period that a local check or sync is about to use. */
export function assertLocalFolder(config: Config, unit: string, expectedEpoch?: number): number {
  requireFolderName(unit);
  const source = config.source;
  const epoch = withArchiveStore((db) => {
    const binding = db
      .query<{ identity: string | null }, [string]>("SELECT identity FROM bindings WHERE source=?")
      .get(source);
    const row = db
      .query<CatalogFolder, [string, string]>(
        "SELECT unit,active,local,since FROM folders WHERE source=? AND unit=?",
      )
      .get(source, unit);
    if (!binding?.identity || !row) {
      return (
        observeCatalog(db, config, Date.now()).find(
          (f) => f.unit === unit && !!f.active && f.local === "present",
        )?.since ?? null
      );
    }
    const st = rootStat(source);
    if (!row.active || !st || rootIdentity(source, st.ino) !== binding.identity) return null;
    let child: BigIntStats;
    try {
      child = lstatSync(join(source, unit), { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && row.local === "present")
        db.run("UPDATE folders SET local='absent' WHERE source=? AND unit=?", [source, unit]);
      return null;
    }
    if (!child.isDirectory()) return null;
    const replaced = rememberObject(db, source, unit, child.ino.toString());
    const since =
      replaced || row.local === "absent" ? Math.max(Date.now(), row.since + 1) : row.since;
    if (replaced || row.local !== "present")
      db.run("UPDATE folders SET local='present',since=? WHERE source=? AND unit=?", [
        since,
        source,
        unit,
      ]);
    return since;
  });
  if (epoch === null) throw new Error(unit + " · tracked local copy unavailable");
  if (expectedEpoch !== undefined && epoch !== expectedEpoch)
    throw new Error(unit + " · local copy changed after review");
  return epoch;
}
