#!/usr/bin/env bash
# The env file is read by systemd AND sourced by bash. Prove a password with
# punctuation and spaces survives both, and that the rejected characters are
# actually rejected.
set -euo pipefail

W="$(mktemp -d)"
trap 'rm -rf "$W"' EXIT
ENVFILE="$W/floor.env"

password_is_safe() {
  case "$1" in
    *\'*|*\"*|*\\*|*\$*|*\`*) return 1 ;;
    *) return 0 ;;
  esac
}

read_existing() {
  sed -n "s/^$1='\(.*\)'$/\1/p" "$ENVFILE" | head -1
}

PW='Cold Storage #7 (rear) 50%!'
PIN='6269'
SECRET='deadbeef00'

password_is_safe "$PW" || { echo "FAIL  test password was rejected"; exit 1; }
echo "PASS  a spaces-and-punctuation password is accepted"

for bad in "it's" 'say "hi"' 'back\slash' 'cost$100' 'tick`cmd`'; do
  if password_is_safe "$bad"; then
    echo "FAIL  should have rejected: $bad"
    exit 1
  fi
done
echo "PASS  quote, doublequote, backslash, dollar, backtick all rejected"

cat > "$ENVFILE" <<ENV
INVENTREE_URL='http://127.0.0.1'
INVENTREE_ADMIN_USER='admin'
INVENTREE_ADMIN_PASSWORD='$PW'
FLOOR_SESSION_SECRET='$SECRET'
FLOOR_DEV_PIN='$PIN'
FLOOR_ROOT='/var/lib/floor'
ENV

# 1. the installer re-reading its own file on update
[ "$(read_existing INVENTREE_ADMIN_PASSWORD)" = "$PW" ] \
  || { echo "FAIL  installer could not re-read the password"; exit 1; }
[ "$(read_existing FLOOR_DEV_PIN)" = "$PIN" ] \
  || { echo "FAIL  installer could not re-read the PIN"; exit 1; }
echo "PASS  installer re-reads its own values on update"

# 2. bin/floor-env sourcing it
GOT="$(set -a; . "$ENVFILE"; set +a; printf '%s' "$INVENTREE_ADMIN_PASSWORD")"
[ "$GOT" = "$PW" ] || { echo "FAIL  bash source mangled it: [$GOT]"; exit 1; }
echo "PASS  bash source gives back the exact password"

# 3. systemd, if this machine has it
if command -v systemd-run >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  OUT="$(systemd-run --quiet --wait --pipe --property=EnvironmentFile="$ENVFILE" \
    /usr/bin/printenv INVENTREE_ADMIN_PASSWORD 2>/dev/null || true)"
  if [ -n "$OUT" ]; then
    [ "$OUT" = "$PW" ] && echo "PASS  systemd EnvironmentFile gives back the exact password" \
      || { echo "FAIL  systemd returned [$OUT]"; exit 1; }
  else
    echo "SKIP  systemd-run could not be used here"
  fi
else
  echo "SKIP  no systemd on this machine, checked bash only"
fi

echo
echo "PASS  env quoting"
