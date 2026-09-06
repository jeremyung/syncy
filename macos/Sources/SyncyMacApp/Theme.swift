import SwiftUI
import SyncyMacCore

enum SyncyTheme {
  static let paper = Color(nsColor: .textBackgroundColor)
  static let raised = Color(nsColor: .windowBackgroundColor)
  static let rule = Color.primary.opacity(0.13)
  static let secondaryInk = Color.primary.opacity(0.64)
  static let quietInk = Color.primary.opacity(0.45)
  static let verified = Color(red: 0.23, green: 0.47, blue: 0.32)
  static let caution = Color(red: 0.68, green: 0.43, blue: 0.12)
  static let fault = Color(red: 0.64, green: 0.24, blue: 0.20)
  static let selection = caution.opacity(0.10)

  static func color(for state: LedgerState) -> Color {
    switch state {
    case .verified: verified
    case .behind, .unverified: caution
    case .missing, .error: fault
    case .unchecked: quietInk
    }
  }
}

enum SyncySpace {
  static let xs: CGFloat = 4
  static let sm: CGFloat = 8
  static let md: CGFloat = 12
  static let lg: CGFloat = 16
  static let xl: CGFloat = 24
  static let xxl: CGFloat = 32
}

struct StateMark: View {
  let state: LedgerState

  var body: some View {
    Image(systemName: state.symbol)
      .font(.system(size: 11, weight: .semibold))
      .foregroundStyle(SyncyTheme.color(for: state))
      .frame(width: 20, height: 20)
      .background(SyncyTheme.color(for: state).opacity(0.11), in: Circle())
      .accessibilityLabel(state.rawValue)
  }
}

struct EngineNotice: View {
  let text: String
  var trailing: String? = nil

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Circle()
        .fill(SyncyTheme.quietInk)
        .frame(width: 6, height: 6)
      Text(text)
        .font(.caption)
        .foregroundStyle(SyncyTheme.secondaryInk)
      if let trailing {
        Spacer()
        Text(trailing)
          .font(.caption)
          .foregroundStyle(SyncyTheme.quietInk)
      }
    }
    .accessibilityElement(children: .combine)
  }
}
