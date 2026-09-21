#!/usr/bin/env bash
# Publish an over-the-air (Safari) install page for an ad-hoc IPA built on Codemagic.
#
# Creates a public Codemagic URL for the IPA, writes a proper iOS manifest.plist,
# hosts a tiny HTTPS install page via Netlify REST API (never netlify-cli in the monorepo),
# emails the link when RESEND_* is set, and prints a banner with the Safari URL + QR.
#
# Required env (Codemagic group appstore):
#   CODEMAGIC_TOKEN  — Codemagic → User settings → Integrations → Codemagic API
# Optional:
#   NETLIFY_AUTH_TOKEN + NETLIFY_SITE_ID — HTTPS install page (required for itms-services)
#   GITHUB_TOKEN — gist fallback for the manifest if Netlify is unset
#   RESEND_API_KEY + RESEND_FROM + OTA_EMAIL_TO — email the install link
set -euo pipefail

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
  exit 1
fi

export CM_ARTIFACT_LINKS="${CM_ARTIFACT_LINKS:-[]}"
if [ "$CM_ARTIFACT_LINKS" = "[]" ]; then
  echo "WARN  CM_ARTIFACT_LINKS empty — will resolve IPA via Builds API"
fi

python3 - "$BUNDLE_ID" "$APP_NAME" "$TAG_SAFE" "$EXPIRE_DAYS" <<'PY'
import io
import json
import os
import sys
import tempfile
import textwrap
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

bundle_id, app_name, tag_safe, expire_days = sys.argv[1:5]
cm_token = os.environ["CODEMAGIC_TOKEN"]


def cm_json(method: str, url: str, data=None):
    body = None if data is None else json.dumps(data).encode()
    req = urllib.request.Request(
        url,
        data=body,
        method=method,
        headers={
            "x-auth-token": cm_token,
            "Content-Type": "application/json",
            "User-Agent": "floor-ota",
        },
    )
    with urllib.request.urlopen(req, timeout=90) as resp:
        raw = resp.read()
        return json.loads(raw.decode()) if raw else {}


def ensure_https(url: str) -> str:
    if url.startswith("http://"):
        url = "https://" + url[len("http://") :]
    if not url.startswith("https://"):
        raise SystemExit(f"OTA URL must be HTTPS for itms-services, got: {url}")
    return url


# --- Resolve IPA artefact URL ---
links = []
try:
    links = json.loads(os.environ.get("CM_ARTIFACT_LINKS") or "[]")
except json.JSONDecodeError:
    links = []

ipa = None
for art in links:
    name = (art.get("name") or art.get("filename") or "")
    url = art.get("url") or ""
    typ = (art.get("type") or "").lower()
    if name.lower().endswith(".ipa") or typ == "ipa" or "/ipa" in url.lower():
        ipa = art
        break

if not ipa or not ipa.get("url"):
    build_id = os.environ.get("CM_BUILD_ID") or os.environ.get("FCI_BUILD_ID") or ""
    if build_id:
        try:
            info = cm_json("GET", f"https://api.codemagic.io/builds/{build_id}")
            build = info.get("build") or info
            for art in build.get("artefacts") or build.get("artifacts") or []:
                name = (art.get("name") or art.get("filename") or "")
                url = art.get("url") or ""
                if str(name).lower().endswith(".ipa") or "/ipa" in str(url).lower():
                    ipa = {"name": name, "url": url, "type": "ipa"}
                    print("PASS  resolved IPA via Builds API", name)
                    break
        except Exception as e:
            print("WARN  Builds API artefact lookup failed:", e, file=sys.stderr)

if not ipa or not ipa.get("url"):
    raise SystemExit(
        "No .ipa artefact URL available for OTA. "
        f"CM_ARTIFACT_LINKS={os.environ.get('CM_ARTIFACT_LINKS', '')[:200]!r}"
    )

auth_url = ipa["url"].rstrip("/")
expires_at = int(time.time()) + int(expire_days) * 86400
pub = cm_json("POST", auth_url + "/public-url", {"expiresAt": expires_at})
ipa_public = pub["url"]
print(f"PASS  public IPA URL (expires ~{expire_days}d)")

version = os.environ.get("CFBundleShortVersionString") or os.environ.get("MARKETING_VERSION") or "1.0"
build = os.environ.get("CFBundleVersion") or str(int(time.time()))
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

tmpdir = Path(tempfile.mkdtemp(prefix="floor-ota-", dir="/tmp"))
(tmpdir / "manifest.plist").write_text(manifest)
(tmpdir / "_headers").write_text(
    "/*\n  X-Frame-Options: DENY\n/manifest.plist\n  Content-Type: application/xml\n"
)

bootstrap = textwrap.dedent(
    f"""\
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
    """
)
(tmpdir / "index.html").write_text(bootstrap)

manifest_url = None
install_page_url = None
alias = f"ota-{tag_safe}"[:60].rstrip("-")

netlify_token = os.environ.get("NETLIFY_AUTH_TOKEN") or os.environ.get("NETLIFY_TOKEN")
netlify_site = os.environ.get("NETLIFY_SITE_ID") or os.environ.get("NETLIFY_SITE")

if netlify_token and netlify_site:
    # Zip deploy via REST API — never call netlify-cli inside the monorepo
    # (it detects workspace packages and refuses without --filter).
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in sorted(tmpdir.iterdir()):
            if p.is_file():
                zf.write(p, arcname=p.name)
    zip_bytes = buf.getvalue()
    deploy_endpoint = (
        f"https://api.netlify.com/api/v1/sites/{urllib.parse.quote(netlify_site)}/deploys"
        f"?title={urllib.parse.quote('floor-ota-' + alias)}"
        f"&branch={urllib.parse.quote(alias)}"
    )
    print("Deploying OTA zip to Netlify site", netlify_site, "branch", alias)
    req = urllib.request.Request(
        deploy_endpoint,
        data=zip_bytes,
        method="POST",
        headers={
            "Authorization": f"Bearer {netlify_token}",
            "Content-Type": "application/zip",
            "User-Agent": "floor-ota",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            meta = json.load(resp)
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", "replace")
        raise SystemExit(f"netlify zip deploy HTTP {e.code}: {err[:800]}") from e

    deploy_id = meta.get("id") or ""
    for _ in range(40):
        state = (meta.get("state") or "").lower()
        if state in ("ready", "current"):
            break
        if state in ("error", "failed"):
            raise SystemExit(f"netlify deploy error: {meta}")
        time.sleep(2)
        with urllib.request.urlopen(
            urllib.request.Request(
                f"https://api.netlify.com/api/v1/deploys/{deploy_id}",
                headers={"Authorization": f"Bearer {netlify_token}", "User-Agent": "floor-ota"},
            ),
            timeout=30,
        ) as resp:
            meta = json.load(resp)

    install_page_url = ensure_https(
        meta.get("deploy_ssl_url")
        or meta.get("ssl_url")
        or meta.get("deploy_url")
        or meta.get("url")
        or ""
    )
    manifest_url = install_page_url.rstrip("/") + "/manifest.plist"
    print(f"PASS  Netlify OTA page: {install_page_url}")
    print(f"PASS  manifest: {manifest_url}")
else:
    print("WARN  NETLIFY_AUTH_TOKEN / NETLIFY_SITE_ID unset — gist fallback")
    gh = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if not gh:
        raise SystemExit("Need NETLIFY_AUTH_TOKEN+NETLIFY_SITE_ID (preferred) or GITHUB_TOKEN")
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
    manifest_url = raw.split("?")[0] if "gist.githubusercontent.com" in raw else raw
    install_page_url = "itms-services://?action=download-manifest&url=" + urllib.parse.quote(
        manifest_url, safe=""
    )
    print(f"PASS  gist manifest: {manifest_url}")

itms = "itms-services://?action=download-manifest&url=" + urllib.parse.quote(manifest_url, safe="")
share_url = install_page_url if install_page_url.startswith("http") else itms
qr = "https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=" + urllib.parse.quote(
    share_url, safe=""
)

banner = f"""
================================================================================
FLOOR AD-HOC OTA INSTALL
================================================================================
1. On your iPhone, open Safari (not Chrome / not in-app browsers).
2. Go to:
   {share_url}
3. Or scan this QR:
   {qr}
4. Tap Install → Trust the developer cert if Settings prompts
   (General → VPN & Device Management).
================================================================================
"""
print(banner)
Path("/tmp/floor-ota-install-url.txt").write_text(share_url + "\n")
Path("/tmp/floor-ota-itms-url.txt").write_text(itms + "\n")
Path("/tmp/floor-ota-qr-url.txt").write_text(qr + "\n")

# Publish onto GitHub release for the tag when possible.
tag = os.environ.get("CM_TAG") or ""
gh_token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or ""
if tag and gh_token:
    notes = (
        f"Ad-hoc sandbox build with MockReaderUI.\n\n"
        f"**OTA install (open in Safari on a registered iPhone):**\n"
        f"{share_url}\n\n"
        f"QR: {qr}\n"
    )

    def gh_api(method, url, data=None):
        body = None if data is None else json.dumps(data).encode()
        req = urllib.request.Request(
            url,
            data=body,
            method=method,
            headers={
                "Authorization": f"Bearer {gh_token}",
                "Accept": "application/vnd.github+json",
                "Content-Type": "application/json",
                "User-Agent": "floor-ota",
            },
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read()
            return json.loads(raw.decode()) if raw else {}

    repo = os.environ.get("CM_REPO_SLUG") or os.environ.get("GITHUB_REPOSITORY") or "Lordsleezy/inventory"
    api = f"https://api.github.com/repos/{repo}"
    try:
        try:
            rel = gh_api("GET", f"{api}/releases/tags/{tag}")
            gh_api("PATCH", f"{api}/releases/{rel['id']}", {"body": notes, "name": tag, "prerelease": True})
            print("PASS  updated GitHub release notes with OTA URL")
        except Exception:
            rel = gh_api(
                "POST",
                f"{api}/releases",
                {"tag_name": tag, "name": tag, "body": notes, "draft": False, "prerelease": True},
            )
            print("PASS  created GitHub release", tag)
        upload_url = (rel.get("upload_url") or "").split("{")[0] + "?name=floor-ota-install-url.txt"
        req = urllib.request.Request(
            upload_url,
            data=share_url.encode(),
            method="POST",
            headers={
                "Authorization": f"Bearer {gh_token}",
                "Content-Type": "text/plain",
                "Accept": "application/vnd.github+json",
                "User-Agent": "floor-ota",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                print("PASS  uploaded floor-ota-install-url.txt", resp.status)
        except Exception as e:
            print("WARN  release asset upload:", e, file=sys.stderr)
    except Exception as e:
        print("WARN  GitHub release publish failed:", e, file=sys.stderr)

# Email via Resend when configured
resend_key = os.environ.get("RESEND_API_KEY")
resend_from = os.environ.get("RESEND_FROM")
resend_to = os.environ.get("OTA_EMAIL_TO") or os.environ.get("RESEND_TO") or "pgg124@gmail.com"
if resend_key and resend_from:
    mail = {
        "from": resend_from,
        "to": [resend_to],
        "subject": f"Floor iOS install ({tag_safe})",
        "html": (
            f"<p><strong>Install Floor</strong> (ad-hoc <code>{tag_safe}</code>)</p>"
            f"<p>On iPhone <strong>Safari</strong>: <a href=\"{share_url}\">{share_url}</a></p>"
            f"<p><img src=\"{qr}\" alt=\"QR\" width=\"240\" height=\"240\"/></p>"
        ),
    }
    req = urllib.request.Request(
        "https://api.resend.com/emails",
        data=json.dumps(mail).encode(),
        headers={"Authorization": f"Bearer {resend_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            print("PASS  emailed install link via Resend →", resend_to, resp.status)
    except Exception as e:
        print("WARN  Resend email failed:", e, file=sys.stderr)
PY
