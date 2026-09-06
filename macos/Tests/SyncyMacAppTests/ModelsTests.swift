import Foundation
import XCTest

@testable import SyncyMacCore

final class ModelsTests: XCTestCase {
  func testElapsedTimeNeverBecomesNegative() {
    let now = Date(timeIntervalSince1970: 2_000)
    let job = RunningJob(
      kind: .deepVerify,
      unit: "photos",
      destination: "NAS",
      phase: "Comparing file contents",
      startedAt: now.addingTimeInterval(10),
      typicalDuration: nil,
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
    XCTAssertEqual(job.typicalText, "Typically 42m 0s–55m 0s on this destination")
  }

  func testVocabularyMatchesLedgerStates() {
    XCTAssertEqual(
      Set(LedgerState.allCases.map(\.rawValue)),
      [
        "verified", "unverified", "behind", "missing", "unchecked", "error",
      ])
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
    var schedule = CheckSchedule(
      operation: .quick, unit: nil, cadence: .daily, hour: 10, minute: 30)

    XCTAssertTrue(schedule.isDue(at: now, calendar: calendar))
    schedule.lastAttemptAt = now
    XCTAssertFalse(schedule.isDue(at: now, calendar: calendar))
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
