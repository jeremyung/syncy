import SwiftUI
import SyncyMacCore

struct AddTrackedFolderView: View {
  @ObservedObject var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var result: FolderCandidates?
  @State private var query = ""
  @State private var selection: FolderCandidate.ID?
  @State private var destination: String?
  @State private var busy = false
  @State private var failure: String?

  private var matches: [FolderCandidate] {
    (result?.candidates ?? []).filter {
      query.isEmpty || $0.unit.localizedCaseInsensitiveContains(query)
    }
  }

  private var selected: FolderCandidate? {
    matches.first { $0.id == selection }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: SyncySpace.md) {
      Text("Add Folder").font(.title2.bold())
      TextField("Find a folder by name", text: $query)
      HStack {
        Picker("Search", selection: $destination) {
          Text("All destinations").tag(String?.none)
          ForEach(model.snapshot?.targets ?? []) { target in
            Text(target.name).tag(Optional(target.name))
          }
        }.disabled(busy)
        Spacer()
        Button("Find on Destinations") { Task { await load(discover: true) } }
          .disabled(busy)
      }
      if let failure { Text(failure).foregroundStyle(SyncyTheme.fault).textSelection(.enabled) }
      if let result {
        if !result.blocked.isEmpty {
          ScrollView {
            VStack(alignment: .leading) {
              ForEach(result.blocked, id: \.self) { Text($0) }
            }.frame(maxWidth: .infinity, alignment: .leading)
          }.frame(maxHeight: 74).foregroundStyle(SyncyTheme.caution)
        }
        if result.candidates.isEmpty {
          ContentUnavailableView(
            "No folders found", systemImage: "folder",
            description: Text("Find folders on a connected destination."))
        } else if matches.isEmpty {
          ContentUnavailableView.search(text: query)
        } else {
          List(matches, selection: $selection) { candidate in
            HStack {
              VStack(alignment: .leading) {
                Text(candidate.unit)
                Text(candidate.locations.joined(separator: " · "))
                  .font(.caption).foregroundStyle(.secondary)
              }
              Spacer()
              if candidate.tracked { Text("Tracked").foregroundStyle(.secondary) }
            }.tag(candidate.id)
          }
        }
      }
      if busy { ProgressView().controlSize(.small) }
      Spacer(minLength: 0)
      HStack {
        Spacer()
        Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
        Button(actionTitle) {
          guard let selected, let revision = result?.configRevision else { return }
          Task {
            busy = true
            defer { busy = false }
            if selected.tracked {
              await model.refresh()
              guard model.engineErrorMessage == nil, model.snapshot?.configRevision == revision,
                model.snapshot?.units.contains(where: { $0.unit == selected.unit }) == true
              else {
                failure = "The ledger changed. Find the folder again."
                return
              }
              model.selectedUnitID = selected.unit
              dismiss()
            } else if await model.track(selected.unit, active: true, revision: revision) {
              dismiss()
            } else {
              failure = model.setupMessage
            }
          }
        }.keyboardShortcut(.defaultAction).disabled(busy || selected == nil)
      }
    }
    .padding(SyncySpace.gutter)
    .frame(minWidth: 480, minHeight: 360)
    .task { await load(discover: false) }
    .onChange(of: destination) { _, _ in
      result = nil
      selection = nil
      Task { await load(discover: true) }
    }
  }

  private var actionTitle: String {
    guard let selected else { return "Track Folder" }
    if selected.tracked { return "Show in Ledger" }
    return selected.remembered ? "Resume Tracking" : "Track Folder"
  }

  private func load(discover: Bool) async {
    busy = true
    failure = nil
    defer { busy = false }
    do {
      let next = try await model.folders(discover: discover, destinations: destination.map { [$0] } ?? [])
      result = next
      if !next.candidates.contains(where: { $0.id == selection }) {
        selection = next.candidates.first(where: { !$0.tracked })?.id ?? next.candidates.first?.id
      }
    } catch { failure = error.localizedDescription }
  }
}

struct ArchiveCopySections: View {
  @ObservedObject var model: AppModel
  let unit: String
  let record: ArchiveRecord
  let revision: String
  @State private var selection: DestinationPair.ID?

  private var selected: DestinationPair? {
    if record.pairOptions.count == 1 { return record.pairOptions.first }
    return record.pairOptions.first { $0.id == selection }
  }

  var body: some View {
    Section("Compare Copies") {
      if record.pairOptions.isEmpty {
        Text("Add a second destination to compare copies.")
      } else {
        if record.pairOptions.count > 1 {
          Picker("Destinations", selection: $selection) {
            Text("Choose two destinations").tag(DestinationPair.ID?.none)
            ForEach(record.pairOptions) { option in
              Text(option.label).tag(Optional(option.id))
            }
          }
        } else if let selected {
          Text(selected.label).fontWeight(.medium)
        }
        if let selected {
          if let blocker = selected.blocker { Text(blocker).foregroundStyle(SyncyTheme.caution) }
          HStack {
            Button("Quick Check") {
              Task { await model.compareCopies(.quick, unit: unit, pair: selected, revision: revision) }
            }
            Button("Deep Check") {
              Task { await model.compareCopies(.deep, unit: unit, pair: selected, revision: revision) }
            }
          }.disabled(selected.blocker != nil || model.isLaunchingJob || model.activeJob != nil)
          let readings = record.pairs.filter { selected.matches($0.endpoints) }
          if readings.isEmpty {
            Text("No comparison recorded for these copies.").foregroundStyle(.secondary)
          }
          ForEach(Array(readings.enumerated()), id: \.offset) { _, reading in
            PairReadingView(reading: reading)
          }
        }
      }
    }
    let historical = record.pairs.filter { reading in
      !record.pairOptions.contains { $0.matches(reading.endpoints) }
    }
    if !historical.isEmpty {
      Section("Earlier Destination Pairs") {
        ForEach(Array(historical.enumerated()), id: \.offset) { _, reading in
          PairReadingView(reading: reading)
        }
      }
    }
    Section("Last Verified Against Local") {
      if record.localChecks.isEmpty {
        Text("No local verification recorded.").foregroundStyle(.secondary)
      }
      ForEach(record.localChecks, id: \.target) { check in
        LabeledContent(
          check.target,
          value: Date(timeIntervalSince1970: check.at / 1_000)
            .formatted(date: .abbreviated, time: .shortened))
      }
    }
  }
}

private struct PairReadingView: View {
  let reading: PairEvidence
  var body: some View {
    VStack(alignment: .leading, spacing: SyncySpace.xs) {
      Text(reading.endpoints.joined(separator: " ↔ ")).fontWeight(.medium)
      Text(reading.detail)
      let method = reading.method == "deep" ? "Deep check" : "Quick check"
      Text(
        "\(reading.current ? method : "Historical " + method.lowercased()) · \(reading.date.formatted(date: .abbreviated, time: .shortened))"
      )
      .font(.caption).foregroundStyle(.secondary)
      DisclosureGroup("Comparison Rules") {
        Text(reading.comparisonRules).font(.caption).textSelection(.enabled)
      }
      if !reading.samples.isEmpty {
        DisclosureGroup("Differences · \(reading.samples.count) shown") {
          ForEach(Array(reading.samples.enumerated()), id: \.offset) { _, sample in
            LabeledContent(sample.kind, value: sample.name).textSelection(.enabled)
          }
        }
      }
    }
  }
}
