import Foundation

private final class ProcessBox: @unchecked Sendable {
  let process: Process
  init(_ process: Process) { self.process = process }
}

public protocol EngineClient: Sendable {
  func snapshot() async throws -> EngineSnapshot
  func runCheck(
    _ operation: EngineCheckOperation, unit: String?, actor: EngineActor,
    onEvent: @escaping JobEventHandler
  ) async throws
  func doctor() async throws -> String
  func prepareSync(unit: String, target: String) async throws -> SyncPreflight
  func runSync(
    confirmationToken: String, actor: EngineActor, onEvent: @escaping JobEventHandler
  ) async throws
  func setSource(path: String) async throws -> EngineSnapshot
  func addDestination(path: String, name: String) async throws -> EngineSnapshot
  func adoptDestination(name: String) async throws -> EngineSnapshot
  func removeDestination(name: String) async throws -> EngineSnapshot
  func differences(unit: String, target: String) async throws -> DiffEnvelope
  func history() async throws -> [HistorySnapshotEntry]
  func recordMissed(schedule: CheckSchedule, due: Date) async throws
}

extension EngineClient {
  public func runCheck(_ operation: EngineCheckOperation, unit: String?) async throws {
    try await runCheck(operation, unit: unit, actor: .mac, onEvent: { _ in })
  }

  public func runCheck(
    _ operation: EngineCheckOperation, unit: String?, actor: EngineActor
  ) async throws {
    try await runCheck(operation, unit: unit, actor: actor, onEvent: { _ in })
  }

  public func runSync(confirmationToken: String) async throws {
    try await runSync(confirmationToken: confirmationToken, actor: .mac, onEvent: { _ in })
  }

  public func runSync(confirmationToken: String, actor: EngineActor) async throws {
    try await runSync(confirmationToken: confirmationToken, actor: actor, onEvent: { _ in })
  }
}

public typealias JobEventHandler = @Sendable (JobEventSnapshot) -> Void

public enum EngineActor: String, Sendable {
  case mac
  case scheduler
}

public enum EngineCheckOperation: String, Sendable {
  case quick = "check"
  case deep = "verify"

  public var readerTitle: String {
    self == .deep ? "Deep verify" : "Quick check"
  }
}

public struct JobBatchSnapshot: Decodable, Sendable {
  public let position: Int64
  public let total: Int64
  public let bytesDone: Int64
  public let bytesTotal: Int64
}

public struct JobUnitSizeSnapshot: Decodable, Sendable {
  public let files: Int64?
  public let bytes: Int64
}

public struct JobResultSnapshot: Decodable, Sendable {
  public let outcome: String?
  public let nChanges: Int64?
  public let nFiles: Int64?
  public let nNew: Int64?
  public let nExtra: Int64?
  public let bytesPending: Int64?
  public let exitCode: Int32?
  public let durationMs: Double?
  public let transferred: Int64?
}

/// One literal JSONL observation from the engine. Missing progress values remain missing.
public struct JobEventSnapshot: Decodable, Sendable {
  public let protocolVersion: Int
  public let type: String
  public let jobId: String
  public let at: Double
  public let operation: String
  public let unit: String
  public let target: String
  public let phase: String?
  public let batch: JobBatchSnapshot?
  public let unitSize: JobUnitSizeSnapshot?
  public let priorDurationMs: Double?
  public let filesSeen: Int64?
  public let filesTotal: Int64?
  public let bytesDone: Int64?
  public let bytesTotal: Int64?
  public let lastItem: String?
  public let reachability: Reachability?
  public let reason: String?
  public let result: JobResultSnapshot?
  public let message: String?
  public let exitCode: Int32?
  public let transferred: Int64?

  public init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    protocolVersion = try values.decode(Int.self, forKey: .protocolVersion)
    type = try values.decode(String.self, forKey: .type)
    jobId = try values.decode(String.self, forKey: .jobId)
    at = try values.decode(Double.self, forKey: .at)
    operation = try values.decode(String.self, forKey: .operation)
    unit = try values.decode(String.self, forKey: .unit)
    target = try values.decode(String.self, forKey: .target)
    phase = try values.decodeIfPresent(String.self, forKey: .phase)
    batch = try values.decodeIfPresent(JobBatchSnapshot.self, forKey: .batch)
    unitSize = try values.decodeIfPresent(JobUnitSizeSnapshot.self, forKey: .unitSize)
    priorDurationMs = try values.decodeIfPresent(Double.self, forKey: .priorDurationMs)
    filesSeen = try values.decodeIfPresent(Int64.self, forKey: .filesSeen)
    filesTotal = try values.decodeIfPresent(Int64.self, forKey: .filesTotal)
    bytesDone = try values.decodeIfPresent(Int64.self, forKey: .bytesDone)
    bytesTotal = try values.decodeIfPresent(Int64.self, forKey: .bytesTotal)
    lastItem = try values.decodeIfPresent(String.self, forKey: .lastItem)
    reachability = try values.decodeIfPresent(Reachability.self, forKey: .reachability)
    reason = try values.decodeIfPresent(String.self, forKey: .reason)
    result = try values.decodeIfPresent(JobResultSnapshot.self, forKey: .result)
    message = try values.decodeIfPresent(String.self, forKey: .message)
    exitCode = try values.decodeIfPresent(Int32.self, forKey: .exitCode)
    transferred = try values.decodeIfPresent(Int64.self, forKey: .transferred)

    guard protocolVersion == 1 else {
      throw EngineClientError.protocolFailure("unsupported job event version \(protocolVersion)")
    }
    guard
      Self.allowedTypes.contains(type), Self.allowedOperations.contains(operation), at.isFinite
    else {
      throw EngineClientError.protocolFailure("invalid job event")
    }
    let counts = [
      filesSeen, filesTotal, bytesDone, bytesTotal, batch?.position, batch?.total,
      batch?.bytesDone, batch?.bytesTotal, unitSize?.files, unitSize?.bytes,
      result?.nChanges, result?.nFiles, result?.nNew, result?.nExtra,
      result?.bytesPending, result?.transferred, transferred,
    ]
    guard counts.allSatisfy({ $0.map { $0 >= 0 } ?? true }) else {
      throw EngineClientError.protocolFailure("job event contains a negative count")
    }
    guard priorDurationMs.map({ $0.isFinite && $0 >= 0 }) ?? true,
      result?.durationMs.map({ $0.isFinite && $0 >= 0 }) ?? true
    else {
      throw EngineClientError.protocolFailure("job event contains an invalid duration")
    }
    if let batch {
      guard batch.total > 0, batch.position > 0, batch.position <= batch.total else {
        throw EngineClientError.protocolFailure("job event contains an invalid batch position")
      }
    }
    switch type {
    case "job.started":
      guard phase == "queued", unitSize != nil else {
        throw EngineClientError.protocolFailure("invalid job.started event")
      }
    case "job.phase-changed":
      guard phase.map({ Self.allowedPhases.contains($0) }) == true else {
        throw EngineClientError.protocolFailure("invalid job.phase-changed event")
      }
    case "job.progress-observed":
      guard
        [filesSeen, filesTotal, bytesDone, bytesTotal].contains(where: { $0 != nil })
          || lastItem != nil
      else {
        throw EngineClientError.protocolFailure("progress event contains no observation")
      }
    case "job.skipped":
      guard let reachability, reachability != .ok, reason != nil else {
        throw EngineClientError.protocolFailure("invalid job.skipped event")
      }
    case "job.completed":
      guard let result else {
        throw EngineClientError.protocolFailure("completed event contains no result")
      }
      if operation == "sync" {
        guard result.exitCode != nil, result.transferred != nil else {
          throw EngineClientError.protocolFailure("invalid completed sync event")
        }
      } else {
        guard result.outcome.map({ Self.allowedOutcomes.contains($0) }) == true,
          result.nChanges != nil, result.nExtra != nil, result.bytesPending != nil
        else {
          throw EngineClientError.protocolFailure("invalid completed check event")
        }
      }
    case "job.failed":
      guard message != nil else {
        throw EngineClientError.protocolFailure("failed event contains no message")
      }
    case "job.cancelled":
      break
    default:
      preconditionFailure("allowed job event was not validated")
    }
  }

  private static let allowedTypes: Set<String> = [
    "job.started", "job.phase-changed", "job.progress-observed", "job.skipped",
    "job.completed", "job.failed", "job.cancelled",
  ]
  private static let allowedOperations: Set<String> = ["quick", "deep", "sync", "setup"]
  private static let allowedPhases: Set<String> = [
    "queued", "inspecting-source", "checking-destination-identity", "running-preflight",
    "starting-rsync", "comparing-metadata", "comparing-content", "transferring",
    "fingerprinting-destination", "recording-evidence", "cancelling",
  ]
  private static let allowedOutcomes: Set<String> = ["clean", "behind", "missing", "error"]

  private enum CodingKeys: String, CodingKey {
    case protocolVersion, type, jobId, at, operation, unit, target, phase, batch, unitSize
    case priorDurationMs, filesSeen, filesTotal, bytesDone, bytesTotal, lastItem, reachability
    case reason, result, message, exitCode, transferred
  }
}

public struct SyncGuardCheck: Decodable, Identifiable, Sendable {
  public var id: String { name }
  public let name: String
  public let ok: Bool
  public let warn: Bool?
  public let detail: String
}

public struct SyncPreflight: Decodable, Sendable {
  public let protocolVersion: Int
  public let type: String
  public let generatedAt: Double
  public let unit: String
  public let target: String
  public let argv: [String]
  public let checks: [SyncGuardCheck]
  public let ok: Bool
  public let nChanges: Int64
  public let nFiles: Int64?
  public let nNew: Int64?
  public let nExtra: Int64
  public let bytesPending: Int64
  public let needsChecksum: Bool
  public let confirmationToken: String?
  public let expiresAt: Double?
}

public struct DiffEntrySnapshot: Decodable, Identifiable, Sendable {
  public var id: String { "\(kind):\(name)" }
  public let kind: String
  public let name: String
  public let bytes: Int64
  public let flags: String
  public let dir: Bool
  public let sized: Bool
  public let mtime: Double?
}

public struct RecordedDiff: Decodable, Sendable {
  public let version: Int
  public let unit: String
  public let target: String
  public let ts: Double
  public let method: String
  public let entries: [DiffEntrySnapshot]
  public let truncated: Int64
  public let wholeFolderMissing: Bool
  public let targetIdentity: String?
  public let sourceHolds: FingerprintSnapshot?
  public let targetHolds: FingerprintSnapshot?
}

public struct DiffPresentationPart: Decodable, Identifiable, Sendable {
  public var id: String { kind }
  public let kind: String
  public let count: Int64
  public let label: String
}

public struct DiffPresentationSnapshot: Decodable, Sendable {
  public let parts: [DiffPresentationPart]
  public let copyableFiles: Int64
}

public struct DiffProvenanceSnapshot: Decodable, Sendable {
  public let targetIdentity: String
  public let identityMatches: Bool?
  public let reachability: Reachability?
  public let current: Bool
}

public struct DiffEnvelope: Decodable, Sendable {
  public let protocolVersion: Int
  public let type: String
  public let generatedAt: Double
  public let unit: String
  public let target: String
  public let diff: RecordedDiff?
  public let presentation: DiffPresentationSnapshot?
  public let provenance: DiffProvenanceSnapshot?
}

public struct HistorySnapshotEntry: Decodable, Identifiable, Sendable {
  public var id: String { "\(ts):\(unit):\(target):\(operation):\(outcome)" }
  public let ts: Double
  public let unit: String
  public let target: String
  public let operation: String
  public let outcome: String
  public let exitCode: Int32?
  public let detail: String?
  public let log: String?
}

private struct HistoryEnvelope: Decodable {
  let protocolVersion: Int
  let type: String
  let entries: [HistorySnapshotEntry]
}

public enum Reachability: String, Codable, Sendable {
  case ok
  case missing
  case mismatch
  case unreachable

  public var ledgerPhrase: String {
    switch self {
    case .ok: "connected"
    case .missing: "no sentinel found"
    case .mismatch: "different volume"
    case .unreachable: "not connected"
    }
  }
}

public struct TargetSnapshot: Codable, Identifiable, Sendable {
  public var id: String { name }
  public let name: String
  public let required: Bool
  public let reachability: Reachability
  public let reachabilityPhrase: String?
  public let usesSentinel: Bool
}

public struct FingerprintSnapshot: Decodable, Sendable {
  public let nfiles: Int64
  public let bytes: Int64
  public let maxMtimeNs: String
  public let digest: String?
  public let complete: Bool?

  public init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    nfiles = try values.decode(Int64.self, forKey: .nfiles)
    bytes = try values.decode(Int64.self, forKey: .bytes)
    maxMtimeNs = try values.decode(String.self, forKey: .maxMtimeNs)
    digest = values.contains(.digest) ? try values.decode(String.self, forKey: .digest) : nil
    complete = values.contains(.complete) ? try values.decode(Bool.self, forKey: .complete) : nil
  }

  private enum CodingKeys: String, CodingKey {
    case nfiles, bytes, maxMtimeNs, digest, complete
  }
}

public struct CheckEvidenceSnapshot: Decodable, Sendable {
  public let method: String
  public let outcome: String
  public let at: Double
  public let durationMs: Double?
  public let nChanges: Int64
  public let nFiles: Int64?
  public let nExtra: Int64
  public let bytesPending: Int64
}

public struct CellEvidenceSnapshot: Decodable, Sendable {
  public let currentTarget: Bool
  public let lastCheck: CheckEvidenceSnapshot?
  public let deepCheck: CheckEvidenceSnapshot?
  public let extrasObservedAt: Double?
}

public struct CellSnapshot: Decodable, Identifiable, Sendable {
  public var id: String { target }
  public let target: String
  public let state: LedgerState
  public let reason: String
  public let differenceSummary: String?
  public let evidence: CellEvidenceSnapshot?
  public let nChanges: Int64
  public let nFiles: Int64?
  public let nNew: Int64?
  public let bytesPending: Int64
  public let nExtra: Int64
  public let needsChecksum: Bool?

  public init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    target = try values.decode(String.self, forKey: .target)
    state = try values.decode(LedgerState.self, forKey: .state)
    reason = try values.decode(String.self, forKey: .reason)
    differenceSummary = try values.decodeIfPresent(String.self, forKey: .differenceSummary)
    evidence = try values.decodeIfPresent(CellEvidenceSnapshot.self, forKey: .evidence)
    nChanges = try values.decode(Int64.self, forKey: .nChanges)
    nFiles = try values.decodeIfPresent(Int64.self, forKey: .nFiles)
    nNew = values.contains(.nNew) ? try values.decode(Int64.self, forKey: .nNew) : nil
    bytesPending = try values.decode(Int64.self, forKey: .bytesPending)
    nExtra = try values.decode(Int64.self, forKey: .nExtra)
    needsChecksum =
      values.contains(.needsChecksum)
      ? try values.decode(Bool.self, forKey: .needsChecksum) : nil
  }

  private enum CodingKeys: String, CodingKey {
    case target, state, reason, differenceSummary, evidence, nChanges, nFiles, nNew, bytesPending, nExtra,
      needsChecksum
  }
}

public struct UnitSnapshot: Decodable, Identifiable, Sendable {
  public var id: String { unit }
  public let unit: String
  public let state: LedgerState
  public let reason: String
  public let fingerprint: FingerprintSnapshot
  public let cells: [CellSnapshot]

  public func cell(for target: String) -> CellSnapshot? {
    cells.first { $0.target == target }
  }
}

public struct ActiveJobSnapshot: Decodable, Sendable {
  public let actor: String
  public let operation: String
  public let startedAt: Double
  public let heartbeatAt: Double
  public let activity: ActiveJobActivity?
  public let priorDurationMs: Double?
  public let batchPosition: Int64?
  public let batchTotal: Int64?

  public init(
    actor: String, operation: String, startedAt: Double, heartbeatAt: Double,
    activity: ActiveJobActivity?, priorDurationMs: Double? = nil,
    batchPosition: Int64? = nil, batchTotal: Int64? = nil
  ) {
    self.actor = actor
    self.operation = operation
    self.startedAt = startedAt
    self.heartbeatAt = heartbeatAt
    self.activity = activity
    self.priorDurationMs = priorDurationMs
    self.batchPosition = batchPosition
    self.batchTotal = batchTotal
  }
}

public struct ActiveJobActivity: Decodable, Sendable {
  public let unit: String
  public let target: String
  public let phase: String
  public let at: Double
  public let filesSeen: Int64?
  public let filesTotal: Int64?
  public let bytesDone: Int64?
  public let bytesTotal: Int64?
  public let lastItem: String?

  public init(
    unit: String, target: String, phase: String, at: Double, filesSeen: Int64? = nil,
    filesTotal: Int64? = nil, bytesDone: Int64? = nil, bytesTotal: Int64? = nil,
    lastItem: String? = nil
  ) {
    self.unit = unit
    self.target = target
    self.phase = phase
    self.at = at
    self.filesSeen = filesSeen
    self.filesTotal = filesTotal
    self.bytesDone = bytesDone
    self.bytesTotal = bytesTotal
    self.lastItem = lastItem
  }
}

public struct EngineSnapshot: Decodable, Sendable {
  public let protocolVersion: Int
  public let type: String
  public let generatedAt: Double
  public let source: String
  public let configRevision: String
  public let targets: [TargetSnapshot]
  public let units: [UnitSnapshot]
  public let activeJob: ActiveJobSnapshot?

  public init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    protocolVersion = try values.decode(Int.self, forKey: .protocolVersion)
    guard protocolVersion == 1 else {
      throw EngineClientError.protocolFailure(
        "unsupported version \(protocolVersion); expected 1")
    }
    type = try values.decode(String.self, forKey: .type)
    guard type == "snapshot" else {
      throw EngineClientError.protocolFailure("expected snapshot, received \(type)")
    }
    generatedAt = try values.decode(Double.self, forKey: .generatedAt)
    guard generatedAt.isFinite else {
      throw EngineClientError.protocolFailure("generatedAt must be finite")
    }
    source = try values.decode(String.self, forKey: .source)
    configRevision = try values.decode(String.self, forKey: .configRevision)
    targets = try values.decode([TargetSnapshot].self, forKey: .targets)
    units = try values.decode([UnitSnapshot].self, forKey: .units)
    activeJob = try values.decodeIfPresent(ActiveJobSnapshot.self, forKey: .activeJob)

    for (index, unit) in units.enumerated() {
      guard unit.fingerprint.nfiles >= 0, unit.fingerprint.bytes >= 0 else {
        throw EngineClientError.protocolFailure(
          "units[\(index)].fingerprint contains a negative count")
      }
      for (cellIndex, cell) in unit.cells.enumerated() {
        guard
          cell.nChanges >= 0, cell.nFiles.map({ $0 >= 0 }) ?? true,
          cell.nNew.map({ $0 >= 0 }) ?? true,
          cell.bytesPending >= 0, cell.nExtra >= 0
        else {
          throw EngineClientError.protocolFailure(
            "units[\(index)].cells[\(cellIndex)] contains a negative count")
        }
      }
    }
    if let activity = activeJob?.activity {
      let counts = [activity.filesSeen, activity.filesTotal, activity.bytesDone, activity.bytesTotal]
      guard counts.allSatisfy({ $0.map { $0 >= 0 } ?? true }) else {
        throw EngineClientError.protocolFailure("activeJob.activity contains a negative count")
      }
    }
  }

  private enum CodingKeys: String, CodingKey {
    case protocolVersion, type, generatedAt, source, configRevision, targets, units, activeJob
  }
}

public enum EngineClientError: LocalizedError, Sendable {
  case engineNotFound
  case launchFailed(String)
  case exited(Int32, String)
  case emptyOutput
  case protocolFailure(String)

  public var errorDescription: String? {
    switch self {
    case .engineNotFound:
      "Syncy engine not found · set SYNCY_ENGINE or bundle syncy-engine"
    case .launchFailed(let detail):
      "Syncy engine could not start · \(detail)"
    case .exited(let status, let detail):
      detail.isEmpty
        ? "Syncy engine exited with status \(status)"
        : "Syncy engine exited with status \(status) · \(detail)"
    case .emptyOutput:
      "Syncy engine returned no snapshot"
    case .protocolFailure(let detail):
      "Syncy engine protocol error · \(detail)"
    }
  }
}

public struct ProcessEngineClient: EngineClient {
  public let executableURL: URL

  public init(executableURL: URL) {
    self.executableURL = executableURL
  }

  public static func located(
    environment: [String: String] = ProcessInfo.processInfo.environment,
    bundle: Bundle = .main
  ) throws -> ProcessEngineClient {
    if let path = environment["SYNCY_ENGINE"], !path.isEmpty {
      return ProcessEngineClient(executableURL: URL(fileURLWithPath: path))
    }
    if let bundled = bundle.url(forAuxiliaryExecutable: "syncy-engine") {
      return ProcessEngineClient(executableURL: bundled)
    }
    throw EngineClientError.engineNotFound
  }

  public func snapshot() async throws -> EngineSnapshot {
    let executableURL = executableURL
    return try await Task.detached(priority: .userInitiated) {
      try await Self.loadSnapshot(executableURL: executableURL, arguments: ["engine", "snapshot"])
    }.value
  }

  public func runCheck(
    _ operation: EngineCheckOperation, unit: String?, actor: EngineActor,
    onEvent: @escaping JobEventHandler
  ) async throws {
    let executableURL = executableURL
    let worker = Task.detached(priority: .userInitiated) {
      try await Self.runJob(
        executableURL: executableURL,
        arguments: [operation.rawValue] + (unit.map { [$0] } ?? []), actor: actor,
        onEvent: onEvent)
    }
    try await withTaskCancellationHandler {
      try await worker.value
    } onCancel: {
      worker.cancel()
    }
  }

  public func doctor() async throws -> String {
    let executableURL = executableURL
    return try await Task.detached(priority: .userInitiated) {
      try await Self.runText(executableURL: executableURL, arguments: ["doctor"])
    }.value
  }

  public func prepareSync(unit: String, target: String) async throws -> SyncPreflight {
    let executableURL = executableURL
    return try await Task.detached(priority: .userInitiated) {
      let text = try await Self.runText(
        executableURL: executableURL,
        arguments: ["engine", "preflight", unit, target])
      do {
        let prepared = try JSONDecoder().decode(SyncPreflight.self, from: Data(text.utf8))
        guard prepared.protocolVersion == 1, prepared.type == "sync.preflight" else {
          throw EngineClientError.protocolFailure("invalid sync preflight envelope")
        }
        guard prepared.nChanges >= 0, prepared.nExtra >= 0, prepared.bytesPending >= 0 else {
          throw EngineClientError.protocolFailure("sync preflight contains a negative count")
        }
        if prepared.ok && (prepared.confirmationToken == nil || prepared.expiresAt == nil) {
          throw EngineClientError.protocolFailure("successful preflight has no confirmation")
        }
        return prepared
      } catch let error as EngineClientError {
        throw error
      } catch {
        throw EngineClientError.protocolFailure(error.localizedDescription)
      }
    }.value
  }

  public func runSync(
    confirmationToken: String, actor: EngineActor, onEvent: @escaping JobEventHandler
  ) async throws {
    let executableURL = executableURL
    let worker = Task.detached(priority: .userInitiated) {
      try await Self.runJob(
        executableURL: executableURL, arguments: ["sync", confirmationToken], actor: actor,
        onEvent: onEvent)
    }
    try await withTaskCancellationHandler {
      try await worker.value
    } onCancel: {
      worker.cancel()
    }
  }

  public func setSource(path: String) async throws -> EngineSnapshot {
    try await mutate(arguments: ["engine", "set-source", path])
  }

  public func addDestination(path: String, name: String) async throws -> EngineSnapshot {
    try await mutate(arguments: ["engine", "add-destination", path, name])
  }

  public func adoptDestination(name: String) async throws -> EngineSnapshot {
    try await mutate(arguments: ["engine", "adopt-destination", name])
  }

  public func removeDestination(name: String) async throws -> EngineSnapshot {
    try await mutate(arguments: ["engine", "remove-destination", name])
  }

  public func differences(unit: String, target: String) async throws -> DiffEnvelope {
    let executableURL = executableURL
    return try await Task.detached(priority: .userInitiated) {
      let text = try await Self.runText(
        executableURL: executableURL, arguments: ["engine", "diff", unit, target])
      let envelope = try JSONDecoder().decode(DiffEnvelope.self, from: Data(text.utf8))
      guard envelope.protocolVersion == 1, envelope.type == "diff" else {
        throw EngineClientError.protocolFailure("invalid differences envelope")
      }
      return envelope
    }.value
  }

  public func history() async throws -> [HistorySnapshotEntry] {
    let executableURL = executableURL
    return try await Task.detached(priority: .userInitiated) {
      let text = try await Self.runText(
        executableURL: executableURL, arguments: ["engine", "history"])
      let envelope = try JSONDecoder().decode(HistoryEnvelope.self, from: Data(text.utf8))
      guard envelope.protocolVersion == 1, envelope.type == "history" else {
        throw EngineClientError.protocolFailure("invalid history envelope")
      }
      return envelope.entries
    }.value
  }

  public func recordMissed(schedule: CheckSchedule, due: Date) async throws {
    let executableURL = executableURL
    _ = try await Task.detached(priority: .utility) {
      try await Self.runText(
        executableURL: executableURL,
        arguments: [
          "engine", "record-missed", schedule.operation.rawValue, schedule.unit ?? "*",
          String(Int64(due.timeIntervalSince1970 * 1_000)),
          schedule.target ?? "*",
        ])
    }.value
  }

  private func mutate(arguments: [String]) async throws -> EngineSnapshot {
    let executableURL = executableURL
    return try await Task.detached(priority: .userInitiated) {
      try await Self.loadSnapshot(executableURL: executableURL, arguments: arguments)
    }.value
  }

  private static func loadSnapshot(executableURL: URL, arguments: [String]) async throws
    -> EngineSnapshot
  {
    let process = Process()
    let stdout = Pipe()
    let stderr = Pipe()
    process.executableURL = executableURL
    process.arguments = arguments
    process.standardOutput = stdout
    process.standardError = stderr

    do {
      try process.run()
    } catch {
      throw EngineClientError.launchFailed(error.localizedDescription)
    }

    let errorHandle = stderr.fileHandleForReading
    let errorReader = Task.detached { errorHandle.readDataToEndOfFile() }
    let output = stdout.fileHandleForReading.readDataToEndOfFile()
    let errorOutput = await errorReader.value
    process.waitUntilExit()

    let errorText =
      String(data: errorOutput, encoding: .utf8)?
      .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard process.terminationStatus == 0 else {
      throw EngineClientError.exited(process.terminationStatus, errorText)
    }
    guard !output.isEmpty else { throw EngineClientError.emptyOutput }

    do {
      return try JSONDecoder().decode(EngineSnapshot.self, from: output)
    } catch let error as EngineClientError {
      throw error
    } catch {
      throw EngineClientError.protocolFailure(error.localizedDescription)
    }
  }

  private static func runJob(
    executableURL: URL, arguments: [String], actor: EngineActor,
    onEvent: @escaping JobEventHandler
  ) async throws {
    let process = Process()
    let processBox = ProcessBox(process)
    let stdout = Pipe()
    let stderr = Pipe()
    process.executableURL = executableURL
    process.arguments = ["engine"] + arguments
    process.environment = ProcessInfo.processInfo.environment.merging(["SYNCY_ACTOR": actor.rawValue]) {
      _, requested in requested
    }
    process.standardOutput = stdout
    process.standardError = stderr

    let pair: (Data, Data) = try await withTaskCancellationHandler {
      try Task.checkCancellation()
      do {
        try process.run()
      } catch {
        throw EngineClientError.launchFailed(error.localizedDescription)
      }
      defer {
        if process.isRunning { process.terminate() }
      }
      if Task.isCancelled { process.terminate() }
      let errorHandle = stderr.fileHandleForReading
      let errorReader = Task.detached { errorHandle.readDataToEndOfFile() }
      var output = Data()
      var pending: [UInt8] = []
      while let chunk = try stdout.fileHandleForReading.read(upToCount: 64 * 1_024), !chunk.isEmpty {
        output.append(chunk)
        pending.append(contentsOf: chunk)
        while let newline = pending.firstIndex(of: 0x0A) {
          let line = Data(pending[..<newline])
          pending.removeFirst(newline + 1)
          if !line.isEmpty { onEvent(try decodeJobEvent(line)) }
        }
      }
      if !pending.isEmpty { onEvent(try decodeJobEvent(Data(pending))) }
      let errorOutput = await errorReader.value
      process.waitUntilExit()
      try Task.checkCancellation()
      return (output, errorOutput)
    } onCancel: {
      if processBox.process.isRunning { processBox.process.terminate() }
    }
    let (output, errorOutput) = pair
    let errorText =
      String(data: errorOutput, encoding: .utf8)?
      .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard process.terminationStatus == 0 else {
      throw EngineClientError.exited(process.terminationStatus, errorText)
    }
    guard !output.isEmpty else { throw EngineClientError.emptyOutput }

  }

  private static func decodeJobEvent(_ data: Data) throws -> JobEventSnapshot {
    do {
      return try JSONDecoder().decode(JobEventSnapshot.self, from: data)
    } catch let error as EngineClientError {
      throw error
    } catch {
      throw EngineClientError.protocolFailure(
        "job output contained an invalid record · \(error.localizedDescription)")
    }
  }

  private static func runText(executableURL: URL, arguments: [String]) async throws -> String {
    let process = Process()
    let stdout = Pipe()
    let stderr = Pipe()
    process.executableURL = executableURL
    process.arguments = arguments
    process.standardOutput = stdout
    process.standardError = stderr
    do {
      try process.run()
    } catch {
      throw EngineClientError.launchFailed(error.localizedDescription)
    }
    let errorHandle = stderr.fileHandleForReading
    let errorReader = Task.detached { errorHandle.readDataToEndOfFile() }
    let output = stdout.fileHandleForReading.readDataToEndOfFile()
    let errorOutput = await errorReader.value
    process.waitUntilExit()
    let errorText =
      String(data: errorOutput, encoding: .utf8)?
      .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard process.terminationStatus == 0 else {
      throw EngineClientError.exited(process.terminationStatus, errorText)
    }
    guard let text = String(data: output, encoding: .utf8), !text.isEmpty else {
      throw EngineClientError.emptyOutput
    }
    return text
  }
}

public struct DisconnectedEngineClient: EngineClient {
  public init() {}

  public func snapshot() async throws -> EngineSnapshot {
    throw EngineClientError.engineNotFound
  }

  public func runCheck(
    _: EngineCheckOperation, unit _: String?, actor _: EngineActor, onEvent _: @escaping JobEventHandler
  ) async throws {
    throw EngineClientError.engineNotFound
  }

  public func doctor() async throws -> String {
    throw EngineClientError.engineNotFound
  }

  public func prepareSync(unit _: String, target _: String) async throws -> SyncPreflight {
    throw EngineClientError.engineNotFound
  }

  public func runSync(
    confirmationToken _: String, actor _: EngineActor, onEvent _: @escaping JobEventHandler
  ) async throws {
    throw EngineClientError.engineNotFound
  }

  public func setSource(path _: String) async throws -> EngineSnapshot {
    throw EngineClientError.engineNotFound
  }

  public func addDestination(path _: String, name _: String) async throws -> EngineSnapshot {
    throw EngineClientError.engineNotFound
  }

  public func adoptDestination(name _: String) async throws -> EngineSnapshot {
    throw EngineClientError.engineNotFound
  }

  public func removeDestination(name _: String) async throws -> EngineSnapshot {
    throw EngineClientError.engineNotFound
  }

  public func differences(unit _: String, target _: String) async throws -> DiffEnvelope {
    throw EngineClientError.engineNotFound
  }

  public func history() async throws -> [HistorySnapshotEntry] {
    throw EngineClientError.engineNotFound
  }

  public func recordMissed(schedule _: CheckSchedule, due _: Date) async throws {
    throw EngineClientError.engineNotFound
  }
}
