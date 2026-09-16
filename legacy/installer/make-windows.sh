#!/usr/bin/env bash
# Build the downloadable Windows zip (ARM64 + x64 Node, same adapter payload).
# Safe to run on Linux x64. Does not touch live /var/lib/floor.
#
#   installer/make-windows.sh [version]
#
# Produces build/floor-<version>-windows.zip and a .sha256 next to it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="${1:-$(node -p "require('./package.json').version")}"
NODE_VERSION="${NODE_VERSION:-22.18.0}"
STAGE="$ROOT/build/windows-stage"
NAME="floor-${VERSION}-windows"
OUT="$ROOT/build/${NAME}.zip"

rm -rf "$STAGE" "$OUT"
mkdir -p "$STAGE/$NAME" "$ROOT/build"

say() { printf '\n>>> %s\n' "$*"; }

say "Building the adapter ($VERSION)"
npm run build -w @floor/adapter

say "Staging the app"
mkdir -p "$STAGE/$NAME/app"
cp -a apps/adapter/.next/standalone/. "$STAGE/$NAME/app/"
cp -a apps/adapter/.next/static "$STAGE/$NAME/app/apps/adapter/.next/static"
if [ -d apps/adapter/public ]; then
  cp -a apps/adapter/public "$STAGE/$NAME/app/apps/adapter/public"
fi
test -f "$STAGE/$NAME/app/apps/adapter/server.js" || {
  echo "FAIL  standalone build has no server.js" >&2; exit 1; }

fetch_node() {
  local arch="$1"
  local zip="build/node-v${NODE_VERSION}-win-${arch}.zip"
  local dest="$STAGE/$NAME/runtime/node-win-${arch}"
  if [ ! -f "$zip" ]; then
    curl -fsSL -o "$zip" \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-${arch}.zip"
  fi
  rm -rf "build/node-win-${arch}-unpack"
  mkdir -p "build/node-win-${arch}-unpack"
  python3 - "$zip" "build/node-win-${arch}-unpack" <<'PY'
import sys, zipfile
zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])
PY
  inner="$(find "build/node-win-${arch}-unpack" -maxdepth 2 -name node.exe -print -quit)"
  [ -n "$inner" ] || { echo "FAIL  no node.exe in $zip" >&2; exit 1; }
  mkdir -p "$dest"
  cp "$inner" "$dest/node.exe"
}

say "Bundling Node $NODE_VERSION win-arm64 and win-x64"
fetch_node arm64
fetch_node x64

say "Staging Windows scripts and InvenTree compose"
mkdir -p "$STAGE/$NAME/infra/inventree" "$STAGE/$NAME/config" "$STAGE/$NAME/packages"
cp installer/windows/README.md "$STAGE/$NAME/README.md"
cp installer/windows/Install-Floor.ps1 installer/windows/Start-Floor.ps1 \
   installer/windows/Stop-Floor.ps1 "$STAGE/$NAME/"
cp infra/inventree/docker-compose.yml infra/inventree/.env.example \
   infra/inventree/http.mjs infra/inventree/probe.mjs \
   infra/inventree/bootstrap.mjs infra/inventree/settings.mjs \
   "$STAGE/$NAME/infra/inventree/"
mkdir -p "$STAGE/$NAME/packages/inventree"
cp -a packages/inventree/src "$STAGE/$NAME/packages/inventree/"
cp config/floor.example.json config/staff.example.json "$STAGE/$NAME/config/"
printf '%s\n' "$VERSION" > "$STAGE/$NAME/VERSION"

# probe.mjs imports ../../packages/inventree/src/*.ts — keep that relative shape.
test -f "$STAGE/$NAME/packages/inventree/src/token.ts"

say "Packing $OUT"
( cd "$STAGE" && python3 - "$OUT" "$NAME" <<'PY'
import sys, zipfile, os
out, root = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for dirpath, _, files in os.walk(root):
        for name in files:
            path = os.path.join(dirpath, name)
            z.write(path, path)
PY
)

( cd "$ROOT/build" && sha256sum "$(basename "$OUT")" > "$(basename "$OUT").sha256" )

echo
echo "PASS  $OUT"
echo "      $(du -h "$OUT" | cut -f1)"
cat "$OUT.sha256"
test -f "$STAGE/$NAME/README.md"
grep -q "Install-Floor.ps1" "$STAGE/$NAME/README.md"
grep -q "node-win-arm64" "$STAGE/$NAME/README.md"
test -f "$STAGE/$NAME/runtime/node-win-arm64/node.exe"
test -f "$STAGE/$NAME/runtime/node-win-x64/node.exe"
echo "PASS  README matches scripts and both Node runtimes are in the zip"
