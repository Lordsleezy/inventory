#!/bin/bash
# Ubuntu 24.04 kiosk: greetd autologin -> Cage -> Floor POS.
# Run as root after installing the floor-pos .deb.
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

install -d /etc/greetd
cat >/etc/greetd/config.toml <<'EOF'
[terminal]
vt = 1

[default_session]
command = "cage -s -- /usr/bin/floor-pos"
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
echo "Set a password for floor-admin, then reboot."
