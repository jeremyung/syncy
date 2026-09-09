import SwiftUI
import SyncyMacCore

/// The tray panel is a glance surface: it is read in about two seconds, by
/// someone deciding whether anything is safe to delete from a full boot volume.
/// So it is shaped like a tally slip rather than a dashboard — one verdict set
/// large with its extent on the same baseline, a rule carrying how the
/// archive's bytes are split, a single line of counts, and a note of when the
/// evidence was taken. 210 points at its tallest, 136 when the archive is
/// settled.
///
/// Three rules keep it from filling up again. Every fact is printed at the one
/// level it belongs to and never restated at another. Nothing takes a row of
/// its own that a rule or a line can carry — the proportion rule *is* the byte
/// view, which is what lets the tally be counts alone. And a measurement is
/// shown only where one exists: the progress rule is absent, not
/// indeterminate, when nothing measured it.
struct MenuBarPanel: View {
  @Environment(\.openWindow) private var openWindow
  @ObservedObject var model: AppModel
  @State private var isHoveringSettings = false

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      report
        .padding(.horizontal, SyncySpace.lg)
        .padding(.vertical, SyncySpace.md)

      Divider()
      actions
        .padding(.horizontal, SyncySpace.lg)
        .padding(.vertical, SyncySpace.sm)
    }
    .frame(width: 360)
    .background(SyncyTheme.paper)
    .task { await model.loadIfNeeded() }
  }

  /// A failure never takes the panel over. The reader's question — is anything
  /// safe to delete — is asked *most* after a check goes wrong, and the old
  /// order answered it by throwing the whole ledger away and printing the
  /// engine's complaint instead. The evidence still stands after a job fails;
  /// only its date stops advancing. So the ledger renders, and the failure goes
  /// to the provenance line, which is the slot for what was going on when this
  /// reading was taken. The headline is surrendered only when there is genuinely
  /// nothing to report.
  @ViewBuilder private var report: some View {
    if model.isLaunchingJob, model.activeJob == nil {
      PanelHeadline(title: "starting work", isWorking: true)
    } else if let active = model.activeJob {
      RunningReport(job: active)
    } else if model.isLoading, model.snapshot == nil {
      PanelHeadline(title: "reading ledger", isWorking: true)
    } else if let snapshot = model.snapshot {
      ArchiveReport(
        snapshot: snapshot,
        outcome: model.jobOutcomeMessage,
        problem: problem)
    } else {
      PanelHeadline(
        title: "ledger unavailable",
        detail: problem ?? "The engine returned no snapshot.")
    }
  }

  /// An unreadable engine outranks a failed job: it says the figures on screen
  /// are no longer being confirmed, which changes how every other line should
  /// be read.
  private var problem: String? {
    model.engineErrorMessage ?? model.errorMessage
  }

  /// Two controls, never three, and the settings gear rides the same row rather
  /// than paying for a masthead of its own. While work is running the check
  /// menu is disabled anyway, so the row swaps wholesale rather than growing a
  /// third button beside a dead one.
  private var actions: some View {
    HStack(spacing: SyncySpace.sm) {
      SettingsLink {
        Image(systemName: "gearshape")
          .font(.system(size: 13, weight: .medium))
          .foregroundStyle(isHoveringSettings ? SyncyTheme.secondaryInk : SyncyTheme.quietInk)
      }
      .buttonStyle(.plain)
      .onHover { isHoveringSettings = $0 }
      .help("Open Syncy settings")
      .accessibilityLabel("Settings")

      if model.activeJob != nil || model.isLaunchingJob {
        if model.canCancelOwnedJob {
          Button(model.isCancellingJob ? "Cancelling…" : "Cancel…", role: .destructive) {
            model.cancelOwnedJob()
          }
          .disabled(model.isCancellingJob)
        }
        Spacer()
        Button("View activity") {
          model.closeFolderRecord()
          model.selection = .activity
          openLedger()
        }
        .keyboardShortcut(.defaultAction)
      } else {
        Menu("Check") {
          Button("Quick check · all folders") {
            Task { await model.runCheck(.quick) }
          }
          Button("Deep verify · all folders") {
            Task { await model.runCheck(.deep) }
          }
        }
        .fixedSize()
        .disabled(model.snapshot == nil)
        Spacer()
        Button("Open Syncy") { openLedger() }
          .keyboardShortcut(.defaultAction)
      }
    }
  }

  private func openLedger() {
    // Claim the Dock before raising the window. An accessory app cannot take
    // focus properly, so activating first and promoting afterwards leaves the
    // ledger open but behind whatever the reader was already looking at.
    NSApp.setActivationPolicy(.regular)
    openWindow(id: "ledger")
    // `activate(ignoringOtherApps:)` is on its way out; the no-argument form
    // arrived in macOS 14, which is this package's floor.
    NSApp.activate()
  }
}

// MARK: - The one headline slot

/// Every state of the panel opens with the same block, so the panel does not
/// change shape as it moves between reading, running and reporting. The title
/// is lower case in all of them: the idle title is a ledger state word, and a
/// slot that holds `unchecked` one moment should not hold `Ledger Unavailable`
/// the next.
private struct PanelHeadline: View {
  let title: String
  /// A short fact that rides the title's own baseline instead of costing a
  /// line of its own — the same slot, and the same reason, as `PageHeader`.
  var trailing: String?
  var detail: String?
  /// A folder path shortens honestly from the middle; a sentence does not.
  var truncatesDetailInMiddle = false
  var isWorking = false

  var body: some View {
    VStack(alignment: .leading, spacing: SyncySpace.xs) {
      HStack(alignment: .firstTextBaseline, spacing: SyncySpace.sm) {
        Text(title)
          .font(.system(.title, design: .serif, weight: .semibold))
          .lineLimit(2)
          .fixedSize(horizontal: false, vertical: true)
        if isWorking {
          ProgressView().controlSize(.small)
        }
        if let trailing {
          Spacer(minLength: SyncySpace.sm)
          Text(trailing)
            .font(.callout.monospacedDigit())
            .foregroundStyle(SyncyTheme.secondaryInk)
            .lineLimit(1)
        }
      }
      if let detail {
        Text(detail)
          .font(.callout)
          .foregroundStyle(SyncyTheme.secondaryInk)
          .lineLimit(truncatesDetailInMiddle ? 1 : nil)
          .truncationMode(truncatesDetailInMiddle ? .middle : .tail)
          .fixedSize(horizontal: false, vertical: !truncatesDetailInMiddle)
      }
    }
  }
}

// MARK: - Idle: what the ledger currently holds

private struct ArchiveReport: View {
  let snapshot: EngineSnapshot
  let outcome: String?
  let problem: String?
  /// Walked once at construction. The headline, the rule and the tally all read
  /// the same grouping, and filtering the units four times per render to get
  /// three views of one answer is how they drift apart.
  private let tallies: [StateTally]
  /// Every destination, or none — never just the troublesome ones. Listing the
  /// single drive that is out of place, and silently dropping the one that is
  /// fine, reads as though the absent drive were the whole story: it hides
  /// which drive is carrying the evidence, and invites the conclusion that the
  /// rule above is a picture of that one destination. When any drive is
  /// unsettled the comparison *is* the information, so they are all shown.
  /// Only when they are all connected is there nothing to compare, and the fact
  /// folds into the provenance line rather than taking a row each.
  private let destinations: [DestinationReading]
  private let allConnected: Bool

  init(snapshot: EngineSnapshot, outcome: String?, problem: String?) {
    self.snapshot = snapshot
    self.outcome = outcome
    self.problem = problem

    let anyUnsettled = snapshot.targets.contains { $0.reachability != .ok }
    self.allConnected = !anyUnsettled && !snapshot.targets.isEmpty
    self.destinations =
      anyUnsettled
      ? snapshot.targets
        // Required first: an optional destination being away gates no folder's
        // verdict, so it should not lead the reader's eye.
        .sorted { left, right in
          left.required == right.required ? left.name < right.name : left.required
        }
        .map { DestinationReading(target: $0, units: snapshot.units) }
      : []

    self.tallies = LedgerState.precedence.compactMap { state in
      let matching = snapshot.units.filter { $0.state == state }
      guard !matching.isEmpty else { return nil }
      return StateTally(
        state: state,
        count: matching.count,
        bytes: matching.reduce(0) { $0 + $1.fingerprint.bytes })
    }
  }

  /// Spacing carries what the removed section headings used to: the rule and
  /// the tally sit tight against the verdict they measure, and the step out to
  /// `md` is the only thing marking destinations and provenance as a different
  /// subject — facts about drives and about dates, not about folders.
  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if let state = snapshot.archiveState {
        PanelHeadline(title: state.rawValue, trailing: extent)

        ProportionRule(parts: parts)
          .padding(.top, SyncySpace.sm)

        // With one state present the headline and its extent have already said
        // everything a tally could, and repeating it is the busiest thing this
        // panel used to do.
        if tallies.count > 1 {
          TallyLine(rows: tallies)
            .padding(.top, SyncySpace.sm)
        }
      } else {
        PanelHeadline(
          title: "nothing tracked",
          detail: "No folders are recorded in the ledger.")
      }

      if !destinations.isEmpty {
        Destinations(readings: destinations)
          .padding(.top, SyncySpace.md)
      }

      Provenance(
        at: snapshot.newestEvidenceAt,
        outcome: outcome,
        problem: problem,
        settled: allConnected
      )
      .padding(.top, SyncySpace.md)
    }
  }

  private var extent: String {
    let bytes = snapshot.units.reduce(Int64(0)) { $0 + $1.fingerprint.bytes }
    return "\(counted(snapshot.units.count, of: "folder")) · \(byteText(bytes))"
  }

  /// Bytes, because the reader is reclaiming disk space and that is the measure
  /// the decision is made in. An archive whose folders are all empty has no
  /// byte proportion to show, so the rule falls back to counting folders rather
  /// than dividing by zero or vanishing.
  private var parts: [RulePart] {
    let totalBytes = tallies.reduce(Int64(0)) { $0 + $1.bytes }
    return tallies.map { row in
      RulePart(
        id: row.state.rawValue,
        color: SyncyTheme.color(for: row.state),
        weight: totalBytes > 0 ? Double(row.bytes) : Double(row.count))
    }
  }

}

private struct StateTally {
  let state: LedgerState
  let count: Int
  let bytes: Int64
}

/// One line, not a column of rows. The rule above already carries the byte
/// split — a segment's width *is* its byte figure — so the tally is left with
/// counts alone, and four counts do not need four rows. The exact bytes behind
/// each state stay one click away in the ledger, which is the right place for a
/// figure you read rather than glance at.
private struct TallyLine: View {
  let rows: [StateTally]

  var body: some View {
    line
      .lineLimit(2)
      .fixedSize(horizontal: false, vertical: true)
      .accessibilityLabel(summary)
  }

  /// `verbatim` throughout: these are ledger vocabulary and formatted numbers,
  /// not localizable copy, and the plain initialiser would send every one of
  /// them through a table lookup that always misses.
  private var line: Text {
    rows.enumerated().reduce(Text(verbatim: "")) { assembled, entry in
      let separator =
        entry.offset == 0
        ? Text(verbatim: "")
        : Text(verbatim: " · ").font(.callout).foregroundStyle(SyncyTheme.quietInk)
      return assembled + separator
        + Text(verbatim: entry.element.count.formatted())
          .font(.callout.monospacedDigit().weight(.semibold))
        + Text(verbatim: " \(entry.element.state.rawValue)")
          .font(.callout)
          .foregroundStyle(SyncyTheme.color(for: entry.element.state))
    }
  }

  /// Carries the bytes too, because the rule that shows them is hidden from
  /// VoiceOver. Sighted reading gets the split twice — once as widths, once as
  /// counts — and reading it aloud twice was the panel's original sin surviving
  /// in the accessibility layer.
  private var summary: String {
    rows
      .map { "\(counted($0.count, of: "folder")) \($0.state.rawValue), \(byteText($0.bytes))" }
      .joined(separator: ". ")
  }
}

/// The destinations that are not simply connected. The drive glyph does the
/// orienting work the deleted `DESTINATIONS` heading used to, and costs no
/// height to do it — it rides the row that was already there. It is set inside
/// the name's `Text` rather than given a grid column of its own so that it sits
/// on the text baseline exactly, which a bare `Image` in a baseline-aligned row
/// does not.
///
/// The glyph is the same on every row on purpose. It marks the subject; it does
/// not encode the state, because the phrase beside it already names the state
/// in the words the ledger uses everywhere else. No colour either: `different
/// volume` is a statement about what we can know right now, not a fault, and
/// amber would report a problem the ledger has not observed.
private struct Destinations: View {
  let readings: [DestinationReading]

  var body: some View {
    Grid(
      alignment: .leadingFirstTextBaseline,
      horizontalSpacing: SyncySpace.sm,
      verticalSpacing: SyncySpace.xs
    ) {
      ForEach(readings) { reading in
        GridRow {
          name(of: reading)
            .lineLimit(1)
            .truncationMode(.tail)
            // Bounded so one long drive name cannot starve the phrase beside
            // it — the phrase is the part that says something.
            .frame(maxWidth: 120, alignment: .leading)
          Text(reading.phrase)
            .font(.caption)
            .foregroundStyle(SyncyTheme.secondaryInk)
            .lineLimit(1)
            .truncationMode(.tail)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(readings.map(\.spoken).joined(separator: ". "))
  }

  private func name(of reading: DestinationReading) -> some View {
    (Text(Image(systemName: "externaldrive")).foregroundStyle(SyncyTheme.quietInk)
      + Text(verbatim: "  \(reading.name)"))
      .font(.callout.weight(.medium))
  }
}

/// One drive, and what it is actually holding.
///
/// Reachability alone was not enough. A reader looking at `NAS · different
/// volume` beside a rule full of amber concluded the amber belonged to the NAS
/// and that the other drive was fine — when in truth the absent NAS had
/// verified nothing at all, and every amber folder was the *connected* drive's
/// own unverified evidence. So each row carries the count that settles it: how
/// many folders this destination has actually deep verified.
///
/// Only required destinations carry that count. An optional one gates no
/// folder's verdict, so what it has verified changes nothing, and the row says
/// `optional` instead — which is the more useful fact about it and keeps the
/// line inside the panel's width.
private struct DestinationReading: Identifiable {
  var id: String { name }
  let name: String
  let phrase: String
  /// The same facts with the `·` spelled as a comma; read aloud, the separator
  /// is just punctuation.
  let spoken: String

  init(target: TargetSnapshot, units: [UnitSnapshot]) {
    // The engine's own wording wins; `ledgerPhrase` is the fallback for a
    // snapshot that predates it.
    let reachability = target.reachabilityPhrase ?? target.reachability.ledgerPhrase
    self.name = target.name
    guard target.required else {
      self.phrase = "\(reachability) · optional"
      self.spoken = "\(target.name), \(reachability), optional"
      return
    }
    // "deep verified", never a bare "verified". The tally above counts folder
    // *verdicts*, and a folder is only verified when every required
    // destination is — so a drive that has deep verified two folders can sit
    // above a tally showing none verified at all, and the reader is left
    // hunting the rule for a green segment that cannot be there. The method is
    // a different measurement from the verdict, and the ledger already names it
    // this way in its evidence lines.
    let verified = units.filter { $0.cell(for: target.name)?.state == .verified }.count
    let held = verified > 0 ? "\(verified) deep verified" : "none deep verified"
    self.phrase = "\(reachability) · \(held)"
    self.spoken = "\(target.name), \(reachability), \(held)"
  }
}

/// When the evidence was taken, which is not when the snapshot was read. The
/// newest check dates the whole panel: everything else in it is at least this
/// old.
///
/// One line, never two. A finished job and a fresh evidence date are the same
/// fact told twice — "quick check completed · evidence recorded" already means
/// the newest evidence is seconds old, so printing "newest evidence 14 minutes
/// ago" beneath it was not merely redundant, it contradicted the line above.
/// While an outcome is standing it speaks for both. And an all-connected note
/// belongs here rather than in a row of its own: which drives were reachable is
/// a condition the reading was taken under, same as when.
private struct Provenance: View {
  let at: Double?
  let outcome: String?
  let problem: String?
  let settled: Bool

  var body: some View {
    if let problem {
      Text(problem)
        .font(.caption)
        .foregroundStyle(SyncyTheme.fault)
        // A batch that skipped every destination records one problem per
        // folder, joined into a single string — two dozen of them would grow
        // this popover off the screen. The panel states as much as two lines
        // hold and leaves the roll call to the activity pane.
        .lineLimit(2)
        .truncationMode(.tail)
    } else {
      TimelineView(.periodic(from: .epochAnchor, by: 30)) { context in
        Text(line(at: context.date))
          .font(.caption)
          .foregroundStyle(SyncyTheme.quietInk)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }

  private func line(at date: Date) -> String {
    if let outcome { return outcome }
    let dated =
      at.map { "newest evidence \(relativeAge(since: $0, at: date))" } ?? "no check recorded"
    return settled ? "all destinations connected · \(dated)" : dated
  }
}

// MARK: - Running: what the engine is doing now

private struct RunningReport: View {
  let job: ActiveJobSnapshot

  var body: some View {
    TimelineView(.periodic(from: .epochAnchor, by: 1)) { context in
      VStack(alignment: .leading, spacing: 0) {
        PanelHeadline(
          title: operationWord,
          detail: job.activity.map { "\($0.unit) → \($0.target)" },
          truncatesDetailInMiddle: true)

        // Absent rather than indeterminate. A barber-pole would imply a
        // measurement the engine has not reported; the facts line says so in
        // words instead.
        if let fraction = measuredFraction {
          MeasuredRule(fraction: fraction)
            .padding(.top, SyncySpace.sm)
        }

        VStack(alignment: .leading, spacing: SyncySpace.xs) {
          Text(measurements(at: context.date))
            .font(.callout.monospacedDigit())
          if let circumstance {
            Text(circumstance)
              .font(.caption)
              .foregroundStyle(SyncyTheme.secondaryInk)
              .fixedSize(horizontal: false, vertical: true)
          }
          if let silence = silence(at: context.date) {
            Text(silence)
              .font(.caption.monospacedDigit())
              .foregroundStyle(SyncyTheme.caution)
          }
        }
        .padding(.top, SyncySpace.md)
      }
    }
  }

  /// An operation the app does not recognise is reported as itself. Calling it
  /// "quick check" would be a claim about what the engine is doing right now,
  /// made without evidence, in the one line least able to hedge.
  private var operationWord: String {
    switch job.operation {
    case "deep": "deep verify"
    case "quick": "quick check"
    default: job.operation
    }
  }

  private var measuredFraction: Double? {
    guard let activity = job.activity else { return nil }
    if let seen = activity.filesSeen, let total = activity.filesTotal, total > 0 {
      return Double(seen) / Double(total)
    }
    if let done = activity.bytesDone, let total = activity.bytesTotal, total > 0 {
      return Double(done) / Double(total)
    }
    return nil
  }

  private func measurements(at date: Date) -> String {
    var parts = [elapsed(at: date)]
    if let activity = job.activity {
      if let seen = activity.filesSeen, let total = activity.filesTotal, total > 0 {
        parts.append("\(seen.formatted()) of \(total.formatted()) files")
      } else if let done = activity.bytesDone, let total = activity.bytesTotal, total > 0 {
        parts.append("\(byteText(done)) of \(byteText(total))")
      } else if let seen = activity.filesSeen {
        parts.append("\(counted(Int(seen), of: "file")) · no measured total")
      } else {
        parts.append("no measured total")
      }
    } else {
      parts.append("no measured total")
    }
    return parts.joined(separator: " · ")
  }

  private var circumstance: String? {
    var parts: [String] = []
    if let phase = job.activity?.phase {
      parts.append(phase.replacingOccurrences(of: "-", with: " "))
    }
    if let position = job.batchPosition, let total = job.batchTotal, total > 1 {
      parts.append("folder \(position.formatted()) of \(total.formatted())")
    }
    if let estimate = job.estimatedDurationMs, estimate > 0 {
      parts.append("around \(approximateDuration(milliseconds: estimate)) from previous checks")
    }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
  }

  /// A silent job and a finished job look identical on a progress rule. Ninety
  /// seconds without a heartbeat is worth a line; anything shorter is the
  /// normal gap between rsync's own reports.
  private func silence(at date: Date) -> String? {
    let quiet = date.timeIntervalSince1970 - job.heartbeatAt / 1_000
    guard quiet >= 90 else { return nil }
    return "no engine event for \(Int(quiet / 60))m"
  }

  private func elapsed(at date: Date) -> String {
    let started = Date(timeIntervalSince1970: job.startedAt / 1_000)
    return "\(duration(seconds: max(0, Int(date.timeIntervalSince(started))))) elapsed"
  }
}

// MARK: - Rules

private struct RulePart: Identifiable {
  let id: String
  let color: Color
  let weight: Double
}

/// The panel's signature: a five-point rule carrying the split of the archive
/// by state. It is the only element that answers "how much of this is settled"
/// without being read word by word, which is what a glance surface owes its
/// reader. Square ends and hairline gaps — a printed rule, not a progress pill.
private struct ProportionRule: View {
  let parts: [RulePart]

  private let height: CGFloat = 5
  private let gap: CGFloat = 2
  private let minimum: CGFloat = 4

  var body: some View {
    GeometryReader { proxy in
      HStack(spacing: gap) {
        ForEach(parts) { part in
          Rectangle()
            .fill(part.color)
            .frame(width: width(of: part, across: proxy.size.width))
        }
      }
    }
    .frame(height: height)
    // Silent on purpose. Its widths *are* the tally's bytes, which the tally
    // line reads out in words, and the headline's extent already carries the
    // total — so there is nothing here left to say.
    .accessibilityHidden(true)
  }

  /// Each part keeps a floor so a folder worth a few megabytes beside a
  /// terabyte is still visible; the remainder is what gets shared out by
  /// weight, which keeps the widths summing to the space available.
  private func width(of part: RulePart, across total: CGFloat) -> CGFloat {
    let count = CGFloat(max(1, parts.count))
    let gaps = CGFloat(max(0, parts.count - 1)) * gap
    let room = total - gaps
    // Too narrow to honour the floor at all: share what there is rather than
    // returning widths that sum past the rule.
    guard room >= count * minimum else { return max(0, room / count) }
    let free = room - count * minimum
    let sum = parts.reduce(0) { $0 + $1.weight }
    guard sum > 0 else { return minimum + free / count }
    return minimum + free * (part.weight / sum)
  }
}

/// The same rule, carrying a measured fraction. Sharing the geometry is what
/// makes the running panel read as the same slip as the idle one.
private struct MeasuredRule: View {
  let fraction: Double
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    GeometryReader { proxy in
      ZStack(alignment: .leading) {
        Rectangle().fill(SyncyTheme.rule)
        Rectangle()
          .fill(SyncyTheme.caution)
          .frame(width: proxy.size.width * min(1, max(0, fraction)))
      }
    }
    .frame(height: 5)
    .animation(reduceMotion ? nil : .easeOut(duration: 0.4), value: fraction)
    // The measurements line directly beneath states the same thing in the
    // counts the engine actually reported. A rounded percentage here would be
    // the only one in the app, and it would name a figure shown nowhere.
    .accessibilityHidden(true)
  }
}

// MARK: - Shared formatting

extension Date {
  /// A fixed origin for the panel's timelines. `.now` is re-evaluated every
  /// time a body runs, which restarts the schedule on each render and lets the
  /// one-second clock drop a tick whenever a redraw lands just before one. A
  /// constant anchor keeps the cadence independent of when we happened to draw.
  static let epochAnchor = Date(timeIntervalSince1970: 0)
}

private func byteText(_ value: Int64) -> String {
  let formatter = ByteCountFormatter()
  formatter.countStyle = .file
  // Left on, a zero total reads "Zero KB" — prose in the slot where the ledger
  // puts a number first.
  formatter.allowsNonnumericFormatting = false
  return formatter.string(fromByteCount: value).lowercased()
}

/// A running clock, zero-padded. The elapsed line is set in monospaced digits
/// so the column holds still as it counts, and `6m 3s` widening to `6m 13s`
/// undoes exactly that.
private func duration(seconds: Int) -> String {
  let hours = seconds / 3_600
  let minutes = (seconds % 3_600) / 60
  let remainder = seconds % 60
  if hours > 0 { return String(format: "%dh %02dm", hours, minutes) }
  if minutes > 0 { return String(format: "%dm %02ds", minutes, remainder) }
  return "\(remainder)s"
}

/// The same clock, coarse, for a duration read off previous runs. An estimate
/// is not precise to the second, and "around 49m 0s" spends width on a digit
/// that means nothing.
private func approximateDuration(milliseconds: Double) -> String {
  let seconds = max(0, Int(milliseconds / 1_000))
  if seconds >= 3_600 {
    let hours = seconds / 3_600
    let minutes = (seconds % 3_600) / 60
    return minutes > 0 ? "\(hours)h \(minutes)m" : "\(hours)h"
  }
  if seconds >= 60 { return "\(seconds / 60)m" }
  return "\(seconds)s"
}

private func relativeAge(since milliseconds: Double, at date: Date) -> String {
  let seconds = max(0, Int(date.timeIntervalSince1970 - milliseconds / 1_000))
  if seconds < 60 { return "under a minute ago" }
  if seconds < 3_600 { return "\(counted(seconds / 60, of: "minute")) ago" }
  if seconds < 172_800 { return "\(counted(seconds / 3_600, of: "hour")) ago" }
  return "\(counted(seconds / 86_400, of: "day")) ago"
}

private func counted(_ count: Int, of noun: String) -> String {
  "\(count.formatted()) \(noun)\(count == 1 ? "" : "s")"
}
