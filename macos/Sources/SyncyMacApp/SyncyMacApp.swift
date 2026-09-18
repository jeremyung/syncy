import AppKit
import SwiftUI
import SyncyMacCore
@preconcurrency import UserNotifications

/// `LSUIElement` hides the app from the Dock, which is right for something that
/// lives in the menu bar — and wrong the moment it opens a 1040×700 window with
/// a sidebar. Held as a permanent accessory, the ledger opened with no Dock
/// tile and no app menu: ⌘-Tab could not reach it, ⌘-W had nothing to close,
/// and the window read as though the click had done nothing at all.
///
/// So the Dock presence follows the windows. Regular while a real one is up,
/// accessory again once the last closes — the menu bar panel itself never
/// counts, because it cannot become main.
@MainActor
final class DockPresence: NSObject, NSApplicationDelegate {
  /// The delegate is built by `NSApplicationDelegateAdaptor`, which cannot pass
  /// it anything, so the app hands the model over once it exists.
  static weak var model: AppModel?

  /// A check outlives the app on purpose — the engine owns the work, and a
  /// half-hour checksum pass should not be discarded because a window closed.
  /// What was missing was being told: quitting mid-verify left rsync running
  /// with nothing on screen saying so, discoverable only through `ps`.
  func applicationShouldTerminate(
    _ sender: NSApplication
  ) -> NSApplication.TerminateReply {
    guard let model = Self.model, let job = model.activeJob else { return .terminateNow }

    let operation = job.operation == "deep" ? "Deep verify" : job.operation.capitalized
    let alert = NSAlert()
    alert.messageText = "\(operation) is still running"
    alert.informativeText =
      job.activity.map { "\($0.unit) \u{2192} \($0.target). " } ?? ""
    alert.informativeText +=
      "The engine keeps running after Syncy quits and records what it establishes. "
      + "Stopping it now records no verification for the folders not yet reached."
    alert.addButton(withTitle: "Quit and Keep Running")
    alert.addButton(withTitle: "Stop and Quit")
    alert.addButton(withTitle: "Don\u{2019}t Quit")

    switch alert.runModal() {
    case .alertFirstButtonReturn:
      return .terminateNow
    case .alertSecondButtonReturn:
      model.cancelActiveJob()
      // The engine releases its lease on SIGTERM; leaving is safe once it is
      // sent, and waiting for the outcome would hold a modal over a quit.
      return .terminateNow
    default:
      return .terminateCancel
    }
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    for name in [NSWindow.didBecomeMainNotification, NSWindow.willCloseNotification] {
      NotificationCenter.default.addObserver(
        forName: name, object: nil, queue: .main
      ) { _ in
        MainActor.assumeIsolated { Self.sync() }
      }
    }
  }

  static func sync() {
    // `willClose` posts while the window is still listed, so settle on the next
    // turn of the run loop and count what is actually left standing.
    DispatchQueue.main.async {
      // Panels are excluded outright. The menu bar readout is a window too, and
      // counting it would flash a Dock tile every time the tray is opened.
      let hasWindow = NSApp.windows.contains {
        $0.isVisible && $0.canBecomeMain && !($0 is NSPanel)
      }
      let wanted: NSApplication.ActivationPolicy = hasWindow ? .regular : .accessory
      guard NSApp.activationPolicy() != wanted else { return }
      NSApp.setActivationPolicy(wanted)
    }
  }
}

@main
struct SyncyMacApp: App {
  @NSApplicationDelegateAdaptor(DockPresence.self) private var dockPresence
  @StateObject private var model = AppModel()

  var body: some Scene {
    MenuBarExtra {
      MenuBarPanel(model: model)
    } label: {
      // The glyph alone. The menu bar is shared real estate, and "Syncy ·
      // reading ledger" widening and narrowing as jobs come and go shoves every
      // other item along with it. The wording survives as the accessibility
      // label, where it is read rather than measured.
      Label(model.menuTitle, systemImage: model.menuSymbol)
        .labelStyle(.iconOnly)
        .accessibilityLabel(model.menuTitle)
        .task {
          DockPresence.model = model
          await model.monitor()
        }
    }
    .menuBarExtraStyle(.window)

    // `Window`, not `WindowGroup`: there is one ledger, so there is one window
    // onto it. A group opens a fresh copy on every `openWindow` call, so a few
    // trips through the tray left a stack of identical ledgers cascading down
    // the screen. A single window is raised instead of duplicated.
    Window("Syncy", id: "ledger") {
      LedgerWindow(model: model)
        .frame(minWidth: 860, minHeight: 560)
    }
    .defaultSize(width: 1040, height: 700)
    // Refreshing left the toolbar, so it needs a menu to live in: a keyboard
    // shortcut nobody can find is not a command, and the toolbar is for the two
    // things this window does to the ledger.
    .commands {
      CommandGroup(after: .toolbar) {
        Button("Refresh Ledger") { Task { await model.refresh() } }
          .keyboardShortcut("r", modifiers: .command)
          .disabled(model.isRefreshing)
      }
    }

    Settings {
      AppSettingsView(model: model)
        .frame(width: 820, height: 600)
    }
  }
}

@MainActor
final class AppModel: ObservableObject {
  /// Which activity tab the drawer is showing, or `nil` while it is shut.
  /// The tray opens it too, so the state cannot live in the window.
  @Published var activityDrawer: ActivityDrawerTab?
  @Published var selectedUnitID: UnitSnapshot.ID?
  @Published private(set) var presentedUnitID: UnitSnapshot.ID?
  @Published private(set) var snapshot: EngineSnapshot?
  @Published private(set) var isLoading = false
  @Published private(set) var isRefreshing = false
  @Published private(set) var errorMessage: String?
  @Published private(set) var engineErrorMessage: String?
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
  @Published private(set) var isLoadingDifferences = false
  @Published private(set) var isLoadingHistory = false
  @Published private(set) var differencesErrorMessage: String?
  @Published private(set) var historyErrorMessage: String?
  @Published private(set) var liveActiveJob: ActiveJobSnapshot?
  @Published private(set) var observedActiveJob: ActiveJobSnapshot?
  @Published private(set) var jobOutcomeMessage: String?
  @Published private(set) var schedules: [CheckSchedule] = []
  private let client: any EngineClient
  private var attemptedInitialLoad = false
  private var lastFullRefreshAt: Date?
  private var snapshotRefreshInFlight = false
  private var checkTask: Task<Void, Error>?
  private var syncTask: Task<Void, Never>?
  private var scheduleTask: Task<Void, Never>?
  private var jobOutcomeProblems: [String] = []
  private var liveJobID: String?
  private var differencesRequestID = UUID()
  private var suppressSnapshotJob = false
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

  var presentedUnit: UnitSnapshot? {
    snapshot?.units.first { $0.id == presentedUnitID }
  }

  func openFolderRecord(_ id: UnitSnapshot.ID) {
    selectedUnitID = id
    presentedUnitID = id
  }

  func closeFolderRecord() {
    presentedUnitID = nil
  }

  var activeJob: ActiveJobSnapshot? {
    liveActiveJob ?? (suppressSnapshotJob ? nil : observedActiveJob)
  }

  var canCancelOwnedJob: Bool {
    checkTask != nil || syncTask != nil || scheduleTask != nil
  }

  /// A job this process did not start still belongs to someone: the lease names
  /// the owning pid, and the engine takes SIGTERM as a graceful cancel, which
  /// releases the lease and records the outcome. Without this, quitting the app
  /// mid-verify left work no interface could stop.
  private var observedJobPID: pid_t? {
    guard !canCancelOwnedJob, let pid = activeJob?.pid, pid > 1 else { return nil }
    return pid_t(pid)
  }

  var canCancelActiveJob: Bool { canCancelOwnedJob || observedJobPID != nil }

  func cancelActiveJob() {
    guard !isCancellingJob else { return }
    if canCancelOwnedJob {
      cancelOwnedJob()
      return
    }
    guard let pid = observedJobPID else { return }
    isCancellingJob = true
    // Not `SIGKILL`: the engine's handler is what releases the lease and writes
    // the cancelled outcome. Killing it outright would leave a lease to expire.
    if kill(pid, SIGTERM) != 0 {
      isCancellingJob = false
      errorMessage = "Could not signal the engine process (pid \(pid))"
    }
  }

  var menuTitle: String {
    if let active = activeJob {
      // The same words the panel's headline uses. The tray reading "Syncy ·
      // quick" above a panel reading "quick check" is one job named twice.
      let operation =
        switch active.operation {
        case "deep": "deep verify"
        case "quick": "quick check"
        default: active.operation
        }
      return "Syncy · \(operation)"
    }
    if isLaunchingJob { return "Syncy · starting work" }
    if isLoading, snapshot == nil { return "Syncy · reading ledger" }
    if engineErrorMessage != nil { return "Syncy · engine unavailable" }
    if errorMessage != nil { return "Syncy · error" }
    if let state = snapshot?.archiveState { return "Syncy · \(state.rawValue)" }
    return "Syncy"
  }

  /// The glyph reports the archive's weakest state, read through the same
  /// `precedence` order the panel headline and the tally use. Keeping one
  /// ordering is what stops the tray from showing a checkmark while the panel
  /// below it reads `behind`.
  var menuSymbol: String {
    if activeJob != nil || isLaunchingJob { return "arrow.triangle.2.circlepath" }
    if isLoading, snapshot == nil { return "arrow.triangle.2.circlepath" }
    if engineErrorMessage != nil { return "questionmark.circle" }
    if errorMessage != nil { return "exclamationmark.circle" }
    guard let state = snapshot?.archiveState else { return "questionmark.circle" }
    switch state {
    case .error: return "exclamationmark.circle"
    case .missing, .behind: return "arrow.up.circle"
    case .unchecked: return "questionmark.circle"
    case .unverified: return "circle.lefthalf.filled"
    case .verified: return "checkmark.circle"
    }
  }

  func loadIfNeeded() async {
    if attemptedInitialLoad,
      let lastFullRefreshAt,
      Date().timeIntervalSince(lastFullRefreshAt) < 5
    {
      return
    }
    attemptedInitialLoad = true
    await refresh()
  }

  func monitor() async {
    await loadIfNeeded()
    startDueScheduleIfNeeded()
    while !Task.isCancelled {
      try? await Task.sleep(for: .seconds(3))
      if Task.isCancelled { return }
      await pollActivity()
      startDueScheduleIfNeeded()
    }
  }

  func refresh() async {
    guard !snapshotRefreshInFlight else { return }
    snapshotRefreshInFlight = true
    isRefreshing = true
    isLoading = true
    defer {
      snapshotRefreshInFlight = false
      isRefreshing = false
      isLoading = false
    }
    do {
      let next = try await client.snapshot()
      engineErrorMessage = nil
      snapshot = next
      lastFullRefreshAt = Date()
      observedActiveJob = next.activeJob
      if next.activeJob == nil { suppressSnapshotJob = false }
      if selectedUnitID == nil || !next.units.contains(where: { $0.id == selectedUnitID }) {
        selectedUnitID = next.units.first?.id
      }
      if let presentedUnitID, !next.units.contains(where: { $0.id == presentedUnitID }) {
        self.presentedUnitID = nil
      }
    } catch {
      engineErrorMessage = error.localizedDescription
    }
  }

  private func pollActivity() async {
    do {
      let previouslyActive = observedActiveJob != nil
      observedActiveJob = try await client.activity()
      if observedActiveJob == nil {
        suppressSnapshotJob = false
        if !canCancelOwnedJob { isCancellingJob = false }
        // External CLI/TUI work records evidence outside this process. Refresh
        // once when it ends so the ledger catches up, never once per poll.
        if previouslyActive { await refresh() }
      }
    } catch {
      // Preserve the last complete ledger. A lightweight observation failure
      // must not turn already-established evidence into an unavailable screen;
      // an explicit refresh still reports engine errors in full.
    }
  }

  func runCheck(_ operation: EngineCheckOperation, unit: String? = nil) async {
    guard !isLaunchingJob, activeJob == nil else { return }
    isLaunchingJob = true
    suppressSnapshotJob = false
    errorMessage = nil
    jobOutcomeMessage = nil
    jobOutcomeProblems = []
    defer {
      isLaunchingJob = false
      isCancellingJob = false
      checkTask = nil
    }
    let events = eventHandler(actor: .mac)
    let worker = Task {
      try await client.runCheck(operation, unit: unit, actor: .mac, onEvent: events)
    }
    checkTask = worker
    do {
      try await worker.value
      await refresh()
      finishJob(success: "\(operation.readerTitle) completed · evidence recorded")
    } catch is CancellationError {
      await refresh()
      errorMessage =
        jobOutcomeProblems.isEmpty
        ? "Check cancelled · no verification was recorded"
        : jobOutcomeProblems.joined(separator: " · ")
    } catch {
      // The engine exits non-zero when a destination failed, but the reason
      // already arrived on the event stream. Reporting only the exit status
      // would replace "photos → archive failed · <rsync said>" with a number.
      let message = error.localizedDescription
      await refresh()
      errorMessage =
        jobOutcomeProblems.isEmpty ? message : jobOutcomeProblems.joined(separator: " · ")
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
    guard !isPreparingSync, !isLaunchingJob, activeJob == nil else { return }
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
    guard !isLaunchingJob, activeJob == nil else { return }
    isLaunchingJob = true
    suppressSnapshotJob = false
    isCancellingJob = false
    errorMessage = nil
    jobOutcomeMessage = nil
    jobOutcomeProblems = []
    let events = eventHandler(actor: .mac)
    syncTask = Task { [weak self] in
      guard let self else { return }
      defer {
        self.isLaunchingJob = false
        self.isCancellingJob = false
        self.syncTask = nil
      }
      var outcomeMessage: String?
      do {
        try await self.client.runSync(
          confirmationToken: token, actor: .mac, onEvent: events)
        self.syncPreflight = nil
        self.finishJob(success: "Sync completed · evidence recorded")
      } catch is CancellationError {
        outcomeMessage =
          self.jobOutcomeProblems.isEmpty
          ? "Sync cancelled · no verification was recorded"
          : self.jobOutcomeProblems.joined(separator: " · ")
      } catch {
        // Same as the cancellation case above: what the engine reported about
        // the transfer outranks the exit status it happened to leave with.
        outcomeMessage =
          self.jobOutcomeProblems.isEmpty
          ? error.localizedDescription
          : self.jobOutcomeProblems.joined(separator: " · ")
      }
      await self.refresh()
      if let outcomeMessage { self.errorMessage = outcomeMessage }
    }
  }

  func cancelOwnedJob() {
    guard canCancelOwnedJob else { return }
    isCancellingJob = true
    checkTask?.cancel()
    syncTask?.cancel()
    scheduleTask?.cancel()
  }

  @discardableResult
  func setSource(path: String) async -> Bool {
    await updateSetup("Saving source") { try await client.setSource(path: path) }
  }

  @discardableResult
  func addDestination(path: String, name: String) async -> Bool {
    await updateSetup("Identifying and probing \(name)") {
      try await client.addDestination(path: path, name: name)
    }
  }

  @discardableResult
  func adoptDestination(name: String) async -> Bool {
    await updateSetup("Writing and recording sentinel for \(name)") {
      try await client.adoptDestination(name: name)
    }
  }

  @discardableResult
  func removeDestination(name: String) async -> Bool {
    await updateSetup("Removing \(name) from configuration") {
      try await client.removeDestination(name: name)
    }
  }

  /// Reports whether the change was written, so a caller can act on the outcome
  /// without reading `setupMessage`. That string is display copy: a screen was
  /// comparing it to `"Saved"` to decide whether to dismiss its form, which made
  /// rewording a sentence enough to break the form.
  @discardableResult
  private func updateSetup(
    _ progress: String,
    operation: () async throws -> EngineSnapshot
  ) async -> Bool {
    guard !isUpdatingSetup, activeJob == nil else { return false }
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
      if let presentedUnitID, !next.units.contains(where: { $0.id == presentedUnitID }) {
        self.presentedUnitID = nil
      }
      return true
    } catch {
      setupMessage = "Not saved · \(error.localizedDescription)"
      return false
    }
  }

  func loadDifferences(unit: String, target: String) async {
    let requestID = UUID()
    differencesRequestID = requestID
    isLoadingDifferences = true
    differencesErrorMessage = nil
    defer {
      if differencesRequestID == requestID { isLoadingDifferences = false }
    }
    do {
      let next = try await client.differences(unit: unit, target: target)
      guard differencesRequestID == requestID else { return }
      differences = next
    } catch {
      guard differencesRequestID == requestID else { return }
      differences = nil
      differencesErrorMessage = error.localizedDescription
    }
  }

  func loadHistory() async {
    guard !isLoadingHistory else { return }
    isLoadingHistory = true
    historyErrorMessage = nil
    defer { isLoadingHistory = false }
    do {
      historyEntries = try await client.history()
    } catch {
      historyEntries = []
      historyErrorMessage = error.localizedDescription
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
    guard scheduleTask == nil, !isLaunchingJob, activeJob == nil else { return }
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
    suppressSnapshotJob = false
    jobOutcomeMessage = nil
    jobOutcomeProblems = []
    let events = eventHandler(actor: .scheduler)
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
          try await self.client.runCheck(
            operation, unit: schedule.unit, actor: .scheduler, onEvent: events)
        case .sync:
          guard let unit = schedule.unit, let target = schedule.target else {
            throw ScheduleRunError.incompleteSyncScope
          }
          let preflight = try await self.client.prepareSync(unit: unit, target: target)
          guard preflight.ok, let token = preflight.confirmationToken else {
            throw ScheduleRunError.preflightRefused(
              preflight.checks.first(where: { !$0.ok })?.detail ?? "guard checks did not pass")
          }
          try await self.client.runSync(
            confirmationToken: token, actor: .scheduler, onEvent: events)
        }
      } catch is CancellationError {
        outcomeMessage =
          self.jobOutcomeProblems.isEmpty
          ? "Scheduled work cancelled"
          : self.jobOutcomeProblems.joined(separator: " · ")
      } catch {
        outcomeMessage = "Scheduled work failed · \(error.localizedDescription)"
      }
      await self.notifyScheduledOutcome(schedule: schedule, failure: outcomeMessage)
      self.isLaunchingJob = false
      self.scheduleTask = nil
      await self.refresh()
      if outcomeMessage == nil {
        self.finishJob(success: "Scheduled work completed · evidence recorded")
      }
      if let outcomeMessage { self.errorMessage = outcomeMessage }
    }
  }

  private func eventHandler(actor: EngineActor) -> JobEventHandler {
    { [weak self] event in
      Task { @MainActor [weak self] in
        self?.observe(event, actor: actor)
      }
    }
  }

  private func observe(_ event: JobEventSnapshot, actor: EngineActor) {
    switch event.type {
    case "job.skipped":
      let reason = event.reason ?? event.reachability?.ledgerPhrase ?? "not run"
      jobOutcomeProblems.append("\(event.unit) → \(event.target) skipped · \(reason)")
      liveActiveJob = nil
      liveJobID = nil
      suppressSnapshotJob = true
    case "job.failed":
      jobOutcomeProblems.append(
        "\(event.unit) → \(event.target) failed · \(event.message ?? "engine error")")
      liveActiveJob = nil
      liveJobID = nil
      suppressSnapshotJob = true
    case "job.cancelled":
      if event.operation == "sync" {
        let transferred = event.transferred.map { " after \($0.formatted()) files transferred" } ?? ""
        jobOutcomeProblems.append(
          "Sync cancelled\(transferred) · no verification was recorded")
      } else {
        jobOutcomeProblems.append("Check cancelled · no verification was recorded")
      }
      liveActiveJob = nil
      liveJobID = nil
      suppressSnapshotJob = true
    case "job.completed":
      liveActiveJob = nil
      liveJobID = nil
      suppressSnapshotJob = true
    default:
      let existing = liveActiveJob
      let startedAt =
        event.type == "job.started" || liveJobID != event.jobId
        ? event.at : existing?.startedAt ?? event.at
      liveJobID = event.jobId
      let previous = existing?.activity
      liveActiveJob = ActiveJobSnapshot(
        actor: actor.rawValue,
        operation: event.operation,
        startedAt: startedAt,
        heartbeatAt: event.at,
        activity: ActiveJobActivity(
          unit: event.unit,
          target: event.target,
          phase: event.phase ?? previous?.phase ?? "starting-rsync",
          at: event.at,
          filesSeen: event.filesSeen ?? previous?.filesSeen,
          filesTotal: event.filesTotal ?? previous?.filesTotal,
          bytesDone: event.bytesDone ?? previous?.bytesDone,
          bytesTotal: event.bytesTotal ?? previous?.bytesTotal,
          lastItem: event.lastItem ?? previous?.lastItem),
        estimatedDurationMs: event.estimatedDurationMs ?? existing?.estimatedDurationMs,
        batchPosition: event.batch?.position ?? existing?.batchPosition,
        batchTotal: event.batch?.total ?? existing?.batchTotal)
    }
  }

  private func finishJob(success: String) {
    liveActiveJob = nil
    liveJobID = nil
    if jobOutcomeProblems.isEmpty {
      jobOutcomeMessage = success
    } else {
      errorMessage = jobOutcomeProblems.joined(separator: " · ")
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
      return "Sync · \(schedule.unit ?? "no folder") → \(schedule.target ?? "no destination")"
    }
    return "\(schedule.operation.readerTitle) · \(schedule.unit ?? "all folders")"
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

/// What the activity drawer shows when it is open. This replaced a sidebar
/// whose three destinations were a ledger, this, and a Settings item that
/// duplicated the `Settings` scene the app already declares — leaving one
/// permanent column to switch between two things.
enum ActivityDrawerTab: String, CaseIterable, Identifiable {
  case running = "Running"
  case history = "History"

  var id: String { rawValue }
}
