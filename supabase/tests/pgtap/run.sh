#!/usr/bin/env bash
# Apply migrations to local pgTAP DB and run tests.
# Requires: docker compose up -d in this directory, then:
#   bash supabase/tests/pgtap/run.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
DB_URL="${DATABASE_URL:-postgres://postgres:postgres@127.0.0.1:54322/postgres}"
echo "Applying migrations to $DB_URL"
# Minimal stub for auth if using plain postgres image — supabase image has auth schema.
for f in $(ls "$ROOT/supabase/migrations/"*.sql | sort); do
  echo "  $(basename "$f")"
  psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$f" >/dev/null
done
echo "Running pgTAP"
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/pgtap/001_tickets.sql"
echo "PASS"
