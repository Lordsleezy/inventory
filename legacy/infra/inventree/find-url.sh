#!/usr/bin/env bash
# Print the first localhost URL that answers InvenTree's /api/.
set -euo pipefail

candidates=(
  "http://127.0.0.1"
  "http://127.0.0.1:80"
  "http://127.0.0.1:6000"
  "http://localhost"
)

for url in "${candidates[@]}"; do
  if curl -fsS --max-time 3 "$url/api/" >/tmp/floor-inventree-api.json 2>/dev/null; then
    if grep -q "server-version\|version" /tmp/floor-inventree-api.json; then
      echo "PASS  InvenTree API at $url"
      echo "export INVENTREE_URL=$url"
      exit 0
    fi
  fi
done

echo "FAIL  no InvenTree API on localhost (tried ${candidates[*]})"
echo "      check: sudo inventree logs --tail"
exit 1
