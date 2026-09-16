#!/usr/bin/env bash
# First-run Floor setup. Safe to run more than once.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "FAIL  node not found. Install Node 22 first (see README)."
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "${NODE_MAJOR}" -lt 22 ]; then
  echo "FAIL  need Node 22 or newer, got $(node --version)"
  exit 1
fi
echo "PASS  node $(node --version)"

if [ ! -f apps/adapter/.env.local ]; then
  cp apps/adapter/.env.example apps/adapter/.env.local
  echo "WROTE apps/adapter/.env.local — edit INVENTREE_ADMIN_PASSWORD, FLOOR_DEV_PIN, FLOOR_SESSION_SECRET"
else
  echo "PASS  apps/adapter/.env.local already exists"
fi

if [ ! -f config/floor.json ]; then
  mkdir -p config
  cp config/floor.example.json config/floor.json
  echo "WROTE config/floor.json from example"
else
  echo "PASS  config/floor.json already exists"
fi

if [ ! -d data ]; then
  mkdir -p data
  echo "WROTE data/ (SKU ledger and local files live here; never commit this)"
else
  echo "PASS  data/ exists"
fi

npm install
echo "PASS  npm install"

echo
echo "Edit apps/adapter/.env.local before starting Floor."
echo "Then install InvenTree and run: npm run adapter"
