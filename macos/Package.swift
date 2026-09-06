// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "SyncyMac",
  platforms: [.macOS(.v14)],
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
