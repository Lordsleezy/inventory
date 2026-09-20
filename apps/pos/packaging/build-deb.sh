#!/bin/bash
# Build a .deb with dpkg-deb after `npm run tauri:build -w @floor/pos` on amd64/Linux.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PACK="${ROOT}/packaging"
STAGE="${PACK}/deb-stage"
VER="${1:-0.1.0}"
ICONS="${ROOT}/src-tauri/icons"
rm -rf "${STAGE}"
install -d "${STAGE}/DEBIAN" \
  "${STAGE}/usr/bin" \
  "${STAGE}/usr/share/applications" \
  "${STAGE}/usr/share/floor-pos" \
  "${STAGE}/usr/share/icons/hicolor/32x32/apps" \
  "${STAGE}/usr/share/icons/hicolor/128x128/apps" \
  "${STAGE}/usr/share/icons/hicolor/256x256/apps" \
  "${STAGE}/usr/share/icons/hicolor/512x512/apps" \
  "${STAGE}/lib/systemd/user" \
  "${STAGE}/etc/floor-pos"

BIN="$(ls -1 "${ROOT}/src-tauri/target/release/floor-pos" "${ROOT}/src-tauri/target/release/floor-pos.exe" 2>/dev/null | head -n1 || true)"
if [[ -z "${BIN}" ]]; then
  echo "Build the Tauri binary first: npm run tauri:build -w @floor/pos" >&2
  exit 1
fi
install -m 0755 "${BIN}" "${STAGE}/usr/bin/floor-pos"
install -m 0755 "${PACK}/floor-pos-kiosk" "${STAGE}/usr/bin/floor-pos-kiosk"
install -m 0755 "${PACK}/floor-pos-kiosk" "${STAGE}/usr/share/floor-pos/floor-pos-kiosk"
install -m 0755 "${PACK}/install-kiosk.sh" "${STAGE}/usr/share/floor-pos/install-kiosk.sh"
install -m 0755 "${PACK}/install-desktop.sh" "${STAGE}/usr/share/floor-pos/install-desktop.sh"
install -m 0644 "${PACK}/floor-pos.desktop" "${STAGE}/usr/share/applications/floor-pos.desktop"
install -m 0644 "${PACK}/floor-pos.desktop" "${STAGE}/usr/share/floor-pos/floor-pos.desktop"

install -d "${STAGE}/usr/share/floor-pos/icons"
install -m 0644 "${ICONS}/32x32.png" "${STAGE}/usr/share/icons/hicolor/32x32/apps/floor-pos.png"
install -m 0644 "${ICONS}/128x128.png" "${STAGE}/usr/share/icons/hicolor/128x128/apps/floor-pos.png"
install -m 0644 "${ICONS}/128x128@2x.png" "${STAGE}/usr/share/icons/hicolor/256x256/apps/floor-pos.png"
install -m 0644 "${ICONS}/icon.png" "${STAGE}/usr/share/icons/hicolor/512x512/apps/floor-pos.png"
# Copy for install-desktop.sh when run from /usr/share/floor-pos after the .deb.
install -m 0644 "${ICONS}/32x32.png" "${STAGE}/usr/share/floor-pos/icons/32x32.png"
install -m 0644 "${ICONS}/128x128.png" "${STAGE}/usr/share/floor-pos/icons/128x128.png"
install -m 0644 "${ICONS}/128x128@2x.png" "${STAGE}/usr/share/floor-pos/icons/128x128@2x.png"
install -m 0644 "${ICONS}/icon.png" "${STAGE}/usr/share/floor-pos/icons/icon.png"

cat >"${STAGE}/etc/floor-pos/webkit.env" <<'EOF'
# Uncomment if WebKitGTK flickers on nouveau:
# WEBKIT_DISABLE_DMABUF_RENDERER=1
# WEBKIT_DISABLE_COMPOSITING_MODE=1
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
 Includes a desktop launcher (Floor) for pre-kiosk Ubuntu sessions.
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
gtk-update-icon-cache -f /usr/share/icons/hicolor 2>/dev/null || true
update-desktop-database /usr/share/applications 2>/dev/null || true
echo "Desktop launcher: Floor (app grid). Kiosk OS bits: sudo /usr/share/floor-pos/install-kiosk.sh"
EOF
chmod 0755 "${STAGE}/DEBIAN/postinst"

dpkg-deb --build "${STAGE}" "${PACK}/floor-pos_${VER}_amd64.deb"
echo "Wrote ${PACK}/floor-pos_${VER}_amd64.deb"
