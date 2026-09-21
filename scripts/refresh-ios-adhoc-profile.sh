#!/usr/bin/env bash
# Delete stale Ad Hoc profiles for BUNDLE_ID, then fetch/create a fresh one
# that includes every ENABLED device currently on the Apple team.
set -euo pipefail

BUNDLE_ID="${BUNDLE_ID:-com.openboxindustries.floor}"

echo "Refreshing Ad Hoc profile for $BUNDLE_ID (include all team devices)…"

# Dump profiles to a file so we can parse reliably.
PROF_JSON="$(mktemp)"
if app-store-connect profiles list --type IOS_APP_ADHOC --json >"$PROF_JSON" 2>/tmp/prof-list.err; then
  :
else
  echo "WARN  profiles list --json failed; trying plain list"
  app-store-connect profiles list --type IOS_APP_ADHOC >"$PROF_JSON" 2>/tmp/prof-list.err || true
fi

FLOOR_BUNDLE="$BUNDLE_ID" python3 - "$PROF_JSON" <<'PY'
import json, os, re, subprocess, sys

path = sys.argv[1]
bundle = os.environ["FLOOR_BUNDLE"]
raw = open(path).read().strip()
profiles = []
try:
    data = json.loads(raw) if raw.startswith(("{", "[")) else None
except Exception:
    data = None
if isinstance(data, list):
    profiles = data
elif isinstance(data, dict):
    profiles = data.get("data") or data.get("profiles") or data.get("items") or []
else:
    # Plain text: look for UUID-ish ids next to adhoc names
    for m in re.finditer(r"([0-9A-Fa-f-]{20,})\s+.*?(adhoc|ad.?hoc|Ad Hoc)", raw, re.I):
        profiles.append({"id": m.group(1), "name": m.group(0)})

def matches(p: dict) -> bool:
    attrs = p.get("attributes") if isinstance(p.get("attributes"), dict) else p
    blob = json.dumps(attrs, default=str).lower()
    if bundle.lower() in blob:
        return True
    name = str(attrs.get("name") or p.get("name") or "").lower()
    if "adhoc" in name.replace("-", "").replace("_", "") or "ad hoc" in name:
        if "floor" in name or "openbox" in name:
            return True
    return False

deleted = 0
for p in profiles:
    if not isinstance(p, dict) or not matches(p):
        continue
    pid = p.get("id") or (p.get("attributes") or {}).get("id")
    name = (p.get("attributes") or p).get("name") or pid
    if not pid:
        continue
    print(f"Deleting stale Ad Hoc profile: {name} ({pid})")
    for cmd in (
        ["app-store-connect", "profiles", "delete", str(pid)],
        ["app-store-connect", "delete-profile", str(pid)],
        ["app-store-connect", "profiles", "delete", "--id", str(pid)],
    ):
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode == 0:
            print("PASS  deleted", pid)
            deleted += 1
            break
        print(" try failed:", " ".join(cmd), (r.stderr or r.stdout)[:200])
    else:
        print("WARN  could not delete", pid, "- fetch --create may still reuse it")
print(f"Deleted {deleted} profile(s)")
PY

rm -f "$PROF_JSON"

app-store-connect fetch-signing-files "$BUNDLE_ID" \
  --platform IOS \
  --type IOS_APP_ADHOC \
  --create

# Prove IOS_DEVICE_UDID is on the freshly fetched profile (if set).
if [ -n "${IOS_DEVICE_UDID:-}" ]; then
  WANT="$(printf '%s' "$IOS_DEVICE_UDID" | tr -d ' \t\r\n-' | tr '[:lower:]' '[:upper:]')"
  FOUND=0
  # Codemagic CLI saves profiles under Xcode UserData, not ~/Library/MobileDevice.
  while IFS= read -r prov; do
    [ -f "$prov" ] || continue
    DECODED="$(mktemp)"
    if security cms -D -i "$prov" >"$DECODED" 2>/dev/null \
      || openssl smime -inform DER -verify -noverify -in "$prov" >"$DECODED" 2>/dev/null; then
      if FLOOR_WANT="$WANT" FLOOR_PROV="$prov" python3 - "$DECODED" <<'PY'
import plistlib, os, re, sys
want = os.environ["FLOOR_WANT"]
p = plistlib.load(open(sys.argv[1], "rb"))
devs = p.get("ProvisionedDevices") or []
def norm(s): return re.sub(r"[^0-9A-Fa-f]", "", s or "").upper()
norms = [norm(d) for d in devs]
ok = want in norms
print("profile", p.get("Name"), "path", os.environ.get("FLOOR_PROV"))
print("get-task-allow", (p.get("Entitlements") or {}).get("get-task-allow"))
print("devices", len(devs))
for d in devs:
    print("  ", d, "norm=", norm(d), "match=" + str(norm(d) == want))
print("want_norm", want, "udid_match", ok)
sys.exit(0 if ok else 1)
PY
      then
        FOUND=1
        rm -f "$DECODED"
        break
      fi
    fi
    rm -f "$DECODED"
  done < <(find \
    "/Users/builder/Library/Developer/Xcode/UserData/Provisioning Profiles" \
    "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles" \
    "$HOME/Library/MobileDevice/Provisioning Profiles" \
    /Users/builder/Library/MobileDevice/Provisioning\ Profiles \
    . \
    -name '*.mobileprovision' 2>/dev/null | head -80)

  if [ "$FOUND" -ne 1 ]; then
    echo "FAIL  refreshed Ad Hoc profile does not include IOS_DEVICE_UDID (normalized check)." >&2
    echo "Want (normalized): $WANT" >&2
    echo "Enable the device in Apple Developer → Devices and re-run." >&2
    exit 1
  fi
  echo "PASS  IOS_DEVICE_UDID is in the fresh Ad Hoc profile"
fi

echo "PASS  Ad Hoc signing files refreshed"
