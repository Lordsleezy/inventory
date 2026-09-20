#!/usr/bin/env bash
# Apply stub + migrations to local pgTAP DB and run tests.
#   docker compose -f supabase/tests/pgtap/docker-compose.yml up -d --build
#   bash supabase/tests/pgtap/run.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
DB_URL="${DATABASE_URL:-postgres://postgres:postgres@127.0.0.1:54322/postgres}"

echo "Waiting for database..."
for i in $(seq 1 60); do
  if psql "$DB_URL" -v ON_ERROR_STOP=1 -c 'select 1' >/dev/null 2>&1; then
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "database not ready: $DB_URL" >&2
    exit 1
  fi
  sleep 1
done

echo "Applying stub + migrations to $DB_URL"
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/pglite-stub.sql" >/dev/null
psql "$DB_URL" -v ON_ERROR_STOP=1 -c 'create extension if not exists pgtap' >/dev/null

for f in $(ls "$ROOT/supabase/migrations/"*.sql | sort); do
  echo "  $(basename "$f")"
  psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$f" >/dev/null
done

echo "Running pgTAP"
shopt -s nullglob
failed=0
for t in "$ROOT"/supabase/tests/pgtap/[0-9]*.sql; do
  echo "  $(basename "$t")"
  out="$(psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$t" 2>&1)" || {
    echo "$out"
    echo "psql failed on $(basename "$t")" >&2
    exit 1
  }
  echo "$out"
  if echo "$out" | grep -E '^not ok |Looks like you failed'; then
    echo "pgTAP failures in $(basename "$t")" >&2
    failed=1
  fi
done
if [ "$failed" -ne 0 ]; then
  exit 1
fi
echo "PASS"
