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
    lastAttemptAt: Date? = nil,
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
}
