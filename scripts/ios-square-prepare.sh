#!/usr/bin/env bash
# Add Square Mobile Payments SDK via Swift Package Manager after cap sync.
# Safe to re-run. Does not embed secrets.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PBX="$ROOT/apps/adapter/ios/App/App.xcodeproj/project.pbxproj"
if [ ! -f "$PBX" ]; then
  echo "iOS project missing; skip Square SPM" >&2
  exit 0
fi

PLIST="$ROOT/apps/adapter/ios/App/App/Info.plist"
if [ -x /usr/libexec/PlistBuddy ] && [ -f "$PLIST" ]; then
  /usr/libexec/PlistBuddy -c "Delete :NSBluetoothAlwaysUsageDescription" "$PLIST" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Delete :NSBluetoothPeripheralUsageDescription" "$PLIST" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Add :NSBluetoothAlwaysUsageDescription string Floor uses Bluetooth to talk to the Square card reader." "$PLIST"
  /usr/libexec/PlistBuddy -c "Add :NSBluetoothPeripheralUsageDescription string Floor uses Bluetooth to talk to the Square card reader." "$PLIST"
  /usr/libexec/PlistBuddy -c "Delete :NSLocationWhenInUseUsageDescription" "$PLIST" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Add :NSLocationWhenInUseUsageDescription string Square may use location while taking a payment." "$PLIST"
fi

echo "Square Mobile Payments SDK: add in Xcode if not present:"
echo "  File → Add Package Dependencies → https://github.com/square/mobile-payments-sdk-ios"
echo "  Link SquareMobilePaymentsSDK to the App target."
echo "FloorSquarePlugin.swift compiles with #if canImport(SquareMobilePaymentsSDK)."
echo "PASS  square ios prepare notes written"
