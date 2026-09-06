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
        SettingsLink {
          Image(systemName: "gearshape")
        }
        .buttonStyle(.borderless)
        .help("Open Syncy settings")
      }
      .padding(.bottom, 18)

      if model.isLaunchingJob, model.activeJob == nil {
        HStack(spacing: 9) {
          ProgressView().controlSize(.small)
          Text("Starting work")
        }
      } else if model.isLoading, model.snapshot == nil {
        HStack(spacing: 9) {
          ProgressView().controlSize(.small)
          Text("Reading ledger")
        }
      } else if let engineError = model.engineErrorMessage {
        StatusProblem(
          title: "Ledger unavailable",
          detail: engineError)
      } else if let active = model.activeJob {
        ActiveJobSummary(job: active)
      } else if let error = model.errorMessage {
        StatusProblem(
          title: "Last work needs attention",
          detail: error)
      } else if let snapshot = model.snapshot {
        VStack(alignment: .leading, spacing: SyncySpace.md) {
          if let outcome = model.jobOutcomeMessage {
            Text(outcome)
              .font(.caption)
              .foregroundStyle(SyncyTheme.secondaryInk)
          }
          SnapshotSummary(snapshot: snapshot)
        }
      } else {
        StatusProblem(title: "Ledger unavailable", detail: "The engine returned no snapshot.")
      }

      Divider().padding(.vertical, 16)

      HStack {
        Button("Open Syncy") {
          openWindow(id: "ledger")
          NSApp.activate(ignoringOtherApps: true)
        }
        .keyboardShortcut(.defaultAction)
        Spacer()
        if model.canCancelOwnedJob {
          Button(model.isCancellingJob ? "Cancelling…" : "Cancel…", role: .destructive) {
            model.cancelOwnedJob()
          }
          .disabled(model.isCancellingJob)
        }
        Button("Refresh") { Task { await model.refresh() } }
          .disabled(model.isRefreshing)
      }
    }
    .padding(SyncySpace.lg)
    .frame(width: 360)
    .background(SyncyTheme.paper)
    .task { await model.loadIfNeeded() }
  }

  private var statusWord: String {
    if model.activeJob != nil { return "running" }
    if model.isLaunchingJob { return "starting" }
    if model.isLoading, model.snapshot == nil { return "reading" }
    if model.engineErrorMessage != nil { return "unavailable" }
    if model.errorMessage != nil { return "error" }
    guard let snapshot = model.snapshot else { return "unchecked" }
    for state in [LedgerState.error, .missing, .behind, .unchecked, .unverified, .verified] {
      if snapshot.units.contains(where: { $0.state == state }) { return state.rawValue }
    }
    if snapshot.targets.contains(where: { $0.reachability != .ok }) { return "unchecked" }
    return "unchecked"
  }
}

private struct StatusProblem: View {
  let title: String
  let detail: String

  var body: some View {
    VStack(alignment: .leading, spacing: SyncySpace.sm) {
      Text(title).font(.headline)
      Text(detail)
        .font(.caption)
        .foregroundStyle(SyncyTheme.secondaryInk)
        .fixedSize(horizontal: false, vertical: true)
    }
  }
}

private struct ActiveJobSummary: View {
  let job: ActiveJobSnapshot

  var body: some View {
    TimelineView(.periodic(from: .now, by: 1)) { context in
      VStack(alignment: .leading, spacing: 8) {
        Text(operationTitle)
          .font(.headline)
        if let position = job.batchPosition, let total = job.batchTotal, total > 1 {
          Text("Folder \(position.formatted()) of \(total.formatted())")
            .font(.caption.monospacedDigit())
            .foregroundStyle(SyncyTheme.secondaryInk)
        }
        if let activity = job.activity {
          Text("\(phaseName(activity.phase)) · \(activity.unit) → \(activity.target)")
            .font(.callout)
            .foregroundStyle(SyncyTheme.secondaryInk)
          if let seen = activity.filesSeen, let total = activity.filesTotal, total > 0 {
            ProgressView(value: Double(seen), total: Double(total))
            Text("\(seen.formatted()) of \(total.formatted()) files observed")
              .font(.caption.monospacedDigit())
              .foregroundStyle(SyncyTheme.secondaryInk)
          } else if let done = activity.bytesDone, let total = activity.bytesTotal, total > 0 {
            ProgressView(value: Double(done), total: Double(total))
            Text("\(bytes(done)) of \(bytes(total)) observed · rsync measured")
              .font(.caption.monospacedDigit())
              .foregroundStyle(SyncyTheme.secondaryInk)
          } else if let seen = activity.filesSeen {
            Text("\(seen.formatted()) files observed · no measured total")
              .font(.caption.monospacedDigit())
              .foregroundStyle(SyncyTheme.secondaryInk)
          } else {
            Text("No file-level results yet · elapsed time remains authoritative")
              .font(.caption)
              .foregroundStyle(SyncyTheme.secondaryInk)
          }
          Text("Last engine event \(age(since: activity.at, at: context.date))")
            .font(.caption)
            .foregroundStyle(SyncyTheme.quietInk)
          if let item = activity.lastItem, !item.isEmpty {
            Text(item)
              .font(.caption.monospaced())
              .foregroundStyle(SyncyTheme.quietInk)
              .lineLimit(1)
              .truncationMode(.middle)
          }
        }
        Text(elapsed(at: context.date))
          .font(.system(.title3, design: .monospaced, weight: .semibold))
          .monospacedDigit()
        if let prior = job.priorDurationMs, prior > 0 {
          Text("This folder previously took about \(duration(milliseconds: prior))")
            .font(.caption)
            .foregroundStyle(SyncyTheme.secondaryInk)
        }
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

  private func age(since milliseconds: Double, at date: Date) -> String {
    let seconds = max(0, Int(date.timeIntervalSince1970 - milliseconds / 1_000))
    if seconds < 5 { return "just now" }
    if seconds < 60 { return "\(seconds)s ago" }
    return "\(seconds / 60)m ago"
  }

  private func bytes(_ value: Int64) -> String {
    ByteCountFormatter.string(fromByteCount: value, countStyle: .file).lowercased()
  }

  private func duration(milliseconds: Double) -> String {
    let seconds = max(0, Int(milliseconds / 1_000))
    if seconds >= 3_600 { return "\(seconds / 3_600)h \((seconds % 3_600) / 60)m" }
    if seconds >= 60 { return "\(seconds / 60)m \(seconds % 60)s" }
    return "\(seconds)s"
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
      if verifiedBytes > 0 {
        EvidenceSummaryRow(value: bytes(verifiedBytes), label: "source bytes deep verified")
      }
      ForEach(snapshot.targets.filter { $0.reachability != .ok }) { target in
        EvidenceSummaryRow(
          value: target.name,
          label: target.reachabilityPhrase ?? target.reachability.ledgerPhrase)
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

  private var verifiedBytes: Int64 {
    snapshot.units.filter { $0.state == .verified }.reduce(0) {
      $0 + $1.fingerprint.bytes
    }
  }

  private func bytes(_ value: Int64) -> String {
    ByteCountFormatter.string(fromByteCount: value, countStyle: .file).lowercased()
  }

  private func unitLabel(_ count: Int, state: LedgerState) -> String {
    "folder\(count == 1 ? "" : "s") \(state.rawValue)"
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
