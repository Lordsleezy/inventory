#!/usr/bin/env bash
# Production backup: one dated archive of the SQLite database and media.
# Usage: FLOOR_ROOT=~/liquidation-os scripts/backup.sh
set -euo pipefail

DATA_DIR="${INVENTREE_DATA_DIR:-/home/inventree/data}"
BACKUP_DIR="${FLOOR_BACKUP_DIR:-/home/inventree/backups}"
KEEP="${FLOOR_BACKUP_KEEP:-14}"
FLOOR_ROOT="${FLOOR_ROOT:-$HOME/liquidation-os}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/floor-backup-$STAMP.tar.gz"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

mkdir -p "$BACKUP_DIR"
DB="$DATA_DIR/inventree.sqlite3"
if [[ ! -f "$DB" ]]; then
  echo "FAIL  no sqlite at $DB" >&2
  exit 1
fi

if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB" "PRAGMA wal_checkpoint(TRUNCATE);" || true
fi

mkdir -p "$WORKDIR/data"
cp -a "$DB" "$WORKDIR/data/inventree.sqlite3"
if [[ -f "$DB-wal" ]]; then cp -a "$DB-wal" "$WORKDIR/data/inventree.sqlite3-wal"; fi
if [[ -f "$DB-shm" ]]; then cp -a "$DB-shm" "$WORKDIR/data/inventree.sqlite3-shm"; fi
if [[ -d "$DATA_DIR/media" ]]; then
  cp -a "$DATA_DIR/media" "$WORKDIR/data/media"
fi

tar -C "$WORKDIR" -czf "$OUT" data

# retention: keep the newest KEEP archives
mapfile -t OLD < <(ls -1t "$BACKUP_DIR"/floor-backup-*.tar.gz 2>/dev/null | tail -n +"$((KEEP + 1))" || true)
if ((${#OLD[@]})); then
  rm -f "${OLD[@]}"
fi

STATUS_DIR="$FLOOR_ROOT/data"
mkdir -p "$STATUS_DIR"
cat > "$STATUS_DIR/backup-status.json" <<EOF
{"ok":true,"at":"$STAMP","file":"$OUT"}
EOF

echo "PASS  $OUT"
