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
  "${STAGE}/usr/share/floor-pos"

BIN="$(ls -1 "${ROOT}/src-tauri/target/release/floor-pos" "${ROOT}/src-tauri/target/release/floor-pos.exe" 2>/dev/null | head -n1 || true)"
if [[ -z "${BIN}" ]]; then
  echo "Build the Tauri binary first: npm run tauri:build -w @floor/pos" >&2
  exit 1
fi
install -m 0755 "${BIN}" "${STAGE}/usr/bin/floor-pos"
install -m 0755 "${ROOT}/packaging/install-kiosk.sh" "${STAGE}/usr/share/floor-pos/install-kiosk.sh"

cat >"${STAGE}/usr/share/applications/floor-pos.desktop" <<'EOF'
[Desktop Entry]
Name=Floor Register
Exec=/usr/bin/floor-pos
Type=Application
X-GNOME-Autostart-enabled=false
EOF

cat >"${STAGE}/lib/systemd/user/floor-pos.service" <<'EOF'
[Unit]
Description=Floor POS (restart if it dies)
After=graphical-session.target

[Service]
ExecStart=/usr/bin/floor-pos
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
 Register-only POS for the Penryn Floor store.
EOF

cat >"${STAGE}/DEBIAN/postinst" <<'EOF'
#!/bin/bash
set -e
chmod 0755 /usr/bin/floor-pos || true
echo "Install kiosk OS bits with: sudo /usr/share/floor-pos/install-kiosk.sh"
EOF
chmod 0755 "${STAGE}/DEBIAN/postinst"

dpkg-deb --build "${STAGE}" "${ROOT}/packaging/floor-pos_${VER}_amd64.deb"
echo "Wrote ${ROOT}/packaging/floor-pos_${VER}_amd64.deb"
