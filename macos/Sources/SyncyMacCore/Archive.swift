import Foundation

public enum LocalPresence: String, Decodable, Sendable {
  case present, absent, unavailable
}

public struct ArchiveRecord: Decodable, Sendable {
  public let local: LocalPresence
  public let label: String
  public let pairOptions: [DestinationPair]
  public let pairs: [PairEvidence]
  public let localChecks: [LocalVerification]
}

public struct LocalVerification: Decodable, Sendable {
  public let target: String
  public let at: Double
}

public struct DestinationPair: Decodable, Identifiable, Sendable {
  public let first: String
  public let second: String
  public let blocker: String?
  public var id: [String] { [first, second] }
  public var label: String { "\(first) ↔ \(second)" }

  public init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    let names = try values.decode([String].self, forKey: .endpoints)
    guard names.count == 2, names[0] != names[1] else {
      throw EngineClientError.protocolFailure("a comparison needs two different destinations")
    }
    first = names[0]
    second = names[1]
    blocker = try values.decodeIfPresent(String.self, forKey: .blocker)
  }

  private enum CodingKeys: CodingKey { case endpoints, blocker }

  public func matches(_ endpoints: [String]) -> Bool {
    endpoints == id || endpoints == [second, first]
  }
}

public struct PairEvidence: Decodable, Sendable {
  public let unit: String
  public let endpoints: [String]
  public let method: String
  public let at: Double
  public let current: Bool
  public let detail: String
  public let comparisonRules: String
  public let counts: [String: Int]
  public let samples: [DifferenceSample]
  public let outcome: String

  public var date: Date { Date(timeIntervalSince1970: at / 1_000) }

  public var datedSummary: String {
    let scope = endpoints.joined(separator: " ↔ ")
    let status = current ? detail : "Historical · " + detail
    return "\(scope) · \(status) · \(date.formatted(date: .abbreviated, time: .shortened))"
  }
}

public struct DifferenceSample: Decodable, Sendable {
  public let kind: String
  public let name: String
}

public struct FolderCandidates: Decodable, Sendable {
  public let protocolVersion: Int
  public let type: String
  public let configRevision: String
  public let candidates: [FolderCandidate]
  public let blocked: [String]
}

public struct FolderCandidate: Decodable, Identifiable, Sendable {
  public var id: String { unit }
  public let unit: String
  public let locations: [String]
  public let remembered: Bool
  public let tracked: Bool
}
