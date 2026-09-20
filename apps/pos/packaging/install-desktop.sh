#!/bin/bash
# Install (or refresh) a desktop launcher for Floor Register.
# Safe to re-run after every tauri:build — updates the binary; leaves greetd/Cage alone.
#
# From a source checkout (usual):
#   bash apps/pos/packaging/install-desktop.sh
#
# System-wide (matches the .deb layout):
#   sudo bash apps/pos/packaging/install-desktop.sh --system
set -euo pipefail

PACK="$(cd "$(dirname "$0")" && pwd)"
# Repo layout: packaging/ sits next to src-tauri/. Deb layout: files under /usr/share/floor-pos/.
if [[ -d "${PACK}/../src-tauri" ]]; then
  ROOT="$(cd "${PACK}/.." && pwd)"
  ICONS="${ROOT}/src-tauri/icons"
  BIN_SRC="${ROOT}/src-tauri/target/release/floor-pos"
  DESKTOP_SRC="${PACK}/floor-pos.desktop"
else
  ROOT=""
  ICONS="${PACK}/icons"
  BIN_SRC="/usr/bin/floor-pos"
  DESKTOP_SRC="${PACK}/floor-pos.desktop"
fi

SYSTEM=0
if [[ "${1:-}" == "--system" ]]; then
  SYSTEM=1
fi

if [[ ! -x "${BIN_SRC}" ]]; then
  echo "No Floor binary at ${BIN_SRC}" >&2
  echo "Build first: npm run tauri:build -w @floor/pos" >&2
  exit 1
fi

if [[ ! -f "${ICONS}/128x128.png" ]]; then
  echo "Floor icons missing under ${ICONS}" >&2
  exit 1
fi

if [[ "${SYSTEM}" -eq 1 ]]; then
  if [[ ${EUID} -ne 0 ]]; then
    echo "run as root for --system (or omit it for a user install)" >&2
    exit 1
  fi
  BIN_DIR=/usr/bin
  APP_DIR=/usr/share/applications
  ICON_ROOT=/usr/share/icons/hicolor
  WRAP_EXEC=/usr/bin/floor-pos-kiosk
  BIN_EXEC=/usr/bin/floor-pos
else
  BIN_DIR="${HOME}/.local/bin"
  APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  ICON_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor"
  WRAP_EXEC="${BIN_DIR}/floor-pos-kiosk"
  BIN_EXEC="${BIN_DIR}/floor-pos"
fi

install -d "${BIN_DIR}" "${APP_DIR}" \
  "${ICON_ROOT}/32x32/apps" \
  "${ICON_ROOT}/128x128/apps" \
  "${ICON_ROOT}/256x256/apps" \
  "${ICON_ROOT}/512x512/apps"

# Refresh binary when installing from a build tree; leave /usr/bin alone if already the source.
if [[ "${BIN_SRC}" != "${BIN_EXEC}" ]]; then
  install -m 0755 "${BIN_SRC}" "${BIN_EXEC}"
fi

cat >"${WRAP_EXEC}" <<EOF
#!/bin/bash
set -euo pipefail
if [[ -f /etc/floor-pos/webkit.env ]]; then
  # shellcheck disable=SC1091
  set -a
  source /etc/floor-pos/webkit.env
  set +a
fi
exec ${BIN_EXEC} "\$@"
EOF
chmod 0755 "${WRAP_EXEC}"

install -m 0644 "${ICONS}/32x32.png" "${ICON_ROOT}/32x32/apps/floor-pos.png"
install -m 0644 "${ICONS}/128x128.png" "${ICON_ROOT}/128x128/apps/floor-pos.png"
install -m 0644 "${ICONS}/128x128@2x.png" "${ICON_ROOT}/256x256/apps/floor-pos.png"
install -m 0644 "${ICONS}/icon.png" "${ICON_ROOT}/512x512/apps/floor-pos.png"

if [[ -f "${DESKTOP_SRC}" ]]; then
  sed \
    -e "s|^Exec=.*|Exec=${WRAP_EXEC}|" \
    -e "s|^TryExec=.*|TryExec=${BIN_EXEC}|" \
    "${DESKTOP_SRC}" >"${APP_DIR}/floor-pos.desktop"
else
  cat >"${APP_DIR}/floor-pos.desktop" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=Floor
GenericName=Register
Comment=Floor store register
Exec=${WRAP_EXEC}
TryExec=${BIN_EXEC}
Icon=floor-pos
Terminal=false
Categories=Office;Finance;
Keywords=floor;pos;register;inventory;retail;
StartupNotify=true
StartupWMClass=floor-pos
X-GNOME-Autostart-enabled=false
EOF
fi
chmod 0644 "${APP_DIR}/floor-pos.desktop"

if [[ "${SYSTEM}" -eq 1 ]]; then
  install -d /etc/floor-pos
  if [[ ! -f /etc/floor-pos/webkit.env ]]; then
    cat >/etc/floor-pos/webkit.env <<'ENV'
# Uncomment if WebKitGTK flickers on nouveau:
# WEBKIT_DISABLE_DMABUF_RENDERER=1
# WEBKIT_DISABLE_COMPOSITING_MODE=1
ENV
  fi
  gtk-update-icon-cache -f "${ICON_ROOT}" 2>/dev/null || true
fi
update-desktop-database "${APP_DIR}" 2>/dev/null || true

echo "Installed Floor desktop launcher → ${APP_DIR}/floor-pos.desktop"
echo "Pin “Floor” from the app grid / dock. Rerun after each build to refresh the binary."
