#!/usr/bin/env bash
# Publish an over-the-air (Safari) install page for an ad-hoc IPA built on Codemagic.
#
# Creates a public Codemagic URL for the IPA, writes a proper iOS manifest.plist,
# hosts a tiny HTTPS install page (Netlify alias deploy preferred; GitHub gist fallback),
# emails the link when RESEND_* is set, and prints a banner with the Safari URL + QR.
#
# Required env (Codemagic group appstore):
#   CODEMAGIC_TOKEN  — Codemagic → User settings → Integrations → Codemagic API
# Optional:
#   NETLIFY_AUTH_TOKEN + NETLIFY_SITE_ID — host install page at https://ota-<tag>--<site>.netlify.app
#   GITHUB_TOKEN — gist fallback for the manifest if Netlify is unset
#   RESEND_API_KEY + RESEND_FROM + OTA_EMAIL_TO — email the install link
#   BUNDLE_ID, CM_TAG / CM_BRANCH
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUNDLE_ID="${BUNDLE_ID:-com.openboxindustries.floor}"
APP_NAME="${OTA_APP_NAME:-Floor}"
TAG="${CM_TAG:-${CM_BRANCH:-adhoc}}"
TAG_SAFE="$(printf '%s' "$TAG" | tr -c 'A-Za-z0-9._-' '-' | sed 's/^-//;s/-$//')"
EXPIRE_DAYS="${OTA_URL_EXPIRE_DAYS:-14}"

if [ -z "${CODEMAGIC_TOKEN:-}" ] && [ -n "${CM_API_TOKEN:-}" ]; then
  CODEMAGIC_TOKEN="$CM_API_TOKEN"
fi
if [ -z "${CODEMAGIC_TOKEN:-}" ]; then
  echo "FAIL  CODEMAGIC_TOKEN is unset — cannot mint a public IPA URL for OTA install." >&2
  echo "Codemagic → User settings → Integrations → Codemagic API → copy token" >&2
  echo "→ add CODEMAGIC_TOKEN to the Codemagic variable group named appstore." >&2
  exit 1
fi

if [ -z "${CM_ARTIFACT_LINKS:-}" ]; then
  echo "FAIL  CM_ARTIFACT_LINKS is empty (publishing scripts only)." >&2
  exit 1
fi

python3 - "$BUNDLE_ID" "$APP_NAME" "$TAG_SAFE" "$EXPIRE_DAYS" <<'PY'
import json, os, sys, urllib.parse, urllib.request, ssl, time, subprocess, tempfile, textwrap
from pathlib import Path

bundle_id, app_name, tag_safe, expire_days = sys.argv[1:5]
token = os.environ["CODEMAGIC_TOKEN"]
links = json.loads(os.environ["CM_ARTIFACT_LINKS"])

ipa = None
for art in links:
    name = (art.get("name") or art.get("filename") or "")
    url = art.get("url") or ""
    typ = (art.get("type") or "").lower()
    if name.lower().endswith(".ipa") or typ == "ipa" or "/ipa" in url.lower():
        ipa = art
        break
if not ipa or not ipa.get("url"):
    raise SystemExit(f"No .ipa in CM_ARTIFACT_LINKS: {json.dumps(links)[:800]}")

auth_url = ipa["url"].rstrip("/")
# Codemagic artifact URL shape: https://api.codemagic.io/artifacts/<...>/<file>
# Public URL: POST {artifactUrl}/public-url
expires_at = int(time.time()) + int(expire_days) * 86400
req = urllib.request.Request(
    auth_url + "/public-url",
    data=json.dumps({"expiresAt": expires_at}).encode(),
    headers={
        "Content-Type": "application/json",
        "x-auth-token": token,
    },
    method="POST",
)
with urllib.request.urlopen(req, timeout=60) as resp:
    pub = json.load(resp)
ipa_public = pub["url"]
print(f"PASS  public IPA URL (expires ~{expire_days}d)")

version = os.environ.get("CFBundleShortVersionString") or os.environ.get("MARKETING_VERSION") or "1.0"
build = os.environ.get("CFBundleVersion") or str(int(time.time()))
# Prefer values from the built Info if present on disk
for candidate in Path(".").rglob("Payload/*.app/Info.plist"):
    try:
        import plistlib
        data = plistlib.loads(candidate.read_bytes())
        version = str(data.get("CFBundleShortVersionString") or version)
        build = str(data.get("CFBundleVersion") or build)
    except Exception:
        pass
    break

manifest = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
        <dict>
          <key>kind</key>
          <string>software-package</string>
          <key>url</key>
          <string>{ipa_public}</string>
        </dict>
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key>
        <string>{bundle_id}</string>
        <key>bundle-version</key>
        <string>{build}</string>
        <key>kind</key>
        <string>software</string>
        <key>title</key>
        <string>{app_name}</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>
"""

tmpdir = Path(tempfile.mkdtemp(prefix="floor-ota-"))
(tmpdir / "manifest.plist").write_text(manifest)
print(f"Wrote {tmpdir / 'manifest.plist'}")

manifest_url = None
install_page_url = None

netlify_token = os.environ.get("NETLIFY_AUTH_TOKEN") or os.environ.get("NETLIFY_TOKEN")
netlify_site = os.environ.get("NETLIFY_SITE_ID") or os.environ.get("NETLIFY_SITE")
if netlify_token and netlify_site:
    # Placeholder install page — rewritten after we know the public site URL is awkward;
    # use relative manifest + absolute itms link built after deploy via second write.
    # First deploy with a bootstrap page; Netlify alias gives a stable host.
    bootstrap = textwrap.dedent(f"""\
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8"/>
      <meta name="viewport" content="width=device-width, initial-scale=1"/>
      <title>Install {app_name}</title>
      <style>
        body {{ font-family: system-ui, sans-serif; max-width: 28rem; margin: 2rem auto; padding: 0 1rem; }}
        a.btn {{ display: inline-block; background: #111; color: #fff; padding: .9rem 1.2rem;
                 border-radius: 8px; text-decoration: none; font-weight: 600; }}
        .hint {{ color: #555; font-size: .95rem; line-height: 1.4; }}
        img.qr {{ margin: 1.2rem 0; width: 200px; height: 200px; }}
      </style>
    </head>
    <body>
      <h1>Install {app_name}</h1>
      <p class="hint">Open this page in <strong>Safari</strong> on your registered iPhone, then tap Install.</p>
      <p><a class="btn" id="install" href="#">Install {app_name}</a></p>
      <p class="hint">Tag <code>{tag_safe}</code> · build {build} · ad-hoc (MockReaderUI)</p>
      <img class="qr" id="qr" alt="QR"/>
      <script>
        const manifest = location.origin + location.pathname.replace(/\\/?$/, '/') + 'manifest.plist';
        const itms = 'itms-services://?action=download-manifest&url=' + encodeURIComponent(manifest);
        document.getElementById('install').href = itms;
        document.getElementById('qr').src =
          'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' + encodeURIComponent(location.href);
      </script>
    </body>
    </html>
    """)
    (tmpdir / "index.html").write_text(bootstrap)
    alias = f"ota-{tag_safe}"[:60].rstrip("-")
    env = os.environ.copy()
    env["NETLIFY_AUTH_TOKEN"] = netlify_token
    cmd = [
        "npx", "--yes", "netlify-cli@17", "deploy",
        "--dir", str(tmpdir),
        "--alias", alias,
        "--site", netlify_site,
        "--json",
    ]
    print("Deploying OTA page to Netlify alias", alias)
    proc = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout)
        sys.stderr.write(proc.stderr)
        raise SystemExit("netlify deploy failed")
    # netlify --json prints deploy metadata; find deploy URL
    out = proc.stdout.strip().splitlines()
    meta = None
    for line in reversed(out):
        line = line.strip()
        if line.startswith("{"):
            try:
                meta = json.loads(line)
                break
            except json.JSONDecodeError:
                continue
    if not meta:
        # sometimes the whole stdout is JSON
        try:
            meta = json.loads(proc.stdout)
        except json.JSONDecodeError as e:
            sys.stderr.write(proc.stdout)
            raise SystemExit(f"could not parse netlify JSON: {e}") from e
    install_page_url = meta.get("deploy_url") or meta.get("url") or meta.get("ssl_url")
    if not install_page_url:
        raise SystemExit(f"netlify deploy returned no URL: {meta}")
    manifest_url = install_page_url.rstrip("/") + "/manifest.plist"
    print(f"PASS  Netlify OTA page: {install_page_url}")
else:
    print("WARN  NETLIFY_AUTH_TOKEN / NETLIFY_SITE_ID unset — trying GitHub gist for manifest")
    gh = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if not gh:
        raise SystemExit(
            "Need NETLIFY_AUTH_TOKEN+NETLIFY_SITE_ID or GITHUB_TOKEN to host the OTA manifest over HTTPS"
        )
    body = {
        "description": f"Floor iOS OTA manifest {tag_safe}",
        "public": True,
        "files": {"manifest.plist": {"content": manifest}},
    }
    req = urllib.request.Request(
        "https://api.github.com/gists",
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {gh}",
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "User-Agent": "floor-ota",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        gist = json.load(resp)
    raw = gist["files"]["manifest.plist"]["raw_url"]
    # Prefer the immutable raw URL without query if present
    manifest_url = raw.split("?")[0] if "gist.githubusercontent.com" in raw else raw
    itms = "itms-services://?action=download-manifest&url=" + urllib.parse.quote(manifest_url, safe="")
    # Minimal public HTML via another gist file rendered through htmlpreview / direct itms in email
    install_page_url = itms
    print(f"PASS  gist manifest: {manifest_url}")
    print("NOTE  Open the itms-services link in Safari (QR below encodes it).")

itms = "itms-services://?action=download-manifest&url=" + urllib.parse.quote(manifest_url, safe="")
# Prefer HTTPS install page when we have one (Safari-friendly); else raw itms
share_url = install_page_url if install_page_url.startswith("http") else itms
qr = "https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=" + urllib.parse.quote(share_url, safe="")

banner = f"""
================================================================================
FLOOR AD-HOC OTA INSTALL
================================================================================
1. On your iPhone, open Safari (not Chrome / not in-app browsers).
2. Go to:
   {share_url}
3. Or scan this QR (open the image URL on any screen, point phone camera):
   {qr}
4. Tap Install → Trust the developer cert if Settings prompts
   (General → VPN & Device Management).

Your phone UDID must be on the Ad Hoc profile (see docs/SQUARE.md).
IPA public URL expires in ~{expire_days} days.
================================================================================
"""
print(banner)
Path("/tmp/floor-ota-install-url.txt").write_text(share_url + "\n")
Path("/tmp/floor-ota-itms-url.txt").write_text(itms + "\n")
Path("/tmp/floor-ota-qr-url.txt").write_text(qr + "\n")

# Email via Resend when configured
resend_key = os.environ.get("RESEND_API_KEY")
resend_from = os.environ.get("RESEND_FROM")
resend_to = os.environ.get("OTA_EMAIL_TO") or os.environ.get("RESEND_TO") or "pgg124@gmail.com"
if resend_key and resend_from:
    mail = {
        "from": resend_from,
        "to": [resend_to],
        "subject": f"Floor iOS install ({tag_safe})",
        "html": f"""
          <p><strong>Install Floor</strong> (ad-hoc sandbox build <code>{tag_safe}</code>)</p>
          <p>On your <strong>iPhone in Safari</strong> open:</p>
          <p><a href="{share_url}">{share_url}</a></p>
          <p><img src="{qr}" alt="QR" width="240" height="240"/></p>
          <p>Must use Safari. Trust the developer certificate if iOS asks.</p>
        """,
    }
    req = urllib.request.Request(
        "https://api.resend.com/emails",
        data=json.dumps(mail).encode(),
        headers={
            "Authorization": f"Bearer {resend_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            print("PASS  emailed install link via Resend →", resend_to, resp.status)
    except Exception as e:
        print("WARN  Resend email failed:", e, file=sys.stderr)
else:
    print("HINT  Set RESEND_API_KEY + RESEND_FROM in Codemagic appstore to email the link automatically.")
PY
