#!/bin/bash
# Normal GDM employee session. Never invokes the old greetd/Cage setup.
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
PACK=$(cd "$(dirname "$0")" && pwd)
SRC="$PACK/store-session"
[[ $(gnome-shell --version) == 'GNOME Shell 50.'* ]] || { echo 'This session is validated for GNOME 50.' >&2; exit 1; }
if ! getent passwd store >/dev/null; then
  useradd --create-home --user-group --shell /bin/bash --comment 'Store' store
  # Passwordless GDM login, accepted by the installed pam_unix nullok rule.
  passwd -d store
fi
[[ $(id -nG store) == store ]] || { echo 'store must have no supplementary groups.' >&2; exit 1; }
install -d /etc/dconf/profile /etc/dconf/db/floor-store.d/locks
printf 'user-db:user\nsystem-db:floor-store\n' >/etc/dconf/profile/floor-store
install -m644 "$SRC/00-lockdown" /etc/dconf/db/floor-store.d/00-lockdown
python3 - <<'PY'
from pathlib import Path
section=''
locks=[]
for line in Path('/etc/dconf/db/floor-store.d/00-lockdown').read_text().splitlines():
    if line.startswith('['): section=line[1:-1]
    elif '=' in line: locks.append('/'+section+'/'+line.split('=',1)[0])
Path('/etc/dconf/db/floor-store.d/locks/00-lockdown').write_text('\n'.join(locks)+'\n')
PY
dconf update
install -d /usr/share/gnome-shell/extensions/floor-store@floor.local
install -m644 "$SRC/metadata.json" "$SRC/extension.js" /usr/share/gnome-shell/extensions/floor-store@floor.local/
install -m644 "$SRC/floor-store.json" /usr/share/gnome-shell/modes/floor-store.json
install -m644 "$SRC/00-floor-store.rules" /etc/polkit-1/rules.d/00-floor-store.rules
install -d /usr/local/libexec /etc/systemd/user/gnome-session@floor-store.target.d
cat >/etc/systemd/user/gnome-session@floor-store.target.d/session.conf <<'CONF'
[Unit]
Requires=gnome-session-services.target
Requires=org.gnome.Shell@floor-store.service
CONF
cat >/usr/share/gnome-session/sessions/floor-store.session <<'CONF'
[GNOME Session]
Name=Floor Store
CONF
cat >/usr/local/libexec/floor-store-session <<'SCRIPT'
#!/bin/sh
if [ "$(id -un)" != store ]; then exec /usr/bin/gnome-session --session=ubuntu; fi
export DCONF_PROFILE=floor-store
export GNOME_SHELL_SESSION_MODE=floor-store
dbus-update-activation-environment --systemd DCONF_PROFILE GNOME_SHELL_SESSION_MODE
exec /usr/bin/gnome-session --session=floor-store
SCRIPT
chmod 755 /usr/local/libexec/floor-store-session
cat >/usr/share/wayland-sessions/floor-store.desktop <<'CONF'
[Desktop Entry]
Name=Floor Store
Exec=/usr/local/libexec/floor-store-session
TryExec=/usr/local/libexec/floor-store-session
Type=Application
DesktopNames=GNOME
X-GDM-SessionRegisters=true
CONF
install -d /var/lib/AccountsService/users
cat >/var/lib/AccountsService/users/store <<'CONF'
[User]
Session=floor-store
XSession=floor-store
SystemAccount=false
CONF
chmod 600 /var/lib/AccountsService/users/store
# Root-owned configuration prevents replacement of autostart and session launchers.
install -d -o root -g root -m755 /home/store/.config /home/store/.config/autostart
cat >/home/store/.config/autostart/floor-pos.desktop <<'CONF'
[Desktop Entry]
Type=Application
Name=Floor
Exec=/usr/bin/floor-pos-kiosk
OnlyShowIn=GNOME;
X-GNOME-Autostart-enabled=true
CONF
# GNOME and Floor need their own writable settings/data, but no user launchers.
install -d -o store -g store -m700 /home/store/.config/dconf /home/store/.config/com.floor.register
install -d -o root -g root -m755 /home/store/.local /home/store/.local/share /home/store/.local/share/applications /home/store/.local/share/gnome-shell
install -d -o store -g store -m700 /home/store/.local/share/com.floor.register /home/store/.cache
# Account-specific execute denials also stop launching these via browser file dialogs.
for bin in gnome-terminal gnome-terminal-server kgx xterm uxterm x-terminal-emulator gnome-console nautilus gnome-control-center gnome-software snap-store gnome-extensions gnome-extensions-app dconf-editor; do
  target=$(command -v "$bin" || true)
  [[ -z $target ]] || setfacl -m u:store:--- "$(readlink -f "$target")"
done
# Force the employee account into its locked session even if Ubuntu is selected in GDM.
# prime still executes the same Ubuntu session command as before.
if ! grep -q '^Exec=/usr/local/libexec/floor-gdm-session$' /usr/share/wayland-sessions/ubuntu.desktop; then
  install -d /var/backups/floor-store
  cp -n /usr/share/wayland-sessions/ubuntu.desktop /var/backups/floor-store/ubuntu.desktop
  sed -i 's|^Exec=.*|Exec=/usr/local/libexec/floor-gdm-session|' /usr/share/wayland-sessions/ubuntu.desktop
fi
cat >/usr/local/libexec/floor-gdm-session <<'SCRIPT'
#!/bin/sh
if [ "$(id -un)" = store ]; then exec /usr/local/libexec/floor-store-session; fi
exec /usr/bin/gnome-session --session=ubuntu
SCRIPT
chmod 755 /usr/local/libexec/floor-gdm-session
# Prevent replacing root-owned launch controls by renaming their parent directory.
chown root:root /home/store
chmod 755 /home/store
for file in .profile .bashrc .bash_logout; do
  [[ ! -f /home/store/$file ]] || chown root:root "/home/store/$file"
done
for dir in snap .mozilla Downloads Documents Desktop Pictures .config/gtk-3.0 .config/gtk-4.0 .local/state .local/share/keyrings; do
  install -d -o store -g store -m700 "/home/store/$dir"
done
systemctl daemon-reload
bash "$PACK/install-desktop.sh" --system
# Existing prime shortcuts must also start the new system-wide binary.
if [[ -f /home/prime/.local/share/applications/floor-pos.desktop ]]; then
  install -o prime -g prime -m644 /usr/share/applications/floor-pos.desktop /home/prime/.local/share/applications/floor-pos.desktop
fi
for name in floor-pos floor-pos-kiosk; do
  if [[ -e /home/prime/.local/bin/$name ]]; then
    ln -sfn "/usr/bin/$name" "/home/prime/.local/bin/$name"
    chown -h prime:prime "/home/prime/.local/bin/$name"
  fi
done
printf '\nInstalled Floor Store session. Log out, select Store, and choose Floor Store if prompted.\n'
bash "$PACK/verify-store-session.sh"
