import Foundation

public enum LedgerState: String, CaseIterable, Codable, Sendable {
  case verified
  case unverified
  case behind
  case missing
  case unchecked
  case error

  /// Worst first. This is the engine's own `PRECEDENCE` (`src/status.ts`) with
  /// `verified` restored on the end, where `rollUp` leaves it as the
  /// fallthrough. Every caller that has to pick *the one state to report* walks
  /// this order, so the tray glyph, the panel headline and the tally cannot
  /// disagree with each other — or, more importantly, with the ledger they are
  /// summarising.
  ///
  /// `unverified` outranking `unchecked` reads backwards until you take the
  /// engine's reasoning: "we checked and it is not replicated" is more
  /// informative than "we could not check", so a definite finding outranks a
  /// missing one. An unchecked destination still outranks `verified`, because
  /// no conclusion can be drawn from evidence that was never taken.
  public static let precedence: [LedgerState] = [
    .error, .missing, .behind, .unverified, .unchecked, .verified,
  ]

  public var symbol: String {
    switch self {
    case .verified: "checkmark"
    // A footnote mark: this entry carries a caveat. The TUI sets `~` for the
    // same state, but there is no tilde in SF Symbols — asking for one drew
    // nothing at all, so every `unverified` row in the ledger showed an empty
    // circle where its glyph should have been.
    case .unverified: "asterisk"
    case .behind: "arrow.up"
    case .missing: "minus"
    case .unchecked: "questionmark"
    case .error: "exclamationmark"
    }
  }
}

public struct DestinationEvidence: Identifiable, Codable, Sendable {
  public let id: UUID
  public let name: String
  public let state: LedgerState
  public let evidence: String

  public init(id: UUID = UUID(), name: String, state: LedgerState, evidence: String) {
    self.id = id
    self.name = name
    self.state = state
    self.evidence = evidence
  }
}

public struct LedgerUnit: Identifiable, Codable, Sendable {
  public let id: UUID
  public let name: String
  public let size: String
  public let fileCount: Int
  public let state: LedgerState
  public let destinations: [DestinationEvidence]

  public init(
    id: UUID = UUID(),
    name: String,
    size: String,
    fileCount: Int,
    state: LedgerState,
    destinations: [DestinationEvidence]
  ) {
    self.id = id
    self.name = name
    self.size = size
    self.fileCount = fileCount
    self.state = state
    self.destinations = destinations
  }
}

public enum JobKind: String, Codable, Sendable {
  case quickCheck = "Quick check"
  case deepVerify = "Deep verify"
  case sync = "Sync"
}

public struct RunningJob: Codable, Sendable {
  public let kind: JobKind
  public let unit: String
  public let destination: String
  public let phase: String
  public let startedAt: Date
  public let estimatedDuration: TimeInterval?
  public let lastEvent: String
  public let measuredFraction: Double?

  public init(
    kind: JobKind,
    unit: String,
    destination: String,
    phase: String,
    startedAt: Date,
    estimatedDuration: TimeInterval?,
    lastEvent: String,
    measuredFraction: Double?
  ) {
    self.kind = kind
    self.unit = unit
    self.destination = destination
    self.phase = phase
    self.startedAt = startedAt
    self.estimatedDuration = estimatedDuration
    self.lastEvent = lastEvent
    self.measuredFraction = measuredFraction
  }

  public func elapsed(at date: Date) -> TimeInterval {
    max(0, date.timeIntervalSince(startedAt))
  }

  public func elapsedText(at date: Date) -> String {
    Self.duration(elapsed(at: date)) + " elapsed"
  }

  public var estimateText: String? {
    guard let estimatedDuration else { return nil }
    return "Estimated around \(Self.duration(estimatedDuration)) from previous checks"
  }

  private static func duration(_ interval: TimeInterval) -> String {
    let seconds = max(0, Int(interval.rounded(.down)))
    let hours = seconds / 3_600
    let minutes = (seconds % 3_600) / 60
    let remainder = seconds % 60
    if hours > 0 { return "\(hours)h \(minutes)m" }
    if minutes > 0 { return "\(minutes)m \(remainder)s" }
    return "\(remainder)s"
  }
}

#if DEBUG
  /// Explicit preview and test fixtures. Release builds do not contain these values.
  public enum PreviewData {
    public static let units: [LedgerUnit] = [
      LedgerUnit(
        name: "photos-2019", size: "412 gb", fileCount: 38_024, state: .verified,
        destinations: [
          DestinationEvidence(
            name: "Archive", state: .verified, evidence: "deep verified 2 days ago"),
          DestinationEvidence(name: "NAS", state: .verified, evidence: "deep verified 2 days ago"),
        ]
      ),
      LedgerUnit(
        name: "photos-2020", size: "286 gb", fileCount: 24_901, state: .unverified,
        destinations: [
          DestinationEvidence(
            name: "Archive", state: .verified, evidence: "deep verified 6 days ago"),
          DestinationEvidence(
            name: "NAS", state: .unverified, evidence: "size and date match, bytes unread"),
        ]
      ),
      LedgerUnit(
        name: "field-recordings", size: "84 gb", fileCount: 1_208, state: .behind,
        destinations: [
          DestinationEvidence(name: "Archive", state: .behind, evidence: "17 files short · 3.2 gb"),
          DestinationEvidence(name: "NAS", state: .unchecked, evidence: "destination unavailable"),
        ]
      ),
      LedgerUnit(
        name: "documents", size: "18 gb", fileCount: 9_340, state: .unchecked,
        destinations: [
          DestinationEvidence(name: "Archive", state: .unchecked, evidence: "never checked"),
          DestinationEvidence(name: "NAS", state: .unchecked, evidence: "destination unavailable"),
        ]
      ),
    ]

    public static func runningJob(now: Date = Date()) -> RunningJob {
      RunningJob(
        kind: .deepVerify,
        unit: "photos-2020",
        destination: "NAS",
        phase: "Comparing file contents",
        startedAt: now.addingTimeInterval(-18 * 60 - 42),
        estimatedDuration: 49 * 60,
        lastEvent: "rsync is running · no file-level results have arrived yet",
        measuredFraction: nil
      )
    }
  }
#endif
