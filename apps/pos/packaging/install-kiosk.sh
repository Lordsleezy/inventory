#!/bin/bash
# Ubuntu kiosk: greetd autologin -> Cage -> Floor POS.
# Run as root after installing the floor-pos .deb (or placing /usr/bin/floor-pos).
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "run as root" >&2
  exit 1
fi

id -u floor-admin >/dev/null 2>&1 || adduser --disabled-password --gecos "Floor admin" floor-admin
id -u floor-kiosk >/dev/null 2>&1 || adduser --disabled-password --gecos "Floor kiosk" floor-kiosk
usermod -aG video,render,lp floor-kiosk || true
passwd -l floor-kiosk || true

apt-get update
apt-get install -y greetd cage unattended-upgrades cups printer-driver-all

install -d /etc/floor-pos
if [[ ! -f /etc/floor-pos/webkit.env ]]; then
  cat >/etc/floor-pos/webkit.env <<'EOF'
# Uncomment if WebKitGTK flickers on nouveau:
# WEBKIT_DISABLE_DMABUF_RENDERER=1
# WEBKIT_DISABLE_COMPOSITING_MODE=1
EOF
fi

# Same wrapper the desktop .desktop entry uses. Prefer the packaged file when
# present (repo or /usr/share/floor-pos); otherwise write the known script.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [[ -f "${SCRIPT_DIR}/floor-pos-kiosk" ]]; then
  install -m 0755 "${SCRIPT_DIR}/floor-pos-kiosk" /usr/bin/floor-pos-kiosk
else
  cat >/usr/bin/floor-pos-kiosk <<'EOF'
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
  chmod 0755 /usr/bin/floor-pos-kiosk
fi

install -d /etc/greetd
cat >/etc/greetd/config.toml <<'EOF'
[terminal]
vt = 1

[default_session]
command = "cage -s -- /usr/bin/floor-pos-kiosk"
user = "floor-kiosk"
EOF

cat >/etc/sudoers.d/floor-kiosk <<'EOF'
floor-kiosk ALL=(root) NOPASSWD: /usr/bin/systemctl poweroff, /usr/bin/systemctl reboot
EOF
chmod 440 /etc/sudoers.d/floor-kiosk

# greetd owns tty1.
systemctl disable getty@tty1.service || true
systemctl enable greetd.service
systemctl enable unattended-upgrades.service

# Admin TTY on tty2 without a GNOME session.
install -d /etc/systemd/system/getty@tty2.service.d
cat >/etc/systemd/system/getty@tty2.service.d/override.conf <<'EOF'
[Service]
ExecStart=
ExecStart=-/sbin/agetty --noclear %I $TERM
EOF
systemctl enable getty@tty2.service

echo "Kiosk users: floor-kiosk (autologin Cage), floor-admin (Ctrl+Alt+F2)."
echo "Optional WebKit env: /etc/floor-pos/webkit.env"
echo "Set a password for floor-admin, then reboot."
