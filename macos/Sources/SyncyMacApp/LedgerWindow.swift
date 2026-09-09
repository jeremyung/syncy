import SwiftUI
import SyncyMacCore

struct LedgerWindow: View {
  @ObservedObject var model: AppModel

  var body: some View {
    NavigationSplitView {
      List(SidebarItem.allCases, selection: sidebarSelection) { item in
        Label(item.rawValue, systemImage: item.symbol)
          .tag(item)
      }
      // Paper on both sides of the split, for the reason given in
      // `AppSettingsView`: the sidebar was the one surface still showing the
      // system's cool grey against syncy's warm ground.
      .scrollContentBackground(.hidden)
      .background(SyncyTheme.paper)
      .navigationSplitViewColumnWidth(min: 176, ideal: 196)
    } detail: {
      Group {
        if model.presentedUnit != nil {
          FolderRecordView(model: model)
        } else {
          switch model.selection ?? .ledger {
          case .ledger: LedgerView(model: model)
          case .activity: ActivityView(model: model)
          case .settings: AppSettingsView(model: model)
          }
        }
      }
      .background(SyncyTheme.paper)
    }
    .safeAreaInset(edge: .bottom) {
      EngineNotice(
        text: footerText,
        trailing: model.snapshot.map { "snapshot · \(formatted(date: $0.generatedAt))" }
      )
      .padding(.horizontal, SyncySpace.gutter)
      .frame(height: 34)
      .background(.bar)
    }
    .task { await model.loadIfNeeded() }
  }

  private var sidebarSelection: Binding<SidebarItem?> {
    Binding(
      get: { model.selection },
      set: { next in
        model.closeFolderRecord()
        model.selection = next
      })
  }

  private var footerText: String {
    if model.activeJob != nil { return "Engine work is running" }
    if model.isLaunchingJob { return "Starting engine job" }
    if model.isLoading, model.snapshot == nil { return "Reading engine snapshot" }
    if let error = model.engineErrorMessage ?? model.errorMessage { return error }
    guard let snapshot = model.snapshot else { return "No snapshot loaded" }
    let verified = snapshot.units.filter { $0.state == .verified }.count
    return "\(verified) of \(snapshot.units.count) folders verified"
  }

  private func formatted(date milliseconds: Double) -> String {
    Date(timeIntervalSince1970: milliseconds / 1_000).formatted(
      date: .abbreviated, time: .shortened)
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
        LedgerGrid(
          snapshot: snapshot,
          selection: model.selectedUnitID,
          open: model.openFolderRecord
        )
        if let activeJob = model.activeJob {
          LedgerJobStrip(job: activeJob, model: model)
            .padding(.horizontal, SyncySpace.gutter)
            .padding(.bottom, SyncySpace.md)
        }
      } else {
        PaneNotice(
          title: "Ledger unavailable",
          detail: model.engineErrorMessage ?? "The engine returned no snapshot.",
          symbol: "externaldrive.badge.exclamationmark")
      }
    }
    .toolbar {
      ToolbarItemGroup {
        Menu("Check", systemImage: "checkmark.circle") {
          Menu("Selected folder") {
            Button("Quick check") {
              Task { await model.runCheck(.quick, unit: model.selectedUnit?.unit) }
            }
            Button("Deep verify") {
              Task { await model.runCheck(.deep, unit: model.selectedUnit?.unit) }
            }
          }
          .disabled(model.selectedUnit == nil)

          Menu("All folders") {
            Button("Quick check") { Task { await model.runCheck(.quick) } }
            Button("Deep verify") { Task { await model.runCheck(.deep) } }
          }
        }
        .disabled(model.isLaunchingJob || model.activeJob != nil || model.snapshot == nil)

        Menu {
          Button("Refresh snapshot", systemImage: "arrow.clockwise") {
            Task { await model.refresh() }
          }
          .disabled(model.isRefreshing)
        } label: {
          Label("More actions", systemImage: "ellipsis.circle")
            .labelStyle(.iconOnly)
        }
        .accessibilityLabel("More actions")
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

private struct LedgerJobStrip: View {
  let job: ActiveJobSnapshot
  @ObservedObject var model: AppModel

  var body: some View {
    TimelineView(.periodic(from: .now, by: 1)) { context in
      HStack(spacing: SyncySpace.md) {
        Image(systemName: "arrow.triangle.2.circlepath")
          .foregroundStyle(SyncyTheme.caution)
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: SyncySpace.xs) {
          Text(jobTitle).font(.callout.weight(.semibold))
          Text(detail(at: context.date))
            .font(.caption.monospacedDigit())
            .foregroundStyle(SyncyTheme.secondaryInk)
        }
        Spacer()
        Button("View") {
          model.closeFolderRecord()
          model.selection = .activity
        }
      }
      .padding(.horizontal, SyncySpace.lg)
      .padding(.vertical, SyncySpace.md)
      .background(SyncyTheme.raised)
      .overlay {
        RoundedRectangle(cornerRadius: 8)
          .stroke(SyncyTheme.rule)
      }
      .accessibilityElement(children: .combine)
    }
  }

  private var jobTitle: String {
    let operation = job.operation == "deep" ? "Deep verify" : job.operation.capitalized
    guard let activity = job.activity else { return "\(operation) is running" }
    let batch =
      if let position = job.batchPosition, let total = job.batchTotal, total > 1 {
        " · folder \(position.formatted()) of \(total.formatted())"
      } else {
        ""
      }
    return "\(operation) · \(activity.unit) → \(activity.target)\(batch)"
  }

  private func detail(at date: Date) -> String {
    let elapsed = max(0, Int(date.timeIntervalSince1970 - job.startedAt / 1_000))
    let duration = elapsed >= 3_600
      ? "\(elapsed / 3_600)h \((elapsed % 3_600) / 60)m"
      : "\(elapsed / 60)m \(elapsed % 60)s"
    let phase = job.activity?.phase.replacingOccurrences(of: "-", with: " ") ?? "starting"
    let progress: String
    if let seen = job.activity?.filesSeen, let total = job.activity?.filesTotal, total > 0 {
      progress = " · \(seen.formatted()) of \(total.formatted()) files observed"
    } else if let done = job.activity?.bytesDone, let total = job.activity?.bytesTotal, total > 0 {
      progress =
        " · \(ByteCountFormatter.string(fromByteCount: done, countStyle: .file).lowercased()) of \(ByteCountFormatter.string(fromByteCount: total, countStyle: .file).lowercased()) observed"
    } else {
      progress = " · no measured percentage"
    }
    return "\(duration) elapsed · \(phase)\(progress) · window may close"
  }
}

private struct LedgerGrid: View {
  let snapshot: EngineSnapshot
  let selection: UnitSnapshot.ID?
  let open: (UnitSnapshot.ID) -> Void

  private let stateWidth: CGFloat = 32
  private let unitWidth: CGFloat = 270
  private let destinationWidth: CGFloat = 230

  var body: some View {
    ScrollView([.horizontal, .vertical]) {
      LazyVStack(spacing: 0) {
        header
        Divider()
        ForEach(snapshot.units) { unit in
          row(unit)
          Divider()
        }
      }
      .frame(minWidth: totalWidth, alignment: .topLeading)
    }
  }

  private var header: some View {
    HStack(spacing: 0) {
      Text("").frame(width: stateWidth)
      HeaderCell("Folder", width: unitWidth)
      ForEach(snapshot.targets) { target in
        HeaderCell(target.name, width: destinationWidth, leadingInset: 20)
      }
    }
    .padding(.horizontal, SyncySpace.gutter)
    .frame(height: 34)
    .background(SyncyTheme.raised)
  }

  private func row(_ unit: UnitSnapshot) -> some View {
    HStack(spacing: 0) {
      StateMark(state: unit.state).frame(width: stateWidth)
      VStack(alignment: .leading, spacing: SyncySpace.xs) {
        Text(unit.unit).fontWeight(.medium).lineLimit(1)
        Text(folderFacts(unit))
          .font(.caption.monospacedDigit())
          .foregroundStyle(SyncyTheme.secondaryInk)
          .lineLimit(1)
      }
      .frame(width: unitWidth, alignment: .leading)
      ForEach(snapshot.targets) { target in
        DestinationCell(destination: unit.cell(for: target.name))
          .frame(width: destinationWidth, alignment: .leading)
      }
    }
    .padding(.horizontal, SyncySpace.gutter)
    .frame(minHeight: 58)
    .background(selection == unit.id ? SyncyTheme.selection : Color.clear)
    .contentShape(Rectangle())
    .onTapGesture { open(unit.id) }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(unit.unit), \(unit.state.rawValue), \(unit.reason)")
    .accessibilityAddTraits(.isButton)
    .accessibilityAddTraits(
      selection == unit.id ? .isSelected : AccessibilityTraits())
    .accessibilityAction { open(unit.id) }
  }

  private func folderFacts(_ unit: UnitSnapshot) -> String {
    let size = ByteCountFormatter.string(
      fromByteCount: unit.fingerprint.bytes, countStyle: .file
    ).lowercased()
    return "\(size) · \(unit.fingerprint.nfiles.formatted()) files"
  }

  private var totalWidth: CGFloat {
    stateWidth + unitWidth + CGFloat(snapshot.targets.count) * destinationWidth + 32
  }
}

private struct HeaderCell: View {
  let label: String
  let width: CGFloat
  let alignment: Alignment
  let leadingInset: CGFloat

  init(
    _ label: String,
    width: CGFloat,
    alignment: Alignment = .leading,
    leadingInset: CGFloat = 0
  ) {
    self.label = label
    self.width = width
    self.alignment = alignment
    self.leadingInset = leadingInset
  }

  var body: some View {
    Text(label)
      .font(.caption.weight(.semibold))
      .foregroundStyle(SyncyTheme.secondaryInk)
      .frame(width: max(0, width - leadingInset), alignment: alignment)
      .padding(.leading, leadingInset)
  }
}

private struct DestinationCell: View {
  let destination: CellSnapshot?

  var body: some View {
    VStack(alignment: .leading, spacing: SyncySpace.xs) {
      if let destination {
        Text(destination.state.rawValue)
          .font(.callout.weight(.medium))
          .foregroundStyle(SyncyTheme.color(for: destination.state))
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
    .padding(.leading, SyncySpace.gutter)
    .padding(.vertical, SyncySpace.xs)
  }
}
