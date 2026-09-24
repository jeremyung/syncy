#if canImport(AppKit)
  import AppKit
#endif
import Foundation
import XCTest

@testable import SyncyMacCore

final class ModelsTests: XCTestCase {
  private func contractFixture(_ name: String) throws -> Data {
    let repository = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
    return try Data(contentsOf: repository.appendingPathComponent("test/fixtures/ui-contract/\(name)"))
  }

  func testElapsedTimeNeverBecomesNegative() {
    let now = Date(timeIntervalSince1970: 2_000)
    let job = RunningJob(
      kind: .deepVerify,
      unit: "photos",
      destination: "NAS",
      phase: "Comparing file contents",
      startedAt: now.addingTimeInterval(10),
      estimatedDuration: nil,
      lastEvent: "rsync is running",
      measuredFraction: nil
    )

    XCTAssertEqual(job.elapsed(at: now), 0)
    XCTAssertEqual(job.elapsedText(at: now), "0s elapsed")
  }

  func testSilentVerifyDoesNotInventMeasuredProgress() {
    let job = PreviewData.runningJob(now: Date(timeIntervalSince1970: 10_000))

    XCTAssertNil(job.measuredFraction)
    XCTAssertTrue(job.lastEvent.contains("no file-level results"))
    XCTAssertEqual(job.estimateText, "Estimated around 49m 0s from previous checks")
  }

  func testVocabularyMatchesLedgerStates() {
    XCTAssertEqual(
      Set(LedgerState.allCases.map(\.rawValue)),
      [
        "verified", "unverified", "behind", "missing", "unchecked", "error",
      ])
  }

  /// Pins the Swift copy to the engine's `PRECEDENCE` in `src/status.ts`, which
  /// is the only authority on which of six words leads. The two must be read
  /// side by side: a snapshot arrives with the unit state already rolled up, so
  /// a client that ranks the words differently will contradict the very ledger
  /// it is summarising — the tally once read `2 unchecked · 8 unverified` while
  /// the engine had already ruled the eight to be the worse news.
  func testPrecedenceMatchesTheEngineRollup() {
    XCTAssertEqual(
      LedgerState.precedence,
      [.error, .missing, .behind, .unverified, .unchecked, .verified])
    XCTAssertEqual(Set(LedgerState.precedence), Set(LedgerState.allCases))
    // `verified` is the engine's fallthrough rather than a listed rank, so it
    // is last here and appears in no other position.
    XCTAssertEqual(LedgerState.precedence.last, .verified)
  }

  /// A glyph that does not exist draws nothing at all — no error, no fallback,
  /// just an empty badge where a state should be. `unverified` shipped as
  /// `tilde`, which is the TUI's `~` but is not an SF Symbol, so every
  /// unverified row in the ledger showed a blank circle.
  func testEveryStateGlyphResolves() throws {
    #if canImport(AppKit)
      for state in LedgerState.allCases {
        XCTAssertNotNil(
          NSImage(systemSymbolName: state.symbol, accessibilityDescription: nil),
          "\(state.rawValue) draws nothing: \"\(state.symbol)\" is not an SF Symbol")
      }
    #else
      // SF Symbols only resolve on Apple platforms; the rest of this file is
      // pure Foundation and runs anywhere the core target compiles.
      throw XCTSkip("SF Symbols resolve only where AppKit is available")
    #endif
  }

  func testArchiveReportsItsWeakestFolder() throws {
    let json = """
      {"protocolVersion":1,"type":"snapshot","generatedAt":1,"source":"/source",\
      "configRevision":"r","targets":[],"units":[\
      {"unit":"a","state":"verified","reason":"deep verified","fingerprint":\
      {"nfiles":1,"bytes":10,"maxMtimeNs":"0"},"cells":[]},\
      {"unit":"b","state":"behind","reason":"17 files short","fingerprint":\
      {"nfiles":1,"bytes":20,"maxMtimeNs":"0"},"cells":[]},\
      {"unit":"c","state":"unverified","reason":"bytes unread","fingerprint":\
      {"nfiles":1,"bytes":30,"maxMtimeNs":"0"},"cells":[]}]}
      """
    let snapshot = try JSONDecoder().decode(EngineSnapshot.self, from: Data(json.utf8))

    XCTAssertEqual(snapshot.archiveState, .behind)
  }

  /// No folders is an absence, not a state. Reporting it as `unchecked` would
  /// claim we looked at something.
  func testEmptyArchiveHasNoState() throws {
    let json =
      #"{"protocolVersion":1,"type":"snapshot","generatedAt":1,"source":"/source","configRevision":"r","targets":[],"units":[]}"#
    let snapshot = try JSONDecoder().decode(EngineSnapshot.self, from: Data(json.utf8))

    XCTAssertNil(snapshot.archiveState)
    XCTAssertNil(snapshot.newestEvidenceAt)
  }

  /// The panel dates itself by when evidence was taken, never by when the
  /// snapshot was read — `generatedAt` is this second on every refresh and
  /// would make a month-old ledger look current.
  func testNewestEvidenceIsTheLatestRecordedCheck() throws {
    let snapshot = try JSONDecoder().decode(
      EngineSnapshot.self, from: contractFixture("snapshot.json"))
    let recorded = snapshot.units
      .flatMap(\.cells)
      .compactMap(\.evidence)
      .flatMap { [$0.lastCheck?.at, $0.deepCheck?.at] }
      .compactMap { $0 }

    XCTAssertFalse(recorded.isEmpty, "fixture carries no check evidence to date the panel by")
    XCTAssertEqual(snapshot.newestEvidenceAt, recorded.max())
    XCTAssertNotEqual(snapshot.newestEvidenceAt, snapshot.generatedAt)
  }

  func testReachabilityUsesCanonicalLedgerLanguage() {
    XCTAssertEqual(Reachability.ok.ledgerPhrase, "connected")
    XCTAssertEqual(Reachability.missing.ledgerPhrase, "no sentinel found")
    XCTAssertEqual(Reachability.mismatch.ledgerPhrase, "different volume")
    XCTAssertEqual(Reachability.unreachable.ledgerPhrase, "not connected")
    XCTAssertEqual(Reachability.timeout.ledgerPhrase, "did not answer in time")
  }

  func testTimedOutDestinationDecodesAsItsOwnState() throws {
    let json =
      #"{"protocolVersion":1,"type":"snapshot","generatedAt":1,"source":"/source","configRevision":"r","targets":[{"name":"nas","required":true,"reachability":"timeout","reachabilityPhrase":"did not answer within 5s","usesSentinel":false}],"units":[]}"#
    let snapshot = try JSONDecoder().decode(EngineSnapshot.self, from: Data(json.utf8))
    XCTAssertEqual(snapshot.targets.first?.reachability, .timeout)
    XCTAssertEqual(snapshot.targets.first?.reachabilityPhrase, "did not answer within 5s")
  }

  func testDisconnectedClientCannotProduceEvidence() async {
    let client = DisconnectedEngineClient()

    do {
      _ = try await client.snapshot()
      XCTFail("Disconnected client returned a snapshot")
    } catch is EngineClientError {
      // Expected: preview data must never cross the engine evidence seam.
    } catch {
      XCTFail("Unexpected error: \(error)")
    }
  }

  func testSnapshotProtocolRejectsUnsupportedVersion() {
    let json =
      #"{"protocolVersion":2,"type":"snapshot","generatedAt":1,"source":"/source","configRevision":"r","targets":[],"units":[]}"#

    XCTAssertThrowsError(try JSONDecoder().decode(EngineSnapshot.self, from: Data(json.utf8)))
  }

  func testSnapshotProtocolDecodesArbitraryTargets() throws {
    let json =
      #"{"protocolVersion":1,"type":"snapshot","generatedAt":1,"source":"/source","configRevision":"r","targets":[{"name":"one","required":true,"reachability":"ok","usesSentinel":false},{"name":"two","required":false,"reachability":"unreachable","usesSentinel":true}],"units":[]}"#
    let snapshot = try JSONDecoder().decode(EngineSnapshot.self, from: Data(json.utf8))

    XCTAssertEqual(snapshot.targets.map(\.name), ["one", "two"])
  }

  func testSyncableTargetsOffersOnlyDestinationsATransferWouldChange() throws {
    let snapshot = try JSONDecoder().decode(
      EngineSnapshot.self, from: contractFixture("snapshot.json"))
    let unit = snapshot.units[0]

    // Archive is verified and Studio NAS is behind, so the verified destination
    // must not be offered: there is nothing to send to a destination that
    // already matches, and offering it invites a confirmed no-op transfer.
    XCTAssertEqual(unit.cells.map(\.target), ["Archive", "Studio NAS"])
    XCTAssertEqual(unit.syncableTargets, ["Studio NAS"])
    XCTAssertTrue(unit.needsSync)
  }

  func testSyncableTargetsIsEmptyWhenEveryDestinationMatches() throws {
    let json =
      #"{"protocolVersion":1,"type":"snapshot","generatedAt":1,"source":"/source","configRevision":"r","targets":[],"units":[{"unit":"photos","state":"verified","reason":"all destinations deep verified","fingerprint":{"nfiles":1,"bytes":1,"maxMtimeNs":"1"},"cells":[{"target":"Archive","state":"verified","reason":"deep verified","nChanges":0,"bytesPending":0,"nExtra":0}]}]}"#
    let snapshot = try JSONDecoder().decode(EngineSnapshot.self, from: Data(json.utf8))

    XCTAssertEqual(snapshot.units[0].syncableTargets, [])
    XCTAssertFalse(snapshot.units[0].needsSync)
  }

  func testSharedSnapshotFixtureCarriesCanonicalPresentation() throws {
    let snapshot = try JSONDecoder().decode(
      EngineSnapshot.self, from: contractFixture("snapshot.json"))

    XCTAssertEqual(snapshot.targets[1].reachabilityPhrase, "different volume")
    XCTAssertEqual(snapshot.units[0].cells[1].reason, "2 files not copied yet")
    XCTAssertEqual(snapshot.units[0].cells[1].nFiles, 2)
    XCTAssertEqual(snapshot.units[0].cells[0].evidence?.lastCheck?.method, "deep")
    XCTAssertEqual(snapshot.units[0].cells[0].evidence?.lastCheck?.durationMs, 42_000)
    XCTAssertEqual(snapshot.activeJob?.actor, "scheduler")
    XCTAssertEqual(snapshot.activeJob?.estimatedDurationMs, 42_000)
    XCTAssertEqual(snapshot.activeJob?.batchPosition, 2)
    XCTAssertEqual(snapshot.activeJob?.batchTotal, 4)
    XCTAssertEqual(snapshot.activeJob?.activity?.lastItem, "rsync started")
  }

  func testSharedDifferenceFixturePreservesIdentityAndLabels() throws {
    let envelope = try JSONDecoder().decode(
      DiffEnvelope.self, from: contractFixture("diff.json"))

    XCTAssertEqual(envelope.provenance?.current, false)
    XCTAssertEqual(envelope.provenance?.identityMatches, false)
    XCTAssertEqual(envelope.provenance?.reachability, .mismatch)
    XCTAssertEqual(envelope.presentation?.parts.first?.label, "not at destination")
    XCTAssertEqual(envelope.presentation?.copyableFiles, 2)
    XCTAssertEqual(envelope.presentation?.state, .differences)
  }

  func testDifferenceProtocolDistinguishesNoRecordFromARecordedEmptyCheck() throws {
    let json =
      #"{"protocolVersion":1,"type":"diff","generatedAt":1,"unit":"photos","target":"Archive","diff":null,"presentation":{"state":"no-record","title":"No check recorded","detail":"No recorded check for this destination. Run a check to record differences.","parts":[],"copyableFiles":0}}"#

    let envelope = try JSONDecoder().decode(DiffEnvelope.self, from: Data(json.utf8))

    XCTAssertNil(envelope.diff)
    XCTAssertEqual(envelope.presentation?.state, .noRecord)
    XCTAssertEqual(envelope.presentation?.title, "No check recorded")
  }

  func testSharedJobFixturePreservesMeasuredProgress() throws {
    let data = try contractFixture("events.jsonl")
    let lines = try XCTUnwrap(String(data: data, encoding: .utf8))
      .split(separator: "\n")
    let events = try lines.map {
      try JSONDecoder().decode(JobEventSnapshot.self, from: Data($0.utf8))
    }

    XCTAssertEqual(events.map(\.type), [
      "job.started", "job.phase-changed", "job.progress-observed", "job.completed",
    ])
    XCTAssertEqual(events[2].filesSeen, 4)
    XCTAssertEqual(events[2].filesTotal, 12)
    XCTAssertEqual(events[0].estimatedDurationMs, 42_000)
  }

  /// A record this build cannot read is a fault in the reader. The engine
  /// keeps running and records its own outcome; the reader must not turn a
  /// display problem into a cancelled sync by terminating it. The fake
  /// engine below writes a marker if it is ever signalled.
  func testUnreadableJobEventDoesNotTerminateTheEngine() async throws {
    let dir = FileManager.default.temporaryDirectory
      .appendingPathComponent("syncy-engine-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let marker = dir.appendingPathComponent("terminated")
    let engine = dir.appendingPathComponent("engine.sh")
    let base = "\"protocolVersion\":1,\"jobId\":\"j\",\"operation\":\"quick\",\"unit\":\"u\",\"target\":\"t\""
    let script = """
      #!/bin/sh
      trap 'echo terminated > "\(marker.path)"; exit 143' TERM
      printf '%s\\n' '{\(base),"type":"job.started","at":1,"phase":"queued","unitSize":{"bytes":1}}'
      printf '%s\\n' '{\(base),"type":"job.phase-changed","at":2,"phase":"a-phase-this-build-does-not-know"}'
      sleep 0.3
      printf '%s\\n' '{\(base),"type":"job.completed","at":3,"result":{"outcome":"clean","nChanges":0,"nExtra":0,"bytesPending":0,"exitCode":0}}'
      exit 0
      """
    try script.write(to: engine, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: engine.path)

    final class Seen: @unchecked Sendable {
      private let lock = NSLock()
      private var types: [String] = []
      func add(_ type: String) { lock.withLock { types.append(type) } }
      var all: [String] { lock.withLock { types } }
    }
    let seen = Seen()
    let client = ProcessEngineClient(executableURL: engine)
    do {
      try await client.runCheck(.quick, unit: nil, actor: .mac) { seen.add($0.type) }
      XCTFail("an unreadable record must still be reported")
    } catch let error as EngineClientError {
      guard case .protocolFailure = error else {
        return XCTFail("expected a protocol failure, got \(error)")
      }
    }
    // A signalled engine writes its marker from a trap; give it a moment so
    // the assertion below is about the signal, not about who ran first.
    try await Task.sleep(nanoseconds: 500_000_000)
    XCTAssertFalse(
      FileManager.default.fileExists(atPath: marker.path),
      "the engine was signalled because of a record the reader could not parse")
    XCTAssertEqual(
      seen.all, ["job.started", "job.completed"],
      "records that do decode are still delivered, before and after the unreadable one")
  }

  func testJobProtocolRejectsUnknownEventTypes() {
    let json =
      #"{"protocolVersion":1,"type":"job.future","jobId":"j","at":1,"operation":"deep","unit":"photos","target":"Archive"}"#

    XCTAssertThrowsError(try JSONDecoder().decode(JobEventSnapshot.self, from: Data(json.utf8)))
  }

  func testJobProtocolRejectsProgressWithoutAnObservation() {
    let json =
      #"{"protocolVersion":1,"type":"job.progress-observed","jobId":"j","at":1,"operation":"deep","unit":"photos","target":"Archive"}"#

    XCTAssertThrowsError(try JSONDecoder().decode(JobEventSnapshot.self, from: Data(json.utf8)))
  }

  func testSnapshotProtocolRejectsNullOptionalCounts() {
    let json =
      #"{"protocolVersion":1,"type":"snapshot","generatedAt":1,"source":"/source","configRevision":"r","targets":[],"units":[{"unit":"a","state":"unchecked","reason":"never checked","fingerprint":{"nfiles":0,"bytes":0,"maxMtimeNs":"0"},"cells":[{"target":"one","state":"unchecked","reason":"never checked","nChanges":0,"nNew":null,"bytesPending":0,"nExtra":0}]}]}"#

    XCTAssertThrowsError(try JSONDecoder().decode(EngineSnapshot.self, from: Data(json.utf8)))
  }

  func testDailyScheduleRunsLatestMissedOccurrenceOnlyOnce() throws {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = try XCTUnwrap(TimeZone(secondsFromGMT: 0))
    let now = try XCTUnwrap(
      calendar.date(from: DateComponents(year: 2026, month: 9, day: 5, hour: 12)))
    let yesterday = try XCTUnwrap(
      calendar.date(from: DateComponents(year: 2026, month: 9, day: 4, hour: 12)))
    var schedule = CheckSchedule(
      operation: .quick, unit: nil, cadence: .daily, hour: 10, minute: 30,
      lastAttemptAt: yesterday)

    XCTAssertTrue(schedule.isDue(at: now, calendar: calendar))
    schedule.lastAttemptAt = now
    XCTAssertFalse(schedule.isDue(at: now, calendar: calendar))
  }

  /// Every due date is in the past, so a schedule with no attempt behind it
  /// would fire on creation — a weekly sync added on Wednesday transferring
  /// immediately instead of on Sunday. Creation counts as the first attempt.
  func testNewScheduleWaitsForItsNextOccurrence() throws {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = try XCTUnwrap(TimeZone(secondsFromGMT: 0))
    let schedule = CheckSchedule(
      operation: .sync, unit: "photos", target: "Archive", cadence: .weekly, weekday: 1,
      hour: 2, minute: 0)

    XCTAssertFalse(schedule.isDue(at: Date(), calendar: calendar))
  }

  func testWeeklyScheduleFindsTheLatestRequestedWeekday() throws {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = try XCTUnwrap(TimeZone(secondsFromGMT: 0))
    let saturday = try XCTUnwrap(
      calendar.date(from: DateComponents(year: 2026, month: 9, day: 5, hour: 12)))
    let schedule = CheckSchedule(
      operation: .deep, unit: "photos", cadence: .weekly, weekday: 2, hour: 2, minute: 0)
    let due = try XCTUnwrap(schedule.latestDueDate(at: saturday, calendar: calendar))

    XCTAssertEqual(calendar.component(.weekday, from: due), 2)
    XCTAssertLessThan(due, saturday)
  }

  func testScheduledSyncPersistsItsExactDestination() throws {
    let original = CheckSchedule(
      operation: .sync, unit: "photos", target: "Archive", cadence: .daily, hour: 3,
      minute: 15, approvedConfigRevision: "revision-1")

    let decoded = try JSONDecoder().decode(
      CheckSchedule.self, from: JSONEncoder().encode(original))

    XCTAssertEqual(decoded.operation, .sync)
    XCTAssertEqual(decoded.unit, "photos")
    XCTAssertEqual(decoded.target, "Archive")
    XCTAssertEqual(decoded.approvedConfigRevision, "revision-1")
    XCTAssertNil(decoded.operation.engineOperation)
    XCTAssertTrue(decoded.isApproved(forConfigRevision: "revision-1"))
    XCTAssertFalse(decoded.isApproved(forConfigRevision: "revision-2"))
  }
}
