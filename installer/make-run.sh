#!/usr/bin/env bash
# Build the downloadable Floor installer. Must run on Linux x64.
#
#   installer/make-run.sh [version]
#
# Produces build/floor-<version>-linux-x64.run and a .sha256 next to it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="${1:-$(node -p "require('./package.json').version")}"
NODE_VERSION="${NODE_VERSION:-22.18.0}"

if [ "$(uname -s)" != "Linux" ] || [ "$(uname -m)" != "x86_64" ]; then
  echo "FAIL  this must be built on Linux x64. Found $(uname -s) $(uname -m)." >&2
  echo "      Push a tag instead and let .github/workflows/release.yml build it." >&2
  exit 1
fi

STAGE="$ROOT/build/stage"
OUT="$ROOT/build/floor-${VERSION}-linux-x64.run"
rm -rf "$STAGE" "$OUT"
mkdir -p "$STAGE" "$ROOT/build"

say() { printf '\n>>> %s\n' "$*"; }

say "Building the adapter ($VERSION)"
npm run build -w @floor/adapter

say "Staging the app"
# Next's standalone output already contains the pruned production node_modules.
mkdir -p "$STAGE/app"
cp -a apps/adapter/.next/standalone/. "$STAGE/app/"
# Static assets and public files are deliberately not part of standalone.
cp -a apps/adapter/.next/static "$STAGE/app/apps/adapter/.next/static"
if [ -d apps/adapter/public ]; then
  cp -a apps/adapter/public "$STAGE/app/apps/adapter/public"
fi
test -f "$STAGE/app/apps/adapter/server.js" || {
  echo "FAIL  standalone build has no server.js" >&2; exit 1; }

say "Bundling Node $NODE_VERSION"
NODE_TGZ="build/node-v${NODE_VERSION}-linux-x64.tar.xz"
if [ ! -f "$NODE_TGZ" ]; then
  curl -fsSL -o "$NODE_TGZ" \
    "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"
fi
rm -rf build/node-unpack && mkdir -p build/node-unpack
tar xJf "$NODE_TGZ" -C build/node-unpack --strip-components=1
# Only the interpreter ships. No npm, no headers.
mkdir -p "$STAGE/runtime/node/bin"
cp build/node-unpack/bin/node "$STAGE/runtime/node/bin/node"
chmod +x "$STAGE/runtime/node/bin/node"

say "Bundling Electron"
# npm ci already fetched the linux-x64 Electron dist for apps/desktop.
if [ -d node_modules/electron/dist ]; then
  cp -a node_modules/electron/dist "$STAGE/runtime/electron"
else
  echo "WARN  no node_modules/electron/dist, the payload will have no desktop shell" >&2
fi
mkdir -p "$STAGE/desktop"
cp apps/desktop/main.mjs apps/desktop/marketplace.mjs apps/desktop/preload.cjs \
   apps/desktop/package.json apps/desktop/icon.png "$STAGE/desktop/"

say "Staging the setup scripts"
# probe.mjs and bootstrap.mjs import ../../packages/inventree/src/*.ts by
# relative path, so infra/ and packages/ must keep that shape.
cp -a infra "$STAGE/infra"
cp -a packages "$STAGE/packages"
find "$STAGE/packages" -name node_modules -maxdepth 2 -type d -prune -exec rm -rf {} +
mkdir -p "$STAGE/config" "$STAGE/assets"
cp config/floor.example.json "$STAGE/config/floor.example.json"
cp config/staff.example.json "$STAGE/config/staff.example.json"
cp installer/assets/floor-adapter.service installer/assets/floor.desktop \
   installer/assets/icon.png \
   installer/assets/floor-backup.sh installer/assets/floor-restore.sh \
   installer/assets/floor-backup.service installer/assets/floor-backup.timer \
   installer/assets/backup.env \
   "$STAGE/assets/"
cp installer/install.sh "$STAGE/install.sh"
chmod +x "$STAGE/install.sh"
printf '%s\n' "$VERSION" > "$STAGE/VERSION"

say "Verifying the staged tree with the bundled Node"
NODE_BIN="$STAGE/runtime/node/bin/node"
"$NODE_BIN" --version
# Catch broken imports now rather than on the Surface. The module graph must
# load with no third-party dependencies present.
( cd "$STAGE" && INVENTREE_URL=http://127.0.0.1 INVENTREE_ADMIN_PASSWORD=x \
  "./runtime/node/bin/node" --experimental-strip-types \
  -e 'import("./infra/inventree/http.mjs").then(()=>console.log("PASS  setup script imports resolve")).catch((e)=>{console.error("FAIL  "+e.message);process.exit(1)})' )
bash -n "$STAGE/install.sh" && echo "PASS  install.sh parses"
bash -n "$STAGE/assets/floor-backup.sh" && echo "PASS  floor-backup.sh parses"
bash -n "$STAGE/assets/floor-restore.sh" && echo "PASS  floor-restore.sh parses"

say "Installer logic self-tests"
bash installer/selftest-header.sh | tail -1
bash installer/selftest-env.sh | tail -1
bash installer/selftest-distro.sh | tail -1

say "Booting the packaged app with the bundled Node"
# This is the check that matters: the standalone bundle has to serve pages using
# only what is inside the payload. It runs without InvenTree on purpose.
BOOTROOT="$(mktemp -d)"
mkdir -p "$BOOTROOT/config" "$BOOTROOT/data"
cp config/floor.example.json "$BOOTROOT/config/floor.example.json"
(
  cd "$STAGE/app"
  FLOOR_ROOT="$BOOTROOT" INVENTREE_URL="http://127.0.0.1:1" \
  FLOOR_SESSION_SECRET=buildcheck FLOOR_DEV_PIN=0000 \
  NODE_ENV=production PORT=3111 HOSTNAME=127.0.0.1 \
    "$STAGE/runtime/node/bin/node" apps/adapter/server.js > "$BOOTROOT/boot.log" 2>&1 &
  echo $! > "$BOOTROOT/pid"
)
BOOTPID="$(cat "$BOOTROOT/pid")"
cleanup_boot() { kill "$BOOTPID" 2>/dev/null || true; rm -rf "$BOOTROOT"; }
trap cleanup_boot EXIT

LOGIN_CODE=000
for _ in $(seq 1 40); do
  LOGIN_CODE="$(curl -s -o /dev/null -m 2 -w '%{http_code}' http://127.0.0.1:3111/login || true)"
  [ "$LOGIN_CODE" != "000" ] && break
  sleep 1
done

if [ "$LOGIN_CODE" != "200" ]; then
  echo "FAIL  the packaged app did not serve /login (got $LOGIN_CODE)" >&2
  cat "$BOOTROOT/boot.log" >&2
  exit 1
fi
echo "PASS  /login served 200 by the bundled Node"

# 401 is correct here and is exactly why the installer's readiness check must
# not use curl -f.
HEALTH_CODE="$(curl -s -o /dev/null -m 5 -w '%{http_code}' http://127.0.0.1:3111/api/health || true)"
if [ "$HEALTH_CODE" != "401" ]; then
  echo "FAIL  /api/health answered $HEALTH_CODE, expected 401 when signed out" >&2
  cat "$BOOTROOT/boot.log" >&2
  exit 1
fi
echo "PASS  /api/health answered 401 signed out"

STATIC_CODE="$(curl -s -o /dev/null -m 5 -w '%{http_code}' \
  "http://127.0.0.1:3111/_next/static/chunks/$(ls "$STAGE/app/apps/adapter/.next/static/chunks" | grep -m1 '\.js$')" || true)"
if [ "$STATIC_CODE" != "200" ]; then
  echo "FAIL  static assets are not being served (got $STATIC_CODE)" >&2
  exit 1
fi
echo "PASS  static assets served"

cleanup_boot
trap - EXIT

say "Packing"
tar czf build/payload.tar.gz --owner=0 --group=0 -C "$STAGE" .
sed "s/@@VERSION@@/$VERSION/g" installer/header.sh > build/header.gen.sh
# The header ends with the marker line; the archive starts on the next byte.
cat build/header.gen.sh build/payload.tar.gz > "$OUT"
chmod +x "$OUT"
rm -f build/payload.tar.gz build/header.gen.sh

say "Self-test"
"$OUT" --version
TESTDIR="$(mktemp -d)"
"$OUT" --extract "$TESTDIR" >/dev/null
test -f "$TESTDIR/install.sh" || { echo "FAIL  round-trip extract lost install.sh" >&2; exit 1; }
test -x "$TESTDIR/runtime/node/bin/node" || { echo "FAIL  node not executable after extract" >&2; exit 1; }
rm -rf "$TESTDIR"
echo "PASS  the installer extracts itself cleanly"

( cd build && sha256sum "$(basename "$OUT")" > "$(basename "$OUT").sha256" )

echo
echo "PASS  $OUT"
echo "      $(du -h "$OUT" | cut -f1)"
cat "$OUT.sha256"
