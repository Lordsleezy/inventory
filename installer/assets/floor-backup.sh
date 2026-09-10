#!/usr/bin/env bash
# Cold Floor backup. Run as root.
# Copies SQLite (checkpointed), InvenTree media, Floor config/SKU ledger/photos,
# and secrets into /var/backups/floor — never under /var/lib/floor.
set -euo pipefail

STATE="${FLOOR_STATE:-/var/lib/floor}"
INVENTREE_DATA="${INVENTREE_DATA:-/opt/inventree/data}"
ENVFILE="${FLOOR_ENVFILE:-/etc/floor/floor.env}"
BACKUP_DIR="${FLOOR_BACKUP_DIR:-/var/backups/floor}"
KEEP="${FLOOR_BACKUP_KEEP:-14}"
MIN_KEEP="${FLOOR_BACKUP_MIN_KEEP:-3}"
MAX_GB="${FLOOR_BACKUP_MAX_GB:-8}"
MIRROR="${FLOOR_BACKUP_MIRROR:-}"
REASON="${FLOOR_BACKUP_REASON:-manual}"

if [ -f /etc/floor/backup.env ]; then
  # shellcheck disable=SC1091
  set -a
  . /etc/floor/backup.env
  set +a
fi
BACKUP_DIR="${FLOOR_BACKUP_DIR:-$BACKUP_DIR}"
KEEP="${FLOOR_BACKUP_KEEP:-$KEEP}"
MIN_KEEP="${FLOOR_BACKUP_MIN_KEEP:-$MIN_KEEP}"
MAX_GB="${FLOOR_BACKUP_MAX_GB:-$MAX_GB}"
MIRROR="${FLOOR_BACKUP_MIRROR:-$MIRROR}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORKDIR="$(mktemp -d)"
ARCHIVE=""
SERVICES_STOPPED=0
cleanup() {
  if [ "$SERVICES_STOPPED" = 1 ]; then
    systemctl start inventree-web-1 inventree-worker-1 2>/dev/null || true
    systemctl start floor-adapter 2>/dev/null || true
  fi
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

if [ "$(id -u)" -ne 0 ]; then
  echo "FAIL  run as root: sudo floor-backup" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
# 0755 so the adapter can read status.json; archives stay 0640.
chmod 0755 "$BACKUP_DIR"

write_status() {
  local payload="$1"
  printf '%s\n' "$payload" > "$BACKUP_DIR/status.json"
  chmod 0644 "$BACKUP_DIR/status.json"
  mkdir -p "$STATE/data"
  cp -a "$BACKUP_DIR/status.json" "$STATE/data/backup-status.json" || true
}

fail_status() {
  write_status "$(printf '{"ok":false,"at":"%s","reason":"%s","error":"%s"}' "$STAMP" "$REASON" "$1")"
  echo "FAIL  $1" >&2
  exit 1
}

systemctl stop floor-adapter 2>/dev/null || true
systemctl stop inventree-web-1 inventree-worker-1 2>/dev/null || true
SERVICES_STOPPED=1

DB="$INVENTREE_DATA/inventree.sqlite3"
[ -f "$DB" ] || fail_status "no sqlite at $DB"

if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null 2>&1 || true
  sqlite3 "$DB" "PRAGMA integrity_check;" | grep -qx ok || fail_status "sqlite integrity_check failed"
fi

STAGE="$WORKDIR/floor-backup-$STAMP"
mkdir -p "$STAGE/inventree-data" "$STAGE/floor-state"

cp -a "$INVENTREE_DATA/inventree.sqlite3" "$STAGE/inventree-data/"
[ -f "$DB-wal" ] && cp -a "$DB-wal" "$STAGE/inventree-data/"
[ -f "$DB-shm" ] && cp -a "$DB-shm" "$STAGE/inventree-data/"
if [ -d "$INVENTREE_DATA/media" ]; then
  cp -a "$INVENTREE_DATA/media" "$STAGE/inventree-data/media"
fi
if [ -d "$INVENTREE_DATA/static" ]; then
  : # static is regenerable; skip to keep archives small
fi

cp -a "$STATE/." "$STAGE/floor-state/"
if [ -f "$ENVFILE" ]; then
  cp -a "$ENVFILE" "$STAGE/floor.env"
fi

cat > "$STAGE/manifest.json" <<EOF
{
  "at": "$STAMP",
  "reason": "$REASON",
  "host": "$(hostname 2>/dev/null || echo unknown)",
  "inventreeDb": "inventree-data/inventree.sqlite3",
  "floorState": "floor-state"
}
EOF

ARCHIVE="$BACKUP_DIR/floor-backup-$STAMP.tar.gz"
tar -C "$WORKDIR" -czf "$ARCHIVE" "floor-backup-$STAMP"
chmod 0640 "$ARCHIVE"

# Bring live services back before prune/mirror so a clerk isn't waiting.
systemctl start inventree-web-1 inventree-worker-1 2>/dev/null || true
systemctl start floor-adapter 2>/dev/null || true
SERVICES_STOPPED=0
for i in $(seq 1 30); do
  CODE="$(curl -s -o /dev/null -m 2 -w '%{http_code}' http://127.0.0.1/api/ || true)"
  if [ "$CODE" = "200" ]; then break; fi
  sleep 1
done
for i in $(seq 1 30); do
  CODE="$(curl -s -o /dev/null -m 2 -w '%{http_code}' http://127.0.0.1:3000/login || true)"
  if [ -n "$CODE" ] && [ "$CODE" != "000" ] && [ "$CODE" != "500" ]; then break; fi
  sleep 1
done

prune_backups() {
  local files=()
  mapfile -t files < <(ls -1t "$BACKUP_DIR"/floor-backup-*.tar.gz 2>/dev/null || true)
  local count="${#files[@]}"
  local cutoff
  cutoff="$(date -u -d "-${KEEP} days" +%Y%m%dT%H%M%SZ 2>/dev/null || date -u -v-${KEEP}d +%Y%m%dT%H%M%SZ 2>/dev/null || echo "")"
  local i
  for ((i = MIN_KEEP; i < count; i++)); do
    local f="${files[$i]}"
    local base
    base="$(basename "$f")"
    local ts="${base#floor-backup-}"
    ts="${ts%.tar.gz}"
    if [ -n "$cutoff" ] && [[ "$ts" < "$cutoff" ]]; then
      rm -f "$f"
    fi
  done
  mapfile -t files < <(ls -1t "$BACKUP_DIR"/floor-backup-*.tar.gz 2>/dev/null || true)
  count="${#files[@]}"
  local max_bytes=$((MAX_GB * 1024 * 1024 * 1024))
  local avail
  avail="$(df -B1 --output=avail "$BACKUP_DIR" | tail -1 | tr -d ' ')"
  # Never let backups eat the last 2GB of free space.
  local cap="$max_bytes"
  if [ -n "$avail" ] && [ "$avail" -gt 0 ]; then
    local used
    used="$(du -sb "$BACKUP_DIR" | awk '{print $1}')"
    local room=$((avail + used - 2 * 1024 * 1024 * 1024))
    if [ "$room" -gt 0 ] && [ "$room" -lt "$cap" ]; then
      cap="$room"
    fi
  fi
  used="$(du -sb "$BACKUP_DIR" | awk '{print $1}')"
  local j=$((count - 1))
  while [ "$used" -gt "$cap" ] && [ "$j" -ge "$MIN_KEEP" ]; do
    rm -f "${files[$j]}"
    j=$((j - 1))
    used="$(du -sb "$BACKUP_DIR" | awk '{print $1}')"
  done
}
prune_backups

if [ -n "$MIRROR" ] && [ -d "$MIRROR" ]; then
  cp -a "$ARCHIVE" "$MIRROR/" || true
fi

BYTES="$(stat -c '%s' "$ARCHIVE" 2>/dev/null || stat -f '%z' "$ARCHIVE")"
write_status "$(printf '{"ok":true,"at":"%s","file":"%s","bytes":%s,"reason":"%s"}' "$STAMP" "$ARCHIVE" "$BYTES" "$REASON")"

echo "PASS  backup at $ARCHIVE"
