#!/usr/bin/env bash
# Register phone UDID(s) on the Apple Developer team before fetching an Ad Hoc profile.
#
# Env (Codemagic group appstore):
#   IOS_DEVICE_UDID   — your iPhone UDID (required for auto-register)
#   IOS_DEVICE_NAME   — label in the portal (default: Floor phone)
#   IOS_DEVICE_UDIDS  — optional extra UDIDs, comma or newline separated
set -euo pipefail

NAME="${IOS_DEVICE_NAME:-Floor phone}"
UDIDS=()

add_udid() {
  local u
  u="$(printf '%s' "${1:-}" | tr -d ' \t\r\n')"
  [ -n "$u" ] || return 0
  local existing
  for existing in "${UDIDS[@]+"${UDIDS[@]}"}"; do
    [ "$existing" = "$u" ] && return 0
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
  echo "      Add IOS_DEVICE_UDID to Codemagic group appstore, or register via"
  echo "      Codemagic → Team settings → iOS test devices (email/QR), or"
  echo "      Apple Developer → Devices after reading UDID from https://udid.tech on the phone."
  app-store-connect devices list --json 2>/dev/null | head -c 2000 || true
  exit 0
fi

for u in "${UDIDS[@]}"; do
  echo "Registering device $NAME ($u)"
  if app-store-connect devices register --name "$NAME" --udid "$u"; then
    echo "PASS  registered (or already present): $u"
  else
    echo "WARN  register returned non-zero for $u — listing devices to confirm"
    if app-store-connect devices list 2>/dev/null | grep -qi "$u"; then
      echo "PASS  device already on the team: $u"
    else
      echo "FAIL  could not register $u — Ad Hoc install will not work on this phone" >&2
      exit 1
    fi
  fi
done

echo "Registered devices on team:"
app-store-connect devices list || true
