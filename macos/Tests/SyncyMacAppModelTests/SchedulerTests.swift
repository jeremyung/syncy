import Foundation
import SyncyMacCore
import Testing

@testable import SyncyMacApp

@MainActor
struct SchedulerTests {
  @Test func cancellationClearsTheScheduledJobsCancellingState() async throws {
    let client = ControlledEngine()
    client.holdCheck = true
    let model = AppModel(client: client, preferences: MemoryPreferences())
    model.addSchedule(dueSchedule())
    try await until { client.checkCalls == 1 }

    model.cancelOwnedJob()
    #expect(model.isCancellingJob)
    try await until { !model.isLaunchingJob }

    #expect(!model.isCancellingJob)
    #expect(!model.canCancelOwnedJob)
    #expect(model.errorMessage?.contains("cancelled") == true)
  }

  @Test func anotherScheduleWaitsForTheFinalLedgerRefresh() async throws {
    let client = ControlledEngine()
    let model = AppModel(client: client, preferences: MemoryPreferences())
    await model.refresh()
    client.holdRefresh = true
    defer { client.finishRefresh() }
    model.addSchedule(dueSchedule())
    try await until { client.refreshIsWaiting }

    // addSchedule tries to start due work synchronously. The first run has
    // finished its engine call, but has not yet settled its ledger refresh.
    model.addSchedule(dueSchedule())
    #expect(model.isLaunchingJob)
    #expect(model.schedules[1].lastAttemptAt == Date.distantPast)
    #expect(client.checkCalls == 1)

    client.finishRefresh()
    try await until { !model.isLaunchingJob }
    #expect(!model.canCancelOwnedJob)
  }

  @Test func changedPreflightSuspendsTheScheduleWithoutConsumingItsOccurrence() async throws {
    let client = ControlledEngine()
    client.preparedRevision = "changed"
    let preferences = MemoryPreferences()
    let model = AppModel(client: client, preferences: preferences)
    await model.refresh()
    let schedule = dueSchedule(operation: .sync)
    model.addSchedule(schedule)
    try await until { !model.isLaunchingJob }

    #expect(client.preflightCalls == 1)
    #expect(client.syncCalls == 0)
    #expect(model.schedules[0].approvedConfigRevision == nil)
    #expect(model.schedules[0].lastAttemptAt == schedule.lastAttemptAt)
    #expect(preferences.schedules[0].approvedConfigRevision == nil)
    #expect(model.errorMessage?.contains("suspended") == true)
  }

  @Test func finalRefreshReadsAgainAfterAnOlderRefreshFinishes() async throws {
    let client = ControlledEngine()
    let model = AppModel(client: client, preferences: MemoryPreferences())
    await model.refresh()
    client.holdRefresh = true
    let olderRefresh = Task { await model.refresh() }
    defer { client.finishRefresh() }
    try await until { client.refreshIsWaiting }

    model.addSchedule(dueSchedule())
    try await until { client.historyCalls == 1 }
    // The older snapshot began before this check completed. Its response
    // cannot replace the fresh evidence the run's final refresh must read.
    client.finishRefresh()
    await olderRefresh.value
    try await until { !model.isLaunchingJob }
    #expect(client.snapshotCalls == 3)
    #expect(model.snapshot?.generatedAt == 3)
  }

  private func dueSchedule(operation: EngineCheckOperationValue = .quick) -> CheckSchedule {
    CheckSchedule(
      operation: operation, unit: "photos", target: operation == .sync ? "archive" : nil,
      cadence: .daily, hour: 0, minute: 0, lastAttemptAt: .distantPast,
      approvedConfigRevision: operation == .sync ? "original" : nil)
  }

  /// Wait on the actual scheduler state; the deadline only bounds a failure.
  private func until(_ predicate: () -> Bool) async throws {
    let deadline = ContinuousClock.now.advanced(by: .seconds(5))
    while !predicate() {
      guard ContinuousClock.now < deadline else { throw TestFailure.stateNeverArrived }
      await Task.yield()
    }
  }
}

private enum TestFailure: Error { case stateNeverArrived, unexpectedCommand }

@MainActor
private final class MemoryPreferences: AppPreferences {
  var schedules: [CheckSchedule] = []
  let notifyProblems = false
  let notifySuccess = false
}

/// The real app state machine, with engine completion and refresh held at
/// observable boundaries. No UserDefaults, filesystem, or notification access.
@MainActor
final class ControlledEngine: EngineClient {
  var snapshotOverride: EngineSnapshot?
  var holdCheck = false
  var holdRefresh = false
  var preparedRevision = "original"
  private(set) var checkCalls = 0
  private(set) var preflightCalls = 0
  private(set) var syncCalls = 0
  private(set) var snapshotCalls = 0
  private(set) var historyCalls = 0
  private var check: CheckedContinuation<Void, any Error>?
  private var refresh: CheckedContinuation<Void, Never>?
  var refreshIsWaiting: Bool { refresh != nil }

  func snapshot() async throws -> EngineSnapshot {
    if let snapshotOverride { return snapshotOverride }
    snapshotCalls += 1
    let generatedAt = snapshotCalls
    if holdRefresh, snapshotCalls > 1 {
      await withCheckedContinuation { refresh = $0 }
    }
    return try JSONDecoder().decode(
      EngineSnapshot.self,
      from: Data(
        #"{"protocolVersion":2,"type":"snapshot","generatedAt":\#(generatedAt),"source":"/source","configRevision":"original","targets":[],"units":[]}"#
          .utf8))
  }

  func finishRefresh() {
    holdRefresh = false
    let waiting = refresh
    refresh = nil
    waiting?.resume()
  }

  func compare(
    _: EngineCheckOperation, unit _: String, pair _: DestinationPair, revision _: String,
    onEvent _: @escaping JobEventHandler
  ) async throws {
    throw EngineClientError.engineNotFound
  }

  func folders(discover _: Bool, destinations _: [String]) async throws -> FolderCandidates {
    throw EngineClientError.engineNotFound
  }

  func track(unit _: String, active _: Bool, revision _: String) async throws -> EngineSnapshot {
    throw EngineClientError.engineNotFound
  }

  func runCheck(
    _ operation: EngineCheckOperation, unit: String?, actor: EngineActor,
    onEvent: @escaping JobEventHandler
  ) async throws {
    if !holdCheck {
      checkCalls += 1
      return
    }
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation {
        check = $0
        checkCalls += 1
      }
    } onCancel: {
      Task { @MainActor in
        let waiting = self.check
        self.check = nil
        waiting?.resume(throwing: CancellationError())
      }
    }
  }

  func prepareSync(unit: String, target: String, actor: EngineActor) async throws -> SyncPreflight {
    preflightCalls += 1
    return try JSONDecoder().decode(
      SyncPreflight.self,
      from: Data(
        """
        {"protocolVersion":2,"type":"sync.preflight","generatedAt":1,
        "unit":"photos","target":"archive","argv":[],"configRevision":"\(preparedRevision)",
        "checks":[],"ok":true,"nChanges":1,"nExtra":0,"bytesPending":1,
        "needsChecksum":false,"confirmationToken":"confirmation","expiresAt":9999999999999}
        """.utf8))
  }

  func runSync(
    confirmationToken: String, actor: EngineActor, onEvent: @escaping JobEventHandler
  ) async throws { syncCalls += 1 }

  func activity() async throws -> ActiveJobSnapshot? { nil }
  func history() async throws -> [HistorySnapshotEntry] {
    historyCalls += 1
    return []
  }
  func recordMissed(schedule: CheckSchedule, due: Date) async throws {}
  func doctor() async throws -> String { throw TestFailure.unexpectedCommand }
  func setSource(path: String) async throws -> EngineSnapshot {
    throw TestFailure.unexpectedCommand
  }
  func addDestination(path: String, name: String) async throws -> EngineSnapshot {
    throw TestFailure.unexpectedCommand
  }
  func adoptDestination(name: String) async throws -> EngineSnapshot {
    throw TestFailure.unexpectedCommand
  }
  func removeDestination(name: String) async throws -> EngineSnapshot {
    throw TestFailure.unexpectedCommand
  }
  func differences(unit: String, target: String) async throws -> DiffEnvelope {
    throw TestFailure.unexpectedCommand
  }
}
