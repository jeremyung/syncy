import AppKit
import SwiftUI
import SyncyMacCore
import UserNotifications

@main
struct SyncyMacApp: App {
  @StateObject private var model = AppModel()

  var body: some Scene {
    MenuBarExtra {
      MenuBarPanel(model: model)
    } label: {
      Label(model.menuTitle, systemImage: model.menuSymbol)
        .task { await model.monitor() }
    }
    .menuBarExtraStyle(.window)

    WindowGroup("Syncy", id: "ledger") {
      LedgerWindow(model: model)
        .frame(minWidth: 860, minHeight: 560)
    }
    .defaultSize(width: 1040, height: 700)

    Settings {
      SettingsView()
        .frame(width: 560, height: 420)
    }
  }
}

@MainActor
final class AppModel: ObservableObject {
  @Published var selection: SidebarItem? = .ledger
  @Published var selectedUnitID: UnitSnapshot.ID?
  @Published private(set) var snapshot: EngineSnapshot?
  @Published private(set) var isLoading = false
  @Published private(set) var errorMessage: String?
  @Published private(set) var isLaunchingJob = false
  @Published private(set) var doctorReport: String?
  @Published private(set) var isRunningDoctor = false
  @Published private(set) var syncPreflight: SyncPreflight?
  @Published private(set) var isPreparingSync = false
  @Published private(set) var isCancellingJob = false
  @Published private(set) var isUpdatingSetup = false
  @Published private(set) var setupMessage: String?
  @Published private(set) var differences: DiffEnvelope?
  @Published private(set) var historyEntries: [HistorySnapshotEntry] = []
  @Published private(set) var auxiliaryMessage: String?
  @Published private(set) var schedules: [CheckSchedule] = []
  private let client: any EngineClient
  private var attemptedInitialLoad = false
  private var syncTask: Task<Void, Never>?
  private var scheduleTask: Task<Void, Never>?
  private let scheduleDefaultsKey = "syncy.check-schedules.v1"

  init(client: (any EngineClient)? = nil) {
    if let client {
      self.client = client
    } else {
      self.client = (try? ProcessEngineClient.located()) ?? DisconnectedEngineClient()
    }
    if let data = UserDefaults.standard.data(forKey: scheduleDefaultsKey),
      let decoded = try? JSONDecoder().decode([CheckSchedule].self, from: data)
    {
      schedules = decoded
    }
  }

  var selectedUnit: UnitSnapshot? {
    snapshot?.units.first { $0.id == selectedUnitID }
  }

  var menuTitle: String {
    if isLaunchingJob { return "Syncy · starting work" }
    if let active = snapshot?.activeJob {
      return "Syncy · \(active.operation)"
    }
    if isLoading { return "Syncy · reading ledger" }
    if errorMessage != nil { return "Syncy · engine unavailable" }
    return "Syncy"
  }

  var menuSymbol: String {
    if isLaunchingJob { return "arrow.triangle.2.circlepath" }
    if snapshot?.activeJob != nil { return "arrow.triangle.2.circlepath" }
    if isLoading { return "arrow.triangle.2.circlepath" }
    if errorMessage != nil { return "exclamationmark.circle" }
    guard let snapshot else { return "questionmark.circle" }
    if snapshot.units.contains(where: { $0.state == .error }) {
      return "exclamationmark.circle"
    }
    if !snapshot.units.isEmpty && snapshot.units.allSatisfy({ $0.state == .verified }) {
      return "checkmark.circle"
    }
    return "circle.lefthalf.filled"
  }

  func loadIfNeeded() async {
    guard !attemptedInitialLoad else { return }
    attemptedInitialLoad = true
    await refresh()
  }

  func monitor() async {
    await loadIfNeeded()
    startDueScheduleIfNeeded()
    while !Task.isCancelled {
      try? await Task.sleep(for: .seconds(3))
      if Task.isCancelled { return }
      await refresh()
      startDueScheduleIfNeeded()
    }
  }

  func refresh() async {
    guard !isLoading else { return }
    isLoading = true
    errorMessage = nil
    defer { isLoading = false }
    do {
      let next = try await client.snapshot()
      snapshot = next
      if selectedUnitID == nil || !next.units.contains(where: { $0.id == selectedUnitID }) {
        selectedUnitID = next.units.first?.id
      }
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func runCheck(_ operation: EngineCheckOperation, unit: String? = nil) async {
    guard !isLaunchingJob, snapshot?.activeJob == nil else { return }
    isLaunchingJob = true
    errorMessage = nil
    defer { isLaunchingJob = false }
    do {
      try await client.runCheck(operation, unit: unit)
      await refresh()
    } catch {
      let message = error.localizedDescription
      await refresh()
      errorMessage = message
    }
  }

  func runDoctor() async {
    guard !isRunningDoctor else { return }
    isRunningDoctor = true
    defer { isRunningDoctor = false }
    do {
      doctorReport = try await client.doctor()
    } catch {
      doctorReport = "Doctor could not run\n\n\(error.localizedDescription)"
    }
  }

  func clearSyncPreflight() {
    syncPreflight = nil
  }

  func prepareSync(unit: String, target: String) async {
    guard !isPreparingSync, !isLaunchingJob, snapshot?.activeJob == nil else { return }
    isPreparingSync = true
    syncPreflight = nil
    defer { isPreparingSync = false }
    do {
      syncPreflight = try await client.prepareSync(unit: unit, target: target)
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func startPreparedSync() {
    guard let token = syncPreflight?.confirmationToken, syncPreflight?.ok == true else { return }
    guard !isLaunchingJob, snapshot?.activeJob == nil else { return }
    isLaunchingJob = true
    isCancellingJob = false
    errorMessage = nil
    syncTask = Task { [weak self] in
      guard let self else { return }
      defer {
        self.isLaunchingJob = false
        self.isCancellingJob = false
        self.syncTask = nil
      }
      var outcomeMessage: String?
      do {
        try await self.client.runSync(confirmationToken: token)
        self.syncPreflight = nil
      } catch is CancellationError {
        outcomeMessage = "Sync cancelled · no verification was recorded"
      } catch {
        outcomeMessage = error.localizedDescription
      }
      await self.refresh()
      if let outcomeMessage { self.errorMessage = outcomeMessage }
    }
  }

  func cancelSync() {
    guard let syncTask else { return }
    isCancellingJob = true
    syncTask.cancel()
  }

  func setSource(path: String) async {
    await updateSetup("Saving source") { try await client.setSource(path: path) }
  }

  func addDestination(path: String, name: String) async {
    await updateSetup("Identifying and probing \(name)") {
      try await client.addDestination(path: path, name: name)
    }
  }

  func adoptDestination(name: String) async {
    await updateSetup("Writing and recording sentinel for \(name)") {
      try await client.adoptDestination(name: name)
    }
  }

  func removeDestination(name: String) async {
    await updateSetup("Removing \(name) from configuration") {
      try await client.removeDestination(name: name)
    }
  }

  private func updateSetup(
    _ progress: String,
    operation: () async throws -> EngineSnapshot
  ) async {
    guard !isUpdatingSetup, snapshot?.activeJob == nil else { return }
    isUpdatingSetup = true
    setupMessage = progress
    defer { isUpdatingSetup = false }
    do {
      let next = try await operation()
      snapshot = next
      setupMessage = "Saved"
      if selectedUnitID == nil || !next.units.contains(where: { $0.id == selectedUnitID }) {
        selectedUnitID = next.units.first?.id
      }
    } catch {
      setupMessage = "Not saved · \(error.localizedDescription)"
    }
  }

  func loadDifferences(unit: String, target: String) async {
    do {
      differences = try await client.differences(unit: unit, target: target)
      auxiliaryMessage = differences?.diff == nil ? "No recorded check for this destination" : nil
    } catch {
      differences = nil
      auxiliaryMessage = error.localizedDescription
    }
  }

  func loadHistory() async {
    do {
      historyEntries = try await client.history()
      auxiliaryMessage = historyEntries.isEmpty ? "No task outcomes recorded" : nil
    } catch {
      historyEntries = []
      auxiliaryMessage = error.localizedDescription
    }
  }

  func addSchedule(_ schedule: CheckSchedule) {
    schedules.append(schedule)
    saveSchedules()
    startDueScheduleIfNeeded()
  }

  func setScheduleEnabled(id: UUID, enabled: Bool) {
    guard let index = schedules.firstIndex(where: { $0.id == id }) else { return }
    schedules[index].enabled = enabled
    saveSchedules()
  }

  func reviewSchedule(id: UUID) {
    guard let revision = snapshot?.configRevision,
      let index = schedules.firstIndex(where: { $0.id == id })
    else { return }
    schedules[index].approvedConfigRevision = revision
    saveSchedules()
    startDueScheduleIfNeeded()
  }

  func removeSchedule(id: UUID) {
    schedules.removeAll { $0.id == id }
    saveSchedules()
  }

  private func saveSchedules() {
    if let data = try? JSONEncoder().encode(schedules) {
      UserDefaults.standard.set(data, forKey: scheduleDefaultsKey)
    }
  }

  private func startDueScheduleIfNeeded(now: Date = Date()) {
    guard scheduleTask == nil, !isLaunchingJob, snapshot?.activeJob == nil else { return }
    guard
      let index = schedules.firstIndex(where: {
        $0.isDue(at: now) &&
          $0.isApproved(forConfigRevision: snapshot?.configRevision)
      })
    else { return }
    let due = schedules[index].latestDueDate(at: now)
    schedules[index].lastAttemptAt = now
    let schedule = schedules[index]
    saveSchedules()
    isLaunchingJob = true
    scheduleTask = Task { [weak self] in
      guard let self else { return }
      var outcomeMessage: String?
      do {
        if let due, now.timeIntervalSince(due) > 90 {
          try? await self.client.recordMissed(schedule: schedule, due: due)
        }
        switch schedule.operation {
        case .quick, .deep:
          guard let operation = schedule.operation.engineOperation else {
            throw ScheduleRunError.incompleteCheckOperation
          }
          try await self.client.runCheck(operation, unit: schedule.unit, actor: .scheduler)
        case .sync:
          guard let unit = schedule.unit, let target = schedule.target else {
            throw ScheduleRunError.incompleteSyncScope
          }
          let preflight = try await self.client.prepareSync(unit: unit, target: target)
          guard preflight.ok, let token = preflight.confirmationToken else {
            throw ScheduleRunError.preflightRefused(
              preflight.checks.first(where: { !$0.ok })?.detail ?? "guard checks did not pass")
          }
          try await self.client.runSync(confirmationToken: token, actor: .scheduler)
        }
      } catch is CancellationError {
        outcomeMessage = "Scheduled work cancelled"
      } catch {
        outcomeMessage = "Scheduled work failed · \(error.localizedDescription)"
      }
      await self.notifyScheduledOutcome(schedule: schedule, failure: outcomeMessage)
      self.isLaunchingJob = false
      self.scheduleTask = nil
      await self.refresh()
      if let outcomeMessage { self.errorMessage = outcomeMessage }
    }
  }

  private func notifyScheduledOutcome(schedule: CheckSchedule, failure: String?) async {
    let entries = (try? await client.history()) ?? []
    let matching = entries.filter {
      $0.operation == schedule.operation.rawValue &&
        (schedule.unit == nil || $0.unit == schedule.unit) &&
        $0.ts >= (schedule.lastAttemptAt?.timeIntervalSince1970 ?? 0) * 1_000
    }
    let hasProblem = failure != nil || matching.contains { $0.outcome != "completed" }
    let defaults = UserDefaults.standard
    let shouldNotify =
      hasProblem
      ? defaults.object(forKey: "notify-problems") as? Bool ?? true
      : defaults.object(forKey: "notify-success") as? Bool ?? false
    guard shouldNotify else { return }

    let center = UNUserNotificationCenter.current()
    let settings = await center.notificationSettings()
    if settings.authorizationStatus == .notDetermined {
      _ = try? await center.requestAuthorization(options: [.alert, .sound])
    }
    let refreshed = await center.notificationSettings()
    guard refreshed.authorizationStatus == .authorized else { return }
    let content = UNMutableNotificationContent()
    content.title = hasProblem ? "Syncy scheduled work needs attention" : "Syncy work completed"
    if let failure {
      content.body = failure
    } else if let skipped = matching.first(where: { $0.outcome == "skipped" }) {
      content.body = "\(skipped.unit) → \(skipped.target) skipped · \(skipped.detail ?? "not run")"
    } else {
      content.body = scheduleSummary(schedule)
    }
    try? await center.add(
      UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
  }

  private func scheduleSummary(_ schedule: CheckSchedule) -> String {
    if schedule.operation == .sync {
      return "Sync · \(schedule.unit ?? "no unit") → \(schedule.target ?? "no destination")"
    }
    return "\(schedule.operation.rawValue.capitalized) check · \(schedule.unit ?? "all units")"
  }
}

private enum ScheduleRunError: LocalizedError {
  case incompleteCheckOperation
  case incompleteSyncScope
  case preflightRefused(String)

  var errorDescription: String? {
    switch self {
    case .incompleteCheckOperation: "scheduled check has no check operation"
    case .incompleteSyncScope: "scheduled sync has no exact unit and destination"
    case .preflightRefused(let detail): "scheduled sync preflight refused · \(detail)"
    }
  }
}

enum SidebarItem: String, CaseIterable, Identifiable {
  case ledger = "Ledger"
  case differences = "Differences"
  case evidence = "Evidence"
  case sync = "Sync"
  case schedules = "Schedules"
  case history = "History"
  case setup = "Setup"
  case diagnostics = "Diagnostics"

  var id: String { rawValue }

  var symbol: String {
    switch self {
    case .ledger: "list.bullet.rectangle"
    case .differences: "arrow.left.arrow.right"
    case .evidence: "doc.text.magnifyingglass"
    case .sync: "arrow.triangle.2.circlepath"
    case .schedules: "calendar.badge.clock"
    case .history: "clock.arrow.circlepath"
    case .setup: "externaldrive"
    case .diagnostics: "stethoscope"
    }
  }
}
