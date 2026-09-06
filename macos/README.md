# Syncy for Mac — interface shell

This directory contains a native SwiftUI menu-bar app for Syncy. It has no
external dependencies and invokes Syncy's engine for the ledger, differences,
evidence, history, setup, diagnostics, quick checks, deep verifies, and guarded
syncs.

At runtime the app launches Syncy's `engine snapshot` command and strictly
decodes protocol version 1. It does not substitute sample evidence when the
engine is missing or returns invalid output.

## Run

Requires macOS 14 or later and Swift 6.

```sh
cd macos
SYNCY_ENGINE=/absolute/path/to/syncy swift run SyncyMac
```

## Build and test

```sh
cd macos
swift build
swift test
```

From the repository root, `scripts/build-mac-app.sh` builds the engine and a
`build/Syncy.app` bundle, embeds the engine helper, and ad-hoc signs both. Set
`SYNCY_SIGN_IDENTITY` to use a Developer ID identity. Notarization is a separate
distribution step and is not needed for a personal local build.

## Engine seam

`ProcessEngineClient` locates the engine in this order:

1. The absolute path in `SYNCY_ENGINE`.
2. A bundled auxiliary executable named `syncy-engine`.

It launches versioned engine commands, requires successful exit status, and validates the
version, message type, enums, required fields, and non-negative counts. While a
job runs, the app consumes the engine's JSON Lines events as they arrive;
snapshots remain the recovery path when the app opens during work another
process started. Both paths expose the single process owner, elapsed time,
current phase, batch position, historical duration estimate, last observed
file, and only progress rsync actually measured.
UI code does not infer completion from process silence or scrape the terminal
renderer.

Reader-facing status phrases, difference labels, evidence timestamps, file-only
counts, and destination provenance are produced by the same presentation and
protocol layer the terminal UI uses. Bun and Swift tests decode the same golden
fixtures under `test/fixtures/ui-contract` so either client changing meaning
without the other is a contract failure.

## Background work

Daily and weekly schedules can run quick checks, deep verifies, or an explicitly
enabled sync for one exact folder and destination. Scheduled sync always obtains
a new, short-lived preflight token immediately before running; it cannot reuse a
previous review. A source or destination configuration change suspends that sync
schedule until the person reviews it again. Missed occurrences and skipped
destinations are literal history outcomes, and local notifications default to
problems only. The app must be running to start work; opening it at login is
available from Settings. After sleep, only the latest missed occurrence runs.

## Developer ID and optional notarization

```sh
SYNCY_SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
  ./scripts/build-mac-app.sh
ditto -c -k --keepParent build/Syncy.app build/Syncy.zip
xcrun notarytool submit build/Syncy.zip --keychain-profile syncy-notary --wait
xcrun stapler staple build/Syncy.app
codesign --verify --deep --strict build/Syncy.app
spctl --assess --type execute build/Syncy.app
```

The default build uses an ad-hoc signature for personal use on the building Mac.
Notarization needs an Apple Developer account and a `notarytool` keychain profile;
it is optional for that local build.
