#!/usr/bin/env bash
# Start / inspect Codemagic builds from this machine (no UI screenshots).
#
# One-time setup (do once, then I can drive builds):
#   1. Codemagic → User settings → Integrations → Codemagic API → Show → copy token
#   2. Codemagic → open your Floor app → copy app id from the URL:
#        https://codemagic.io/app/<APP_ID>/...
#   3. Store locally (NOT in git):
#        mkdir -p ~/.config/floor
#        cat > ~/.config/floor/codemagic.env <<'EOF'
#        export CODEMAGIC_TOKEN='paste-token-here'
#        export CODEMAGIC_APP_ID='paste-app-id-here'
#        EOF
#        chmod 600 ~/.config/floor/codemagic.env
#   4. Tell me "Codemagic env is ready" — I will source that file and run this script.
#
# Usage:
#   scripts/codemagic-build.sh start ios-square-sandbox ios-square-14
#   scripts/codemagic-build.sh start ios-capacitor ios-14
#   scripts/codemagic-build.sh status <buildId>
#   scripts/codemagic-build.sh wait <buildId>
#   scripts/codemagic-build.sh latest
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${FLOOR_CODEMAGIC_ENV:-$HOME/.config/floor/codemagic.env}"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

TOKEN="${CODEMAGIC_TOKEN:-${CM_API_TOKEN:-}}"
APP_ID="${CODEMAGIC_APP_ID:-}"

if [ -z "$TOKEN" ] || [ -z "$APP_ID" ]; then
  echo "FAIL  need CODEMAGIC_TOKEN and CODEMAGIC_APP_ID" >&2
  echo "Create $ENV_FILE as described in the header of this script." >&2
  exit 1
fi

api() {
  local method="$1" path="$2"
  shift 2
  curl -sS -X "$method" \
    -H "Content-Type: application/json" \
    -H "x-auth-token: $TOKEN" \
    "https://api.codemagic.io$path" \
    "$@"
}

cmd="${1:-}"
shift || true

case "$cmd" in
  start)
    WORKFLOW="${1:-ios-square-sandbox}"
    REF="${2:-}"
    if [ -z "$REF" ]; then
      echo "usage: $0 start <workflowId> <tag-or-branch>" >&2
      echo "  workflowId: ios-square-sandbox | ios-capacitor" >&2
      exit 1
    fi
    # Prefer tag when it looks like ios-*
    if [[ "$REF" == ios-* ]]; then
      BODY=$(printf '{"appId":"%s","workflowId":"%s","tag":"%s"}' "$APP_ID" "$WORKFLOW" "$REF")
    else
      BODY=$(printf '{"appId":"%s","workflowId":"%s","branch":"%s"}' "$APP_ID" "$WORKFLOW" "$REF")
    fi
    echo "Starting workflow=$WORKFLOW ref=$REF app=$APP_ID"
    RESP="$(api POST /builds -d "$BODY")"
    echo "$RESP" | python3 -m json.tool 2>/dev/null || echo "$RESP"
    BUILD_ID="$(printf '%s' "$RESP" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("buildId") or (d.get("build") or {}).get("_id") or d.get("_id") or "")' 2>/dev/null || true)"
    if [ -n "$BUILD_ID" ]; then
      echo "BUILD_ID=$BUILD_ID"
      echo "https://codemagic.io/app/$APP_ID/build/$BUILD_ID"
    fi
    ;;
  status)
    BUILD_ID="${1:-}"
    [ -n "$BUILD_ID" ] || { echo "usage: $0 status <buildId>" >&2; exit 1; }
    api GET "/builds/$BUILD_ID" | python3 -m json.tool
    ;;
  wait)
    BUILD_ID="${1:-}"
    [ -n "$BUILD_ID" ] || { echo "usage: $0 wait <buildId>" >&2; exit 1; }
    for i in $(seq 1 90); do
      RESP="$(api GET "/builds/$BUILD_ID")"
      STATUS="$(printf '%s' "$RESP" | python3 -c 'import json,sys; d=json.load(sys.stdin); b=d.get("build") or d; print(b.get("status") or b.get("status") or "")' 2>/dev/null || true)"
      echo "$(date -u +%H:%M:%S)z status=$STATUS"
      case "$STATUS" in
        finished|failed|canceled|timeout|skipped) echo "$RESP" | python3 -m json.tool; exit 0 ;;
      esac
      sleep 30
    done
    echo "TIMEOUT waiting for $BUILD_ID" >&2
    exit 1
    ;;
  latest)
    api GET "/builds?appId=$APP_ID" | python3 -c '
import json,sys
d=json.load(sys.stdin)
builds=d.get("builds") or d.get("data") or (d if isinstance(d,list) else [])
for b in builds[:8]:
    print(b.get("_id") or b.get("id"), b.get("status"), b.get("workflowId") or b.get("workflow"), b.get("tag") or b.get("branch"), b.get("finishedAt") or "")
'
    ;;
  *)
    echo "usage: $0 start|status|wait|latest ..." >&2
    exit 1
    ;;
esac
