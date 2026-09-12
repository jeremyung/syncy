// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "SyncyMac",
  // 14.4 for `TableColumnForEach`: the ledger grows a column per destination,
  // so a real `Table` — and the arrow-key navigation that comes with it — needs
  // columns the builder can generate rather than ones written out by hand.
  platforms: [.macOS("14.4")],
  products: [
    .executable(name: "SyncyMac", targets: ["SyncyMacApp"])
  ],
  targets: [
    .target(name: "SyncyMacCore"),
    .executableTarget(
      name: "SyncyMacApp",
      dependencies: ["SyncyMacCore"]
    ),
    .testTarget(
      name: "SyncyMacAppTests",
      dependencies: ["SyncyMacCore"]
    ),
  ]
)
