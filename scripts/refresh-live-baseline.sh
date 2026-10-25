#!/usr/bin/env bash
# Refresh the live schema baseline used by CI (scripts/test-migrations-live.sh).
# Run by someone with live access (Codex), from a clean checkout of master, AFTER applying migrations:
#   SUPABASE_DB_URL=postgres://... bash scripts/refresh-live-baseline.sh      # or: supabase link first, no URL
# Writes schema only (no rows) + the list of migration versions live has applied, then refuses to finish
# if anything that looks like a secret ended up in the dump. Commit both files.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/supabase/tests/live-baseline"
mkdir -p "$OUT"
cd "$ROOT"
SB="npx --no-install supabase"

if [ -n "${SUPABASE_DB_URL:-}" ]; then
  $SB db dump --db-url "$SUPABASE_DB_URL" -f "$OUT/schema.sql"
  $SB db dump --db-url "$SUPABASE_DB_URL" --role-only -f "$OUT/roles.sql"
  psql "$SUPABASE_DB_URL" -At -v ON_ERROR_STOP=1 \
    -c "select version from supabase_migrations.schema_migrations order by version" > "$OUT/applied-versions.txt"
else
  $SB db dump --linked -f "$OUT/schema.sql"
  $SB db dump --linked --role-only -f "$OUT/roles.sql"
  tmp="$(mktemp)"
  $SB db dump --linked --data-only --schema supabase_migrations -f "$tmp"
  # pg_dump puts VALUES on its own line and each migration tuple on a new line;
  # match the first field of each tuple instead of assuming INSERT and VALUES share a line.
  awk -F"'" '
    /INSERT INTO .*schema_migrations/ { in_data=1; next }
    in_data && /^;/ { exit }
    in_data && /^[[:space:]]*\(/ && $2 ~ /^[0-9]+$/ { print $2 }
  ' "$tmp" | sort -u > "$OUT/applied-versions.txt"
  rm -f "$tmp"
fi

[ -s "$OUT/schema.sql" ] || { echo "empty schema dump" >&2; exit 1; }
[ -s "$OUT/applied-versions.txt" ] || { echo "no applied versions found" >&2; exit 1; }

if grep -nE 'eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}|sk_(live|test)_[A-Za-z0-9]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY|EAAA[A-Za-z0-9_-]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|PASSWORD '"'"'[^'"'"']+'"'"'' "$OUT/schema.sql" "$OUT/roles.sql"; then
  echo "Possible secret in schema.sql/roles.sql (lines above). Do NOT commit; remove it from live function bodies first." >&2
  exit 1
fi

{
  echo "-- Live schema baseline for CI. Generated $(date -u +%Y-%m-%dT%H:%MZ) by scripts/refresh-live-baseline.sh."
  echo "-- Applied migrations on live: $(wc -l < "$OUT/applied-versions.txt"). Do not edit by hand."
  cat "$OUT/schema.sql"
} > "$OUT/schema.sql.tmp" && mv "$OUT/schema.sql.tmp" "$OUT/schema.sql"
touch "$OUT/roles.sql"
echo "Wrote $OUT/schema.sql ($(wc -l < "$OUT/schema.sql") lines) and applied-versions.txt ($(wc -l < "$OUT/applied-versions.txt") versions)."
echo "Next: git add supabase/tests/live-baseline && commit."
