#!/usr/bin/env bash
# Restore a Floor backup into a directory. Never defaults to live paths.
# Usage: floor-restore <archive.tar.gz> <empty-or-new-dest>
set -euo pipefail

ARCHIVE="${1:-}"
DEST="${2:-}"
if [ -z "$ARCHIVE" ] || [ ! -f "$ARCHIVE" ] || [ -z "$DEST" ]; then
  echo "FAIL  usage: floor-restore <floor-backup-*.tar.gz> <destination-dir>" >&2
  exit 1
fi

LIVE_STATE=/var/lib/floor
LIVE_DB=/opt/inventree/data
case "$(readlink -f "$DEST" 2>/dev/null || echo "$DEST")" in
  "$LIVE_STATE"|"$LIVE_STATE"/*|"$LIVE_DB"|"$LIVE_DB"/*)
    echo "FAIL  refusing to restore onto live data ($DEST). Pick a clean directory." >&2
    exit 1
    ;;
esac

mkdir -p "$DEST"
if [ "$(ls -A "$DEST" 2>/dev/null)" ]; then
  echo "FAIL  destination is not empty: $DEST" >&2
  exit 1
fi

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
tar -C "$WORKDIR" -xzf "$ARCHIVE"
INNER="$(find "$WORKDIR" -mindepth 1 -maxdepth 1 -type d | head -1)"
[ -n "$INNER" ] || INNER="$WORKDIR"
if [ ! -f "$INNER/inventree-data/inventree.sqlite3" ]; then
  echo "FAIL  archive has no inventree-data/inventree.sqlite3" >&2
  exit 1
fi
cp -a "$INNER/." "$DEST/"
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DEST/inventree-data/inventree.sqlite3" "PRAGMA integrity_check;" | grep -qx ok \
    || { echo "FAIL  restored sqlite failed integrity_check" >&2; exit 1; }
fi
echo "PASS  restored $ARCHIVE onto $DEST"
