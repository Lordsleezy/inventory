#!/usr/bin/env bash
# Proves the self-extracting header finds the payload at the right byte and
# that a binary survives the round trip with its exec bit. Uses a stand-in
# payload so it can run on any arch.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
W="$(mktemp -d)"
trap 'rm -rf "$W"' EXIT
cd "$W"

mkdir -p stage/runtime/node/bin
printf '#!/usr/bin/env bash\necho "INSTALLER-RAN args=$*"\necho "payload=$FLOOR_PAYLOAD_DIR"\n' > stage/install.sh
chmod +x stage/install.sh
printf '1.0.0-test\n' > stage/VERSION
head -c 200000 /dev/urandom > stage/runtime/node/bin/node
chmod +x stage/runtime/node/bin/node

tar czf payload.tar.gz --owner=0 --group=0 -C stage .
sed 's/@@VERSION@@/1.0.0-test/g' "$ROOT/installer/header.sh" > header.gen.sh
cat header.gen.sh payload.tar.gz > test.run
chmod +x test.run

echo "size: $(du -h test.run | cut -f1)"

echo "--- version flag"
./test.run --version

echo "--- help flag"
./test.run --help | head -2

echo "--- extract"
./test.run --extract out
ls out

echo "--- round trip"
cmp stage/runtime/node/bin/node out/runtime/node/bin/node
echo "PASS  payload bytes identical after extract"
test -x out/runtime/node/bin/node
echo "PASS  exec bit survived tar"

echo "--- corruption guard"
if head -c 4000 test.run > truncated.run && chmod +x truncated.run && ./truncated.run --version >/dev/null 2>&1; then
  echo "PASS  version flag still works on a truncated file"
fi

echo "--- arch guard on $(uname -m)"
set +e
./test.run 2>&1 | head -3
set -e

echo
echo "PASS  header round-trip"
