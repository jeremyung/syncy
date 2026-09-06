import type { Diff } from "./diff.ts";
import type { HistorySnapshotEntry } from "./engine-history.ts";
import type { Fingerprint } from "./fingerprint.ts";
import type { Reachability } from "./scan.ts";
import type { ScanOutcome } from "./state.ts";
import type { CellState, UnitState } from "./status.ts";

/**
 * The wire contract between syncy's engine and interfaces that do not share
 * its process (initially the Mac app).
 *
 * This is deliberately a description of observations, not another executor.
 * The only code allowed to establish reachability, run rsync, or record scan
 * evidence remains in scan.ts, sync.ts and their existing guards. The
 * headless runner translates those results into these messages.
 */
export const ENGINE_PROTOCOL_VERSION = 1 as const;

export type EngineProtocolVersion = typeof ENGINE_PROTOCOL_VERSION;
export type JobOperation = "quick" | "deep" | "sync" | "setup";

/** A phase says what has started; it does not imply a percentage completed. */
export type JobPhase =
  | "queued"
  | "inspecting-source"
  | "checking-destination-identity"
  | "running-preflight"
  | "starting-rsync"
  | "comparing-metadata"
  | "comparing-content"
  | "transferring"
  | "fingerprinting-destination"
  | "recording-evidence"
  | "cancelling";

export interface TargetSnapshot {
  readonly name: string;
  readonly required: boolean;
  readonly reachability: Reachability;
  readonly usesSentinel: boolean;
}

export interface CellSnapshot {
  readonly target: string;
  readonly state: CellState;
  readonly reason: string;
  readonly nChanges: number;
  readonly nNew?: number;
  readonly bytesPending: number;
  readonly nExtra: number;
  readonly needsChecksum?: boolean;
}

export interface UnitSnapshot {
  readonly unit: string;
  readonly state: UnitState;
  readonly reason: string;
  readonly fingerprint: Fingerprint;
  readonly cells: readonly CellSnapshot[];
}

export interface ActiveJobSnapshot {
  readonly actor: "cli" | "mac" | "scheduler";
  readonly operation: JobOperation;
  readonly startedAt: number;
  readonly heartbeatAt: number;
  readonly activity?: {
    readonly unit: string;
    readonly target: string;
    readonly phase: JobPhase | "completed" | "skipped" | "failed" | "cancelled";
    readonly at: number;
    readonly filesSeen?: number;
    readonly filesTotal?: number;
    readonly bytesDone?: number;
    readonly bytesTotal?: number;
  };
}

export interface SnapshotMessage {
  readonly protocolVersion: EngineProtocolVersion;
  readonly type: "snapshot";
  readonly generatedAt: number;
  readonly source: string;
  /** Changes whenever source or destination execution configuration changes. */
  readonly configRevision: string;
  readonly targets: readonly TargetSnapshot[];
  readonly units: readonly UnitSnapshot[];
  /** Present when a process currently owns executable work. */
  readonly activeJob?: ActiveJobSnapshot;
}

export interface SyncPreflightMessage {
  readonly protocolVersion: EngineProtocolVersion;
  readonly type: "sync.preflight";
  readonly generatedAt: number;
  readonly unit: string;
  readonly target: string;
  readonly argv: readonly string[];
  readonly checks: readonly {
    readonly name: string;
    readonly ok: boolean;
    readonly warn?: boolean;
    readonly detail: string;
  }[];
  readonly ok: boolean;
  readonly nChanges: number;
  readonly nNew?: number;
  readonly nExtra: number;
  readonly bytesPending: number;
  readonly needsChecksum: boolean;
  readonly confirmationToken?: string;
  readonly expiresAt?: number;
}

export interface DiffMessage {
  readonly protocolVersion: EngineProtocolVersion;
  readonly type: "diff";
  readonly generatedAt: number;
  readonly unit: string;
  readonly target: string;
  readonly diff: Diff | null;
}

export interface HistoryMessage {
  readonly protocolVersion: EngineProtocolVersion;
  readonly type: "history";
  readonly generatedAt: number;
  readonly entries: readonly HistorySnapshotEntry[];
}

interface JobEventBase {
  readonly protocolVersion: EngineProtocolVersion;
  readonly jobId: string;
  readonly at: number;
  readonly operation: JobOperation;
  readonly unit: string;
  readonly target: string;
}

export interface JobStartedEvent extends JobEventBase {
  readonly type: "job.started";
  readonly phase: "queued";
  /** Position in a batch, if this job belongs to one. Both values are counts. */
  readonly batch?: {
    readonly position: number;
    readonly total: number;
    readonly bytesDone: number;
    readonly bytesTotal: number;
  };
  readonly unitSize: {
    readonly files: number;
    readonly bytes: number;
  };
  /** One measured prior run, not a promise that this run will take as long. */
  readonly priorDurationMs?: number;
}

export interface JobPhaseChangedEvent extends JobEventBase {
  readonly type: "job.phase-changed";
  readonly phase: JobPhase;
}

/**
 * Progress reported by rsync or a measured walk. Missing totals stay missing:
 * a client must not turn `filesSeen` into a percentage without `filesTotal`.
 */
export interface JobProgressObservedEvent extends JobEventBase {
  readonly type: "job.progress-observed";
  readonly filesSeen?: number;
  readonly filesTotal?: number;
  readonly bytesDone?: number;
  readonly bytesTotal?: number;
  readonly lastItem?: string;
}

export interface JobSkippedEvent extends JobEventBase {
  readonly type: "job.skipped";
  readonly reachability: Exclude<Reachability, "ok">;
  readonly reason: string;
}

export interface CheckCompletedEvent extends JobEventBase {
  readonly type: "job.completed";
  readonly operation: "quick" | "deep";
  readonly result: {
    readonly outcome: ScanOutcome;
    readonly nChanges: number;
    readonly nNew?: number;
    readonly nExtra: number;
    readonly bytesPending: number;
    /** null proves no rsync invocation occurred, as with a missing folder. */
    readonly exitCode: number | null;
    readonly durationMs?: number;
  };
}

export interface SyncCompletedEvent extends JobEventBase {
  readonly type: "job.completed";
  readonly operation: "sync";
  readonly result: {
    readonly exitCode: number;
    readonly transferred: number;
  };
}

export interface JobFailedEvent extends JobEventBase {
  readonly type: "job.failed";
  readonly message: string;
  readonly exitCode: number | null;
}

export interface JobCancelledEvent extends JobEventBase {
  readonly type: "job.cancelled";
  readonly transferred?: number;
}

export type JobEvent =
  | JobStartedEvent
  | JobPhaseChangedEvent
  | JobProgressObservedEvent
  | JobSkippedEvent
  | CheckCompletedEvent
  | SyncCompletedEvent
  | JobFailedEvent
  | JobCancelledEvent;

export type EngineMessage =
  | SnapshotMessage
  | SyncPreflightMessage
  | DiffMessage
  | HistoryMessage
  | JobEvent;
