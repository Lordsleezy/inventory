#!/usr/bin/env bash
# Live-baseline migration test: load the committed schema dump of LIVE, then apply every migration in
# supabase/migrations that live has not applied yet (in filename order). A migration that would fail on
# live fails here. Needs a Supabase-image Postgres (roles, auth schema, extensions) at DATABASE_URL:
#   bash scripts/test-migrations-live.sh --start     # starts one with the Supabase CLI (Docker), then tests
#   DATABASE_URL=postgres://... bash scripts/test-migrations-live.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="$ROOT/supabase/tests/live-baseline"
SB="npx --no-install supabase"

if [ ! -s "$BASE/schema.sql" ] || [ ! -s "$BASE/applied-versions.txt" ]; then
  msg="No live baseline committed yet (supabase/tests/live-baseline/schema.sql). Run scripts/refresh-live-baseline.sh with live access and commit it."
  if [ "${REQUIRE_LIVE_BASELINE:-0}" = "1" ]; then echo "$msg" >&2; exit 1; fi
  echo "::warning::$msg"; echo "SKIP (no baseline)"; exit 0
fi

if [ "${1:-}" = "--start" ]; then
  # Empty workdir so the CLI does not auto-apply supabase/migrations on start.
  WORK="$(mktemp -d)"; mkdir -p "$WORK/supabase"; cp "$ROOT/supabase/config.toml" "$WORK/supabase/"
  # pgTAP uses host port 54322 in parallel CI jobs. Keep the live-baseline
  # replay isolated on its own ephemeral local database port.
  TEST_DB_PORT="${FLOOR_LIVE_BASELINE_PORT:-54323}"
  sed -i "/^\[db\]$/a port = $TEST_DB_PORT" "$WORK/supabase/config.toml"
  (cd "$ROOT" && $SB db start --workdir "$WORK")
  trap '(cd "$ROOT" && $SB stop --workdir "$WORK" --no-backup >/dev/null 2>&1 || true)' EXIT
  DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:$TEST_DB_PORT/postgres"
fi
DB="${DATABASE_URL:?set DATABASE_URL or pass --start}"

echo "Baseline: $(head -1 "$BASE/schema.sql")"
# Custom roles first (cluster-wide; Supabase built-in roles already exist, so "already exists" is fine).
[ -s "$BASE/roles.sql" ] && psql "$DB" -q -f "$BASE/roles.sql" >/dev/null 2>&1 || true
psql "$DB" -q -v ON_ERROR_STOP=1 --single-transaction -f "$BASE/schema.sql" >/dev/null
echo "Loaded live baseline."

pending=0
for f in $(ls "$ROOT/supabase/migrations"/*.sql | sort); do
  v="$(basename "$f" | cut -d_ -f1)"
  grep -qx "$v" "$BASE/applied-versions.txt" && continue
  echo "  applying pending $(basename "$f")"
  # Migrations carry their own begin/commit, like `supabase db push` runs them.
  psql "$DB" -q -v ON_ERROR_STOP=1 -f "$f" >/dev/null
  pending=$((pending + 1))
done
missing="$(comm -13 <(ls "$ROOT/supabase/migrations"/*.sql | xargs -n1 basename | cut -d_ -f1 | sort -u) <(sort -u "$BASE/applied-versions.txt") | tr '\n' ' ')"
[ -n "$missing" ] && echo "::warning::Live has versions with no file in supabase/migrations: $missing"
echo "PASS: $pending pending migration(s) apply cleanly on the live baseline."
