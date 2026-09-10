import AppKit
import SwiftUI
import SyncyMacCore

/// One window, one subject. The sidebar this replaced offered a ledger, an
/// activity screen, and a Settings item pointing at the `Settings` scene the app
/// already declares — so a permanent 196pt column switched between two things,
/// and the reader who came to ask whether a folder is safe to delete paid for it
/// on every screen. Activity is not a peer of the ledger; it is the ledger's
/// provenance, and it belongs underneath it.
struct LedgerWindow: View {
  @ObservedObject var model: AppModel

  var body: some View {
    Group {
      if model.presentedUnit != nil {
        FolderRecordView(model: model)
      } else {
        LedgerView(model: model)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .background(SyncyTheme.paper)
    .safeAreaInset(edge: .bottom) { ActivityDrawer(model: model) }
    .task { await model.loadIfNeeded() }
    // The 3s poll only asks whether a job is running; it never rebuilds the
    // ledger, because doing so spawns `syncy engine snapshot`. So evidence
    // recorded by the CLI between two polls used to sit unseen until someone
    // pressed a button. Coming back to the window is the moment that matters,
    // and `loadIfNeeded` already throttles this to one read per five seconds.
    .onReceive(NotificationCenter.default.publisher(
      for: NSApplication.didBecomeActiveNotification)
    ) { _ in
      Task { await model.loadIfNeeded() }
    }
  }
}

/// The window's footer, which now opens. Shut, it is the status line the window
/// already carried; pulled up, it is the running job and the recorded outcomes.
/// A separate job strip used to float above this bar saying the same thing in
/// different words — one running job, reported twice, is not twice the evidence.
private struct ActivityDrawer: View {
  @ObservedObject var model: AppModel

  private var isOpen: Bool { model.activityDrawer != nil }

  var body: some View {
    VStack(spacing: 0) {
      Divider()
      handle
      if let tab = model.activityDrawer {
        Divider()
        Picker("Activity", selection: tabSelection) {
          ForEach(ActivityDrawerTab.allCases) { item in Text(item.rawValue).tag(item) }
        }
        .labelsHidden()
        .pickerStyle(.segmented)
        .frame(width: 220)
        .padding(.horizontal, SyncySpace.gutter)
        .padding(.vertical, SyncySpace.sm)
        Divider()
        Group {
          switch tab {
          case .running: RunningActivityView(model: model)
          case .history: HistoryView(model: model, showsHeader: false)
          }
        }
        .frame(height: 280)
        .background(SyncyTheme.paper)
      }
    }
    .background(.bar)
    .animation(.easeOut(duration: 0.22), value: model.activityDrawer)
  }

  private var tabSelection: Binding<ActivityDrawerTab> {
    Binding(
      get: { model.activityDrawer ?? .running },
      set: { model.activityDrawer = $0 })
  }

  // The clock only ticks while there is an elapsed time to report. Left running
  // it would redraw the footer once a second for the whole life of the window.
  @ViewBuilder
  private var handle: some View {
    if model.activeJob != nil {
      TimelineView(.periodic(from: .now, by: 1)) { context in bar(at: context.date) }
    } else {
      bar(at: .now)
    }
  }

  private func bar(at date: Date) -> some View {
    Button {
      model.activityDrawer = isOpen ? nil : .running
    } label: {
      HStack(alignment: .firstTextBaseline, spacing: SyncySpace.sm) {
        Circle()
          .fill(statusInk)
          .frame(width: 6, height: 6)
          .accessibilityHidden(true)
        Text(statusLine(at: date))
          .font(.caption)
          .foregroundStyle(SyncyTheme.secondaryInk)
          .lineLimit(1)
        Spacer(minLength: SyncySpace.lg)
        if let trailing = trailingLine(at: date) {
          Text(trailing)
            .font(.caption.monospacedDigit())
            .foregroundStyle(SyncyTheme.quietInk)
            .lineLimit(1)
        }
        Image(systemName: isOpen ? "chevron.down" : "chevron.up")
          .font(.caption2.weight(.semibold))
          .foregroundStyle(SyncyTheme.quietInk)
          .accessibilityHidden(true)
      }
      .padding(.horizontal, SyncySpace.gutter)
      .frame(height: 34)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .help(isOpen ? "Hide activity" : "Show running work and history")
    .accessibilityLabel("\(statusLine(at: date)). \(isOpen ? "Hide" : "Show") activity")
  }

  private var statusInk: Color {
    if model.engineErrorMessage ?? model.errorMessage != nil { return SyncyTheme.fault }
    if model.activeJob != nil || model.isLaunchingJob { return SyncyTheme.caution }
    return SyncyTheme.quietInk
  }

  private func statusLine(at date: Date) -> String {
    if let job = model.activeJob { return running(job) }
    if model.isLaunchingJob { return "Starting engine job" }
    if model.isLoading, model.snapshot == nil { return "Reading engine snapshot" }
    if let error = model.engineErrorMessage ?? model.errorMessage { return error }
    guard let snapshot = model.snapshot else { return "No snapshot loaded" }
    let verified = snapshot.units.filter { $0.state == .verified }.count
    return "\(verified) of \(snapshot.units.count) folders verified"
  }

  private func running(_ job: ActiveJobSnapshot) -> String {
    let operation = job.operation == "deep" ? "Deep verify" : job.operation.capitalized
    guard let activity = job.activity else { return "\(operation) is running" }
    let batch =
      if let position = job.batchPosition, let total = job.batchTotal, total > 1 {
        " \u{00B7} folder \(position.formatted()) of \(total.formatted())"
      } else {
        ""
      }
    return "\(operation) \u{00B7} \(activity.unit) \u{2192} \(activity.target)\(batch)"
  }

  private func trailingLine(at date: Date) -> String? {
    if let job = model.activeJob {
      let elapsed = max(0, Int(date.timeIntervalSince1970 - job.startedAt / 1_000))
      let duration = elapsed >= 3_600
        ? "\(elapsed / 3_600)h \((elapsed % 3_600) / 60)m"
        : "\(elapsed / 60)m \(elapsed % 60)s"
      let phase = job.activity?.phase.replacingOccurrences(of: "-", with: " ") ?? "starting"
      return "\(duration) \u{00B7} \(phase)"
    }
    guard let snapshot = model.snapshot else { return nil }
    let taken = Date(timeIntervalSince1970: snapshot.generatedAt / 1_000)
      .formatted(date: .abbreviated, time: .shortened)
    return "snapshot \u{00B7} \(taken)"
  }
}

private struct LedgerView: View {
  @ObservedObject var model: AppModel

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      PageHeader(
        title: "Ledger",
        detail: "What the last checks established",
        trailing: snapshotSummary
      )

      if model.isLoading, model.snapshot == nil {
        PaneNotice(title: "Reading ledger", isWorking: true)
      } else if let snapshot = model.snapshot {
        LedgerTable(
          snapshot: snapshot,
          selection: $model.selectedUnitID,
          open: model.openFolderRecord,
          check: { operation, unit in
            Task { await model.runCheck(operation, unit: unit) }
          },
          canCheck: model.activeJob == nil && !model.isLaunchingJob
        )
      } else {
        PaneNotice(
          title: "Ledger unavailable",
          detail: model.engineErrorMessage ?? "The engine returned no snapshot.",
          symbol: "externaldrive.badge.exclamationmark")
      }
    }
    .toolbar {
      ToolbarItemGroup {
        CheckButton(
          title: "Quick Check", symbol: "checkmark.circle",
          operation: .quick, model: model)
        CheckButton(
          title: "Deep Verify", symbol: "magnifyingglass.circle",
          operation: .deep, model: model)
      }
    }
  }

  private var snapshotSummary: String? {
    guard let snapshot = model.snapshot else { return nil }
    let bytes = snapshot.units.reduce(Int64(0)) { $0 + $1.fingerprint.bytes }
    return
      "\(snapshot.units.count) folders · \(ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file).lowercased())"
  }
}

/// Quick check and deep verify are separate operations, not two settings of one
/// "Check" control, so each gets its own toolbar button. Clicking a button runs
/// it over the whole ledger — the unambiguous reading, and the only one this
/// screen can promise, since the row selection follows the cursor. The chevron
/// holds the narrower scope and names the folder outright rather than saying
/// "selected", so nobody has to look away to learn what it will touch.
private struct CheckButton: View {
  let title: String
  let symbol: String
  let operation: EngineCheckOperation
  @ObservedObject var model: AppModel

  var body: some View {
    Menu {
      Button(scopedTitle) {
        Task { await model.runCheck(operation, unit: model.selectedUnit?.unit) }
      }
      .disabled(model.selectedUnit == nil)
    } label: {
      Label(title, systemImage: symbol)
    } primaryAction: {
      Task { await model.runCheck(operation) }
    }
    .disabled(model.isLaunchingJob || model.activeJob != nil || model.snapshot == nil)
    .help("\(title) every folder")
  }

  private var scopedTitle: String {
    guard let unit = model.selectedUnit else { return "\(title) Selected Folder" }
    return "\(title) \u{201C}\(unit.unit)\u{201D}"
  }
}

/// The ledger is a real `Table` rather than a stack of rows with tap gestures
/// on them. That is what buys arrow-key navigation, click to select, double
/// click to open, and a menu on right- or two-finger click: a reader reaching
/// for any of those on a Mac is not reaching for something exotic, and a
/// `LazyVStack` cannot answer a single one of them.
private struct LedgerTable: View {
  let snapshot: EngineSnapshot
  @Binding var selection: UnitSnapshot.ID?
  let open: (UnitSnapshot.ID) -> Void
  let check: (EngineCheckOperation, String) -> Void
  let canCheck: Bool

  var body: some View {
    Table(of: UnitSnapshot.self, selection: $selection) {
      TableColumn("") { unit in
        StateMark(state: unit.state)
      }
      .width(28)

      TableColumn("Folder") { unit in
        VStack(alignment: .leading, spacing: SyncySpace.xs) {
          Text(unit.unit).fontWeight(.medium).lineLimit(1)
          Text(folderFacts(unit))
            .font(.caption.monospacedDigit())
            .foregroundStyle(SyncyTheme.secondaryInk)
            .lineLimit(1)
        }
        .padding(.vertical, SyncySpace.xs)
      }
      .width(min: 180, ideal: 270)

      // One column per destination, named by the destination, so the ledger
      // still reads across rather than down.
      TableColumnForEach(snapshot.targets) { target in
        TableColumn(target.name) { (unit: UnitSnapshot) in
          DestinationCell(destination: unit.cell(for: target.name))
        }
        .width(min: 150, ideal: 230)
      }
    } rows: {
      ForEach(snapshot.units) { TableRow($0) }
    }
    // `primaryAction` is the double click. Single click now only selects, which
    // is why the toolbar buttons had to stop meaning "whatever is highlighted".
    .contextMenu(forSelectionType: UnitSnapshot.ID.self) { ids in
      rowMenu(for: ids)
    } primaryAction: { ids in
      if let id = ids.first { open(id) }
    }
    // Paper under the table for the reason `AppSettingsView` gives: the
    // system's cool grey is the one thing that reads as a different app.
    .scrollContentBackground(.hidden)
    .background(SyncyTheme.paper)
  }

  /// Per-folder work belongs on the folder, not in the toolbar. This is where a
  /// Mac reader looks for it first, and it is the reason the toolbar can mean
  /// every folder without ever being ambiguous.
  @ViewBuilder
  private func rowMenu(for ids: Set<UnitSnapshot.ID>) -> some View {
    if let id = ids.first, let unit = snapshot.units.first(where: { $0.id == id }) {
      Button("Open Folder Record") { open(id) }
      Divider()
      Button("Quick Check \u{201C}\(unit.unit)\u{201D}") { check(.quick, unit.unit) }
        .disabled(!canCheck)
      Button("Deep Verify \u{201C}\(unit.unit)\u{201D}") { check(.deep, unit.unit) }
        .disabled(!canCheck)
    }
  }

  private func folderFacts(_ unit: UnitSnapshot) -> String {
    let size = ByteCountFormatter.string(
      fromByteCount: unit.fingerprint.bytes, countStyle: .file
    ).lowercased()
    return "\(size) \u{00B7} \(unit.fingerprint.nfiles.formatted()) files"
  }
}

private struct DestinationCell: View {
  let destination: CellSnapshot?

  var body: some View {
    VStack(alignment: .leading, spacing: SyncySpace.xs) {
      if let destination {
        Text(destination.state.rawValue)
          .font(.callout.weight(.medium))
        Text(destination.differenceSummary ?? destination.reason)
          .font(.caption)
          .foregroundStyle(SyncyTheme.secondaryInk)
          .lineLimit(1)
      } else {
        Text("not reported")
          .font(.callout)
          .foregroundStyle(SyncyTheme.quietInk)
      }
    }
    .padding(.vertical, SyncySpace.xs)
  }
}
