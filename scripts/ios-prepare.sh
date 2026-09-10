#!/usr/bin/env bash
# Run on macOS / Codemagic after `npx cap add ios` + `npx cap sync ios`.
# Team 4SRR4NV35F. Bundle com.openboxindustries.floor.
# ATS allows HTTP to the Surface API only — the UI is already in the ipa.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IOS="$ROOT/apps/adapter/ios"
PBX="$IOS/App/App.xcodeproj/project.pbxproj"
PLIST="$IOS/App/App/Info.plist"

if [ ! -f "$PBX" ] || [ ! -f "$PLIST" ]; then
  echo "iOS project missing. From apps/adapter: npx cap add ios && npx cap sync ios" >&2
  exit 1
fi

sed_inplace() {
  if sed --version >/dev/null 2>&1; then
    sed -i "$@"
  else
    sed -i '' "$@"
  fi
}

sed_inplace "s/PRODUCT_BUNDLE_IDENTIFIER = [^;]*/PRODUCT_BUNDLE_IDENTIFIER = com.openboxindustries.floor/g" "$PBX"
if grep -q "DEVELOPMENT_TEAM" "$PBX"; then
  sed_inplace "s/DEVELOPMENT_TEAM = [^;]*/DEVELOPMENT_TEAM = 4SRR4NV35F/g" "$PBX"
else
  sed_inplace "s/CODE_SIGN_STYLE = Automatic;/CODE_SIGN_STYLE = Automatic;\n\t\t\t\tDEVELOPMENT_TEAM = 4SRR4NV35F;/g" "$PBX"
fi

if [ -x /usr/libexec/PlistBuddy ]; then
  /usr/libexec/PlistBuddy -c "Delete :NSAppTransportSecurity" "$PLIST" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Add :NSAppTransportSecurity dict" "$PLIST"
  /usr/libexec/PlistBuddy -c "Add :NSAppTransportSecurity:NSAllowsLocalNetworking bool true" "$PLIST"
  /usr/libexec/PlistBuddy -c "Add :NSAppTransportSecurity:NSAllowsArbitraryLoads bool true" "$PLIST"
  for key in NSCameraUsageDescription NSPhotoLibraryUsageDescription NSPhotoLibraryAddUsageDescription; do
    /usr/libexec/PlistBuddy -c "Delete :$key" "$PLIST" 2>/dev/null || true
  done
  /usr/libexec/PlistBuddy -c "Add :NSCameraUsageDescription string Floor adds unit photos from the camera." "$PLIST"
  /usr/libexec/PlistBuddy -c "Add :NSPhotoLibraryUsageDescription string Floor adds unit photos from your library." "$PLIST"
  /usr/libexec/PlistBuddy -c "Add :NSPhotoLibraryAddUsageDescription string Floor can save a copy of a unit photo." "$PLIST"
fi
