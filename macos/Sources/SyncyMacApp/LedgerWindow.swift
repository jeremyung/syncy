import SwiftUI
import SyncyMacCore

struct LedgerWindow: View {
  @ObservedObject var model: AppModel

  var body: some View {
    NavigationSplitView {
      List(SidebarItem.allCases, selection: $model.selection) { item in
        Label(item.rawValue, systemImage: item.symbol)
          .tag(item)
      }
      .navigationSplitViewColumnWidth(min: 176, ideal: 196)
    } detail: {
      Group {
        switch model.selection ?? .ledger {
        case .ledger: LedgerView(model: model)
        case .differences: DifferencesView(model: model)
        case .evidence: EvidenceView(unit: model.selectedUnit)
        case .sync:
          SyncConfirmationView(model: model)
        case .schedules: SchedulesView(model: model)
        case .history: HistoryView(model: model)
        case .setup: SetupView(model: model)
        case .diagnostics:
          DiagnosticsView(model: model)
        }
      }
      .background(SyncyTheme.paper)
    }
    .safeAreaInset(edge: .bottom) {
      EngineNotice(
        text: footerText,
        trailing: model.snapshot.map { "snapshot · \(formatted(date: $0.generatedAt))" }
      )
      .padding(.horizontal, 16)
      .frame(height: 34)
      .background(.bar)
    }
    .task { await model.loadIfNeeded() }
  }

  private var footerText: String {
    if model.isLaunchingJob { return "Starting engine job" }
    if model.isLoading { return "Reading engine snapshot" }
    if let error = model.errorMessage { return error }
    return model.snapshot == nil ? "No snapshot loaded" : "Engine snapshot loaded"
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
        ContentUnavailableView {
          ProgressView().controlSize(.small)
          Text("Reading ledger").font(.headline)
        }
      } else if let snapshot = model.snapshot {
        LedgerGrid(
          snapshot: snapshot,
          selection: $model.selectedUnitID
        )
      } else {
        ContentUnavailableView(
          "Ledger unavailable",
          systemImage: "externaldrive.badge.exclamationmark",
          description: Text(model.errorMessage ?? "The engine returned no snapshot.")
        )
      }
    }
    .toolbar {
      ToolbarItemGroup {
        Button("Refresh", systemImage: "arrow.clockwise") {
          Task { await model.refresh() }
        }
        .disabled(model.isLoading)
        Menu("Quick check", systemImage: "bolt") {
          Button("Selected unit") {
            Task { await model.runCheck(.quick, unit: model.selectedUnit?.unit) }
          }
          .disabled(model.selectedUnit == nil)
          Button("All units") { Task { await model.runCheck(.quick) } }
        }
        .disabled(model.isLaunchingJob || model.snapshot?.activeJob != nil || model.snapshot == nil)
        Menu("Deep verify", systemImage: "checkmark.seal") {
          Button("Selected unit") {
            Task { await model.runCheck(.deep, unit: model.selectedUnit?.unit) }
          }
          .disabled(model.selectedUnit == nil)
          Button("All units") { Task { await model.runCheck(.deep) } }
        }
        .disabled(model.isLaunchingJob || model.snapshot?.activeJob != nil || model.snapshot == nil)
      }
    }
  }

  private var snapshotSummary: String? {
    guard let snapshot = model.snapshot else { return nil }
    let bytes = snapshot.units.reduce(Int64(0)) { $0 + $1.fingerprint.bytes }
    return
      "\(snapshot.units.count) units · \(ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file).lowercased())"
  }
}

private struct LedgerGrid: View {
  let snapshot: EngineSnapshot
  @Binding var selection: UnitSnapshot.ID?

  private let stateWidth: CGFloat = 32
  private let unitWidth: CGFloat = 220
  private let sizeWidth: CGFloat = 84
  private let filesWidth: CGFloat = 84
  private let destinationWidth: CGFloat = 220

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
      HeaderCell("Unit", width: unitWidth)
      HeaderCell("Size", width: sizeWidth, alignment: .trailing)
      HeaderCell("Files", width: filesWidth, alignment: .trailing)
      ForEach(snapshot.targets) { target in
        HeaderCell(target.name, width: destinationWidth)
      }
    }
    .padding(.horizontal, 16)
    .frame(height: 34)
    .background(SyncyTheme.raised)
  }

  private func row(_ unit: UnitSnapshot) -> some View {
    HStack(spacing: 0) {
      StateMark(state: unit.state).frame(width: stateWidth)
      VStack(alignment: .leading, spacing: 3) {
        Text(unit.unit).fontWeight(.medium).lineLimit(1)
        Text(unit.reason).font(.caption).foregroundStyle(SyncyTheme.secondaryInk).lineLimit(1)
      }
      .frame(width: unitWidth, alignment: .leading)
      Text(
        ByteCountFormatter.string(fromByteCount: unit.fingerprint.bytes, countStyle: .file)
          .lowercased()
      )
      .monospacedDigit()
      .foregroundStyle(SyncyTheme.secondaryInk)
      .frame(width: sizeWidth, alignment: .trailing)
      Text(unit.fingerprint.nfiles.formatted())
        .monospacedDigit()
        .foregroundStyle(SyncyTheme.secondaryInk)
        .frame(width: filesWidth, alignment: .trailing)
      ForEach(snapshot.targets) { target in
        DestinationCell(destination: unit.cell(for: target.name))
          .frame(width: destinationWidth, alignment: .leading)
      }
    }
    .padding(.horizontal, 16)
    .frame(minHeight: 58)
    .background(selection == unit.id ? Color.accentColor.opacity(0.09) : Color.clear)
    .contentShape(Rectangle())
    .onTapGesture { selection = unit.id }
    .accessibilityAddTraits(selection == unit.id ? .isSelected : [])
  }

  private var totalWidth: CGFloat {
    stateWidth + unitWidth + sizeWidth + filesWidth
      + CGFloat(snapshot.targets.count) * destinationWidth + 32
  }
}

private struct HeaderCell: View {
  let label: String
  let width: CGFloat
  let alignment: Alignment

  init(_ label: String, width: CGFloat, alignment: Alignment = .leading) {
    self.label = label
    self.width = width
    self.alignment = alignment
  }

  var body: some View {
    Text(label)
      .font(.caption.weight(.semibold))
      .foregroundStyle(SyncyTheme.secondaryInk)
      .frame(width: width, alignment: alignment)
  }
}

private struct DestinationCell: View {
  let destination: CellSnapshot?

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      if let destination {
        Text(destination.state.rawValue)
          .font(.callout.weight(.medium))
          .foregroundStyle(SyncyTheme.color(for: destination.state))
        Text(destination.reason)
          .font(.caption)
          .foregroundStyle(SyncyTheme.secondaryInk)
          .lineLimit(1)
      } else {
        Text("not reported")
          .font(.callout)
          .foregroundStyle(SyncyTheme.quietInk)
      }
    }
    .padding(.leading, 20)
    .padding(.vertical, 5)
  }
}

struct PageHeader: View {
  let title: String
  let detail: String
  var trailing: String? = nil

  var body: some View {
    HStack(alignment: .firstTextBaseline) {
      VStack(alignment: .leading, spacing: 5) {
        Text(title)
          .font(.system(.largeTitle, design: .serif, weight: .semibold))
        Text(detail)
          .font(.callout)
          .foregroundStyle(SyncyTheme.secondaryInk)
      }
      Spacer()
      if let trailing {
        Text(trailing)
          .font(.system(.callout, design: .monospaced))
          .foregroundStyle(SyncyTheme.secondaryInk)
          .monospacedDigit()
      }
    }
    .padding(.horizontal, 24)
    .padding(.top, 24)
    .padding(.bottom, 20)
  }
}
