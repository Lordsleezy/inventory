#!/usr/bin/env bash
# Floor installer. Runs from inside the extracted payload.
# Fresh install and in-place update are the same entry point.
set -euo pipefail

PAYLOAD="${FLOOR_PAYLOAD_DIR:-$(cd "$(dirname "$0")" && pwd)}"
VERSION="$(cat "$PAYLOAD/VERSION" 2>/dev/null || echo unknown)"

PREFIX=/opt/floor          # program files, replaced wholesale on update
STATE=/var/lib/floor       # config + inventory data, never touched by an update
SECRETS=/etc/floor         # password, PIN, session secret
INVENTREE_DATA=/opt/inventree/data

MODE=install
for arg in "$@"; do
  case "$arg" in
    --update) MODE=update ;;
    --reconfigure) MODE=reconfigure ;;
    *) ;;
  esac
done

step() { printf '\n=== %s\n' "$*"; }
pass() { printf 'PASS  %s\n' "$*"; }
warn() { printf 'WARN  %s\n' "$*"; }

die() {
  printf '\nFAIL  %s\n' "$1" >&2
  shift || true
  for line in "$@"; do printf '      %s\n' "$line" >&2; done
  exit 1
}

if [ "$(id -u)" -ne 0 ]; then
  die "run this with sudo" "sudo ./floor-${VERSION}-linux-x64.run"
fi

# The desktop user, not root. Floor runs as them so photos and data stay theirs.
TARGET_USER="${SUDO_USER:-}"
if [ -z "$TARGET_USER" ] || [ "$TARGET_USER" = "root" ]; then
  TARGET_USER="$(logname 2>/dev/null || true)"
fi
if [ -z "$TARGET_USER" ] || [ "$TARGET_USER" = "root" ]; then
  die "cannot tell which user Floor should run as" \
      "Run the installer with sudo from your normal desktop login," \
      "not from a root shell."
fi
TARGET_GROUP="$(id -gn "$TARGET_USER")"
TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"

EXISTING=""
[ -f "$PREFIX/VERSION" ] && EXISTING="$(cat "$PREFIX/VERSION")"

if [ "$MODE" = update ] && [ -z "$EXISTING" ]; then
  die "--update was given but Floor is not installed yet" \
      "Run it without --update to do a first install."
fi
if [ -n "$EXISTING" ] && [ "$MODE" = install ]; then
  MODE=update
fi

echo "Floor $VERSION  (linux-x64)"
case "$MODE" in
  update)      echo "Updating existing install $EXISTING. Inventory, config, and photos are kept." ;;
  reconfigure) echo "Reconfiguring $EXISTING. Inventory and photos are kept, secrets are re-asked." ;;
  *)           echo "Fresh install. Runs as user: $TARGET_USER" ;;
esac
echo "Program files: $PREFIX   Your data: $STATE"

# ---------------------------------------------------------------- prerequisites
step "System check"

if [ ! -r /etc/os-release ]; then
  die "cannot read /etc/os-release, this does not look like Zorin or Ubuntu"
fi
# shellcheck disable=SC1091
. /etc/os-release
CODENAME="${UBUNTU_CODENAME:-${VERSION_CODENAME:-unknown}}"
pass "${NAME:-Linux} ${VERSION_ID:-} (ubuntu base: $CODENAME)"
case "$CODENAME" in
  jammy|noble) ;;
  *) warn "InvenTree's installer officially supports jammy and noble. $CODENAME may not work." ;;
esac

if ! command -v systemctl >/dev/null 2>&1; then
  die "no systemd on this machine" "Floor needs systemd to start on boot."
fi

MISSING=""
for tool in curl tar; do
  command -v "$tool" >/dev/null 2>&1 || MISSING="$MISSING $tool"
done
if [ -n "$MISSING" ]; then
  echo "Installing:$MISSING"
  apt-get update -qq
  # shellcheck disable=SC2086
  apt-get install -y -qq $MISSING ca-certificates
fi
pass "curl and tar present"

# ---------------------------------------------------------------- program files
step "Installing program files"

# Node and Electron ship inside this installer. We never touch the system Node.
install -d -m 0755 "$PREFIX"
for dir in app runtime desktop infra packages bin; do
  rm -rf "${PREFIX:?}/$dir"
done
cp -a "$PAYLOAD/app"      "$PREFIX/app"
cp -a "$PAYLOAD/runtime"  "$PREFIX/runtime"
cp -a "$PAYLOAD/desktop"  "$PREFIX/desktop"
cp -a "$PAYLOAD/infra"    "$PREFIX/infra"
cp -a "$PAYLOAD/packages" "$PREFIX/packages"
install -d -m 0755 "$PREFIX/bin"
cp "$PAYLOAD/VERSION" "$PREFIX/VERSION"

NODE="$PREFIX/runtime/node/bin/node"
chmod +x "$NODE"
if ! "$NODE" --version >/dev/null 2>&1; then
  die "the bundled Node runtime will not run on this machine" \
      "Wrong architecture, or the download was truncated."
fi
pass "bundled Node $("$NODE" --version)"

# Electron's sandbox helper has to be setuid root or the desktop shell will not start.
if [ -f "$PREFIX/runtime/electron/chrome-sandbox" ]; then
  chown root:root "$PREFIX/runtime/electron/chrome-sandbox"
  chmod 4755 "$PREFIX/runtime/electron/chrome-sandbox"
  chmod +x "$PREFIX/runtime/electron/electron"
  pass "bundled Electron"
else
  warn "no Electron in this payload, the browser UI still works at http://127.0.0.1:3000"
fi

# ---------------------------------------------------------------- state
step "Preparing data directories"

install -d -m 0755 -o "$TARGET_USER" -g "$TARGET_GROUP" "$STATE" "$STATE/config" "$STATE/data" "$STATE/photos"
install -d -m 0755 "$SECRETS"

# The example is what the app falls back to, so it must be next to the real config.
install -m 0644 -o "$TARGET_USER" -g "$TARGET_GROUP" \
  "$PAYLOAD/config/floor.example.json" "$STATE/config/floor.example.json"

if [ -f "$STATE/config/floor.json" ]; then
  pass "kept your existing $STATE/config/floor.json"
else
  install -m 0644 -o "$TARGET_USER" -g "$TARGET_GROUP" \
    "$PAYLOAD/config/floor.example.json" "$STATE/config/floor.json"
  pass "created $STATE/config/floor.json from the template"
fi
pass "inventory data stays in $STATE/data"

# ---------------------------------------------------------------- secrets
ENVFILE="$SECRETS/floor.env"

# Values are single-quoted in the env file so that both systemd and `.` in bash
# read them literally. Rejecting these five characters means we never have to
# escape anything, which is the part that silently breaks logins later.
password_is_safe() {
  case "$1" in
    *\'*|*\"*|*\\*|*\$*|*\`*) return 1 ;;
    *) return 0 ;;
  esac
}

read_existing() {
  # Strips the surrounding single quotes we wrote.
  sed -n "s/^$1='\(.*\)'$/\1/p" "$ENVFILE" | head -1
}

ask_password() {
  local pw1 pw2
  while true; do
    printf '\nInvenTree admin password (12+ characters): '
    read -rs pw1; echo
    if [ "${#pw1}" -lt 12 ]; then
      echo "Too short. 12 characters or more."
      continue
    fi
    if ! password_is_safe "$pw1"; then
      echo "Cannot contain any of these:  ' \" \\ \$ \`"
      echo "Letters, digits, spaces, and other punctuation are fine."
      continue
    fi
    printf 'Type it again: '
    read -rs pw2; echo
    if [ "$pw1" != "$pw2" ]; then
      echo "Those did not match."
      continue
    fi
    break
  done
  ADMIN_PASSWORD="$pw1"
}

ask_pin() {
  local pin1 pin2
  while true; do
    printf '\nFloor unlock PIN (4-8 digits): '
    read -rs pin1; echo
    if ! printf '%s' "$pin1" | grep -Eq '^[0-9]{4,8}$'; then
      echo "Digits only, 4 to 8 of them."
      continue
    fi
    if [ "$pin1" = "${ADMIN_PASSWORD:-}" ]; then
      echo "The PIN must not be the admin password."
      continue
    fi
    printf 'Type it again: '
    read -rs pin2; echo
    if [ "$pin1" != "$pin2" ]; then
      echo "Those did not match."
      continue
    fi
    break
  done
  FLOOR_PIN="$pin1"
}

if [ -f "$ENVFILE" ]; then
  ADMIN_PASSWORD="$(read_existing INVENTREE_ADMIN_PASSWORD)"
  FLOOR_PIN="$(read_existing FLOOR_DEV_PIN)"
  SESSION_SECRET="$(read_existing FLOOR_SESSION_SECRET)"
fi
: "${ADMIN_PASSWORD:=}" "${FLOOR_PIN:=}" "${SESSION_SECRET:=}"

if [ -z "$SESSION_SECRET" ]; then
  SESSION_SECRET="$("$NODE" -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
fi

if [ -z "$ADMIN_PASSWORD" ]; then
  step "Choose your two secrets"
  cat <<'EXPLAIN'
Two different things. Do not reuse one for the other.

  1. InvenTree admin password - the database behind Floor. Long. You will
     almost never type it again.
  2. Floor unlock PIN - 4 to 8 digits. This is what staff tap to sign in.

Nothing is echoed as you type.
EXPLAIN
  ask_password
  ask_pin
  pass "secrets captured"
elif [ "$MODE" = reconfigure ]; then
  step "New unlock PIN"
  # Deliberately not re-asking for the admin password: changing it here would
  # not change it inside InvenTree, and every login would start failing.
  echo "Keeping the existing InvenTree admin password. To change that one:"
  echo "  sudo inventree run manage.py changepassword admin"
  echo "  then re-run this installer with --reconfigure and it will still match."
  ask_pin
  pass "PIN replaced"
else
  pass "reusing the password and PIN already on this machine"
fi

if [ -z "$FLOOR_PIN" ]; then
  ask_pin
fi

# ---------------------------------------------------------------- InvenTree
step "InvenTree (system of record)"

install_inventree() {
  cat <<'NOTE'
InvenTree is a Python/Django application. It is NOT bundled in this installer -
it is downloaded and built now, which needs internet and takes several minutes.
Everything else Floor needs is already on this machine.
NOTE

  export INVENTREE_ADMIN_USER=admin
  export INVENTREE_ADMIN_PASSWORD="$ADMIN_PASSWORD"
  export INVENTREE_ADMIN_EMAIL=admin@localhost
  export INVENTREE_DB_ENGINE=sqlite3
  export INVENTREE_DB_NAME="$INVENTREE_DATA/inventree.sqlite3"
  export SETUP_NO_CALLS=true

  curl -fsSL -o /tmp/inventree-install.sh https://get.inventree.org \
    || die "could not download the InvenTree installer" \
           "Check the network and run this installer again. Nothing is half-installed."

  if ! bash /tmp/inventree-install.sh; then
    die "the InvenTree installer failed" \
        "Read the last 50 lines above. Do not install Docker as a workaround." \
        "Re-running this installer is safe."
  fi
}

if command -v inventree >/dev/null 2>&1; then
  pass "InvenTree already installed, leaving it alone"
else
  install_inventree
fi

# Force SQLite and keep the process small. Idempotent.
inventree config:set INVENTREE_DB_ENGINE=sqlite3 >/dev/null 2>&1 || true
inventree config:set INVENTREE_DB_NAME="$INVENTREE_DATA/inventree.sqlite3" >/dev/null 2>&1 || true
inventree config:set INVENTREE_DB_WAL_MODE=True >/dev/null 2>&1 || true
inventree config:set INVENTREE_DB_TIMEOUT=30 >/dev/null 2>&1 || true
inventree config:set INVENTREE_PLUGINS_ENABLED=False >/dev/null 2>&1 || true
inventree config:set INVENTREE_GUNICORN_WORKERS=1 >/dev/null 2>&1 || true
inventree scale worker=1 >/dev/null 2>&1 || true
inventree restart >/dev/null 2>&1 || true

step "Proving the database is SQLite, not Postgres"

DBCONF="$(inventree config 2>/dev/null | grep -i 'db' || true)"

if printf '%s' "$DBCONF" | grep -Eiq 'postgres|mysql|mariadb'; then
  die "InvenTree was provisioned on a server database, not SQLite" \
      "Found: $(printf '%s' "$DBCONF" | tr '\n' ' ')" \
      "Floor is a single-machine store and requires SQLite." \
      "Fix it with:" \
      "  sudo inventree config:set INVENTREE_DB_ENGINE=sqlite3" \
      "  sudo inventree config:set INVENTREE_DB_NAME=$INVENTREE_DATA/inventree.sqlite3" \
      "  sudo inventree run invoke update && sudo inventree restart" \
      "then run this installer again."
fi

if systemctl is-active --quiet postgresql 2>/dev/null; then
  warn "a postgresql service is running. InvenTree is not using it, but nothing here needs it."
fi

if [ ! -s "$INVENTREE_DATA/inventree.sqlite3" ]; then
  die "no SQLite database at $INVENTREE_DATA/inventree.sqlite3" \
      "Migrations did not run. Try:" \
      "  sudo inventree run invoke update && sudo inventree restart" \
      "then run this installer again."
fi
pass "SQLite at $INVENTREE_DATA/inventree.sqlite3 ($(du -h "$INVENTREE_DATA/inventree.sqlite3" | cut -f1))"

# ---------------------------------------------------------------- API URL
step "Finding the InvenTree API"

detect_url() {
  local url
  for url in http://127.0.0.1 http://127.0.0.1:8000 http://127.0.0.1:6000 http://localhost; do
    if curl -fsS --max-time 5 "$url/api/" 2>/dev/null | grep -q 'server-version'; then
      printf '%s' "$url"
      return 0
    fi
  done
  return 1
}

API_URL=""
for attempt in 1 2 3 4 5 6; do
  if API_URL="$(detect_url)"; then break; fi
  echo "      waiting for InvenTree to answer (attempt $attempt of 6)"
  sleep 5
done

if [ -z "$API_URL" ]; then
  die "no InvenTree API on localhost" \
      "It is installed but not answering. Check:" \
      "  sudo inventree logs --tail" \
      "  sudo inventree restart" \
      "then run this installer again."
fi
pass "API at $API_URL"

# ---------------------------------------------------------------- write config
step "Writing configuration"

umask 077
cat > "$ENVFILE" <<ENV
# Floor secrets. Not in git. Not in any backup you hand to someone else.
# Single-quoted so systemd and bash both read the values literally.
INVENTREE_URL='$API_URL'
INVENTREE_ADMIN_USER='admin'
INVENTREE_ADMIN_PASSWORD='$ADMIN_PASSWORD'
FLOOR_SESSION_SECRET='$SESSION_SECRET'
FLOOR_DEV_PIN='$FLOOR_PIN'
FLOOR_ROOT='$STATE'
ENV
umask 022
chown root:"$TARGET_GROUP" "$ENVFILE"
chmod 0640 "$ENVFILE"
pass "$ENVFILE (0640 root:$TARGET_GROUP)"

# ---------------------------------------------------------------- launchers
step "Installing commands"

write_bin() {
  local name="$1"
  cat > "$PREFIX/bin/$name"
  chmod 0755 "$PREFIX/bin/$name"
}

write_bin floor-env <<EOF
#!/usr/bin/env bash
# Load Floor's environment into the current shell's child process.
set -a
# shellcheck disable=SC1091
. $ENVFILE
set +a
exec "\$@"
EOF

write_bin floor-probe <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd $PREFIX
exec $PREFIX/bin/floor-env $NODE --experimental-strip-types infra/inventree/probe.mjs
EOF

write_bin floor-bootstrap <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd $PREFIX
exec $PREFIX/bin/floor-env $NODE --experimental-strip-types infra/inventree/bootstrap.mjs
EOF

write_bin floor-desktop <<EOF
#!/usr/bin/env bash
# Wait for the adapter, then open the Floor shell.
set -euo pipefail
for i in \$(seq 1 60); do
  if curl -fsS --max-time 2 http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if [ -x $PREFIX/runtime/electron/electron ]; then
  exec $PREFIX/runtime/electron/electron $PREFIX/desktop "\$@"
fi
exec xdg-open http://127.0.0.1:3000
EOF

write_bin floor-backup <<EOF
#!/usr/bin/env bash
# Cold copy of everything that matters. Run as root.
set -euo pipefail
DEST="\${1:-\$HOME/floor-backup-\$(date +%F-%H%M)}"
mkdir -p "\$DEST"
systemctl stop floor-adapter || true
inventree stop || true
cp -a $INVENTREE_DATA "\$DEST/inventree-data"
cp -a $STATE "\$DEST/floor-state"
cp -a $ENVFILE "\$DEST/floor.env"
inventree start || true
systemctl start floor-adapter || true
echo "PASS  backup at \$DEST"
EOF

for cmd in floor-probe floor-bootstrap floor-desktop floor-backup; do
  ln -sf "$PREFIX/bin/$cmd" "/usr/local/bin/$cmd"
done
pass "floor-probe, floor-bootstrap, floor-desktop, floor-backup"

# ---------------------------------------------------------------- prove it
step "Probing InvenTree"

if ! "$PREFIX/bin/floor-probe"; then
  die "the probe failed" \
      "Floor is installed but InvenTree is not answering the way it must." \
      "The output above names the failing check. A 404 on /api/user/me/token/" \
      "is a hard failure - do not guess another path." \
      "Fix, then re-run: sudo floor-probe"
fi

step "Bootstrapping"

if ! "$PREFIX/bin/floor-bootstrap"; then
  die "bootstrap failed" \
      "The output above names the failing check." \
      "Re-running is safe: sudo floor-bootstrap"
fi

chown -R "$TARGET_USER":"$TARGET_GROUP" "$STATE"

# ---------------------------------------------------------------- services
step "Starting Floor on boot"

sed -e "s/@USER@/$TARGET_USER/g" -e "s/@GROUP@/$TARGET_GROUP/g" \
  "$PAYLOAD/assets/floor-adapter.service" > /etc/systemd/system/floor-adapter.service
chmod 0644 /etc/systemd/system/floor-adapter.service

install -m 0644 "$PAYLOAD/assets/floor.desktop" /usr/share/applications/floor.desktop
install -d -m 0755 /etc/xdg/autostart
install -m 0644 "$PAYLOAD/assets/floor.desktop" /etc/xdg/autostart/floor.desktop

systemctl daemon-reload
systemctl enable floor-adapter >/dev/null 2>&1
systemctl restart floor-adapter

READY=""
for i in $(seq 1 45); do
  if curl -fsS --max-time 2 http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    READY=yes
    break
  fi
  sleep 1
done

if [ -z "$READY" ]; then
  die "the adapter did not come up on http://127.0.0.1:3000" \
      "See what it said:" \
      "  journalctl -u floor-adapter -n 50 --no-pager" \
      "Then: sudo systemctl restart floor-adapter"
fi
pass "adapter answering on http://127.0.0.1:3000"
pass "enabled at boot (floor-adapter.service)"

# ---------------------------------------------------------------- done
cat <<DONE

=====================================================================
PASS  Floor $VERSION is installed and running.

  Open it          the Floor icon in your applications menu,
                   or http://127.0.0.1:3000 in Firefox
  Sign in          Admin, then the PIN you just chose
  Starts on boot   yes, no terminal needed

  Your data        $STATE          (inventory, config, photos)
  Database         $INVENTREE_DATA/inventree.sqlite3
  Secrets          $ENVFILE

  Backup           sudo floor-backup
  Check health     sudo floor-probe
  Logs             journalctl -u floor-adapter -f

Floor is starting now. Log out and back in once so the menu icon and
autostart pick up.
=====================================================================
DONE
