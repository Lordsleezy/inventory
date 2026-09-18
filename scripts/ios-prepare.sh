#!/usr/bin/env bash
# Run on macOS / Codemagic after `npx cap sync ios`.
# Capacitor 8 SPM uses App.xcodeproj (no CocoaPods workspace).
# Team 4SRR4NV35F. Bundle com.openboxindustries.floor.
# Do not enable UIFileSharingEnabled — the live store is not a Files-app share.
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
  for key in NSCameraUsageDescription NSPhotoLibraryUsageDescription NSPhotoLibraryAddUsageDescription UIFileSharingEnabled LSSupportsOpeningDocumentsInPlace; do
    /usr/libexec/PlistBuddy -c "Delete :$key" "$PLIST" 2>/dev/null || true
  done
  /usr/libexec/PlistBuddy -c "Add :NSCameraUsageDescription string Floor adds unit photos from the camera." "$PLIST"
  /usr/libexec/PlistBuddy -c "Add :NSPhotoLibraryUsageDescription string Floor adds unit photos from your library." "$PLIST"
  /usr/libexec/PlistBuddy -c "Add :NSPhotoLibraryAddUsageDescription string Floor can save a copy of a unit photo." "$PLIST"
  /usr/libexec/PlistBuddy -c "Delete :CFBundleURLTypes" "$PLIST" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes array" "$PLIST"
  /usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0 dict" "$PLIST"
  /usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLName string floor" "$PLIST"
  /usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" "$PLIST"
  /usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string floor" "$PLIST"
fi

SPM="$IOS/App/CapApp-SPM/Package.swift"
CFG="$IOS/App/App/capacitor.config.json"
if [ -f "$SPM" ] && ! grep -q "FloorSquarePlugin" "$SPM"; then
  echo "cap sync skipped FloorSquarePlugin; injecting it into CapApp-SPM"
  python3 - "$SPM" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
text = p.read_text()
dep = '        .package(name: "FloorSquarePlugin", path: "../../../../../node_modules/@floor/square-plugin")'
prod = '                .product(name: "FloorSquarePlugin", package: "FloorSquarePlugin")'
if "FloorSquarePlugin" in text:
    raise SystemExit(0)
needle = '.package(name: "CapacitorShare", path: "../../../../../node_modules/@capacitor/share")'
if needle not in text:
    raise SystemExit("CapApp-SPM Package.swift does not have the CapacitorShare pin to attach FloorSquarePlugin")
text = text.replace(needle, needle + ",\n" + dep, 1)
needle2 = '.product(name: "CapacitorShare", package: "CapacitorShare")'
if needle2 not in text:
    raise SystemExit("CapApp-SPM Package.swift is missing the CapacitorShare product")
text = text.replace(needle2, needle2 + ",\n" + prod, 1)
p.write_text(text)
print("injected FloorSquarePlugin")
PY
fi
if [ -f "$CFG" ] && ! grep -q "FloorSquarePlugin" "$CFG"; then
  python3 - "$CFG" <<'PY'
import json, sys
from pathlib import Path
p = Path(sys.argv[1])
data = json.loads(p.read_text())
classes = data.setdefault("packageClassList", [])
if "FloorSquarePlugin" not in classes:
    classes.append("FloorSquarePlugin")
p.write_text(json.dumps(data, indent="\t") + "\n")
print("added FloorSquarePlugin to packageClassList")
PY
fi
if [ -f "$SPM" ] && ! grep -q "FloorSquarePlugin" "$SPM"; then
  echo "FloorSquarePlugin is still missing from CapApp-SPM after inject" >&2
  exit 1
fi
