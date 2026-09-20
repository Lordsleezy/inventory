#!/usr/bin/env bash
# Fail the Codemagic build unless the built IPA actually contains SquareMobilePaymentsSDK
# and a real SquareApplicationID (not REPLACE_ME). Manifest-only checks are not enough.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IPA="${1:-}"
if [ -z "$IPA" ]; then
  IPA="$(ls -1t "$ROOT"/build/ios/ipa/*.ipa 2>/dev/null | head -1 || true)"
fi
if [ -z "$IPA" ] || [ ! -f "$IPA" ]; then
  # Codemagic xcode-project build-ipa may leave the IPA under ~/clone/build or /Users/builder/...
  IPA="$(find "$ROOT" /Users/builder/clone/build /tmp -name '*.ipa' 2>/dev/null | head -1 || true)"
fi
if [ -z "$IPA" ] || [ ! -f "$IPA" ]; then
  echo "FAIL  no IPA found to verify Square linkage" >&2
  echo "Pass the IPA path: $0 path/to/App.ipa" >&2
  exit 1
fi

echo "Verifying Square SDK inside: $IPA"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
unzip -q "$IPA" -d "$TMP"

APP="$(find "$TMP/Payload" -maxdepth 1 -name '*.app' -print -quit)"
if [ -z "$APP" ] || [ ! -d "$APP" ]; then
  echo "FAIL  IPA has no Payload/*.app" >&2
  exit 1
fi

echo "App bundle: $APP"

# Square ships as an XCFramework; in the app it must appear as a .framework (or be
# linked into the main binary). Search both.
FOUND=0
if find "$APP" \( -iname '*SquareMobilePayments*' -o -iname '*SquareMobilePaymentsSDK*' \) 2>/dev/null | grep -q .; then
  FOUND=1
  echo "Found Square paths:"
  find "$APP" \( -iname '*SquareMobilePayments*' -o -iname '*SquareMobilePaymentsSDK*' \) 2>/dev/null | sed 's/^/  /'
fi

# Also check load commands / linked libraries on the main executable.
BIN="$APP/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Info.plist" 2>/dev/null || basename "$APP" .app)"
if [ -f "$BIN" ] && command -v otool >/dev/null 2>&1; then
  if otool -L "$BIN" 2>/dev/null | grep -qi 'SquareMobilePayments'; then
    FOUND=1
    echo "otool shows SquareMobilePayments linked into $(basename "$BIN")"
    otool -L "$BIN" | grep -i 'SquareMobilePayments' | sed 's/^/  /'
  fi
fi

# Frameworks folder listing (helpful on failure).
if [ -d "$APP/Frameworks" ]; then
  echo "Frameworks/:"
  ls -1 "$APP/Frameworks" | sed 's/^/  /' || true
else
  echo "WARN  no Frameworks/ directory in app bundle"
fi

if [ "$FOUND" -ne 1 ]; then
  echo "FAIL  SquareMobilePaymentsSDK is NOT in the app binary/bundle." >&2
  echo "CapApp-SPM must depend on .product(name: \"SquareMobilePaymentsSDK\", package: \"mobile-payments-sdk-ios\")." >&2
  echo "Manifest-only Package.swift checks are insufficient — this IPA would crash or report sdk_not_in_build at charge time." >&2
  exit 1
fi

# SquareApplicationID must be baked (public app id) or initialize() is skipped.
APP_ID="$(/usr/libexec/PlistBuddy -c 'Print :SquareApplicationID' "$APP/Info.plist" 2>/dev/null || true)"
if [ -z "$APP_ID" ] || [ "$APP_ID" = "REPLACE_ME" ]; then
  echo "FAIL  Info.plist SquareApplicationID is missing or REPLACE_ME (got: '${APP_ID:-empty}')." >&2
  echo "Set SQUARE_APPLICATION_ID in the Codemagic group appstore and re-run ios-square-prepare.sh." >&2
  exit 1
fi
echo "PASS  SquareApplicationID=$APP_ID"
echo "PASS  SquareMobilePaymentsSDK present in IPA"
