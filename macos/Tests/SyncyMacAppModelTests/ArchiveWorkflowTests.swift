import PDFKit
import SwiftUI
import SyncyMacCore
import XCTest

@testable import SyncyMacApp

@MainActor
final class ArchiveWorkflowTests: XCTestCase {
  func testRenderedArchiveRecordMenuAndRunningTask() async throws {
    let repository = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
    let fixture = repository.appendingPathComponent("test/fixtures/ui-contract/archive-snapshot.json")
    let data = try Data(contentsOf: fixture)
    let client = ControlledEngine()
    client.snapshotOverride = try JSONDecoder().decode(EngineSnapshot.self, from: data)
    let model = AppModel(client: client, preferences: ArchiveTestPreferences())
    await model.refresh()

    let renders = repository.appendingPathComponent(".test-tmp/native-renders-" + UUID().uuidString)
    try FileManager.default.createDirectory(at: renders, withIntermediateDirectories: true)
    func renderedText<V: View>(_ name: String, _ view: V, width: CGFloat, height: CGFloat) throws -> String {
      let renderer = ImageRenderer(content: view.frame(width: width, height: height))
      let data = NSMutableData()
      let consumer = try XCTUnwrap(CGDataConsumer(data: data))
      var page = CGRect(x: 0, y: 0, width: width, height: height)
      let context = try XCTUnwrap(CGContext(consumer: consumer, mediaBox: &page, nil))
      renderer.render { _, draw in
        context.beginPDFPage(nil)
        draw(context)
        context.endPDFPage()
      }
      context.closePDF()
      try (data as Data).write(to: renders.appendingPathComponent(name + ".pdf"))
      let document = try XCTUnwrap(PDFDocument(data: data as Data))
      return try XCTUnwrap(document.string).split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    model.closeFolderRecord()
    _ = try renderedText("ledger", LedgerWindow(model: model), width: 940, height: 600)
    model.openFolderRecord("photos")
    let record = try renderedText("folder", FolderRecordView(model: model), width: 780, height: 800)
    XCTAssertTrue(record.contains("Absent locally"), record)
    let menu = try renderedText("menu", MenuBarPanel(model: model), width: 360, height: 480)
    XCTAssertTrue(menu.contains("Archive copies"), menu)
    XCTAssertTrue(menu.contains("Only on External"), menu)
    XCTAssertTrue(menu.contains("without a current local copy"), menu)

    var active = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    active["activeJob"] = [
      "actor": "cli", "operation": "deep", "startedAt": 1788681539900, "heartbeatAt": 1788681539900,
      "activity": ["unit": "photos", "target": "Archive ↔ External", "phase": "comparing-content",
                   "at": 1788681539900],
    ]
    client.snapshotOverride = try JSONDecoder().decode(
      EngineSnapshot.self, from: JSONSerialization.data(withJSONObject: active))
    await model.refresh()
    let job = try XCTUnwrap(model.activeJob)
    let task = try renderedText("task", ActiveTaskView(job: job, model: model), width: 680, height: 420)
    XCTAssertTrue(task.contains("Archive ↔ External"), task)
    XCTAssertTrue(task.contains("comparing content"), task)
  }

  /// CI builds the signed app before these tests. Exercise the same helper the
  /// app launches and give only that child the fixture's config and state.
  func testResumeCompareDisconnectAndReturnThroughTheNativeModel() async throws {
    let files = FileManager.default
    let repository = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
    let engine = repository.appendingPathComponent("build/Syncy.app/Contents/MacOS/syncy-engine")
    try XCTSkipUnless(
      files.isExecutableFile(atPath: engine.path), "Build the macOS bundle to exercise its engine")
    let fixture = repository.appendingPathComponent(".test-tmp/native-archive-" + UUID().uuidString)
    let source = fixture.appendingPathComponent("source")
    let copies = ["First disk", "Second disk"].map { fixture.appendingPathComponent($0) }
    let unit = "Photo archive"
    let local = source.appendingPathComponent(unit)
    let config = fixture.appendingPathComponent("config/syncy")
    for path in [local, config] + copies {
      try files.createDirectory(at: path, withIntermediateDirectories: true)
    }
    let bytes = local.appendingPathComponent("photo")
    try Data("original".utf8).write(to: bytes)
    let fixed = Date(timeIntervalSince1970: 1_700_000_000)
    for url in [bytes, local] {
      try files.setAttributes([.modificationDate: fixed], ofItemAtPath: url.path)
    }
    for (index, path) in copies.enumerated() {
      try files.copyItem(at: local, to: path.appendingPathComponent(unit))
      try Data("copy-\(index)\n".utf8).write(to: path.appendingPathComponent(".syncy-dest-id"))
    }
    let destinations = copies.enumerated().map { index, path in
      """
      [[target]]
      name = "\(path.lastPathComponent)"
      path = "\(path.path)"
      sentinel = "copy-\(index)"
      """
    }
    try (["source = \"\(source.path)\""] + destinations).joined(separator: "\n").write(
      to: config.appendingPathComponent("config.toml"), atomically: true, encoding: .utf8)
    try files.createSymbolicLink(
      at: fixture.appendingPathComponent("engine"), withDestinationURL: engine)
    let wrapper = fixture.appendingPathComponent("fixture-engine")
    try """
    #!/bin/sh
    root=$(dirname "$0")
    export XDG_CONFIG_HOME="$root/config" XDG_STATE_HOME="$root/state"
    exec "$root/engine" "$@"
    """.write(to: wrapper, atomically: true, encoding: .utf8)
    try files.setAttributes([.posixPermissions: 0o755], ofItemAtPath: wrapper.path)

    func checkTUI(_ observation: String? = nil) throws {
      let tui = Process()
      tui.executableURL = URL(fileURLWithPath: "/usr/bin/env")
      tui.arguments = ["bun", "test/drivers/archive-client.tsx", unit] + (observation.map { [$0] } ?? [])
      tui.currentDirectoryURL = repository
      var environment = ProcessInfo.processInfo.environment
      environment["XDG_CONFIG_HOME"] = fixture.appendingPathComponent("config").path
      environment["XDG_STATE_HOME"] = fixture.appendingPathComponent("state").path
      tui.environment = environment
      try tui.run()
      tui.waitUntilExit()
      XCTAssertEqual(tui.terminationStatus, 0)
    }

    let model = AppModel(
      client: ProcessEngineClient(executableURL: wrapper), preferences: ArchiveTestPreferences())
    await model.refresh()
    XCTAssertNil(model.engineErrorMessage)
    let revision = try XCTUnwrap(model.snapshot?.configRevision)
    let observed = try XCTUnwrap(model.snapshot?.localUnits.first)
    XCTAssertEqual(observed.unit, unit)
    await model.runCheck(.deep, unit: unit)
    XCTAssertNil(model.errorMessage)

    let away = fixture.appendingPathComponent("away")
    try files.moveItem(at: local, to: away)

    // Recreate the on-disk upgrade boundary. Older releases wrote unstamped
    // scans and rsync history, before the catalog existed.
    let stateDir = fixture.appendingPathComponent("state/syncy")
    try files.moveItem(at: stateDir.appendingPathComponent("archive-v1.sqlite"),
      to: fixture.appendingPathComponent("pre-upgrade-observations.sqlite"))
    let stateFile = stateDir.appendingPathComponent("state.json")
    var legacy = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: stateFile)) as? [String: Any])
    let scans = try XCTUnwrap(legacy["scans"] as? [[String: Any]])
    legacy["scans"] = scans.map { $0.filter { $0.key != "source" } }
    try JSONSerialization.data(withJSONObject: legacy).write(to: stateFile)
    await model.refresh()
    XCTAssertEqual(model.selectedUnit?.unit, unit)
    XCTAssertEqual(model.selectedUnit?.archive?.local, .unavailable)
    let confirmed = await model.setSource(path: source.path)
    XCTAssertTrue(confirmed)
    await model.refresh()
    XCTAssertEqual(model.selectedUnit?.archive?.local, .absent)
    XCTAssertNil(model.selectedUnit?.fingerprint)
    XCTAssertEqual(model.selectedUnit?.archive?.localChecks.count, 2)
    let stopped = await model.track(unit, active: false, revision: revision)
    XCTAssertTrue(stopped)
    XCTAssertEqual(model.snapshot?.units.count, 0)
    let remembered = try await model.folders(discover: false)
    XCTAssertEqual(remembered.candidates.first?.unit, unit)
    XCTAssertEqual(remembered.candidates.first?.tracked, false)
    XCTAssertEqual(remembered.candidates.first?.remembered, true)
    let unknown = "Destination-only archive"
    try files.createDirectory(
      at: copies[0].appendingPathComponent(unknown), withIntermediateDirectories: false)
    let discovery = try await model.folders(discover: true)
    let newlyFound = try XCTUnwrap(discovery.candidates.first { $0.unit == unknown })
    XCTAssertFalse(newlyFound.remembered)
    XCTAssertFalse(newlyFound.tracked)
    XCTAssertEqual(newlyFound.locations, [copies[0].lastPathComponent])
    XCTAssertTrue(discovery.blocked.isEmpty)
    XCTAssertTrue(
      copies.allSatisfy {
        discovery.candidates.first(where: { $0.unit == unit })?.locations.contains(
          $0.lastPathComponent) == true
      })
    let resumed = await model.track(unit, active: true, revision: remembered.configRevision)
    XCTAssertTrue(resumed)
    XCTAssertEqual(model.selectedUnit?.unit, unit)
    XCTAssertEqual(model.snapshot?.units.count, 1)
    let pair = try XCTUnwrap(model.selectedUnit?.archive?.pairOptions.first)
    XCTAssertNil(pair.blocker)
    XCTAssertTrue(model.selectedUnit?.archive?.pairs.isEmpty == true)

    // The TUI opens the very row resumed in the app and records the first
    // comparison through real key input. Refresh must see its persisted result.
    try checkTUI()
    await model.refresh()
    XCTAssertNil(model.errorMessage)
    XCTAssertEqual(model.selectedUnit?.archive?.pairs.first?.outcome, "agree")
    XCTAssertEqual(model.snapshot?.localUnits.count, 0)
    XCTAssertNil(model.snapshot?.archiveState)
    XCTAssertEqual(model.selectedUnit?.needsSync, false)

    let secondPhoto = copies[1].appendingPathComponent(unit).appendingPathComponent("photo")
    try Data("changed!".utf8).write(to: secondPhoto)
    try files.setAttributes([.modificationDate: fixed], ofItemAtPath: secondPhoto.path)
    await model.compareCopies(.deep, unit: unit, pair: pair, revision: revision)
    await model.compareCopies(.quick, unit: unit, pair: pair, revision: revision)
    let strongest = try XCTUnwrap(model.snapshot?.latestArchivedPair)
    XCTAssertEqual(strongest.method, "deep")
    XCTAssertEqual(strongest.outcome, "different")
    XCTAssertEqual(model.selectedUnit?.archive?.pairs.first { $0.method == "quick" }?.outcome, "agree")

    let extra = copies[1].appendingPathComponent(unit).appendingPathComponent("only-here")
    try Data("unique".utf8).write(to: extra)
    await model.compareCopies(.quick, unit: unit, pair: pair, revision: revision)
    XCTAssertNil(model.errorMessage)
    let changed = try XCTUnwrap(model.selectedUnit?.archive?.pairs.first { $0.method == "quick" })
    XCTAssertEqual(changed.outcome, "different")
    XCTAssertTrue(
      changed.samples.contains { $0.name == "only-here" && $0.kind.contains(pair.second) })
    XCTAssertTrue(files.fileExists(atPath: extra.path))
    try checkTUI("difference")

    try files.moveItem(at: copies[1], to: fixture.appendingPathComponent("offline"))
    await model.refresh()
    let dated = try XCTUnwrap(model.selectedUnit?.archive?.pairs.first { $0.method == "quick" })
    XCTAssertFalse(dated.current)
    XCTAssertEqual(dated.at, changed.at)
    XCTAssertNotNil(model.selectedUnit?.archive?.pairOptions.first?.blocker)
    try checkTUI("offline")
    let selectedDisk = try await model.folders(discover: true, destinations: [copies[0].lastPathComponent])
    XCTAssertTrue(selectedDisk.blocked.isEmpty)
    let available = try await model.folders(discover: true)
    XCTAssertTrue(available.blocked.contains { $0.contains(copies[1].lastPathComponent) })
    XCTAssertEqual(
      available.candidates.first { $0.unit == unknown }?.locations, [copies[0].lastPathComponent])
    let added = await model.track(unknown, active: true, revision: available.configRevision)
    XCTAssertTrue(added)
    XCTAssertEqual(model.selectedUnit?.unit, unknown)
    let hideDiscovered = await model.track(unknown, active: false, revision: revision)
    XCTAssertTrue(hideDiscovered)

    try files.moveItem(at: fixture.appendingPathComponent("offline"), to: copies[1])
    try files.moveItem(at: away, to: local)
    await model.refresh()
    XCTAssertEqual(model.snapshot?.units.count, 1)
    XCTAssertEqual(model.selectedUnit?.archive?.local, .present)
    XCTAssertNotNil(model.selectedUnit?.fingerprint)
    XCTAssertEqual(model.selectedUnit?.state, .unchecked)
    XCTAssertEqual(model.selectedUnit?.archive?.pairs.count, 2)
    try checkTUI("returned")

    let replacement = fixture.appendingPathComponent("replacement-source")
    try files.createDirectory(at: replacement.appendingPathComponent(unit), withIntermediateDirectories: true)
    let configFile = config.appendingPathComponent("config.toml")
    let prior = try String(contentsOf: configFile, encoding: .utf8)
    try prior.replacingOccurrences(of: source.path, with: replacement.path)
      .write(to: configFile, atomically: true, encoding: .utf8)
    await model.refresh()
    XCTAssertNotEqual(model.snapshot?.configRevision, revision)
    await model.compareCopies(.deep, unit: unit, pair: pair, revision: revision)
    XCTAssertNotNil(model.errorMessage)
    let staleStop = await model.track(unit, active: false, revision: revision)
    XCTAssertFalse(staleStop)
    let staleAdd = await model.track(unknown, active: true, revision: available.configRevision)
    XCTAssertFalse(staleAdd)
    await model.refresh()
    XCTAssertEqual(model.snapshot?.units.map(\.unit), [unit])
    XCTAssertTrue(model.selectedUnit?.archive?.pairs.isEmpty == true)
  }
}

@MainActor
private final class ArchiveTestPreferences: AppPreferences {
  var schedules: [CheckSchedule] = []
  let notifyProblems = false
  let notifySuccess = false
}
