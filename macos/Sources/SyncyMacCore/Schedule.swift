import Foundation

public enum ScheduleCadence: String, Codable, CaseIterable, Sendable {
  case daily
  case weekly
}

public struct CheckSchedule: Codable, Identifiable, Sendable {
  public let id: UUID
  public var operation: EngineCheckOperationValue
  public var unit: String?
  public var target: String?
  public var cadence: ScheduleCadence
  public var weekday: Int
  public var hour: Int
  public var minute: Int
  public var enabled: Bool
  public var lastAttemptAt: Date?
  public var approvedConfigRevision: String?

  public init(
    id: UUID = UUID(),
    operation: EngineCheckOperationValue,
    unit: String?,
    target: String? = nil,
    cadence: ScheduleCadence,
    weekday: Int = 1,
    hour: Int,
    minute: Int,
    enabled: Bool = true,
    // Every due date is in the past, so a schedule with no attempt behind it
    // is due the moment it exists: adding "weekly, Sunday 02:00" on a
    // Wednesday started that work immediately rather than on Sunday. Counting
    // creation as the first attempt means the next occurrence is the first one.
    lastAttemptAt: Date? = Date(),
    approvedConfigRevision: String? = nil
  ) {
    self.id = id
    self.operation = operation
    self.unit = unit
    self.target = target
    self.cadence = cadence
    self.weekday = min(7, max(1, weekday))
    self.hour = min(23, max(0, hour))
    self.minute = min(59, max(0, minute))
    self.enabled = enabled
    self.lastAttemptAt = lastAttemptAt
    self.approvedConfigRevision = approvedConfigRevision
  }

  public func latestDueDate(at now: Date, calendar: Calendar = .current) -> Date? {
    var components = calendar.dateComponents([.year, .month, .day], from: now)
    components.hour = hour
    components.minute = minute
    components.second = 0
    guard var candidate = calendar.date(from: components) else { return nil }
    if candidate > now {
      guard let yesterday = calendar.date(byAdding: .day, value: -1, to: candidate) else {
        return nil
      }
      candidate = yesterday
    }
    if cadence == .weekly {
      let candidateWeekday = calendar.component(.weekday, from: candidate)
      let daysBack = (candidateWeekday - weekday + 7) % 7
      guard let weekly = calendar.date(byAdding: .day, value: -daysBack, to: candidate) else {
        return nil
      }
      candidate = weekly
    }
    return candidate
  }

  public func isDue(at now: Date, calendar: Calendar = .current) -> Bool {
    guard enabled, let due = latestDueDate(at: now, calendar: calendar) else { return false }
    return lastAttemptAt == nil || lastAttemptAt! < due
  }

  public func isApproved(forConfigRevision revision: String?) -> Bool {
    operation != .sync || (revision != nil && approvedConfigRevision == revision)
  }

  /// What this schedule does and what it depends on, one line each, in the
  /// words the Schedules list shows. The conditions used to be one footer
  /// under the form for adding a schedule, so a schedule already in the list
  /// named its work and time but not what it needs or what stops it.
  ///
  /// Every line states what the scheduler actually does: nothing here checks
  /// the power source or the network, wakes the Mac, or mounts a share.
  public func statement(destinations: [String], calendar: Calendar = .current) -> [String] {
    let destination: String
    if operation == .sync {
      destination = "Destination · \(target ?? "none chosen")"
    } else if destinations.isEmpty {
      destination = "Destinations · every configured destination"
    } else {
      destination = "Destinations · every configured destination (\(destinations.joined(separator: ", ")))"
    }
    let skips =
      operation == .sync
      ? "Skipped, and recorded by name, if \(target ?? "the destination") is not connected, nothing is recorded as behind, or a guard refuses · suspended after any configuration change until reviewed"
      : "A destination that is not connected is skipped and recorded by name; the others still run"
    return [
      destination,
      cadencePhrase(calendar: calendar),
      "Power · runs on battery or adapter, only while the Mac is awake and Syncy is open; it does not wake the Mac",
      "Network · none of its own; a destination on a network share must already be mounted",
      skips,
      "After sleep or a quit · the latest missed time runs once, and is recorded as missed",
    ]
  }

  public func cadencePhrase(calendar: Calendar = .current) -> String {
    let time = DateComponents(calendar: calendar, hour: hour, minute: minute)
    let clock = time.date?.formatted(date: .omitted, time: .shortened) ?? "the scheduled time"
    if cadence == .daily { return "Every day at \(clock)" }
    return "Every \(calendar.weekdaySymbols[weekday - 1]) at \(clock)"
  }
}

/// What one scheduled run recorded, as its notification and the panel say it.
///
/// Read from history rather than from how the engine process exited. A
/// scheduled sync to an unplugged drive exits non-zero after recording itself
/// as skipped, so the exit status alone called it a failure. And the
/// notification named at most the first skipped destination: a batch with one
/// destination skipped and another failed said nothing of the failure, and no
/// notification said how much of the run had completed.
public struct ScheduledOutcome: Equatable, Sendable {
  public let needsAttention: Bool
  public let message: String

  public init(needsAttention: Bool, message: String) {
    self.needsAttention = needsAttention
    self.message = message
  }

  public static func summarize(
    schedule: CheckSchedule,
    startedAt: Date,
    recorded: [HistorySnapshotEntry],
    failure: String?
  ) -> ScheduledOutcome {
    let since = startedAt.timeIntervalSince1970 * 1_000
    let runs = recorded
      .filter {
        $0.ts >= since && $0.outcome != "missed"
          && $0.operation == schedule.operation.rawValue
          && (schedule.unit == nil || $0.unit == schedule.unit)
          && (schedule.target == nil || $0.target == schedule.target)
      }
      .sorted { $0.ts < $1.ts }
    let completed = runs.filter { $0.outcome == "completed" }.count
    let problems = runs.filter { $0.outcome != "completed" }.map { entry in
      "\(entry.unit) → \(entry.target) \(entry.outcome)"
        + (entry.detail.map { " · \($0)" } ?? "")
    }
    let title = schedule.operation.readerTitle
    if runs.isEmpty {
      // Never report success for work that did not happen.
      return ScheduledOutcome(
        needsAttention: true,
        message: failure ?? "Scheduled \(title.lowercased()) recorded no outcome")
    }
    if problems.isEmpty, let failure {
      return ScheduledOutcome(
        needsAttention: true, message: "\(completed) of \(runs.count) completed · \(failure)")
    }
    if problems.isEmpty {
      return ScheduledOutcome(
        needsAttention: false,
        message: "Scheduled \(title.lowercased()) completed · \(completed) recorded")
    }
    return ScheduledOutcome(
      needsAttention: true,
      message: (["\(completed) of \(runs.count) completed"] + problems).joined(separator: " · "))
  }
}

/** Codable counterpart of the command enum, kept stable in personal settings. */
public enum EngineCheckOperationValue: String, Codable, CaseIterable, Sendable {
  case quick
  case deep
  case sync

  public var engineOperation: EngineCheckOperation? {
    switch self {
    case .quick: .quick
    case .deep: .deep
    case .sync: nil
    }
  }

  public var readerTitle: String {
    switch self {
    case .quick: "Quick check"
    case .deep: "Deep verify"
    case .sync: "Sync"
    }
  }
}
