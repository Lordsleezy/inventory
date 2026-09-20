#!/bin/bash
# Build a .deb with dpkg-deb after `npm run tauri:build -w @floor/pos` on amd64/Linux.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="${ROOT}/packaging/deb-stage"
VER="${1:-0.1.0}"
rm -rf "${STAGE}"
install -d "${STAGE}/DEBIAN" \
  "${STAGE}/usr/bin" \
  "${STAGE}/usr/share/applications" \
  "${STAGE}/lib/systemd/user" \
  "${STAGE}/usr/share/floor-pos" \
  "${STAGE}/etc/floor-pos"

BIN="$(ls -1 "${ROOT}/src-tauri/target/release/floor-pos" "${ROOT}/src-tauri/target/release/floor-pos.exe" 2>/dev/null | head -n1 || true)"
if [[ -z "${BIN}" ]]; then
  echo "Build the Tauri binary first: npm run tauri:build -w @floor/pos" >&2
  exit 1
fi
install -m 0755 "${BIN}" "${STAGE}/usr/bin/floor-pos"
install -m 0755 "${ROOT}/packaging/install-kiosk.sh" "${STAGE}/usr/share/floor-pos/install-kiosk.sh"

cat >"${STAGE}/usr/bin/floor-pos-kiosk" <<'EOF'
#!/bin/bash
set -euo pipefail
if [[ -f /etc/floor-pos/webkit.env ]]; then
  # shellcheck disable=SC1091
  set -a
  source /etc/floor-pos/webkit.env
  set +a
fi
exec /usr/bin/floor-pos "$@"
EOF
chmod 0755 "${STAGE}/usr/bin/floor-pos-kiosk"

cat >"${STAGE}/etc/floor-pos/webkit.env" <<'EOF'
# Uncomment if WebKitGTK flickers on nouveau:
# WEBKIT_DISABLE_DMABUF_RENDERER=1
# WEBKIT_DISABLE_COMPOSITING_MODE=1
EOF

cat >"${STAGE}/usr/share/applications/floor-pos.desktop" <<'EOF'
[Desktop Entry]
Name=Floor Register
Exec=/usr/bin/floor-pos-kiosk
Type=Application
X-GNOME-Autostart-enabled=false
EOF

cat >"${STAGE}/lib/systemd/user/floor-pos.service" <<'EOF'
[Unit]
Description=Floor POS (restart if it dies)
After=graphical-session.target

[Service]
ExecStart=/usr/bin/floor-pos-kiosk
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
EOF

cat >"${STAGE}/DEBIAN/control" <<EOF
Package: floor-pos
Version: ${VER}
Section: utils
Priority: optional
Architecture: amd64
Depends: cage, greetd
Maintainer: Floor <pos@localhost>
Description: Floor Linux register kiosk
 Register POS for Open Box Industries / Floor.
EOF

cat >"${STAGE}/DEBIAN/postinst" <<'EOF'
#!/bin/bash
set -e
chmod 0755 /usr/bin/floor-pos /usr/bin/floor-pos-kiosk || true
if [[ ! -f /etc/floor-pos/webkit.env ]]; then
  install -d /etc/floor-pos
  cat >/etc/floor-pos/webkit.env <<'ENV'
# Uncomment if WebKitGTK flickers on nouveau:
# WEBKIT_DISABLE_DMABUF_RENDERER=1
# WEBKIT_DISABLE_COMPOSITING_MODE=1
ENV
fi
echo "Install kiosk OS bits with: sudo /usr/share/floor-pos/install-kiosk.sh"
EOF
chmod 0755 "${STAGE}/DEBIAN/postinst"

dpkg-deb --build "${STAGE}" "${ROOT}/packaging/floor-pos_${VER}_amd64.deb"
echo "Wrote ${ROOT}/packaging/floor-pos_${VER}_amd64.deb"
