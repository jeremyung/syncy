import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
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

function ownerPaths(root: string): { current: string; archive: string; record: string } {
  const current = join(root, "job-owner");
  return { current, archive: join(root, "job-owners"), record: join(current, "owner.json") };
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
  return record as unknown as JobOwnerRecord;
}

export function readJobOwner(root = stateDir()): JobOwnerRecord | undefined {
  const { record } = ownerPaths(root);
  try {
    return parseRecord(JSON.parse(readFileSync(record, "utf8")));
  } catch {
    return undefined;
  }
}

function archiveCurrent(root: string, label: string, token: string, now: number): boolean {
  const { current, archive } = ownerPaths(root);
  mkdirSync(archive, { recursive: true });
  try {
    renameSync(current, join(archive, `${now}-${label}-${token}`));
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EEXIST" || code === "ENOTEMPTY") return false;
    throw error;
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

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      mkdirSync(paths.current);
      const at = now();
      const record: JobOwnerRecord = {
        version: 1,
        token: makeToken(),
        pid,
        actor,
        operation,
        startedAt: at,
        heartbeatAt: at,
      };
      writeFileSync(paths.record, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "wx" });
      let active = record;
      let released = false;
      const publish = (next: JobOwnerRecord): void => {
        const observed = readJobOwner(root);
        if (observed?.token !== active.token) throw new Error("job ownership was lost");
        active = next;
        const pending = join(paths.current, `owner.${active.token}.pending`);
        writeFileSync(pending, `${JSON.stringify(active)}\n`, "utf8");
        renameSync(pending, paths.record);
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
            publish({
              ...active,
              heartbeatAt: now(),
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
            archiveCurrent(root, "released", active.token, now());
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
      if (!archiveCurrent(root, "stale", observed.token, now())) continue;
      continue;
    }

    // A winner creates the directory just before writing its record. Give that
    // small initialization window the same protection as a live owner.
    try {
      if (now() - statSync(paths.current).mtimeMs <= staleAfterMs) {
        return { acquired: false, reason: "owner-starting" };
      }
    } catch {
      continue;
    }
    if (!archiveCurrent(root, "invalid", "unknown", now())) continue;
  }

  const owner = readJobOwner(root);
  return {
    acquired: false,
    ...(owner === undefined ? {} : { owner }),
    reason: "owner-starting",
  };
}

export function jobOwnerExists(root = stateDir()): boolean {
  return existsSync(ownerPaths(root).current);
}
