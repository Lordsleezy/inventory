#!/usr/bin/env bash
# Register phone UDID(s) on the Apple Developer team before fetching an Ad Hoc profile.
#
# Env (Codemagic group appstore):
#   IOS_DEVICE_UDID   — your iPhone UDID (required for auto-register)
#   IOS_DEVICE_NAME   — label in the portal (default: Floor phone)
#   IOS_DEVICE_UDIDS  — optional extra UDIDs, comma or newline separated
#
# A 409 "already exists" from Apple is success. Confirmation normalizes UDID
# (case / dashes / whitespace) and refuses only if the device is DISABLED.
set -euo pipefail

NAME="${IOS_DEVICE_NAME:-Floor phone}"
UDIDS=()

normalize_udid() {
  printf '%s' "${1:-}" | tr -d ' \t\r\n-' | tr '[:lower:]' '[:upper:]'
}

add_udid() {
  local u
  u="$(printf '%s' "${1:-}" | tr -d ' \t\r\n')"
  [ -n "$u" ] || return 0
  local existing
  for existing in "${UDIDS[@]+"${UDIDS[@]}"}"; do
    [ "$(normalize_udid "$existing")" = "$(normalize_udid "$u")" ] && return 0
  done
  UDIDS+=("$u")
}

add_udid "${IOS_DEVICE_UDID:-}"

if [ -n "${IOS_DEVICE_UDIDS:-}" ]; then
  while IFS= read -r line; do
    add_udid "$line"
  done < <(printf '%s\n' "$IOS_DEVICE_UDIDS" | tr ',' '\n')
fi

if [ "${#UDIDS[@]}" -eq 0 ]; then
  echo "WARN  IOS_DEVICE_UDID unset — skipping auto-register."
  echo "      Add IOS_DEVICE_UDID to Codemagic group appstore."
  app-store-connect devices list --json 2>/dev/null | head -c 2000 || true
  exit 0
fi

# Find device on team by normalized UDID. Echoes "FOUND|<status>|<id>|<name>" or nothing.
find_device() {
  local want
  want="$(normalize_udid "$1")"
  local json plain
  json="$(app-store-connect devices list --json 2>/dev/null || true)"
  if [ -n "$json" ]; then
    FLOOR_WANT_UDID="$want" python3 -c '
import json, os, re, sys
want = os.environ["FLOOR_WANT_UDID"]
def norm(s):
    return re.sub(r"[^0-9A-Fa-f]", "", s or "").upper()
try:
    data = json.loads(sys.stdin.read())
except Exception:
    sys.exit(0)
devices = data if isinstance(data, list) else (
    data.get("data") or data.get("devices") or data.get("items") or []
)
for d in devices:
    if not isinstance(d, dict):
        continue
    attrs = d["attributes"] if isinstance(d.get("attributes"), dict) else d
    udid = str(attrs.get("udid") or d.get("udid") or "")
    if norm(udid) != want:
        continue
    status = str(attrs.get("status") or d.get("status") or "UNKNOWN")
    dev_id = str(d.get("id") or attrs.get("id") or "")
    name = str(attrs.get("name") or d.get("name") or "")
    print(f"FOUND|{status}|{dev_id}|{name}")
    break
' <<<"$json" && return 0
  fi

  # Text fallback: normalize the whole listing and look for the hex string.
  plain="$(app-store-connect devices list 2>/dev/null || true)"
  if printf '%s' "$plain" | tr -d ' \t\r\n-' | tr '[:lower:]' '[:upper:]' | grep -qF "$want"; then
    echo "FOUND|UNKNOWN||"
    return 0
  fi
  return 1
}

confirm_device_on_team() {
  local u="$1"
  local info status
  if ! info="$(find_device "$u")"; then
    return 1
  fi
  status="$(printf '%s' "$info" | cut -d'|' -f2)"
  echo "PASS  device on team: $info"
  case "$(printf '%s' "$status" | tr '[:lower:]' '[:upper:]')" in
    DISABLED)
      echo "FAIL  device is DISABLED in Apple Developer → Devices. Enable it, then re-run." >&2
      return 1
      ;;
  esac
  return 0
}

register_one() {
  local u="$1"
  local out rc
  echo "Registering device $NAME ($u)"

  # Already present? Skip register call.
  if confirm_device_on_team "$u"; then
    echo "PASS  already on team, skip register: $u"
    return 0
  fi

  set +e
  out="$(app-store-connect devices register --name "$NAME" --udid "$u" 2>&1)"
  rc=$?
  set -e
  printf '%s\n' "$out"

  if [ "$rc" -eq 0 ]; then
    echo "PASS  registered: $u"
    confirm_device_on_team "$u" || return 0
    return 0
  fi

  # Apple 409 / "already exists" == success (device was added outside this script).
  if printf '%s' "$out" | grep -Eiq '409|already exists|DUPLICATE|duplicate'; then
    echo "PASS  device already exists (409): $u"
    if confirm_device_on_team "$u"; then
      return 0
    fi
    # 409 from Apple means it exists — do not fail the build on list-format quirks.
    echo "WARN  409 already-exists but list confirm missed it (UDID format). Continuing." >&2
    return 0
  fi

  echo "WARN  register failed (rc=$rc) — confirming via device list"
  if confirm_device_on_team "$u"; then
    return 0
  fi
  echo "FAIL  could not register or find $u on the team" >&2
  return 1
}

failed=0
for u in "${UDIDS[@]}"; do
  if ! register_one "$u"; then
    failed=1
  fi
done

echo "Devices currently on team:"
app-store-connect devices list || true

if [ "$failed" -ne 0 ]; then
  exit 1
fi
echo "PASS  all requested UDIDs are on the Apple team"
