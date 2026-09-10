import AppKit
import ServiceManagement
import SwiftUI
import SyncyMacCore

private struct DifferenceGroup: Identifiable {
  var id: String { kind }
  let kind: String
  let label: String
  let count: Int64
}

struct DifferencesView: View {
  @ObservedObject var model: AppModel
  var showsHeader = true
  @State private var targetName = ""
  @State private var targetUnit = ""

  private var unit: UnitSnapshot? { model.selectedUnit }
  private var query: String { "\(unit?.unit ?? "")\u{0}\(targetName)" }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if showsHeader {
        PageHeader(title: "Differences", detail: unit?.unit ?? "No folder selected")
      }
      if let unit {
        VStack(alignment: .leading, spacing: 0) {
          Picker("Destination", selection: $targetName) {
            ForEach(unit.cells) { cell in Text(cell.target).tag(cell.target) }
          }
          .frame(maxWidth: 420)
          .padding(.horizontal, SyncySpace.gutter)
          .padding(.vertical, SyncySpace.lg)
          if model.isLoadingDifferences {
            PaneNotice(title: "Reading recorded differences", isWorking: true)
          } else if let error = model.differencesErrorMessage {
            PaneNotice(
              title: "Differences unavailable",
              detail: error,
              symbol: "exclamationmark.triangle")
          } else if let envelope = model.differences,
            envelope.unit == unit.unit, envelope.target == targetName,
            let diff = envelope.diff
          {
            let reachability =
              envelope.provenance?.reachability
              ?? model.snapshot?.targets.first(where: { $0.name == targetName })?.reachability
            if envelope.provenance?.identityMatches == false || reachability == .mismatch {
              PaneNotice(
                title: "Destination identity changed",
                detail:
                  "This listing was recorded against a different volume. Current status is unchecked.",
                symbol: "externaldrive.badge.questionmark")
            } else if let reachability, reachability != .ok {
              PaneNotice(
                title: "Destination unavailable",
                detail:
                  "\(targetName) is \(reachability.ledgerPhrase). The recorded listing is historical; no current verification is implied.",
                symbol: "externaldrive.badge.questionmark")
            } else if envelope.provenance == nil {
              PaneNotice(
                title: "Recorded listing has no destination identity",
                detail:
                  "Run a check to establish whether this listing applies to the destination available now.",
                symbol: "externaldrive.badge.questionmark")
            } else if envelope.provenance?.current == false {
              PaneNotice(
                title: "Recorded listing is not current",
                detail: "No current verification is implied.",
                symbol: "clock.badge.exclamationmark")
            } else if sourceChanged(since: diff, current: unit.fingerprint) {
              PaneNotice(
                title: "Evidence is stale",
                detail:
                  "The source changed after this listing was recorded. Current status is \(unit.cell(for: targetName)?.state.rawValue ?? "unverified").",
                symbol: "clock.badge.exclamationmark")
            } else if diff.wholeFolderMissing {
              PaneNotice(
                title: envelope.presentation?.title ?? "Whole folder missing",
                detail: envelope.presentation?.detail
                  ?? "The source holds the files; nothing was itemized at this destination.",
                symbol: "folder.badge.minus")
            } else if diff.entries.isEmpty {
              PaneNotice(
                title: envelope.presentation?.title ?? "No differences",
                detail: envelope.presentation?.detail ?? cleanDifferenceDescription(diff),
                symbol: "equal.circle")
            } else {
              let groups = differenceGroups(envelope: envelope, diff: diff)
              List {
                Section {
                  HStack(spacing: SyncySpace.lg) {
                    ForEach(groups) { group in
                      Text("\(group.count.formatted()) \(group.label)")
                    }
                    Spacer()
                    if diff.truncated == 0, let files = envelope.presentation?.copyableFiles {
                      Text("\(files.formatted()) files to copy")
                    }
                  }
                  .font(.caption)
                  .foregroundStyle(SyncyTheme.secondaryInk)
                }
                ForEach(groups) { group in
                  Section("\(group.label) · \(group.count.formatted())") {
                    ForEach(diff.entries.filter { $0.kind == group.kind }) { entry in
                      HStack(alignment: .firstTextBaseline, spacing: SyncySpace.md) {
                        Text(entry.name).textSelection(.enabled)
                        Spacer()
                        if entry.sized {
                          Text(
                            ByteCountFormatter.string(
                              fromByteCount: entry.bytes, countStyle: .file
                            ).lowercased()
                          )
                          .font(.caption.monospacedDigit())
                          .foregroundStyle(SyncyTheme.secondaryInk)
                        }
                      }
                      .padding(.vertical, SyncySpace.xs)
                    }
                  }
                }
              }
              .listStyle(.inset)
              .overlay(alignment: .bottom) {
                if diff.truncated > 0 {
                  Text("\(diff.truncated.formatted()) more not stored · counts remain exact")
                    .font(.caption)
                    .foregroundStyle(SyncyTheme.secondaryInk)
                    .padding(.horizontal, SyncySpace.md)
                    .padding(.vertical, SyncySpace.sm)
                    .background(.bar, in: Capsule())
                    .padding(.bottom, SyncySpace.md)
                }
              }
            }
          } else if let envelope = model.differences,
            envelope.unit == unit.unit, envelope.target == targetName
          {
            PaneNotice(
              title: envelope.presentation?.title ?? "No check recorded",
              detail: envelope.presentation?.detail
                ?? "No recorded check for this destination. Run a check to record differences.",
              symbol: "arrow.left.arrow.right")
          } else {
            PaneNotice(
              title: "No check recorded",
              detail: "No recorded check for this destination.",
              symbol: "arrow.left.arrow.right")
          }
        }
        .task(id: query) {
          if targetUnit != unit.unit
            || targetName.isEmpty
            || !unit.cells.contains(where: { $0.target == targetName })
          {
            targetUnit = unit.unit
            targetName = preferredDestination(in: unit) ?? ""
            return
          }
          if !targetName.isEmpty {
            await model.loadDifferences(unit: unit.unit, target: targetName)
          }
        }
      } else {
        PaneNotice(
          title: "No folder selected",
          detail: "Choose a folder in the ledger to read its recorded differences.",
          symbol: "arrow.left.arrow.right")
      }
    }
  }

  private func differenceLabel(_ kind: String) -> String {
    switch kind {
    case "new": "not at destination"
    case "changed": "content differs"
    case "metadata": "attributes differ"
    case "extra": "only at destination"
    default: kind
    }
  }

  private func differenceGroups(envelope: DiffEnvelope, diff: RecordedDiff)
    -> [DifferenceGroup]
  {
    if let parts = envelope.presentation?.parts {
      return parts.map { DifferenceGroup(kind: $0.kind, label: $0.label, count: $0.count) }
    }
    let order = ["new", "changed", "metadata", "extra"]
    return order.compactMap { kind in
      let count = Int64(diff.entries.filter { $0.kind == kind }.count)
      return count == 0
        ? nil : DifferenceGroup(kind: kind, label: differenceLabel(kind), count: count)
    }
  }

  private func sourceChanged(since diff: RecordedDiff, current: FingerprintSnapshot) -> Bool {
    guard let recorded = diff.sourceHolds else { return false }
    return recorded.nfiles != current.nfiles || recorded.bytes != current.bytes
      || recorded.maxMtimeNs != current.maxMtimeNs
  }

  private func preferredDestination(in unit: UnitSnapshot) -> String? {
    let required = Set(
      (model.snapshot?.targets ?? []).filter(\.required).map(\.name))
    let needsWork: [LedgerState] = [.error, .missing, .behind, .unchecked, .unverified]
    for state in needsWork {
      if let match = unit.cells.first(where: {
        $0.state == state && required.contains($0.target)
      }) {
        return match.target
      }
    }
    for state in needsWork {
      if let match = unit.cells.first(where: { $0.state == state }) { return match.target }
    }
    if let recorded = unit.cells.first(where: { $0.evidence?.lastCheck != nil }) {
      return recorded.target
    }
    return unit.cells.first?.target
  }

  private func recordedCheckDescription(_ diff: RecordedDiff) -> String {
    let operation = diff.method == "deep" ? "Deep verify" : "Quick check"
    let when = Date(timeIntervalSince1970: diff.ts / 1_000).formatted(
      date: .abbreviated, time: .shortened)
    return "\(operation) \(when) · no differences recorded"
  }

  private func cleanDifferenceDescription(_ diff: RecordedDiff) -> String {
    guard let source = diff.sourceHolds else { return recordedCheckDescription(diff) }
    let sourceSummary =
      "source \(source.nfiles.formatted()) files · \(bytes(source.bytes))"
    guard let destination = diff.targetHolds else {
      return "\(recordedCheckDescription(diff))\n\(sourceSummary) · destination not measured"
    }
    let destinationSummary =
      "destination \(destination.nfiles.formatted()) files · \(bytes(destination.bytes))"
    let totals =
      source.nfiles == destination.nfiles && source.bytes == destination.bytes
      ? " · identical totals" : ""
    return "\(recordedCheckDescription(diff))\n\(sourceSummary) · \(destinationSummary)\(totals)"
  }

  private func bytes(_ value: Int64) -> String {
    ByteCountFormatter.string(fromByteCount: value, countStyle: .file).lowercased()
  }
}

struct HistoryView: View {
  @ObservedObject var model: AppModel
  var showsHeader = true

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if showsHeader {
        PageHeader(title: "History", detail: "Literal task outcomes, newest first")
      }
      if model.isLoadingHistory {
        PaneNotice(title: "Reading task history", isWorking: true)
      } else if let error = model.historyErrorMessage {
        PaneNotice(
          title: "History unavailable", detail: error, symbol: "exclamationmark.triangle")
      } else if model.historyEntries.isEmpty {
        PaneNotice(
          title: "No task outcomes",
          detail: "Nothing has run yet.",
          symbol: "clock.arrow.circlepath")
      } else {
        List(model.historyEntries) { entry in
          HStack(alignment: .firstTextBaseline, spacing: SyncySpace.lg) {
            Text(
              Date(timeIntervalSince1970: entry.ts / 1_000).formatted(
                date: .abbreviated, time: .shortened)
            )
            .font(.caption.monospacedDigit())
            .frame(width: 135, alignment: .leading)
            Text(operationTitle(entry.operation)).frame(width: 92, alignment: .leading)
            VStack(alignment: .leading, spacing: SyncySpace.xs) {
              Text("\(entry.unit) → \(entry.target)")
              if let detail = entry.detail {
                Text(detail).font(.caption).foregroundStyle(SyncyTheme.secondaryInk)
              }
            }
            Spacer()
            Text(entry.outcome)
              .font(.callout.weight(.medium))
          }
          .padding(.vertical, SyncySpace.xs)
        }
        .listStyle(.inset)
        .refreshable { await model.loadHistory() }
      }
    }
    .task { await model.loadHistory() }
  }

  private func operationTitle(_ operation: String) -> String {
    switch operation {
    case "deep": "Deep verify"
    case "quick": "Quick check"
    case "sync": "Sync"
    default: operation
    }
  }
}

struct SchedulesView: View {
  @ObservedObject var model: AppModel
  var showsHeader = true
  @State private var operation: EngineCheckOperationValue = .quick
  @State private var unit = ""
  @State private var target = ""
  @State private var acceptsScheduledWrites = false
  @State private var cadence: ScheduleCadence = .daily
  @State private var weekday = 1
  @State private var time = Date()

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if showsHeader {
        PageHeader(title: "Schedules", detail: "Work runs while Syncy lives in the menu bar")
      }
      Form {
        Section("Existing schedules") {
          if model.schedules.isEmpty {
            Text("No schedules configured")
              .foregroundStyle(SyncyTheme.secondaryInk)
          }
          ForEach(model.schedules) { schedule in
            HStack {
              Toggle(
                isOn: Binding(
                  get: { schedule.enabled },
                  set: { model.setScheduleEnabled(id: schedule.id, enabled: $0) }
                )
              ) {
                VStack(alignment: .leading, spacing: SyncySpace.xs) {
                  Text(scheduleTitle(schedule))
                  Text(scheduleDescription(schedule))
                    .font(.caption)
                    .foregroundStyle(SyncyTheme.secondaryInk)
                  if schedule.operation == .sync,
                    !schedule.isApproved(forConfigRevision: model.snapshot?.configRevision)
                  {
                    Label {
                      Text("suspended · configuration changed")
                    } icon: {
                      Image(systemName: "pause.circle")
                        .foregroundStyle(SyncyTheme.caution)
                    }
                    .font(.caption)
                    .foregroundStyle(SyncyTheme.secondaryInk)
                  }
                }
              }
              Spacer(minLength: SyncySpace.lg)
              if schedule.operation == .sync,
                !schedule.isApproved(forConfigRevision: model.snapshot?.configRevision)
              {
                Button("Review") { model.reviewSchedule(id: schedule.id) }
                  .buttonStyle(.link)
                  .help("Configuration changed; approve this exact source and destination setup")
              }
              Button("Remove", role: .destructive) { model.removeSchedule(id: schedule.id) }
                .buttonStyle(.link)
            }
          }
        }
        Section {
          Picker("Work", selection: $operation) {
            Text("Quick check").tag(EngineCheckOperationValue.quick)
            Text("Deep verify").tag(EngineCheckOperationValue.deep)
            Text("Sync files").tag(EngineCheckOperationValue.sync)
          }
          Picker("Scope", selection: $unit) {
            if operation != .sync { Text("All folders").tag("") }
            ForEach(model.snapshot?.units ?? []) { unit in Text(unit.unit).tag(unit.unit) }
          }
          if operation == .sync {
            Picker("Destination", selection: $target) {
              Text("Choose a destination").tag("")
              ForEach(model.snapshot?.targets ?? []) { destination in
                Text(destination.name).tag(destination.name)
              }
            }
            Toggle(
              "Allow this schedule to copy files to the named destination",
              isOn: $acceptsScheduledWrites)
            Text(
              "Every run performs a fresh guarded preflight. It refuses to start if the source, destination identity, rsync command, or capabilities do not match. Syncy never deletes files."
            )
            .font(.caption)
            .foregroundStyle(SyncyTheme.secondaryInk)
            .fixedSize(horizontal: false, vertical: true)
          }
          Picker("Cadence", selection: $cadence) {
            Text("Daily").tag(ScheduleCadence.daily)
            Text("Weekly").tag(ScheduleCadence.weekly)
          }
          if cadence == .weekly {
            Picker("Day", selection: $weekday) {
              ForEach(1...7, id: \.self) { day in
                Text(Calendar.current.weekdaySymbols[day - 1]).tag(day)
              }
            }
          }
          DatePicker("Time", selection: $time, displayedComponents: .hourAndMinute)
          Button("Add schedule") {
            let parts = Calendar.current.dateComponents([.hour, .minute], from: time)
            model.addSchedule(
              CheckSchedule(
                operation: operation,
                unit: unit.isEmpty ? nil : unit,
                target: operation == .sync ? target : nil,
                cadence: cadence,
                weekday: weekday,
                hour: parts.hour ?? 0,
                minute: parts.minute ?? 0,
                approvedConfigRevision: operation == .sync ? model.snapshot?.configRevision : nil))
          }
          .disabled(
            model.snapshot == nil
              || (operation == .sync && (unit.isEmpty || target.isEmpty || !acceptsScheduledWrites))
          )
        } header: {
          Text("New schedule")
        } footer: {
          Text(
            "Schedules run whenever the Mac and Syncy are awake, including on battery. After sleep, Syncy runs the latest missed occurrence once. A destination that is not connected is recorded as skipped, not completed."
          )
        }
      }
      .formStyle(.grouped)
    }
  }

  private func scheduleDescription(_ schedule: CheckSchedule) -> String {
    let time = DateComponents(calendar: .current, hour: schedule.hour, minute: schedule.minute)
    let date = time.date?.formatted(date: .omitted, time: .shortened) ?? "scheduled time"
    if schedule.cadence == .daily { return "Every day at \(date)" }
    return "\(Calendar.current.weekdaySymbols[schedule.weekday - 1]) at \(date)"
  }

  private func scheduleTitle(_ schedule: CheckSchedule) -> String {
    if schedule.operation == .sync {
      return "Sync · \(schedule.unit ?? "no folder") → \(schedule.target ?? "no destination")"
    }
    return "\(schedule.operation.readerTitle) · \(schedule.unit ?? "all folders")"
  }
}

struct EvidenceView: View {
  let unit: UnitSnapshot?
  var showsHeader = true

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if showsHeader {
        PageHeader(title: "Evidence", detail: unit?.unit ?? "No folder selected")
      }
      if let unit {
        List(unit.cells) { destination in
          Section(destination.target) {
            HStack(alignment: .top, spacing: SyncySpace.md) {
              StateMark(state: destination.state)
              VStack(alignment: .leading, spacing: SyncySpace.sm) {
                Text(destination.state.rawValue)
                  .font(.headline)
                Text(destination.differenceSummary ?? destination.reason)
                  .font(.callout)
                  .foregroundStyle(SyncyTheme.secondaryInk)
                if destination.evidence?.currentTarget == false {
                  Text("Recorded evidence does not establish the destination available now.")
                    .font(.caption)
                    .foregroundStyle(SyncyTheme.secondaryInk)
                }
              }
              Spacer()
            }
            if let check = destination.evidence?.lastCheck {
              LabeledContent(
                destination.evidence?.currentTarget == false ? "Historical check" : "Last check",
                value: checkDescription(check))
              LabeledContent(
                "Result",
                value:
                  "\(check.nChanges.formatted()) changes · \(formatBytes(check.bytesPending)) pending"
              )
              if let deep = destination.evidence?.deepCheck, deep.at != check.at {
                LabeledContent("Last deep verify", value: checkDescription(deep))
              }
              if destination.nExtra > 0 {
                LabeledContent(
                  "Only at destination",
                  value: "\(destination.nExtra.formatted()) · left unchanged")
              }
            } else {
              Text("No check recorded for this destination.")
                .font(.caption)
                .foregroundStyle(SyncyTheme.secondaryInk)
            }
          }
        }
        .listStyle(.inset)
      }
    }
  }

  private func checkDescription(_ check: CheckEvidenceSnapshot) -> String {
    let method = check.method == "deep" ? "Deep verify" : "Quick check"
    let when = Date(timeIntervalSince1970: check.at / 1_000).formatted(
      date: .abbreviated, time: .shortened)
    guard let duration = check.durationMs else { return "\(method) · \(when)" }
    return "\(method) · \(when) · \(formatDuration(duration))"
  }

  private func formatBytes(_ value: Int64) -> String {
    ByteCountFormatter.string(fromByteCount: value, countStyle: .file).lowercased()
  }

  private func formatDuration(_ milliseconds: Double) -> String {
    let seconds = max(0, Int(milliseconds / 1_000))
    if seconds >= 3_600 { return "\(seconds / 3_600)h \((seconds % 3_600) / 60)m" }
    if seconds >= 60 { return "\(seconds / 60)m \(seconds % 60)s" }
    return "\(seconds)s"
  }
}

struct SyncConfirmationView: View {
  @ObservedObject var model: AppModel
  @State private var targetName = ""
  @State private var reviewed = false

  private var unit: UnitSnapshot? { model.selectedUnit }
  private var eligibleTargets: [String] {
    guard let unit else { return [] }
    return unit.cells
      .filter { $0.state == .behind || $0.state == .missing }
      .map(\.target)
  }
  private var prepared: SyncPreflight? {
    guard model.syncPreflight?.unit == unit?.unit, model.syncPreflight?.target == targetName else {
      return nil
    }
    return model.syncPreflight
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      PageHeader(title: "Sync", detail: "Review the transfer before it starts")
      Form {
        LabeledContent("Folder", value: unit?.unit ?? "No folder selected")
        Picker("Destination", selection: $targetName) {
          if eligibleTargets.isEmpty {
            Text("No destination needs syncing").tag("")
          } else {
            ForEach(eligibleTargets, id: \.self) { target in Text(target).tag(target) }
          }
        }
        .onChange(of: targetName) {
          reviewed = false
          model.clearSyncPreflight()
        }

        if model.isPreparingSync {
          WorkingNotice(text: "Checking identity, free space, and command")
        } else if let prepared {
          Section("Preflight") {
            ForEach(prepared.checks) { check in
              LabeledContent(
                check.name, value: "\(check.ok ? "passed" : "blocked") · \(check.detail)"
              )
              .foregroundStyle(check.ok ? .primary : SyncyTheme.fault)
            }
            LabeledContent(
              prepared.nFiles == nil ? "Changes to transfer" : "Files to transfer",
              value: (prepared.nFiles ?? prepared.nChanges).formatted())
            LabeledContent(
              "Bytes to transfer",
              value: ByteCountFormatter.string(
                fromByteCount: prepared.bytesPending, countStyle: .file
              ).lowercased())
            // "Only at destination" everywhere: the evidence inspector and the
            // folder summary already name this fact that way, and a count that
            // skips `formatted()` loses its separator at four digits.
            LabeledContent(
              "Only at destination",
              value: "\(prepared.nExtra.formatted()) · left unchanged")
          }
          Section("Command") {
            Text(prepared.argv.joined(separator: " "))
              .font(.system(.callout, design: .monospaced))
              .foregroundStyle(SyncyTheme.secondaryInk)
              .textSelection(.enabled)
            Toggle("I reviewed this source, destination, and command", isOn: $reviewed)
              .disabled(!prepared.ok)
          }
        } else {
          Section {
            Text("Run a fresh preflight before reviewing the sync. Nothing has run yet.")
              .foregroundStyle(SyncyTheme.secondaryInk)
          }
        }
        HStack {
          Button("Run preflight") {
            guard let unit else { return }
            Task { await model.prepareSync(unit: unit.unit, target: targetName) }
          }
          .disabled(
            unit == nil || targetName.isEmpty || model.isPreparingSync || model.isLaunchingJob
              || model.activeJob != nil)
          Spacer()
          if model.isLaunchingJob {
            Button(model.isCancellingJob ? "Cancelling…" : "Cancel sync…", role: .destructive) {
              model.cancelSync()
            }
            .disabled(model.isCancellingJob)
          } else {
            Button("Begin sync") {
              model.startPreparedSync()
            }
            .buttonStyle(.borderedProminent)
            .disabled(prepared?.ok != true || !reviewed || model.activeJob != nil)
            .help("Requires a fresh preflight and explicit review")
          }
        }
      }
      .formStyle(.grouped)
    }
    .task(id: unit?.id) {
      targetName = eligibleTargets.first ?? ""
      reviewed = false
      model.clearSyncPreflight()
    }
  }
}

/// Name and status stack on the leading edge so the actions stay flush right no
/// matter how long a reachability phrase runs. The sentinel is a fact about the
/// destination, so it is reported on the status line; only the missing case is
/// something to act on.
private struct DestinationRow: View {
  let target: TargetSnapshot
  let isBusy: Bool
  let adopt: () -> Void
  let remove: () -> Void

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: SyncySpace.lg) {
      VStack(alignment: .leading, spacing: SyncySpace.xs) {
        Text(target.name)
        Text(status)
          .font(.caption)
          .foregroundStyle(SyncyTheme.secondaryInk)
      }
      Spacer(minLength: SyncySpace.lg)
      if !target.usesSentinel {
        Button("Add sentinel", action: adopt)
          .buttonStyle(.link)
          .disabled(isBusy)
          .help("Write Syncy's identity sentinel through rsync and record it in configuration")
      }
      Button("Remove…", role: .destructive, action: remove)
        .buttonStyle(.link)
        .disabled(isBusy)
    }
    .padding(.vertical, SyncySpace.xs)
  }

  private var status: String {
    let reachability = target.reachabilityPhrase ?? target.reachability.ledgerPhrase
    let requirement = target.required ? "required" : "optional"
    let sentinel = target.usesSentinel ? "sentinel recorded" : "no sentinel"
    return "\(reachability) · \(requirement) · \(sentinel)"
  }
}

struct SetupView: View {
  @ObservedObject var model: AppModel
  var showsHeader = true
  @State private var pendingDestination: URL?
  @State private var destinationName = ""
  @State private var destinationToRemove: String?

  private var snapshot: EngineSnapshot? { model.snapshot }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if showsHeader {
        PageHeader(title: "Source & destinations", detail: "Identity and availability")
      }
      Form {
        Section("Source") {
          LabeledContent("Folder", value: snapshot?.source ?? "not reported")
          Button("Choose source folder…") {
            guard let url = chooseFolder(prompt: "Choose the folder whose subfolders Syncy tracks")
            else { return }
            Task { await model.setSource(path: url.path) }
          }
          .disabled(model.isUpdatingSetup || model.activeJob != nil)
        }
        Section {
          if let targets = snapshot?.targets, !targets.isEmpty {
            ForEach(targets) { target in
              DestinationRow(
                target: target,
                isBusy: model.isUpdatingSetup || model.activeJob != nil,
                adopt: { Task { await model.adoptDestination(name: target.name) } },
                remove: { destinationToRemove = target.name })
            }
          } else {
            Text("not reported")
              .foregroundStyle(SyncyTheme.secondaryInk)
          }
          Button("Choose destination folder…") {
            guard let url = chooseFolder(prompt: "Choose a mounted destination") else { return }
            pendingDestination = url
            destinationName = url.lastPathComponent
          }
          .disabled(
            snapshot?.source.isEmpty != false || model.isUpdatingSetup
              || model.activeJob != nil)
        } header: {
          Text("Destinations")
        } footer: {
          // Was two sentences and 143 characters, the first of which reported
          // which component runs the probe — true, and no concern of the person
          // reading it. What is left is the half that is about them.
          Text("Syncy never writes to a source or destination from this screen.")
        }
        if let pendingDestination {
          Section("Add destination") {
            LabeledContent("Folder", value: pendingDestination.path)
            TextField("Name", text: $destinationName)
            HStack {
              Button("Cancel") {
                self.pendingDestination = nil
                destinationName = ""
              }
              Spacer()
              Button("Identify and add") {
                let path = pendingDestination.path
                let name = destinationName.trimmingCharacters(in: .whitespacesAndNewlines)
                Task {
                  // The model reports whether it wrote; the sentence it shows
                  // the reader is not a return value.
                  if await model.addDestination(path: path, name: name) {
                    self.pendingDestination = nil
                    destinationName = ""
                  }
                }
              }
              .disabled(destinationName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
          }
        }
        if let message = model.setupMessage {
          Section("Last configuration change") {
            if model.isUpdatingSetup {
              WorkingNotice(text: message)
            } else {
              Text(message).foregroundStyle(SyncyTheme.secondaryInk)
            }
          }
        }
      }
      .formStyle(.grouped)
    }
    .confirmationDialog(
      "Remove \(destinationToRemove ?? "this destination") from Syncy?",
      isPresented: Binding(
        get: { destinationToRemove != nil },
        set: { if !$0 { destinationToRemove = nil } }
      )
    ) {
      if let name = destinationToRemove {
        Button("Remove \(name) from configuration", role: .destructive) {
          destinationToRemove = nil
          Task { await model.removeDestination(name: name) }
        }
      }
      Button("Cancel", role: .cancel) { destinationToRemove = nil }
    } message: {
      Text(
        "No files are deleted. Existing evidence for this destination stops contributing to the ledger."
      )
    }
  }

  private func chooseFolder(prompt: String) -> URL? {
    let panel = NSOpenPanel()
    panel.title = prompt
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = false
    panel.canCreateDirectories = false
    return panel.runModal() == .OK ? panel.url : nil
  }
}

struct DiagnosticsView: View {
  @ObservedObject var model: AppModel
  var showsHeader = true

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if showsHeader {
        PageHeader(title: "Diagnostics", detail: "rsync, source, and destination identity")
      }
      if model.isRunningDoctor {
        PaneNotice(title: "Running doctor", isWorking: true)
      } else if let report = model.doctorReport {
        ScrollView {
          Text(report)
            .font(.system(.callout, design: .monospaced))
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .padding(.horizontal, SyncySpace.gutter)
            .padding(.vertical, SyncySpace.lg)
        }
      } else {
        PaneNotice(
          title: "Doctor has not run",
          detail: "Nothing has been probed since Syncy started.",
          symbol: "stethoscope")
      }
      Divider()
      HStack {
        Spacer()
        Button(model.doctorReport == nil ? "Run doctor" : "Run doctor again") {
          Task { await model.runDoctor() }
        }
        .disabled(model.isRunningDoctor)
      }
      .padding(.horizontal, SyncySpace.gutter)
      .padding(.vertical, SyncySpace.md)
    }
  }
}

private enum FolderRecordSection: String, CaseIterable, Identifiable {
  case summary = "Summary"
  case differences = "Differences"
  case evidence = "Evidence"

  var id: String { rawValue }
}

struct FolderRecordView: View {
  @ObservedObject var model: AppModel
  @State private var section: FolderRecordSection = .summary
  @State private var showsSyncReview = false

  private var unit: UnitSnapshot? { model.presentedUnit }
  private var canReviewSync: Bool {
    unit?.cells.contains { $0.state == .behind || $0.state == .missing } == true
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if let unit {
        PageHeader(
          title: unit.unit,
          detail: "\(unit.state.rawValue) · \(unit.reason)"
        ) {
          Picker("Folder record", selection: $section) {
            ForEach(FolderRecordSection.allCases) { item in
              Text(item.rawValue).tag(item)
            }
          }
          .labelsHidden()
          .pickerStyle(.segmented)
          .frame(width: 300)
        }

        switch section {
        case .summary:
          FolderSummaryView(unit: unit)
        case .differences:
          DifferencesView(model: model, showsHeader: false)
        case .evidence:
          EvidenceView(unit: unit, showsHeader: false)
        }
      } else {
        PaneNotice(
          title: "Folder unavailable",
          detail: "The folder is not present in the current ledger snapshot.",
          symbol: "folder.badge.questionmark")
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .toolbar {
      ToolbarItem(placement: .navigation) {
        Button {
          model.closeFolderRecord()
        } label: {
          Label("Ledger", systemImage: "chevron.left")
        }
        .help("Back to the ledger")
      }
      ToolbarItemGroup {
        if let unit {
          Menu("Check", systemImage: "checkmark.circle") {
            Button("Quick check") {
              Task { await model.runCheck(.quick, unit: unit.unit) }
            }
            Button("Deep verify") {
              Task { await model.runCheck(.deep, unit: unit.unit) }
            }
          }
          .disabled(model.isLaunchingJob || model.activeJob != nil)
        }
        if canReviewSync {
          Button("Review sync…") { showsSyncReview = true }
        }
      }
    }
    .sheet(isPresented: $showsSyncReview) {
      SyncConfirmationView(model: model)
        .frame(minWidth: 620, minHeight: 560)
    }
  }
}

private struct FolderSummaryView: View {
  let unit: UnitSnapshot

  var body: some View {
    Form {
      Section("Source") {
        LabeledContent("Files", value: unit.fingerprint.nfiles.formatted())
        LabeledContent("Size", value: bytes(unit.fingerprint.bytes))
      }
      Section("Destinations") {
        ForEach(unit.cells) { destination in
          HStack(alignment: .top, spacing: SyncySpace.md) {
            StateMark(state: destination.state)
            VStack(alignment: .leading, spacing: SyncySpace.xs) {
              HStack(alignment: .firstTextBaseline) {
                Text(destination.target).fontWeight(.medium)
                Spacer()
                Text(destination.state.rawValue)
              }
              Text(destination.differenceSummary ?? destination.reason)
                .font(.caption)
                .foregroundStyle(SyncyTheme.secondaryInk)
              if destination.nExtra > 0 {
                Text("\(destination.nExtra.formatted()) only at destination · left unchanged")
                  .font(.caption)
                  .foregroundStyle(SyncyTheme.secondaryInk)
              }
            }
          }
          .padding(.vertical, SyncySpace.xs)
        }
      }
    }
    .formStyle(.grouped)
  }

  private func bytes(_ value: Int64) -> String {
    ByteCountFormatter.string(fromByteCount: value, countStyle: .file).lowercased()
  }
}

struct RunningActivityView: View {
  @ObservedObject var model: AppModel

  var body: some View {
    if let job = model.activeJob {
      ScrollView {
        ActiveTaskView(job: job, model: model)
          .padding(.horizontal, SyncySpace.gutter)
          .padding(.vertical, SyncySpace.xl)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    } else if model.isLaunchingJob {
      PaneNotice(title: "Starting engine work", isWorking: true)
    } else {
      PaneNotice(
        title: "No work running",
        detail: "Scheduled and completed work remain available in this view.",
        symbol: "clock")
    }
  }
}

private struct ActiveTaskView: View {
  let job: ActiveJobSnapshot
  @ObservedObject var model: AppModel

  var body: some View {
    TimelineView(.periodic(from: .now, by: 1)) { context in
      VStack(alignment: .leading, spacing: SyncySpace.lg) {
        HStack(alignment: .top, spacing: SyncySpace.lg) {
          VStack(alignment: .leading, spacing: SyncySpace.xs) {
            Text(title).font(.headline)
            if let activity = job.activity {
              Text("\(activity.unit) → \(activity.target)")
                .foregroundStyle(SyncyTheme.secondaryInk)
            }
          }
          Spacer()
          if model.canCancelActiveJob {
            Button(model.isCancellingJob ? "Cancelling…" : "Cancel…", role: .destructive) {
              model.cancelActiveJob()
            }
            .disabled(model.isCancellingJob)
          }
        }

        Text(elapsed(at: context.date))
          .font(.system(.title, design: .monospaced, weight: .semibold))
          .monospacedDigit()

        if let activity = job.activity {
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
          } else {
            Text("\(phase(activity.phase)) · engine work is running · no measured percentage")
              .font(.caption.monospacedDigit())
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
        } else {
          Text("Waiting for the first engine event · no measured percentage")
            .font(.caption)
            .foregroundStyle(SyncyTheme.secondaryInk)
        }
      }
      .frame(maxWidth: 680, alignment: .leading)
    }
  }

  private var title: String {
    let operation =
      switch job.operation {
      case "deep": "Deep verify"
      case "quick": "Quick check"
      case "sync": "Sync"
      case "setup": "Setup"
      default: job.operation
      }
    if let position = job.batchPosition, let total = job.batchTotal, total > 1 {
      return "\(operation) · folder \(position.formatted()) of \(total.formatted())"
    }
    return operation
  }

  private func elapsed(at date: Date) -> String {
    let seconds = max(0, Int(date.timeIntervalSince1970 - job.startedAt / 1_000))
    if seconds >= 3_600 { return "\(seconds / 3_600)h \((seconds % 3_600) / 60)m elapsed" }
    if seconds >= 60 { return "\(seconds / 60)m \(seconds % 60)s elapsed" }
    return "\(seconds)s elapsed"
  }

  private func age(since milliseconds: Double, at date: Date) -> String {
    let seconds = max(0, Int(date.timeIntervalSince1970 - milliseconds / 1_000))
    if seconds < 5 { return "just now" }
    if seconds < 60 { return "\(seconds)s ago" }
    return "\(seconds / 60)m ago"
  }

  private func phase(_ value: String) -> String {
    value.replacingOccurrences(of: "-", with: " ")
  }

  private func bytes(_ value: Int64) -> String {
    ByteCountFormatter.string(fromByteCount: value, countStyle: .file).lowercased()
  }
}

private enum AppSettingsSection: String, CaseIterable, Identifiable {
  case storage = "Source & destinations"
  case schedules = "Schedules"
  case general = "General"
  case notifications = "Notifications"
  case diagnostics = "Diagnostics"

  var id: String { rawValue }

  var symbol: String {
    switch self {
    case .storage: "externaldrive"
    case .schedules: "calendar"
    case .general: "gearshape"
    case .notifications: "bell"
    case .diagnostics: "stethoscope"
    }
  }
}

struct AppSettingsView: View {
  @ObservedObject var model: AppModel
  @State private var section: AppSettingsSection? = .storage

  var body: some View {
    HStack(spacing: 0) {
      List(AppSettingsSection.allCases, selection: $section) { item in
        Label(item.rawValue, systemImage: item.symbol).tag(item)
      }
      .listStyle(.sidebar)
      // The system's sidebar material is a cool grey, and it is the one surface
      // in the app syncy was not painting itself — so it sat against the warm
      // paper beside it looking like a different program. Hiding the scroll
      // background lets the window's own ground show through both columns; the
      // sidebar list style is kept for its selection shape.
      .scrollContentBackground(.hidden)
      .frame(minWidth: 190, idealWidth: 210, maxWidth: 230)

      Divider()
      VStack(alignment: .leading, spacing: 0) {
        PageHeader(title: selectedSection.rawValue, detail: sectionDetail)
        switch selectedSection {
        case .storage:
          SetupView(model: model, showsHeader: false)
        case .schedules:
          SchedulesView(model: model, showsHeader: false)
        case .general:
          GeneralSettingsPane()
        case .notifications:
          NotificationSettingsPane()
        case .diagnostics:
          DiagnosticsView(model: model, showsHeader: false)
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
    .background(SyncyTheme.paper)
  }

  private var selectedSection: AppSettingsSection { section ?? .storage }

  private var sectionDetail: String {
    switch selectedSection {
    case .storage: "Identity and availability"
    case .schedules: "When work runs unattended"
    case .general: "Background availability"
    case .notifications: "Recorded task outcomes"
    case .diagnostics: "rsync, source, and destination identity"
    }
  }
}

private struct GeneralSettingsPane: View {
  @State private var loginStatus = SMAppService.mainApp.status
  @State private var loginMessage: String?

  var body: some View {
    Form {
      Section("Background") {
        LabeledContent("Open at login", value: loginStatus == .enabled ? "Enabled" : "Disabled")
        Button(loginStatus == .enabled ? "Disable" : "Enable") {
          Task { await changeLoginRegistration() }
        }
        if let loginMessage {
          Text(loginMessage).font(.caption).foregroundStyle(SyncyTheme.secondaryInk)
        }
      }
    }
    .formStyle(.grouped)
  }

  private func changeLoginRegistration() async {
    do {
      if SMAppService.mainApp.status == .enabled {
        try await SMAppService.mainApp.unregister()
      } else {
        try SMAppService.mainApp.register()
      }
      loginStatus = SMAppService.mainApp.status
      loginMessage =
        loginStatus == .enabled ? "Syncy will remain available after login." : "Disabled."
    } catch {
      loginStatus = SMAppService.mainApp.status
      loginMessage = "Could not change login setting · \(error.localizedDescription)"
    }
  }
}

private struct NotificationSettingsPane: View {
  @AppStorage("notify-problems") private var notifyProblems = true
  @AppStorage("notify-success") private var notifySuccess = false

  var body: some View {
    Form {
      Section("Notify after") {
        Toggle("Failed and skipped tasks", isOn: $notifyProblems)
        Toggle("Completed tasks", isOn: $notifySuccess)
      }
    }
    .formStyle(.grouped)
  }
}
