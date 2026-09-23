#!/bin/bash
set -euo pipefail
[[ $EUID == 0 ]] || exit 1
[[ $(id -nG store) == store ]]
[[ $(passwd -S store | awk '{print $2}') == NP ]]
[[ $(passwd -S prime | awk '{print $2}') == P ]]
id -nG prime | tr ' ' '\n' | grep -qx sudo
systemctl is-active --quiet gdm3
runuser -u prime -- test -x /usr/bin/floor-pos
runuser -u store -- test -x /usr/bin/floor-pos
for bin in /usr/bin/gnome-terminal /usr/bin/nautilus /usr/bin/gnome-control-center; do
  [[ ! -e $bin ]] || ! runuser -u store -- test -x "$bin"
done
runuser -u store -- env DCONF_PROFILE=floor-store /usr/bin/python3 - <<'PY'
from gi.repository import Gio, GLib
from pathlib import Path
settings=None
count=0
for line in Path('/etc/dconf/db/floor-store.d/00-lockdown').read_text().splitlines():
    if line.startswith('['):
        settings=Gio.Settings.new(line[1:-1].replace('/','.'))
    elif '=' in line:
        key,value=line.split('=',1)
        expected=GLib.Variant.parse(settings.get_value(key).get_type(),value,None,None)
        assert settings.get_value(key).equal(expected), key
        assert not settings.is_writable(key), key
        count+=1
print(f'PASS: {count} employee dconf values enforced and locked')
PY
runuser -u prime -- env -u DCONF_PROFILE gsettings writable org.gnome.desktop.lockdown disable-command-line | grep -qx true
for action in org.freedesktop.login1.power-off org.freedesktop.login1.reboot org.freedesktop.login1.suspend org.freedesktop.login1.hibernate org.freedesktop.login1.set-user-linger org.freedesktop.systemd1.manage-units org.freedesktop.policykit.exec; do
  set +e
  runuser -u store -- sh -c 'exec pkcheck --action-id "$1" --process "$$"' sh "$action" >/dev/null 2>&1
  result=$?
  set -e
  [[ $result == 1 ]] || { echo "Unexpected policy result $result for $action" >&2; exit 1; }
done
sha256sum /usr/bin/floor-pos
printf 'PASS: store is standard/passwordless; prime password and sudo retained; GDM active; Floor executable by both accounts.\n'
