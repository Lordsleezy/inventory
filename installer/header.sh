#!/bin/sh
# Floor self-extracting installer.
# Everything below the __FLOOR_PAYLOAD__ line is a gzipped tar of the install tree.
set -eu

VERSION="@@VERSION@@"

usage() {
  cat <<USAGE
Floor $VERSION installer (Linux x64)

  sudo bash floor-$VERSION-linux-x64.run              install, or update an existing install
  sudo bash floor-$VERSION-linux-x64.run --update     update only, refuse a fresh install
  sudo bash floor-$VERSION-linux-x64.run --reconfigure
                                                      keep data, choose a new unlock PIN
  bash floor-$VERSION-linux-x64.run --version
  bash floor-$VERSION-linux-x64.run --extract DIR     unpack without installing

Use "sudo bash", not "sudo ./file". Browsers save downloads without the
execute bit and bash does not need it.

Your inventory, config, and photos live outside the program directory and are
never touched by an update.
USAGE
}

case "${1:-}" in
  --version) echo "Floor $VERSION (linux-x64)"; exit 0 ;;
  --help|-h) usage; exit 0 ;;
esac

# Byte offset of the payload: the line after the marker.
SKIP=$(awk '/^__FLOOR_PAYLOAD__$/ { print NR + 1; exit 0; }' "$0")
if [ -z "${SKIP:-}" ]; then
  echo "FAIL  this installer is corrupt (no payload marker)." >&2
  echo "      Download it again, and do not open it in a text editor." >&2
  exit 1
fi

# Unpacking for inspection is allowed anywhere. Installing is not.
if [ "${1:-}" = "--extract" ]; then
  DEST="${2:?--extract needs a directory}"
  mkdir -p "$DEST"
  tail -n +"$SKIP" "$0" | tar xz -C "$DEST"
  echo "PASS  extracted to $DEST"
  exit 0
fi

ARCH="$(uname -m)"
if [ "$ARCH" != "x86_64" ]; then
  echo "FAIL  this build is linux-x64 only. This machine is $ARCH." >&2
  echo "      Surface Pro 7 is x86_64, so it will run this file." >&2
  echo "      An ARM machine needs a separate build." >&2
  exit 1
fi

WORK="$(mktemp -d /tmp/floor-install.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT INT TERM

echo "Unpacking Floor $VERSION ..."
tail -n +"$SKIP" "$0" | tar xz -C "$WORK"

if [ ! -f "$WORK/install.sh" ]; then
  echo "FAIL  the payload is incomplete (no install.sh). Download the installer again." >&2
  exit 1
fi

chmod +x "$WORK/install.sh"
FLOOR_PAYLOAD_DIR="$WORK" "$WORK/install.sh" "$@"

__FLOOR_PAYLOAD__
