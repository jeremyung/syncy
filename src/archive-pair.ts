import type { Database } from "bun:sqlite";
import { lstatSync, statSync } from "node:fs";
import { join } from "node:path";
import { requireFolderName, withArchiveStore } from "./archive-catalog.ts";
import { type Config, containmentError, type Target } from "./config.ts";
import { fingerprintAsync, sameFingerprint } from "./fingerprint.ts";
import { type Item, isNew, parseItemizeLine } from "./itemize.ts";
import { presentReachability } from "./presentation.ts";
import { buildArgv, runRsync } from "./rsync.ts";
import { observeTargetSync, type Reachability } from "./scan.ts";
import { appendHistory, type HistoryEntry, type Method } from "./state.ts";

type Pair = [Target, Target];
export interface PairOption {
  endpoints: [string, string];
  blocker: string | null;
}
export interface PairEvidence {
  unit: string;
  endpoints: [string, string];
  method: Method;
  at: number;
  /** Exact roots, configured identity checks, exclusions and negotiated metadata capabilities. */
  rules: string;
  comparisonRules: string;
  counts: Record<string, number>;
  samples: { kind: string; name: string }[];
  outcome: "agree" | "different" | "missing";
  detail: string;
}
export type DisplayPairEvidence = PairEvidence & { current: boolean };

function effectiveRules(config: Config, [left, right]: Pair) {
  return {
    endpoints: [left, right].map((t) => ({
      name: t.name,
      path: t.path,
      identity: t.identity,
      sentinel: t.sentinel,
    })),
    exclude: config.exclude,
    modifyWindow: Math.max(left.modifyWindow, right.modifyWindow),
    flagsDrop: [...new Set([...left.flagsDrop, ...right.flagsDrop])].sort(),
  };
}

function describeRules(
  rules: Pick<ReturnType<typeof effectiveRules>, "modifyWindow" | "flagsDrop" | "exclude">,
): string {
  const skipped = rules.flagsDrop.map((flag) =>
    flag === "-A"
      ? "ACLs"
      : flag === "-X"
        ? "extended attributes"
        : flag === "-p"
          ? "permissions"
          : flag,
  );
  return [
    "Timestamp tolerance " + rules.modifyWindow + "s",
    skipped.length
      ? "Archive metadata except " + skipped.join(", ")
      : "Archive metadata, ACLs and extended attributes",
    "Excludes " + [".syncy-*", ...rules.exclude].join(", "),
  ].join(" · ");
}

function getPair(config: Config, names: readonly string[]): Pair {
  const [a, b] = [...names].sort();
  const left = config.targets.find((t) => t.name === a);
  const right = config.targets.find((t) => t.name === b);
  if (names.length !== 2 || !left || !right || left === right)
    throw new Error("Choose two distinct configured destinations");
  return [left, right];
}

function directoryKey(path: string): string {
  const st = statSync(path, { bigint: true });
  if (!st.isDirectory()) throw new Error("Destination root is not a directory");
  return JSON.stringify([st.dev.toString(), st.ino.toString()]);
}

export function pairOptions(
  config: Config,
  reach: ReadonlyMap<string, Reachability>,
): PairOption[] {
  const options: PairOption[] = [];
  for (const [i, left] of config.targets.entries()) {
    for (const right of config.targets.slice(i + 1)) {
      const endpoints: [string, string] =
        left.name < right.name ? [left.name, right.name] : [right.name, left.name];
      const unavailable = [left, right].flatMap((t) => {
        const status = reach.get(t.name) ?? "unreachable";
        return status === "ok" ? [] : [t.name + " · " + presentReachability(status).phrase];
      });
      if (!unavailable.length && containmentError(left.path, right.path))
        unavailable.push("Choose two distinct destination roots");
      options.push({ endpoints, blocker: unavailable.join(" · ") || null });
    }
  }
  return options;
}

export function recordedPairs(
  db: Database,
  config: Config,
  reach: ReadonlyMap<string, Reachability>,
  now: number,
  unit?: string,
) {
  const where = unit === undefined ? "source=?" : "source=? AND unit=?";
  const stored = db
    .query<{ evidence: string; superseded: number }, string[]>(
      "SELECT evidence,superseded FROM pair_checks WHERE " + where + " ORDER BY rowid DESC",
    )
    .all(...(unit === undefined ? [config.source] : [config.source, unit]));
  const records = stored.map((row) => {
    const result: PairEvidence = JSON.parse(row.evidence);
    if (!result.comparisonRules) {
      const profile = JSON.parse(result.rules);
      result.comparisonRules =
        typeof profile.modifyWindow === "number" &&
        Array.isArray(profile.flagsDrop) &&
        Array.isArray(profile.exclude)
          ? describeRules(profile)
          : "Comparison rules unavailable";
    }
    return { result, superseded: !!row.superseded };
  });
  const latestInventory = new Map<string, number>();
  for (const { result } of records) {
    if (result.at > now) continue;
    const key = JSON.stringify([result.unit, result.rules]);
    latestInventory.set(key, Math.max(latestInventory.get(key) ?? 0, result.at));
  }
  const map = new Map<string, DisplayPairEvidence[]>();
  for (const { result, superseded } of records) {
    const peers = config.targets.filter((t) => result.endpoints.includes(t.name));
    const inventoryAt = latestInventory.get(JSON.stringify([result.unit, result.rules])) ?? 0;
    const current =
      !superseded &&
      peers.length === 2 &&
      peers.every((t) => reach.get(t.name) === "ok") &&
      result.rules === JSON.stringify(effectiveRules(config, getPair(config, result.endpoints))) &&
      result.at <= now &&
      result.at >=
        now -
          (result.method === "deep" ? config.maxVerifyAgeDays : config.maxQuickAgeDays) *
            86400000 &&
      inventoryAt >= now - config.maxQuickAgeDays * 86400000;
    const group = map.get(result.unit) ?? [];
    group.push({ ...result, current });
    map.set(result.unit, group);
  }
  // A new clean metadata check can keep a checksum current; it cannot clear a known
  // content difference. Put the most informative current evidence first for each pair.
  for (const group of map.values())
    group.sort(
      (a, b) =>
        Number(b.current) - Number(a.current) ||
        (a.current && b.current ? Number(b.method === "deep") - Number(a.method === "deep") : 0) ||
        b.at - a.at,
    );
  return map;
}

export function pairEvidence(
  config: Config,
  unit: string,
  reach: ReadonlyMap<string, Reachability>,
  now: number,
) {
  return withArchiveStore((db) => recordedPairs(db, config, reach, now, unit).get(unit) ?? []);
}

interface EndpointObservation {
  root: string;
  identity: string;
  folder: string | null;
}
function observe(t: Target, unit: string): EndpointObservation {
  const { reachability, identity } = observeTargetSync(t);
  if (reachability !== "ok")
    throw new Error(t.name + " · " + presentReachability(reachability).phrase);
  const root = directoryKey(t.path);
  let folder = null;
  try {
    const st = lstatSync(join(t.path, unit), { bigint: true });
    if (!st.isDirectory()) throw new Error(unit + " is not a directory on " + t.name);
    folder = JSON.stringify([st.dev.toString(), st.ino.toString(), st.ctimeNs.toString()]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { root, identity, folder };
}

// Rsync escapes unprintable filename bytes in %n as a backslash, # and three octal
// digits. Keep the displayed name in that printable form. For lstat, recover the
// literal bytes, including names that cannot be represented by a UTF-8 string.
function filenameBytes(part: string): Buffer {
  const chunks: Buffer[] = [];
  let start = 0;
  for (const match of part.matchAll(/\\#([0-7]{3})/g)) {
    chunks.push(
      Buffer.from(part.slice(start, match.index)),
      Buffer.from([Number.parseInt(match[1]!, 8)]),
    );
    start = match.index + match[0].length;
  }
  chunks.push(Buffer.from(part.slice(start)));
  return Buffer.concat(chunks);
}

function receiverHasEntry(root: string, name: string): boolean {
  let path = Buffer.from(root);
  const parts = name.split("/").filter((part) => part !== "" && part !== ".");
  for (const [i, part] of parts.entries()) {
    const bytes = filenameBytes(part);
    if (bytes.equals(Buffer.from("..")) || bytes.includes(47) || bytes.includes(0))
      throw new Error("Invalid path in rsync comparison");
    path = Buffer.concat([path, Buffer.from("/"), bytes]);
    try {
      const st = lstatSync(path);
      // A link to a directory is an archive entry. Never walk through it.
      if (i < parts.length - 1 && !st.isDirectory()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  return true;
}

function discrepancy(
  item: Item,
  mode: Method,
  pair: Pair,
  unit: string,
  unmatchedDirs: Set<string>,
): string {
  const [left, right] = pair;
  if (item.kind === "extra") return "Only on " + right.name;
  if (isNew(item)) {
    // Once a new directory is known to have no receiver directory, every child
    // is absent there too. Bound the cache even for an archive of tiny directories.
    const parts = item.name.split("/");
    const parent = parts.slice(0, item.name.endsWith("/") ? -2 : -1).join("/");
    const exists =
      !unmatchedDirs.has(parent) && receiverHasEntry(join(right.path, unit), item.name);
    if (item.flags[1] === "d") {
      if (unmatchedDirs.size >= 512) unmatchedDirs.clear();
      unmatchedDirs.add(item.name.replace(/\/$/, ""));
    }
    return exists ? "Entry type differs" : "Only on " + left.name;
  }
  if (item.flags[1] === "L" && item.flags[2] === "c") return "Link destination differs";
  if (
    item.flags[1] === "f" &&
    (item.flags[3] === "s" || (mode === "deep" && item.flags[2] === "c"))
  )
    return "Content differs";
  return "Metadata differs";
}

function saveComparison(config: Config, evidence: PairEvidence): void {
  withArchiveStore((db) => {
    // Restoring previous exclusions must not bring back a checksum that a later
    // comparison between these same physical endpoints could have contradicted.
    db.run(
      `UPDATE pair_checks SET superseded=1 WHERE source=? AND unit=? AND profile<>?
      AND json_extract(profile,'$.endpoints')=json_extract(?,'$.endpoints')`,
      [config.source, evidence.unit, evidence.rules, evidence.rules],
    );
    // Keep the invalidation even after a later clean quick check replaces its own row.
    // Quick agreement cannot rehabilitate the earlier checksum after a mismatch.
    if (evidence.method === "deep" || evidence.outcome !== "agree") {
      db.run("UPDATE pair_checks SET superseded=1 WHERE source=? AND unit=? AND profile=?", [
        config.source,
        evidence.unit,
        evidence.rules,
      ]);
    } else {
      // File presence is established by either method. A quick run can resolve an
      // old missing-folder result but a known checksum mismatch still needs a deep run.
      db.run(
        "UPDATE pair_checks SET superseded=1 WHERE source=? AND unit=? AND profile=? AND json_extract(evidence,'$.outcome')='missing'",
        [config.source, evidence.unit, evidence.rules],
      );
    }
    db.run(
      "INSERT OR REPLACE INTO pair_checks(source,unit,profile,method,evidence) VALUES(?,?,?,?,?)",
      [config.source, evidence.unit, evidence.rules, evidence.method, JSON.stringify(evidence)],
    );
  });
}

export type PairPhase =
  | "checking-destination-identity"
  | "comparing-metadata"
  | "comparing-content"
  | "fingerprinting-destination"
  | "recording-evidence";
interface PairOptions {
  signal?: AbortSignal;
  phase?: (phase: PairPhase) => void;
  bin?: string;
}

export async function compareCopies(
  config: Config,
  unit: string,
  names: readonly string[],
  method: Method,
  options: PairOptions = {},
): Promise<PairEvidence> {
  requireFolderName(unit);
  const pair = getPair(config, names);
  const [left, right] = pair;
  const endpoints: [string, string] = [left.name, right.name];
  const target = endpoints.join(" ↔ ");
  const rules = effectiveRules(config, pair);
  const comparisonRules = describeRules(rules);
  const evidence: PairEvidence = {
    unit,
    endpoints,
    method,
    at: 0,
    rules: JSON.stringify(rules),
    comparisonRules,
    counts: {},
    samples: [],
    outcome: "agree",
    detail: "",
  };
  const record = (
    outcome: "completed" | "failed" | "cancelled",
    detail: string,
    argv: string[] = [],
    exitCode: number | null = null,
  ) => {
    const entry: HistoryEntry = {
      comparisonEndpoints: endpoints,
      ts: Date.now(),
      unit,
      target,
      operation: method,
      outcome,
      detail,
      argv,
      exitCode,
    };
    appendHistory(entry);
  };
  options.phase?.("checking-destination-identity");
  options.signal?.throwIfAborted();
  const initial = pair.map((t) => observe(t, unit));
  if (
    containmentError(left.path, right.path) ||
    initial[0]!.root === initial[1]!.root ||
    (initial[0]!.folder !== null && initial[0]!.folder === initial[1]!.folder)
  )
    throw new Error("Choose two distinct destination roots");
  const assertUnchanged = () => {
    options.signal?.throwIfAborted();
    for (const [i, t] of pair.entries()) {
      const current = observe(t, unit);
      const original = initial[i]!;
      if (
        current.root !== original.root ||
        current.folder !== original.folder ||
        current.identity !== original.identity
      )
        throw new Error(t.name + " · folder or volume changed during comparison");
    }
  };
  const missing = pair.filter((_, i) => initial[i]!.folder === null);
  if (missing.length) {
    evidence.outcome = "missing";
    evidence.detail = "Folder missing on " + missing.map((t) => t.name).join(" and ");
  } else {
    const inspect = async () => {
      options.phase?.("fingerprinting-destination");
      const fingerprints = await Promise.all(
        pair.map((t) =>
          fingerprintAsync(
            join(t.path, unit),
            [".syncy-*", ...config.exclude],
            undefined,
            options.signal,
          ),
        ),
      );
      options.signal?.throwIfAborted();
      if (fingerprints.some((fp) => fp.complete !== true))
        throw new Error("Could not read both complete folders");
      return fingerprints;
    };
    const before = await inspect();
    const receiver = {
      ...right,
      path: join(right.path, unit),
      flagsDrop: rules.flagsDrop,
      modifyWindow: rules.modifyWindow,
    };
    const passes: Method[] = method === "deep" ? ["quick", "deep"] : ["quick"];
    for (const pass of passes) {
      options.phase?.(pass === "quick" ? "comparing-metadata" : "comparing-content");
      assertUnchanged();
      const argv = buildArgv(pass, join(left.path, unit), receiver, rules.exclude);
      // An item conversion error must not interrupt the stdout pump. Drain the
      // child fully, record its literal exit code, then refuse incomplete evidence.
      let conversionError: Error | undefined;
      const unmatchedDirs = new Set<string>();
      const result = await runRsync(argv, {
        ...options,
        onLine(line) {
          if (conversionError) return;
          const item = parseItemizeLine(line);
          if (
            !item ||
            item.kind === "same" ||
            (pass === "quick" && method === "deep" && item.kind !== "extra")
          )
            return;
          try {
            const kind = discrepancy(item, pass, pair, unit, unmatchedDirs);
            evidence.counts[kind] = (evidence.counts[kind] ?? 0) + 1;
            if (evidence.samples.length < 100) evidence.samples.push({ kind, name: item.name });
          } catch (error) {
            conversionError = error instanceof Error ? error : new Error(String(error));
          }
        },
      });
      record(
        result.exitCode === 0 ? "completed" : options.signal?.aborted ? "cancelled" : "failed",
        pass + " comparison pass",
        argv,
        result.exitCode,
      );
      options.signal?.throwIfAborted();
      if (result.exitCode !== 0)
        throw new Error(
          result.stderr.trim() || "Incomplete rsync comparison · exit " + result.exitCode,
        );
      if (conversionError) throw conversionError;
    }
    const after = await inspect();
    if (!before.every((fp, i) => sameFingerprint(fp, after[i]!)))
      throw new Error("Folder changed during comparison");
    evidence.outcome = Object.keys(evidence.counts).length ? "different" : "agree";
    evidence.detail =
      evidence.outcome === "different"
        ? Object.entries(evidence.counts)
            .map(([kind, n]) => kind + " · " + n)
            .join(", ")
        : method === "deep"
          ? "Verified against each other"
          : "Size and date match · bytes unread";
  }
  options.phase?.("recording-evidence");
  assertUnchanged();
  evidence.at = Date.now();
  saveComparison(config, evidence);
  return evidence;
}
