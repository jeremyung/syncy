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
    let units = snapshot.units
    // The scale of the archive and the measure of what is safe, which is what
    // the page header used to carry as "12 folders · 431.38 gb" — a total with
    // nothing to compare it against. Bytes rather than a folder count for the
    // reason `verifiedPhrase` in the TUI footer gives: the reader is deciding
    // what to delete off a full disk, and a folder is not a unit of space.
    let total = units.reduce(Int64(0)) { $0 + $1.fingerprint.bytes }
    let verified = units.filter { $0.state == .verified }
      .reduce(Int64(0)) { $0 + $1.fingerprint.bytes }
    let scale = "\(units.count) folder\(units.count == 1 ? "" : "s")"
    return "\(scale) \u{00B7} \(bytes(verified)) verified of \(bytes(total))"
  }

  private func bytes(_ value: Int64) -> String {
    ByteCountFormatter.string(fromByteCount: value, countStyle: .file).lowercased()
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
  @State private var showsSyncReview = false

  var body: some View {
    Group {
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
          canCheck: model.activeJob == nil && !model.isLaunchingJob,
          // The review sheet reads `selectedUnit`, and a right-click reports the
          // row it was made on without necessarily moving the selection there.
          // Set it explicitly, or the sheet describes whichever row happened to
          // be highlighted and the reader confirms a transfer they did not pick.
          sync: { id in
            model.selectedUnitID = id
            showsSyncReview = true
          }
        )
      } else {
        PaneNotice(
          title: "Ledger unavailable",
          detail: model.engineErrorMessage ?? "The engine returned no snapshot.",
          symbol: "externaldrive.badge.exclamationmark")
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .sheet(isPresented: $showsSyncReview) {
      SyncConfirmationView(model: model)
        .frame(minWidth: 620, minHeight: 560)
    }
    // The window's subject goes in the title bar, where macOS puts a window's
    // subject. It used to be a serif `PageHeader` reading "Ledger · What the
    // last checks established" above a trailing "12 folders · 431.38 gb" —
    // three lines explaining a ledger to the person who keeps it, and a folder
    // count the footer was already printing six inches away. The scale and the
    // measure belong on the status bar with the rest of the totals; the name
    // belongs here; and the table gets the height all of it was spending.
    .navigationTitle("Ledger")
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
}

/// Quick check and deep verify are separate operations, not two settings of one
/// "Check" control, so each gets its own toolbar button. Clicking a button runs
/// it over the whole ledger — the unambiguous reading, and the only one this
/// screen can promise, since the row selection follows the cursor.
///
/// Both buttons used to render as a bare glyph: a circled tick and a circled
/// magnifier, side by side, telling a first-time reader nothing about which was
/// which or what either would touch. The tooltip said so, but a tooltip is the
/// answer to a question you have to already know to ask. `.titleAndIcon` holds
/// the words regardless of the toolbar's display mode, and the menu now spells
/// out *both* scopes — the whole ledger and the one folder — so the split
/// button documents its own primary action instead of hiding it behind a click.
private struct CheckButton: View {
  let title: String
  let symbol: String
  let operation: EngineCheckOperation
  @ObservedObject var model: AppModel

  var body: some View {
    Menu {
      Button(allTitle) { Task { await model.runCheck(operation) } }
      if model.selectedUnit != nil {
        Button(scopedTitle) {
          Task { await model.runCheck(operation, unit: model.selectedUnit?.unit) }
        }
      }
    } label: {
      Label(title, systemImage: symbol)
        .labelStyle(.titleAndIcon)
    } primaryAction: {
      Task { await model.runCheck(operation) }
    }
    .disabled(model.isLaunchingJob || model.activeJob != nil || model.snapshot == nil)
    .help("\(allTitle) \u{00B7} open the menu to pick one folder")
  }

  private var allTitle: String {
    guard let count = model.snapshot?.units.count, count > 0 else { return "\(title) Every Folder" }
    return "\(title) All \(count) Folders"
  }

  /// Names the folder outright rather than saying "selected", so nobody has to
  /// look away from the menu to learn what it will touch.
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
///
/// Each row states its verdict once, and says nothing it cannot measure.
///
/// It used to state the verdict three times — a roll-up mark in a leading 28pt
/// column, the state word in every destination cell, and under each of those a
/// reason — so twelve folders printed "source changed since deep verify"
/// seventeen times and called it evidence. The mark column was arithmetic over
/// the two cells beside it (`rollUp` in `status.ts`), so it went, and the marks
/// moved into the cells where the state they colour actually lives.
///
/// The reasons went too, rather than collapsing into one trailing column. A
/// reason is prose about *why we cannot say*, and on this archive nine rows in
/// eleven carried the same sentence: a column whose value barely changes down
/// the page is not a column, and every one of those sentences is already on the
/// folder record, one double click away, per destination and in full. What
/// stays in the cell is the count, because a number is the one thing the reader
/// cannot arrive at on their own — the difference between a folder a little
/// behind and one that was never copied at all.
private struct LedgerTable: View {
  let snapshot: EngineSnapshot
  @Binding var selection: UnitSnapshot.ID?
  let open: (UnitSnapshot.ID) -> Void
  let check: (EngineCheckOperation, String) -> Void
  let canCheck: Bool
  let sync: (UnitSnapshot.ID) -> Void

  var body: some View {
    Table(of: UnitSnapshot.self, selection: $selection) {
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
      .width(min: 220, ideal: 340)

      // One column per destination, named by the destination, so the ledger
      // still reads across rather than down.
      //
      // A destination that is not mounted is a fact about the destination, not
      // about twelve folders. It used to be invisible here — the tray panel and
      // Settings both said "not connected", and the ledger, where the reader
      // actually is, showed a column of `unchecked` and let them guess. It is
      // said once, under the name it belongs to.
      TableColumnForEach(snapshot.targets) { target in
        TableColumn(header(target)) { (unit: UnitSnapshot) in
          DestinationCell(destination: unit.cell(for: target.name))
        }
        .width(min: 132, ideal: 190)
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
      Divider()
      // The ledger's whole job is to say which folders are behind, and this is
      // the row that says it — so the transfer belongs here rather than only
      // behind a drill-in. It stays visible with nothing to send, like the
      // checks above it, because a menu item that comes and goes per row is a
      // worse answer to "can I sync this?" than one that is plainly unavailable.
      // `canCheck` gates it too: a sync writes the tree a check is reading.
      Button("Sync \u{201C}\(unit.unit)\u{201D}\u{2026}") { sync(id) }
        .disabled(!canCheck || !unit.needsSync)
    }
  }

  /// Kept to one line: a wrapped column header shifts every other header's
  /// baseline, and the phrase is short enough that it does not need two.
  private func header(_ target: TargetSnapshot) -> String {
    guard target.reachability != .ok else { return target.name }
    let phrase = target.reachabilityPhrase ?? target.reachability.ledgerPhrase
    return "\(target.name) \u{00B7} \(phrase)"
  }

  private func folderFacts(_ unit: UnitSnapshot) -> String {
    let size = ByteCountFormatter.string(
      fromByteCount: unit.fingerprint.bytes, countStyle: .file
    ).lowercased()
    return "\(size) \u{00B7} \(unit.fingerprint.nfiles.formatted()) files"
  }

}

/// A destination's verdict, in one line: the mark that carries the colour, the
/// word that carries the meaning without it, and — for `behind` alone — the
/// count, because "behind" spans a folder missing one file and a folder missing
/// five hundred, and those are not the same answer to "is this safe to delete".
///
/// Every other state's reason is a sentence about why no conclusion could be
/// drawn, which is what the folder record is for. The one exception this cell
/// used to have to make — a destination that is simply not plugged in, where
/// every row would say `unchecked` for one reason — is answered by the column
/// header instead, once, at the level that fact belongs to.
private struct DestinationCell: View {
  let destination: CellSnapshot?

  var body: some View {
    HStack(spacing: SyncySpace.sm) {
      if let destination {
        StateMark(state: destination.state)
        Text(verdict(destination))
          .font(.callout)
          .lineLimit(1)
      } else {
        // No mark, because there is no state to mark. A `?` glyph here would
        // read as `unchecked`, which is a verdict the engine did not reach —
        // it did not report this destination for this folder at all. The gap
        // is the width of the mark the other rows are wearing, so the words
        // stay on one line down the column.
        Color.clear.frame(width: 20, height: 20)
        Text("not reported")
          .font(.callout)
          .foregroundStyle(SyncyTheme.quietInk)
          .lineLimit(1)
      }
    }
    .padding(.vertical, SyncySpace.xs)
  }

  /// Taken from the structured counts rather than by parsing `reason`, and
  /// split on `nFiles` for the reason `behindSummary` in `presentation.ts`
  /// gives: records predating the file-only count fold directories into
  /// `nChanges`, so calling that a file count claims more than was read.
  private func verdict(_ destination: CellSnapshot) -> String {
    guard destination.state == .behind else { return destination.state.rawValue }
    let count =
      if let files = destination.nFiles {
        "\(files.formatted()) file\(files == 1 ? "" : "s")"
      } else {
        "\(destination.nChanges.formatted()) change\(destination.nChanges == 1 ? "" : "s")"
      }
    return "behind \u{00B7} \(count)"
  }
}
