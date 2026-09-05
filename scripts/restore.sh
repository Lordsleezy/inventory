#!/usr/bin/env bash
# Restore a Floor backup onto a data directory. Stops InvenTree first.
# Usage: scripts/restore.sh /home/inventree/backups/floor-backup-YYYYMMDDThhmmssZ.tar.gz
# Optional: INVENTREE_DATA_DIR=/path/to/empty-or-replace
set -euo pipefail

ARCHIVE="${1:-}"
if [[ -z "$ARCHIVE" || ! -f "$ARCHIVE" ]]; then
  echo "FAIL  usage: scripts/restore.sh <floor-backup-*.tar.gz>" >&2
  exit 1
fi

DATA_DIR="${INVENTREE_DATA_DIR:-/home/inventree/data}"
CONFIRM="${FLOOR_RESTORE_CONFIRM:-}"
if [[ "$CONFIRM" != "RESTORE" ]]; then
  echo "FAIL  set FLOOR_RESTORE_CONFIRM=RESTORE to replace $DATA_DIR" >&2
  exit 1
fi

if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl stop inventree.service inventree-worker.service 2>/dev/null || true
fi

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
tar -C "$WORKDIR" -xzf "$ARCHIVE"
if [[ ! -f "$WORKDIR/data/inventree.sqlite3" ]]; then
  echo "FAIL  archive has no data/inventree.sqlite3" >&2
  exit 1
fi

mkdir -p "$DATA_DIR"
# Replace sqlite and media; leave other files in the data dir alone.
rm -f "$DATA_DIR/inventree.sqlite3" "$DATA_DIR/inventree.sqlite3-wal" "$DATA_DIR/inventree.sqlite3-shm"
cp -a "$WORKDIR/data/inventree.sqlite3" "$DATA_DIR/inventree.sqlite3"
if [[ -f "$WORKDIR/data/inventree.sqlite3-wal" ]]; then
  cp -a "$WORKDIR/data/inventree.sqlite3-wal" "$DATA_DIR/inventree.sqlite3-wal"
fi
if [[ -f "$WORKDIR/data/inventree.sqlite3-shm" ]]; then
  cp -a "$WORKDIR/data/inventree.sqlite3-shm" "$DATA_DIR/inventree.sqlite3-shm"
fi
if [[ -d "$WORKDIR/data/media" ]]; then
  rm -rf "$DATA_DIR/media"
  cp -a "$WORKDIR/data/media" "$DATA_DIR/media"
fi

if [[ "$(id -u)" -eq 0 ]] || id inventree >/dev/null 2>&1; then
  sudo chown -R inventree:inventree "$DATA_DIR" 2>/dev/null || true
fi

if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl start inventree.service inventree-worker.service 2>/dev/null || true
fi

echo "PASS  restored $ARCHIVE onto $DATA_DIR"
