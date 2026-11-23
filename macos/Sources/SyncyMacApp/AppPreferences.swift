import Foundation
import SyncyMacCore

/// Persistence is separate from the scheduler so exercising app workflows
/// never reads or changes someone's real schedules or notification settings.
@MainActor
protocol AppPreferences: AnyObject {
  var schedules: [CheckSchedule] { get set }
  var notifyProblems: Bool { get }
  var notifySuccess: Bool { get }
}

@MainActor
final class DefaultsAppPreferences: AppPreferences {
  private let defaults = UserDefaults.standard
  private let scheduleKey = "syncy.check-schedules.v1"

  var schedules: [CheckSchedule] {
    get {
      guard let data = defaults.data(forKey: scheduleKey),
        let schedules = try? JSONDecoder().decode([CheckSchedule].self, from: data)
      else { return [] }
      return schedules
    }
    set {
      if let data = try? JSONEncoder().encode(newValue) {
        defaults.set(data, forKey: scheduleKey)
      }
    }
  }

  var notifyProblems: Bool { defaults.object(forKey: "notify-problems") as? Bool ?? true }
  var notifySuccess: Bool { defaults.object(forKey: "notify-success") as? Bool ?? false }
}
