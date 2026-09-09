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

  /// The one leading edge in the window. A grouped `Form` insets its section
  /// cards by this much, so every page header, footnote, ledger row and footer
  /// uses it too and the whole column starts on a single vertical line.
  static let gutter: CGFloat = 20
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

/// Every screen opens the same way: serif title, one line of detail, an optional
/// fact or control on the trailing edge, and a rule beneath. Sharing the block
/// is what keeps the title on the same baseline as the sidebar selection moves.
struct PageHeader<Accessory: View>: View {
  let title: String
  let detail: String
  var detailColor: Color = SyncyTheme.secondaryInk
  var trailing: String?
  @ViewBuilder var accessory: Accessory

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .bottom, spacing: SyncySpace.lg) {
        VStack(alignment: .leading, spacing: SyncySpace.xs) {
          Text(title)
            .font(.system(.title, design: .serif, weight: .semibold))
            .lineLimit(1)
          Text(detail)
            .font(.callout)
            .foregroundStyle(detailColor)
            .lineLimit(2)
        }
        Spacer(minLength: SyncySpace.lg)
        if let trailing {
          Text(trailing)
            .font(.callout.monospacedDigit())
            .foregroundStyle(SyncyTheme.secondaryInk)
        }
        accessory
      }
      .padding(.horizontal, SyncySpace.gutter)
      .padding(.top, SyncySpace.xl)
      .padding(.bottom, SyncySpace.lg)
      Divider()
    }
  }
}

extension PageHeader where Accessory == EmptyView {
  init(
    title: String,
    detail: String,
    detailColor: Color = SyncyTheme.secondaryInk,
    trailing: String? = nil
  ) {
    self.init(
      title: title, detail: detail, detailColor: detailColor, trailing: trailing,
      accessory: { EmptyView() })
  }
}

/// One shape for every state that occupies a whole pane — working, empty, or
/// unavailable. It always fills the rectangle it is given; a state that sizes
/// itself drifts to the top-leading corner of a leading-aligned stack, which is
/// why "no work running" used to sit in the wrong place.
struct PaneNotice: View {
  let title: String
  var detail: String?
  var symbol: String?
  var isWorking = false

  var body: some View {
    VStack(spacing: SyncySpace.md) {
      if isWorking {
        ProgressView().controlSize(.small)
      } else if let symbol {
        Image(systemName: symbol)
          .font(.system(size: 28, weight: .light))
          .foregroundStyle(SyncyTheme.quietInk)
      }
      Text(title)
        .font(.headline)
      if let detail {
        Text(detail)
          .font(.callout)
          .foregroundStyle(SyncyTheme.secondaryInk)
          .multilineTextAlignment(.center)
          .frame(maxWidth: 380)
      }
    }
    .padding(SyncySpace.xl)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .accessibilityElement(children: .combine)
  }
}

/// The single spinner row, for use inside a form or list where the surrounding
/// section already provides the inset.
struct WorkingNotice: View {
  let text: String

  var body: some View {
    HStack(spacing: SyncySpace.sm) {
      ProgressView().controlSize(.small)
      Text(text).foregroundStyle(SyncyTheme.secondaryInk)
    }
    .accessibilityElement(children: .combine)
  }
}

struct EngineNotice: View {
  let text: String
  var trailing: String? = nil

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: SyncySpace.sm) {
      Circle()
        .fill(SyncyTheme.quietInk)
        .frame(width: 6, height: 6)
      Text(text)
        .font(.caption)
        .foregroundStyle(SyncyTheme.secondaryInk)
        .lineLimit(1)
      if let trailing {
        Spacer(minLength: SyncySpace.lg)
        Text(trailing)
          .font(.caption.monospacedDigit())
          .foregroundStyle(SyncyTheme.quietInk)
      }
    }
    .accessibilityElement(children: .combine)
  }
}
