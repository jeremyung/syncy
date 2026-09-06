import {
  ENGINE_PROTOCOL_VERSION,
  type EngineMessage,
  type JobOperation,
  type JobPhase,
} from "./engine-protocol.ts";

export class ProtocolError extends Error {
  constructor(message: string) {
    super(`engine protocol: ${message}`);
    this.name = "ProtocolError";
  }
}

const MESSAGE_TYPES = new Set([
  "snapshot",
  "sync.preflight",
  "diff",
  "history",
  "job.started",
  "job.phase-changed",
  "job.progress-observed",
  "job.skipped",
  "job.completed",
  "job.failed",
  "job.cancelled",
]);
const OPERATIONS = new Set<JobOperation>(["quick", "deep", "sync", "setup"]);
const ACTORS = new Set(["cli", "mac", "scheduler"]);
const PHASES = new Set<JobPhase>([
  "queued",
  "inspecting-source",
  "checking-destination-identity",
  "running-preflight",
  "starting-rsync",
  "comparing-metadata",
  "comparing-content",
  "transferring",
  "fingerprinting-destination",
  "recording-evidence",
  "cancelling",
]);
const ACTIVE_PHASES = new Set([...PHASES, "completed", "skipped", "failed", "cancelled"]);
const REACHABILITY = new Set(["ok", "missing", "mismatch", "unreachable"]);
const CELL_STATES = new Set(["verified", "unverified", "behind", "missing", "unchecked", "error"]);
const OUTCOMES = new Set(["clean", "behind", "missing", "error"]);
const DIFF_KINDS = new Set(["new", "changed", "metadata", "extra"]);
const HISTORY_OUTCOMES = new Set([
  "started",
  "completed",
  "skipped",
  "failed",
  "cancelled",
  "missed",
]);
const HISTORY_OPERATIONS = new Set(["quick", "deep", "sync"]);

type RecordValue = Record<string, unknown>;

function record(value: unknown, where: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolError(`${where} must be an object`);
  }
  return value as RecordValue;
}

function string(value: unknown, where: string): asserts value is string {
  if (typeof value !== "string") throw new ProtocolError(`${where} must be a string`);
}

function finite(value: unknown, where: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProtocolError(`${where} must be a finite number`);
  }
}

function count(value: unknown, where: string): asserts value is number {
  finite(value, where);
  if (!Number.isInteger(value) || value < 0) {
    throw new ProtocolError(`${where} must be a non-negative integer`);
  }
}

function optionalCount(value: unknown, where: string): void {
  if (value !== undefined) count(value, where);
}

function member<T extends string>(
  value: unknown,
  values: ReadonlySet<T>,
  where: string,
): asserts value is T {
  if (typeof value !== "string" || !values.has(value as T)) {
    throw new ProtocolError(`${where} has an unknown value`);
  }
}

function bool(value: unknown, where: string): asserts value is boolean {
  if (typeof value !== "boolean") throw new ProtocolError(`${where} must be a boolean`);
}

function optionalBool(value: unknown, where: string): void {
  if (value !== undefined) bool(value, where);
}

function array(value: unknown, where: string): asserts value is unknown[] {
  if (!Array.isArray(value)) throw new ProtocolError(`${where} must be an array`);
}

function validateCell(value: unknown, where: string): void {
  const cell = record(value, where);
  string(cell["target"], `${where}.target`);
  member(cell["state"], CELL_STATES, `${where}.state`);
  string(cell["reason"], `${where}.reason`);
  string(cell["differenceSummary"], `${where}.differenceSummary`);
  if (cell["evidence"] !== undefined) {
    const evidence = record(cell["evidence"], `${where}.evidence`);
    bool(evidence["currentTarget"], `${where}.evidence.currentTarget`);
    for (const name of ["lastCheck", "deepCheck"] as const) {
      if (evidence[name] === undefined) continue;
      const check = record(evidence[name], `${where}.evidence.${name}`);
      member(check["method"], new Set(["quick", "deep"]), `${where}.evidence.${name}.method`);
      member(check["outcome"], OUTCOMES, `${where}.evidence.${name}.outcome`);
      finite(check["at"], `${where}.evidence.${name}.at`);
      if (check["durationMs"] !== undefined)
        finite(check["durationMs"], `${where}.evidence.${name}.durationMs`);
      count(check["nChanges"], `${where}.evidence.${name}.nChanges`);
      optionalCount(check["nFiles"], `${where}.evidence.${name}.nFiles`);
      count(check["nExtra"], `${where}.evidence.${name}.nExtra`);
      count(check["bytesPending"], `${where}.evidence.${name}.bytesPending`);
    }
    if (evidence["extrasObservedAt"] !== undefined)
      finite(evidence["extrasObservedAt"], `${where}.evidence.extrasObservedAt`);
  }
  count(cell["nChanges"], `${where}.nChanges`);
  optionalCount(cell["nFiles"], `${where}.nFiles`);
  optionalCount(cell["nNew"], `${where}.nNew`);
  count(cell["bytesPending"], `${where}.bytesPending`);
  count(cell["nExtra"], `${where}.nExtra`);
  optionalBool(cell["needsChecksum"], `${where}.needsChecksum`);
}

function validateFingerprint(value: unknown, where: string): void {
  const fp = record(value, where);
  count(fp["nfiles"], `${where}.nfiles`);
  count(fp["bytes"], `${where}.bytes`);
  string(fp["maxMtimeNs"], `${where}.maxMtimeNs`);
  if (fp["digest"] !== undefined) string(fp["digest"], `${where}.digest`);
  optionalBool(fp["complete"], `${where}.complete`);
}

function validateSnapshot(message: RecordValue): void {
  finite(message["generatedAt"], "snapshot.generatedAt");
  string(message["source"], "snapshot.source");
  string(message["configRevision"], "snapshot.configRevision");
  array(message["targets"], "snapshot.targets");
  message["targets"].forEach((value, index) => {
    const target = record(value, `snapshot.targets[${index}]`);
    string(target["name"], `snapshot.targets[${index}].name`);
    bool(target["required"], `snapshot.targets[${index}].required`);
    member(target["reachability"], REACHABILITY, `snapshot.targets[${index}].reachability`);
    string(target["reachabilityPhrase"], `snapshot.targets[${index}].reachabilityPhrase`);
    bool(target["usesSentinel"], `snapshot.targets[${index}].usesSentinel`);
  });
  array(message["units"], "snapshot.units");
  message["units"].forEach((value, index) => {
    const unit = record(value, `snapshot.units[${index}]`);
    string(unit["unit"], `snapshot.units[${index}].unit`);
    member(unit["state"], CELL_STATES, `snapshot.units[${index}].state`);
    string(unit["reason"], `snapshot.units[${index}].reason`);
    validateFingerprint(unit["fingerprint"], `snapshot.units[${index}].fingerprint`);
    array(unit["cells"], `snapshot.units[${index}].cells`);
    unit["cells"].forEach((cell, cellIndex) => {
      validateCell(cell, `snapshot.units[${index}].cells[${cellIndex}]`);
    });
  });
  if (message["activeJob"] !== undefined) {
    const active = record(message["activeJob"], "snapshot.activeJob");
    member(active["actor"], ACTORS, "snapshot.activeJob.actor");
    member(active["operation"], OPERATIONS, "snapshot.activeJob.operation");
    finite(active["startedAt"], "snapshot.activeJob.startedAt");
    finite(active["heartbeatAt"], "snapshot.activeJob.heartbeatAt");
    optionalCount(active["estimatedDurationMs"], "snapshot.activeJob.estimatedDurationMs");
    optionalCount(active["batchPosition"], "snapshot.activeJob.batchPosition");
    optionalCount(active["batchTotal"], "snapshot.activeJob.batchTotal");
    const batchPosition = active["batchPosition"];
    const batchTotal = active["batchTotal"];
    if ((batchPosition === undefined) !== (batchTotal === undefined)) {
      throw new ProtocolError("snapshot.activeJob batch position and total must appear together");
    }
    if (
      typeof batchPosition === "number" &&
      typeof batchTotal === "number" &&
      (batchPosition < 1 || batchPosition > batchTotal)
    ) {
      throw new ProtocolError("snapshot.activeJob.batchPosition must be between 1 and total");
    }
    if (active["activity"] !== undefined) {
      const activity = record(active["activity"], "snapshot.activeJob.activity");
      string(activity["unit"], "snapshot.activeJob.activity.unit");
      string(activity["target"], "snapshot.activeJob.activity.target");
      member(activity["phase"], ACTIVE_PHASES, "snapshot.activeJob.activity.phase");
      finite(activity["at"], "snapshot.activeJob.activity.at");
      optionalCount(activity["filesSeen"], "snapshot.activeJob.activity.filesSeen");
      optionalCount(activity["filesTotal"], "snapshot.activeJob.activity.filesTotal");
      optionalCount(activity["bytesDone"], "snapshot.activeJob.activity.bytesDone");
      optionalCount(activity["bytesTotal"], "snapshot.activeJob.activity.bytesTotal");
      if (activity["lastItem"] !== undefined) {
        string(activity["lastItem"], "snapshot.activeJob.activity.lastItem");
      }
    }
  }
}

function validateJobBase(message: RecordValue): JobOperation {
  string(message["jobId"], "job.jobId");
  finite(message["at"], "job.at");
  member(message["operation"], OPERATIONS, "job.operation");
  string(message["unit"], "job.unit");
  string(message["target"], "job.target");
  return message["operation"];
}

function validateSyncPreflight(message: RecordValue): void {
  finite(message["generatedAt"], "sync.preflight.generatedAt");
  string(message["unit"], "sync.preflight.unit");
  string(message["target"], "sync.preflight.target");
  array(message["argv"], "sync.preflight.argv");
  message["argv"].forEach((part, index) => {
    string(part, `sync.preflight.argv[${index}]`);
  });
  array(message["checks"], "sync.preflight.checks");
  message["checks"].forEach((value, index) => {
    const check = record(value, `sync.preflight.checks[${index}]`);
    string(check["name"], `sync.preflight.checks[${index}].name`);
    bool(check["ok"], `sync.preflight.checks[${index}].ok`);
    optionalBool(check["warn"], `sync.preflight.checks[${index}].warn`);
    string(check["detail"], `sync.preflight.checks[${index}].detail`);
  });
  bool(message["ok"], "sync.preflight.ok");
  count(message["nChanges"], "sync.preflight.nChanges");
  optionalCount(message["nFiles"], "sync.preflight.nFiles");
  optionalCount(message["nNew"], "sync.preflight.nNew");
  count(message["nExtra"], "sync.preflight.nExtra");
  count(message["bytesPending"], "sync.preflight.bytesPending");
  bool(message["needsChecksum"], "sync.preflight.needsChecksum");
  if (message["confirmationToken"] !== undefined) {
    string(message["confirmationToken"], "sync.preflight.confirmationToken");
  }
  if (message["expiresAt"] !== undefined) finite(message["expiresAt"], "sync.preflight.expiresAt");
  if (message["ok"] === true) {
    string(message["confirmationToken"], "sync.preflight.confirmationToken");
    finite(message["expiresAt"], "sync.preflight.expiresAt");
  }
}

function validateDiff(message: RecordValue): void {
  finite(message["generatedAt"], "diff.generatedAt");
  string(message["unit"], "diff.unit");
  string(message["target"], "diff.target");
  if (message["diff"] === null) return;
  const diff = record(message["diff"], "diff.diff");
  if (diff["version"] !== 1) throw new ProtocolError("diff.diff.version must be 1");
  string(diff["unit"], "diff.diff.unit");
  string(diff["target"], "diff.diff.target");
  if (diff["targetIdentity"] !== undefined)
    string(diff["targetIdentity"], "diff.diff.targetIdentity");
  if (message["provenance"] !== undefined) {
    const provenance = record(message["provenance"], "diff.provenance");
    string(provenance["targetIdentity"], "diff.provenance.targetIdentity");
    bool(provenance["identityMatches"], "diff.provenance.identityMatches");
    member(provenance["reachability"], REACHABILITY, "diff.provenance.reachability");
    bool(provenance["current"], "diff.provenance.current");
  }
  if (message["presentation"] !== undefined) {
    const presentation = record(message["presentation"], "diff.presentation");
    array(presentation["parts"], "diff.presentation.parts");
    presentation["parts"].forEach((part, index) => {
      const item = record(part, `diff.presentation.parts[${index}]`);
      member(item["kind"], DIFF_KINDS, `diff.presentation.parts[${index}].kind`);
      count(item["count"], `diff.presentation.parts[${index}].count`);
      string(item["label"], `diff.presentation.parts[${index}].label`);
    });
    count(presentation["copyableFiles"], "diff.presentation.copyableFiles");
  }
  finite(diff["ts"], "diff.diff.ts");
  string(diff["method"], "diff.diff.method");
  count(diff["truncated"], "diff.diff.truncated");
  bool(diff["wholeFolderMissing"], "diff.diff.wholeFolderMissing");
  array(diff["entries"], "diff.diff.entries");
  diff["entries"].forEach((value, index) => {
    const entry = record(value, `diff.diff.entries[${index}]`);
    member(entry["kind"], DIFF_KINDS, `diff.diff.entries[${index}].kind`);
    string(entry["name"], `diff.diff.entries[${index}].name`);
    count(entry["bytes"], `diff.diff.entries[${index}].bytes`);
    string(entry["flags"], `diff.diff.entries[${index}].flags`);
    bool(entry["dir"], `diff.diff.entries[${index}].dir`);
    bool(entry["sized"], `diff.diff.entries[${index}].sized`);
    if (entry["mtime"] !== undefined) finite(entry["mtime"], `diff.diff.entries[${index}].mtime`);
  });
}

function validateHistory(message: RecordValue): void {
  finite(message["generatedAt"], "history.generatedAt");
  array(message["entries"], "history.entries");
  message["entries"].forEach((value, index) => {
    const entry = record(value, `history.entries[${index}]`);
    finite(entry["ts"], `history.entries[${index}].ts`);
    string(entry["unit"], `history.entries[${index}].unit`);
    string(entry["target"], `history.entries[${index}].target`);
    member(entry["operation"], HISTORY_OPERATIONS, `history.entries[${index}].operation`);
    member(entry["outcome"], HISTORY_OUTCOMES, `history.entries[${index}].outcome`);
    if (entry["exitCode"] !== null) finite(entry["exitCode"], `history.entries[${index}].exitCode`);
    if (entry["detail"] !== undefined) string(entry["detail"], `history.entries[${index}].detail`);
    if (entry["log"] !== undefined) string(entry["log"], `history.entries[${index}].log`);
  });
}

function validateJob(message: RecordValue): void {
  const operation = validateJobBase(message);
  switch (message["type"]) {
    case "job.started": {
      if (message["phase"] !== "queued") {
        throw new ProtocolError('job.started.phase must be "queued"');
      }
      const batchValue = message["batch"];
      if (batchValue !== undefined) {
        const batch = record(batchValue, "job.started.batch");
        count(batch["position"], "job.started.batch.position");
        count(batch["total"], "job.started.batch.total");
        count(batch["bytesDone"], "job.started.batch.bytesDone");
        count(batch["bytesTotal"], "job.started.batch.bytesTotal");
        if (batch["position"] < 1 || batch["position"] > batch["total"]) {
          throw new ProtocolError("job.started.batch.position must be between 1 and total");
        }
      }
      const unitSize = record(message["unitSize"], "job.started.unitSize");
      optionalCount(unitSize["files"], "job.started.unitSize.files");
      count(unitSize["bytes"], "job.started.unitSize.bytes");
      optionalCount(message["estimatedDurationMs"], "job.started.estimatedDurationMs");
      return;
    }
    case "job.phase-changed":
      member(message["phase"], PHASES, "job.phase-changed.phase");
      return;
    case "job.progress-observed": {
      const fields = ["filesSeen", "filesTotal", "bytesDone", "bytesTotal", "lastItem"];
      if (!fields.some((key) => message[key] !== undefined)) {
        throw new ProtocolError("job.progress-observed must contain an observation");
      }
      optionalCount(message["filesSeen"], "job.progress-observed.filesSeen");
      optionalCount(message["filesTotal"], "job.progress-observed.filesTotal");
      optionalCount(message["bytesDone"], "job.progress-observed.bytesDone");
      optionalCount(message["bytesTotal"], "job.progress-observed.bytesTotal");
      if (message["lastItem"] !== undefined) {
        string(message["lastItem"], "job.progress-observed.lastItem");
      }
      return;
    }
    case "job.skipped":
      member(message["reachability"], REACHABILITY, "job.skipped.reachability");
      if (message["reachability"] === "ok") {
        throw new ProtocolError('job.skipped.reachability cannot be "ok"');
      }
      string(message["reason"], "job.skipped.reason");
      return;
    case "job.completed": {
      const result = record(message["result"], "job.completed.result");
      if (operation === "sync") {
        finite(result["exitCode"], "job.completed.result.exitCode");
        count(result["transferred"], "job.completed.result.transferred");
        return;
      }
      member(result["outcome"], OUTCOMES, "job.completed.result.outcome");
      count(result["nChanges"], "job.completed.result.nChanges");
      optionalCount(result["nNew"], "job.completed.result.nNew");
      optionalCount(result["nFiles"], "job.completed.result.nFiles");
      count(result["nExtra"], "job.completed.result.nExtra");
      count(result["bytesPending"], "job.completed.result.bytesPending");
      if (result["exitCode"] !== null) {
        finite(result["exitCode"], "job.completed.result.exitCode");
      }
      optionalCount(result["durationMs"], "job.completed.result.durationMs");
      return;
    }
    case "job.failed":
      string(message["message"], "job.failed.message");
      if (message["exitCode"] !== null) finite(message["exitCode"], "job.failed.exitCode");
      return;
    case "job.cancelled":
      optionalCount(message["transferred"], "job.cancelled.transferred");
      return;
  }
  throw new ProtocolError("message type is not implemented");
}

/** Runtime validation is part of the boundary: TypeScript types do not cross a pipe. */
export function assertEngineMessage(value: unknown): asserts value is EngineMessage {
  const message = record(value, "message");
  if (message["protocolVersion"] !== ENGINE_PROTOCOL_VERSION) {
    throw new ProtocolError(
      `unsupported version ${String(message["protocolVersion"])}; expected ${ENGINE_PROTOCOL_VERSION}`,
    );
  }
  member(message["type"], MESSAGE_TYPES, "message.type");
  if (message["type"] === "snapshot") validateSnapshot(message);
  else if (message["type"] === "sync.preflight") validateSyncPreflight(message);
  else if (message["type"] === "diff") validateDiff(message);
  else if (message["type"] === "history") validateHistory(message);
  else validateJob(message);
}

/** One complete JSON Lines record, including its framing newline. */
export function serializeEngineMessage(message: EngineMessage): string {
  assertEngineMessage(message);
  return `${JSON.stringify(message)}\n`;
}

/** Parse one record. Framing newlines may be present; blank records are invalid. */
export function parseEngineMessage(line: string): EngineMessage {
  const recordText = line.endsWith("\n") ? line.slice(0, -1).replace(/\r$/, "") : line;
  if (recordText === "") throw new ProtocolError("blank record");
  let value: unknown;
  try {
    value = JSON.parse(recordText);
  } catch (error) {
    throw new ProtocolError(
      `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assertEngineMessage(value);
  return value;
}

/**
 * Incrementally frames stdout chunks. A final record does not need a newline;
 * `finish` validates it instead of silently dropping it.
 */
export class EngineMessageDecoder {
  private carry = "";

  push(chunk: string): EngineMessage[] {
    this.carry += chunk;
    const messages: EngineMessage[] = [];
    let newline = this.carry.indexOf("\n");
    while (newline >= 0) {
      const line = this.carry.slice(0, newline);
      this.carry = this.carry.slice(newline + 1);
      messages.push(parseEngineMessage(line.replace(/\r$/, "")));
      newline = this.carry.indexOf("\n");
    }
    return messages;
  }

  finish(): EngineMessage[] {
    if (this.carry === "") return [];
    const final = this.carry;
    this.carry = "";
    return [parseEngineMessage(final)];
  }
}
