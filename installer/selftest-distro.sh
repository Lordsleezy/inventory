#!/usr/bin/env bash
# The Zorin 18 failure was a distro-detection bug, so pin the detection down
# with the real os-release contents of the machines we care about.
set -uo pipefail

PKG_REPO_BASE=https://dl.packager.io/srv/deb/inventree/InvenTree/stable

# Kept identical to installer/install.sh.
resolve_packager_target() {
  PKG_OS=""
  PKG_VER=""
  case "${UBUNTU_CODENAME:-}" in
    focal) PKG_OS=ubuntu; PKG_VER=20.04 ;;
    jammy) PKG_OS=ubuntu; PKG_VER=22.04 ;;
    noble) PKG_OS=ubuntu; PKG_VER=24.04 ;;
  esac
  if [ -z "$PKG_OS" ] && [ "${ID:-}" = "ubuntu" ] && [ -n "${VERSION_ID:-}" ]; then
    PKG_OS=ubuntu
    PKG_VER="$VERSION_ID"
  fi
  if [ -z "$PKG_OS" ]; then
    case "${VERSION_CODENAME:-}" in
      bookworm) PKG_OS=debian; PKG_VER=12 ;;
      bullseye) PKG_OS=debian; PKG_VER=11 ;;
      buster)   PKG_OS=debian; PKG_VER=10 ;;
    esac
  fi
  if [ -z "$PKG_OS" ] && { [ "${ID:-}" = "debian" ] || [ "${ID:-}" = "raspbian" ]; }; then
    PKG_OS=debian
    PKG_VER="${VERSION_ID%%.*}"
  fi
}

FAILED=0

check() {
  local label="$1" want="$2"
  resolve_packager_target
  local got="${PKG_OS:-none} ${PKG_VER:-none}"
  if [ "$got" = "$want" ]; then
    printf 'PASS  %-34s -> %s\n' "$label" "$got"
  else
    printf 'FAIL  %-34s -> %s, wanted %s\n' "$label" "$got" "$want"
    FAILED=1
  fi
}

clear_os() { unset ID VERSION_ID UBUNTU_CODENAME VERSION_CODENAME NAME; }

# The machine that failed. Zorin reports its own NAME and VERSION_ID, which is
# what upstream's installer rejects, but it does carry the Ubuntu base.
clear_os
NAME="Zorin OS"; ID=zorin; VERSION_ID=18
VERSION_CODENAME=noble; UBUNTU_CODENAME=noble
check "Zorin OS 18 (the reported bug)" "ubuntu 24.04"

clear_os
NAME="Zorin OS"; ID=zorin; VERSION_ID=17; VERSION_CODENAME=jammy; UBUNTU_CODENAME=jammy
check "Zorin OS 17" "ubuntu 22.04"

clear_os
NAME="Ubuntu"; ID=ubuntu; VERSION_ID="24.04"; VERSION_CODENAME=noble; UBUNTU_CODENAME=noble
check "Ubuntu 24.04" "ubuntu 24.04"

clear_os
NAME="Ubuntu"; ID=ubuntu; VERSION_ID="22.04"; VERSION_CODENAME=jammy; UBUNTU_CODENAME=jammy
check "Ubuntu 22.04" "ubuntu 22.04"

# A future Ubuntu whose codename this build has never heard of.
clear_os
NAME="Ubuntu"; ID=ubuntu; VERSION_ID="26.04"; VERSION_CODENAME=someday; UBUNTU_CODENAME=someday
check "Ubuntu 26.04, unknown codename" "ubuntu 26.04"

clear_os
NAME="Linux Mint"; ID=linuxmint; VERSION_ID=22; VERSION_CODENAME=wilma; UBUNTU_CODENAME=noble
check "Linux Mint 22" "ubuntu 24.04"

clear_os
NAME="Pop!_OS"; ID=pop; VERSION_ID="22.04"; VERSION_CODENAME=jammy; UBUNTU_CODENAME=jammy
check "Pop!_OS 22.04" "ubuntu 22.04"

clear_os
NAME="Debian GNU/Linux"; ID=debian; VERSION_ID=12; VERSION_CODENAME=bookworm
check "Debian 12" "debian 12"

# Nothing usable: must report none so the installer stops with a real message
# instead of adding a repo that cannot exist.
clear_os
NAME="Fedora Linux"; ID=fedora; VERSION_ID=41
check "Fedora 41 (must refuse)" "none none"

clear_os
NAME="Some Distro"; ID=whatever; VERSION_ID=1
check "unknown distro (must refuse)" "none none"

echo
echo "Confirming the repo really serves what we resolve to:"
for target in "ubuntu 24.04" "ubuntu 22.04"; do
  set -- $target
  CODE="$(curl -s -o /dev/null -m 20 -w '%{http_code}' \
    "$PKG_REPO_BASE/$1/dists/$2/Release" || true)"
  if [ "$CODE" = "200" ]; then
    echo "PASS  $1 $2 Release is served"
  else
    echo "WARN  $1 $2 Release returned $CODE (network, or upstream changed)"
  fi
done

echo
if [ "$FAILED" -eq 0 ]; then
  echo "PASS  distro detection"
else
  echo "FAIL  distro detection"
  exit 1
fi
