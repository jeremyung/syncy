import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { JobEvent, JobPhase } from "./engine-protocol.ts";
import { stateDir } from "./paths.ts";

/**
 * One process owns work that can read a source, invoke rsync, or record evidence.
 * Other interfaces observe this record instead of starting duplicate work.
 *
 * Ownership directories are moved into an append-only archive on release or
 * recovery. That makes crash recovery inspectable and avoids deleting Syncy's
 * own operational history.
 */
export interface JobOwnerRecord {
  readonly version: 1;
  readonly token: string;
  readonly pid: number;
  readonly actor: "cli" | "mac" | "scheduler";
  readonly operation: "quick" | "deep" | "sync" | "setup";
  readonly startedAt: number;
  readonly heartbeatAt: number;
  readonly estimatedDurationMs?: number;
  readonly batchPosition?: number;
  readonly batchTotal?: number;
  readonly activity?: JobOwnerActivity;
}

export interface JobOwnerActivity {
  readonly unit: string;
  readonly target: string;
  readonly phase: JobPhase | "completed" | "skipped" | "failed" | "cancelled";
  readonly at: number;
  readonly filesSeen?: number;
  readonly filesTotal?: number;
  readonly bytesDone?: number;
  readonly bytesTotal?: number;
  readonly lastItem?: string;
}

export interface JobOwnerLease {
  readonly record: JobOwnerRecord;
  heartbeat(): void;
  observe(event: JobEvent): void;
  release(): void;
}

export interface JobOwnerBusy {
  readonly acquired: false;
  readonly owner?: JobOwnerRecord;
  readonly reason: "owned" | "owner-starting";
}

export type JobOwnerResult =
  | { readonly acquired: true; readonly lease: JobOwnerLease }
  | JobOwnerBusy;

export interface JobOwnerOptions {
  readonly root?: string;
  readonly now?: () => number;
  readonly pid?: number;
  readonly token?: () => string;
  readonly pidAlive?: (pid: number) => boolean;
  readonly staleAfterMs?: number;
  /** A reused PID must not preserve a dead lease indefinitely. */
  readonly abandonAfterMs?: number;
}

const DEFAULT_STALE_AFTER_MS = 30_000;
const DEFAULT_ABANDON_AFTER_MS = 5 * 60_000;
const MAX_ACQUIRE_ATTEMPTS = 6;

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether an ownership record still represents active work to an observer. */
export function isJobOwnerActive(
  owner: JobOwnerRecord,
  now: number = Date.now(),
  staleAfterMs: number = DEFAULT_STALE_AFTER_MS,
  pidAlive: (pid: number) => boolean = processIsAlive,
): boolean {
  // A future heartbeat is tolerated only within the normal clock-skew window;
  // otherwise a bad clock would pin every client to a fictional active job.
  return (
    owner.heartbeatAt >= now - staleAfterMs &&
    owner.heartbeatAt <= now + staleAfterMs &&
    pidAlive(owner.pid)
  );
}

function ownerPaths(root: string): { current: string; archive: string } {
  return { current: join(root, "job-owner"), archive: join(root, "job-owners") };
}

/** The record's file name is keyed by token, never a fixed name — see archiveFile. */
function recordName(token: string): string {
  return `owner.${token}.json`;
}

function isRecordName(name: string): boolean {
  return name.startsWith("owner.") && name.endsWith(".json");
}

function parseRecord(value: unknown): JobOwnerRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.token !== "string" ||
    typeof record.pid !== "number" ||
    !Number.isInteger(record.pid) ||
    record.pid <= 0 ||
    (record.actor !== "cli" && record.actor !== "mac" && record.actor !== "scheduler") ||
    (record.operation !== "quick" &&
      record.operation !== "deep" &&
      record.operation !== "sync" &&
      record.operation !== "setup") ||
    typeof record.startedAt !== "number" ||
    !Number.isFinite(record.startedAt) ||
    typeof record.heartbeatAt !== "number" ||
    !Number.isFinite(record.heartbeatAt)
  ) {
    return undefined;
  }
  if (record.activity !== undefined) {
    if (typeof record.activity !== "object" || record.activity === null) return undefined;
    const activity = record.activity as Record<string, unknown>;
    if (
      typeof activity.unit !== "string" ||
      typeof activity.target !== "string" ||
      typeof activity.phase !== "string" ||
      typeof activity.at !== "number" ||
      !Number.isFinite(activity.at) ||
      (activity.lastItem !== undefined && typeof activity.lastItem !== "string")
    ) {
      return undefined;
    }
  }
  for (const key of ["estimatedDurationMs", "batchPosition", "batchTotal"] as const) {
    const value = record[key];
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    ) {
      return undefined;
    }
  }
  if ((record.batchPosition === undefined) !== (record.batchTotal === undefined)) {
    return undefined;
  }
  if (
    typeof record.batchPosition === "number" &&
    typeof record.batchTotal === "number" &&
    (record.batchPosition < 1 || record.batchPosition > record.batchTotal)
  ) {
    return undefined;
  }
  return record as unknown as JobOwnerRecord;
}

/** Reads and parses one file directly; never throws, mirrors readJobOwner's leniency. */
function tryParseRecordFile(path: string): JobOwnerRecord | undefined {
  try {
    return parseRecord(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
}

/**
 * The live record is whichever single `owner.*.json` file sits in `job-owner/`.
 * Zero files (nobody has published yet) and more than one file (an
 * in-progress claim collision resolving itself, see archiveFile) both read as
 * "no usable owner" rather than guessing.
 */
export function readJobOwner(root = stateDir()): JobOwnerRecord | undefined {
  const { current } = ownerPaths(root);
  let entries: string[];
  try {
    entries = readdirSync(current);
  } catch {
    return undefined;
  }
  const [only, ...rest] = entries.filter(isRecordName);
  if (only === undefined || rest.length > 0) return undefined;
  return tryParseRecordFile(join(current, only));
}

/**
 * Moves one exact file out of `job-owner/` into the archive, then removes the
 * directory if that leaves it empty.
 *
 * The rename's SOURCE always names one specific file, never the directory.
 * That is the only reason this is safe under a race: when two processes both
 * see the same dead owner and both try to reclaim it, both attempt to rename
 * that owner's exact record file out — the loser's source no longer exists
 * (ENOENT, swallowed below) instead of the loser sweeping away a directory
 * that the winner has, in the meantime, already re-mkdir'd and repopulated
 * under a brand-new token. A rename keyed on the directory path, by
 * contrast, cannot tell "the owner I saw" from "whoever owns it now".
 */
function archiveFile(root: string, fileName: string, archivedAs: string): void {
  const { current, archive } = ownerPaths(root);
  mkdirSync(archive, { recursive: true });
  try {
    renameSync(join(current, fileName), join(archive, archivedAs));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
    // Already archived (or never written) by whoever else raced us here.
  }
  rmdirIgnoringNonEmpty(current);
}

/** A record's archive entry is named by its token, not its on-disk file name. */
function archiveRecord(root: string, label: string, token: string, now: number): void {
  archiveFile(root, recordName(token), `${now}-${label}-${token}.json`);
}

/** rmdir only ever removes an EMPTY directory, so it can never destroy a live record. */
function rmdirIgnoringNonEmpty(dir: string): void {
  try {
    rmdirSync(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
  }
}

export function acquireJobOwner(
  actor: JobOwnerRecord["actor"],
  operation: JobOwnerRecord["operation"],
  options: JobOwnerOptions = {},
): JobOwnerResult {
  const root = options.root ?? stateDir();
  const now = options.now ?? Date.now;
  const pid = options.pid ?? process.pid;
  const makeToken = options.token ?? (() => crypto.randomUUID());
  const pidAlive = options.pidAlive ?? processIsAlive;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const abandonAfterMs = options.abandonAfterMs ?? DEFAULT_ABANDON_AFTER_MS;
  const paths = ownerPaths(root);
  mkdirSync(dirname(paths.current), { recursive: true });

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    try {
      mkdirSync(paths.current);
      // `mkdirSync` succeeding only proves we created *a* directory at this
      // path just now; it is not a lock on everything that happens next. A
      // rival can still see it as empty, decide it is abandoned (below),
      // rmdir it, and re-mkdir a fresh one before our write below lands — in
      // which case our write would silently succeed into THEIR directory.
      // The self-check after the write (not the mkdir) is what actually
      // closes that window: see the comment there.
      const token = makeToken();
      const at = now();
      const record: JobOwnerRecord = {
        version: 1,
        token,
        pid,
        actor,
        operation,
        startedAt: at,
        heartbeatAt: at,
      };
      const path = join(paths.current, recordName(token));
      try {
        writeFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "wx" });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Our directory was rmdir'd (and not yet recreated) in the
        // microsecond window between our mkdir and this write.
        if (code === "ENOENT") continue;
        throw error;
      }
      // Confirm the directory we just wrote into still holds only our
      // record. If a rival rmdir'd our directory and re-mkdir'd its own
      // between our mkdir and our write (above), our write above would have
      // landed in THEIR directory instead of failing — this is what catches
      // that: a second file appearing means we lost a race we can't win
      // retroactively, so we back out instead of returning a lease that
      // shares its directory with someone else's.
      const siblings = readdirSync(paths.current).filter(isRecordName);
      if (siblings.length !== 1 || siblings[0] !== recordName(token)) {
        rmSync(path, { force: true });
        rmdirIgnoringNonEmpty(paths.current);
        continue;
      }

      let active = record;
      let released = false;
      const publish = (next: JobOwnerRecord): void => {
        const observed = readJobOwner(root);
        if (observed?.token !== active.token) throw new Error("job ownership was lost");
        active = next;
        const pending = join(paths.current, `owner.${active.token}.pending`);
        writeFileSync(pending, `${JSON.stringify(active)}\n`, "utf8");
        renameSync(pending, join(paths.current, recordName(active.token)));
      };
      return {
        acquired: true,
        lease: {
          get record() {
            return active;
          },
          heartbeat() {
            if (released) return;
            publish({ ...active, heartbeatAt: now() });
          },
          observe(event) {
            if (released) return;
            const terminal =
              event.type === "job.completed"
                ? "completed"
                : event.type === "job.skipped"
                  ? "skipped"
                  : event.type === "job.failed"
                    ? "failed"
                    : event.type === "job.cancelled"
                      ? "cancelled"
                      : undefined;
            const phase =
              terminal ??
              (event.type === "job.started"
                ? event.phase
                : event.type === "job.phase-changed"
                  ? event.phase
                  : (active.activity?.phase ?? "queued"));
            const progress = event.type === "job.progress-observed" ? event : undefined;
            const previous = event.type === "job.started" ? undefined : active.activity;
            const filesSeen = progress?.filesSeen ?? previous?.filesSeen;
            const filesTotal = progress?.filesTotal ?? previous?.filesTotal;
            const bytesDone = progress?.bytesDone ?? previous?.bytesDone;
            const bytesTotal = progress?.bytesTotal ?? previous?.bytesTotal;
            const lastItem = progress?.lastItem ?? previous?.lastItem;
            const estimatedDurationMs =
              event.type === "job.started" ? event.estimatedDurationMs : active.estimatedDurationMs;
            const batchPosition =
              event.type === "job.started" ? event.batch?.position : active.batchPosition;
            const batchTotal =
              event.type === "job.started" ? event.batch?.total : active.batchTotal;
            publish({
              version: active.version,
              token: active.token,
              pid: active.pid,
              actor: active.actor,
              operation: active.operation,
              startedAt: active.startedAt,
              heartbeatAt: now(),
              ...(estimatedDurationMs === undefined ? {} : { estimatedDurationMs }),
              ...(batchPosition === undefined ? {} : { batchPosition }),
              ...(batchTotal === undefined ? {} : { batchTotal }),
              activity: {
                unit: event.unit,
                target: event.target,
                phase,
                at: event.at,
                ...(filesSeen === undefined ? {} : { filesSeen }),
                ...(filesTotal === undefined ? {} : { filesTotal }),
                ...(bytesDone === undefined ? {} : { bytesDone }),
                ...(bytesTotal === undefined ? {} : { bytesTotal }),
                ...(lastItem === undefined ? {} : { lastItem }),
              },
            });
          },
          release() {
            if (released) return;
            const observed = readJobOwner(root);
            if (observed?.token !== active.token) {
              released = true;
              return;
            }
            archiveRecord(root, "released", active.token, now());
            released = true;
          },
        },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
    }

    const observed = readJobOwner(root);
    if (observed !== undefined) {
      const age = now() - observed.heartbeatAt;
      const fresh = age <= staleAfterMs;
      const plausiblyRunning = age <= abandonAfterMs && pidAlive(observed.pid);
      if (fresh || plausiblyRunning) return { acquired: false, owner: observed, reason: "owned" };
      // Stale: reclaim by renaming exactly the record we observed (see
      // archiveFile's comment on why the source must name that one file).
      archiveRecord(root, "stale", observed.token, now());
      continue;
    }

    // `readJobOwner` would not resolve: either the directory is empty (a
    // rival's mkdir with no write yet, or nothing left after a previous
    // sweep), or it holds something that isn't exactly one valid record.
    // Inspect it directly rather than reusing `observed`, since that read is
    // already stale by the time we get here.
    let entries: string[];
    try {
      entries = readdirSync(paths.current);
    } catch {
      continue; // Already gone; next attempt's mkdir will just recreate it.
    }
    const hasLiveCandidate = entries.some(
      (name) => isRecordName(name) && tryParseRecordFile(join(paths.current, name)) !== undefined,
    );
    if (hasLiveCandidate) {
      // At least one file here still parses as a real record even though
      // `readJobOwner` above declined to pick it (most likely more than one
      // candidate present — a self-check above, in another process, is in
      // the middle of backing itself out of a collision). Leave the files
      // alone; the next attempt will see a clean, single record.
      continue;
    }
    // Nothing here is a usable record — empty directory, stray `.pending`
    // leftovers, or genuinely corrupt files. Safe to sweep: rmdir can never
    // remove a non-empty directory, so this can only ever discard junk.
    const at = now();
    for (const name of entries) archiveFile(root, name, `${at}-invalid-${name}`);
    rmdirIgnoringNonEmpty(paths.current);
  }

  const owner = readJobOwner(root);
  return {
    acquired: false,
    ...(owner === undefined ? {} : { owner }),
    reason: "owner-starting",
  };
}

export function jobOwnerExists(root = stateDir()): boolean {
  return readJobOwner(root) !== undefined;
}
