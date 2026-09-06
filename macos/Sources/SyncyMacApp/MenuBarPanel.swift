import SwiftUI
import SyncyMacCore

struct MenuBarPanel: View {
  @Environment(\.openWindow) private var openWindow
  @ObservedObject var model: AppModel

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .firstTextBaseline) {
        Text("Syncy")
          .font(.system(.title2, design: .serif, weight: .semibold))
        Spacer()
        Text(statusWord)
          .font(.caption)
          .foregroundStyle(SyncyTheme.secondaryInk)
      }
      .padding(.bottom, 18)

      if model.isLaunchingJob, model.snapshot?.activeJob == nil {
        HStack(spacing: 9) {
          ProgressView().controlSize(.small)
          Text("Starting work")
        }
      } else if model.isLoading, model.snapshot == nil {
        HStack(spacing: 9) {
          ProgressView().controlSize(.small)
          Text("Reading ledger")
        }
      } else if let snapshot = model.snapshot {
        if let active = snapshot.activeJob {
          ActiveJobSummary(job: active)
        } else {
          SnapshotSummary(snapshot: snapshot)
        }
      } else {
        VStack(alignment: .leading, spacing: 6) {
          Text("Ledger unavailable").font(.headline)
          Text(model.errorMessage ?? "The engine returned no snapshot.")
            .font(.caption)
            .foregroundStyle(SyncyTheme.secondaryInk)
            .fixedSize(horizontal: false, vertical: true)
        }
      }

      Divider().padding(.vertical, 16)

      HStack {
        Button("Open Syncy") {
          openWindow(id: "ledger")
          NSApp.activate(ignoringOtherApps: true)
        }
        .keyboardShortcut(.defaultAction)
        Spacer()
        Button("Refresh") { Task { await model.refresh() } }
          .disabled(model.isLoading)
      }
    }
    .padding(18)
    .frame(width: 360)
    .background(SyncyTheme.paper)
    .task { await model.loadIfNeeded() }
  }

  private var statusWord: String {
    if model.isLaunchingJob { return "starting" }
    if model.snapshot?.activeJob != nil { return "running" }
    if model.isLoading { return "reading" }
    if model.errorMessage != nil { return "unavailable" }
    return "ledger"
  }
}

private struct ActiveJobSummary: View {
  let job: ActiveJobSnapshot

  var body: some View {
    TimelineView(.periodic(from: .now, by: 1)) { context in
      VStack(alignment: .leading, spacing: 8) {
        Text(operationTitle)
          .font(.headline)
        if let activity = job.activity {
          Text("\(phaseName(activity.phase)) · \(activity.unit) → \(activity.target)")
            .font(.callout)
            .foregroundStyle(SyncyTheme.secondaryInk)
          if let seen = activity.filesSeen, let total = activity.filesTotal, total > 0 {
            ProgressView(value: Double(seen), total: Double(total))
            Text("\(seen.formatted()) of \(total.formatted()) files observed")
              .font(.caption.monospacedDigit())
              .foregroundStyle(SyncyTheme.secondaryInk)
          }
        }
        Text(elapsed(at: context.date))
          .font(.system(.title3, design: .monospaced, weight: .semibold))
          .monospacedDigit()
        Text("Owned by the \(ownerName). Refresh to read newly recorded evidence.")
          .font(.caption)
          .foregroundStyle(SyncyTheme.secondaryInk)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }

  private var ownerName: String {
    switch job.actor {
    case "mac": "Mac app"
    case "scheduler": "background scheduler"
    default: "command-line app"
    }
  }

  private var operationTitle: String {
    switch job.operation {
    case "deep": "Deep verify is running"
    case "sync": "Sync is running"
    case "setup": "Setup is running"
    default: "Quick check is running"
    }
  }

  private func elapsed(at date: Date) -> String {
    let started = Date(timeIntervalSince1970: job.startedAt / 1_000)
    let seconds = max(0, Int(date.timeIntervalSince(started)))
    let hours = seconds / 3_600
    let minutes = (seconds % 3_600) / 60
    let remainder = seconds % 60
    if hours > 0 { return "\(hours)h \(minutes)m elapsed" }
    if minutes > 0 { return "\(minutes)m \(remainder)s elapsed" }
    return "\(remainder)s elapsed"
  }

  private func phaseName(_ value: String) -> String {
    value.replacingOccurrences(of: "-", with: " ").capitalized
  }
}

private struct SnapshotSummary: View {
  let snapshot: EngineSnapshot

  var body: some View {
    VStack(alignment: .leading, spacing: 9) {
      ForEach(LedgerState.allCases, id: \.self) { state in
        let count = snapshot.units.filter { $0.state == state }.count
        if count > 0 {
          EvidenceSummaryRow(value: count.formatted(), label: unitLabel(count, state: state))
        }
      }
      ForEach(snapshot.targets.filter { $0.reachability != .ok }) { target in
        EvidenceSummaryRow(value: target.name, label: target.reachability.rawValue)
      }
      Text("Snapshot \(formattedDate)")
        .font(.caption)
        .foregroundStyle(SyncyTheme.quietInk)
        .padding(.top, 4)
    }
  }

  private var formattedDate: String {
    Date(timeIntervalSince1970: snapshot.generatedAt / 1_000).formatted(
      date: .omitted, time: .shortened)
  }

  private func unitLabel(_ count: Int, state: LedgerState) -> String {
    "unit\(count == 1 ? "" : "s") \(state.rawValue)"
  }
}

private struct EvidenceSummaryRow: View {
  let value: String
  let label: String

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 9) {
      Text(value)
        .font(.system(.body, design: .monospaced, weight: .semibold))
        .monospacedDigit()
        .frame(minWidth: 26, alignment: .trailing)
      Text(label)
        .font(.callout)
        .foregroundStyle(SyncyTheme.secondaryInk)
    }
  }
}
