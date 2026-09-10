#!/bin/sh
set -eu

repo_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
build_dir="$repo_dir/build/macos"
app_dir="$repo_dir/build/Syncy.app"
contents_dir="$app_dir/Contents"
binary_dir="$contents_dir/MacOS"
resources_dir="$contents_dir/Resources"
sdk_path=$(xcrun --sdk macosx --show-sdk-path)

# The minimum OS is written down once, in Info.plist, and the compiler target
# follows it. Hardcoding the target here is how a build came to claim 14.0
# support that the code no longer honoured, while `swift build` read the
# newer floor from Package.swift and passed.
deployment_target=$(/usr/libexec/PlistBuddy -c "Print :LSMinimumSystemVersion" \
  "$repo_dir/macos/Info.plist")

mkdir -p "$build_dir/cache" "$binary_dir" "$resources_dir"

cd "$repo_dir"
bun run scripts/build.ts
cp "$repo_dir/syncy" "$binary_dir/syncy-engine"
cp "$repo_dir/macos/Info.plist" "$contents_dir/Info.plist"

# Regenerated from source every build so the tile can never drift from the
# palette the app actually ships.
swift "$repo_dir/scripts/make-app-icon.swift" "$build_dir/Syncy.iconset" >/dev/null
iconutil -c icns "$build_dir/Syncy.iconset" -o "$resources_dir/Syncy.icns"

swiftc -swift-version 6 -sdk "$sdk_path" -target "arm64-apple-macosx$deployment_target" \
  -module-cache-path "$build_dir/cache" \
  -parse-as-library -emit-library -static -emit-module \
  -emit-module-path "$build_dir/SyncyMacCore.swiftmodule" \
  -module-name SyncyMacCore \
  "$repo_dir"/macos/Sources/SyncyMacCore/*.swift \
  -o "$build_dir/libSyncyMacCore.a"

swiftc -swift-version 6 -sdk "$sdk_path" -target "arm64-apple-macosx$deployment_target" \
  -module-cache-path "$build_dir/cache" \
  -I "$build_dir" -L "$build_dir" -lSyncyMacCore \
  -module-name SyncyMacApp \
  "$repo_dir"/macos/Sources/SyncyMacApp/*.swift \
  -o "$binary_dir/Syncy"

identity=${SYNCY_SIGN_IDENTITY:--}
codesign --force --options runtime --timestamp=none --sign "$identity" "$binary_dir/syncy-engine"
codesign --force --options runtime --timestamp=none --sign "$identity" "$app_dir"
codesign --verify --deep --strict "$app_dir"

echo "$app_dir"
