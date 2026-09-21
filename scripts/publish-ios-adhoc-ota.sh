#!/usr/bin/env bash
# Publish Safari OTA install page for an ad-hoc IPA (Codemagic publishing step).
#
# Hosts index.html + manifest.plist + App.ipa together on Netlify over HTTPS
# (same origin, no redirects). Manifest bundle-id/version are read from the IPA
# Info.plist so they match exactly.
#
# Required: CODEMAGIC_TOKEN, NETLIFY_AUTH_TOKEN, NETLIFY_SITE_ID
set -euo pipefail

BUNDLE_ID="${BUNDLE_ID:-com.openboxindustries.floor}"
APP_NAME="${OTA_APP_NAME:-Floor}"
TAG="${CM_TAG:-${CM_BRANCH:-adhoc}}"
TAG_SAFE="$(printf '%s' "$TAG" | tr -c 'A-Za-z0-9._-' '-' | sed 's/^-//;s/-$//')"

if [ -z "${CODEMAGIC_TOKEN:-}" ] && [ -n "${CM_API_TOKEN:-}" ]; then
  CODEMAGIC_TOKEN="$CM_API_TOKEN"
fi
: "${CODEMAGIC_TOKEN:?CODEMAGIC_TOKEN required}"
: "${NETLIFY_AUTH_TOKEN:?NETLIFY_AUTH_TOKEN required}"
: "${NETLIFY_SITE_ID:?NETLIFY_SITE_ID required}"

export CM_ARTIFACT_LINKS="${CM_ARTIFACT_LINKS:-[]}"

python3 - "$BUNDLE_ID" "$APP_NAME" "$TAG_SAFE" <<'PY'
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

bundle_id_hint, app_name, tag_safe = sys.argv[1:4]
cm_token = os.environ["CODEMAGIC_TOKEN"]
netlify_token = os.environ["NETLIFY_AUTH_TOKEN"]
netlify_site = os.environ["NETLIFY_SITE_ID"]


def http_json(method, url, data=None, headers=None, raw=None):
    body = raw if raw is not None else (None if data is None else json.dumps(data).encode())
    hdrs = {"User-Agent": "floor-ota"}
    if headers:
        hdrs.update(headers)
    if data is not None and raw is None:
        hdrs.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url, data=body, headers=hdrs, method=method)
    with urllib.request.urlopen(req, timeout=180) as resp:
        payload = resp.read()
        if not payload:
            return {}
        ctype = resp.headers.get("Content-Type", "")
        if "json" in ctype or payload[:1] in (b"{", b"["):
            return json.loads(payload.decode())
        return {"_raw": payload}


def ensure_https(url: str) -> str:
    if url.startswith("http://"):
        url = "https://" + url[len("http://") :]
    if not url.startswith("https://"):
        raise SystemExit(f"must be HTTPS: {url}")
    return url


def find_local_ipa() -> Path | None:
    candidates = []
    for pattern in ("build/ios/ipa/*.ipa", "**/build/ios/ipa/*.ipa", "**/*.ipa"):
        candidates.extend(Path(".").glob(pattern))
    # Prefer newest under build/ios/ipa
    preferred = [p for p in candidates if "build/ios/ipa" in str(p)]
    pool = preferred or candidates
    if not pool:
        return None
    return max(pool, key=lambda p: p.stat().st_mtime)


def resolve_ipa_bytes() -> tuple[bytes, str]:
    local = find_local_ipa()
    if local and local.is_file():
        print("PASS  using local IPA", local, local.stat().st_size)
        return local.read_bytes(), local.name

    links = []
    try:
        links = json.loads(os.environ.get("CM_ARTIFACT_LINKS") or "[]")
    except json.JSONDecodeError:
        pass
    url = None
    name = "App.ipa"
    for art in links:
        n = art.get("name") or art.get("filename") or ""
        u = art.get("url") or ""
        if str(n).lower().endswith(".ipa") or "/ipa" in u.lower():
            url, name = u, (n or "App.ipa")
            break
    if not url:
        build_id = os.environ.get("CM_BUILD_ID") or os.environ.get("FCI_BUILD_ID") or ""
        if build_id:
            info = http_json(
                "GET",
                f"https://api.codemagic.io/builds/{build_id}",
                headers={"x-auth-token": cm_token},
            )
            build = info.get("build") or info
            for art in build.get("artefacts") or build.get("artifacts") or []:
                n = art.get("name") or ""
                u = art.get("url") or ""
                if str(n).lower().endswith(".ipa") or "/ipa" in str(u).lower():
                    url, name = u, (n or "App.ipa")
                    break
    if not url:
        raise SystemExit("No IPA found locally or in Codemagic artefacts")

    # Fetch authenticated artefact URL, then follow to final body (no auth on GCS).
    req = urllib.request.Request(url, headers={"x-auth-token": cm_token, "User-Agent": "floor-ota"})
    with urllib.request.urlopen(req, timeout=300) as resp:
        data = resp.read()
        final = resp.geturl()
    print("PASS  downloaded IPA via", final[:80], "bytes", len(data))
    return data, name.split("/")[-1] or "App.ipa"


def read_ipa_info(ipa_bytes: bytes) -> tuple[str, str, str, dict]:
    """Return bundle_id, version(build), short_version, provision_summary."""
    tmp = Path(tempfile.mkdtemp(prefix="floor-ipa-", dir="/tmp"))
    ipa_path = tmp / "App.ipa"
    ipa_path.write_bytes(ipa_bytes)
    subprocess.run(["unzip", "-q", str(ipa_path), "-d", str(tmp / "out")], check=True)
    apps = list((tmp / "out" / "Payload").glob("*.app"))
    if not apps:
        raise SystemExit("IPA has no Payload/*.app")
    app = apps[0]
    import plistlib

    info = plistlib.loads((app / "Info.plist").read_bytes())
    bundle_id = str(info.get("CFBundleIdentifier") or "")
    build_ver = str(info.get("CFBundleVersion") or "")
    short_ver = str(info.get("CFBundleShortVersionString") or "")
    if not bundle_id or not build_ver:
        raise SystemExit(f"IPA Info.plist missing id/version: {bundle_id!r} {build_ver!r}")

    summary = {"get_task_allow": None, "devices": [], "name": None, "team": None}
    prov = app / "embedded.mobileprovision"
    if prov.is_file():
        decoded = tmp / "prov.plist"
        ok = False
        for cmd in (
            ["security", "cms", "-D", "-i", str(prov)],
            ["openssl", "smime", "-inform", "DER", "-verify", "-noverify", "-in", str(prov)],
        ):
            try:
                r = subprocess.run(cmd, capture_output=True)
                if r.returncode == 0 and r.stdout:
                    decoded.write_bytes(r.stdout)
                    ok = True
                    break
            except FileNotFoundError:
                continue
        if ok:
            p = plistlib.loads(decoded.read_bytes())
            summary["name"] = p.get("Name")
            summary["team"] = p.get("TeamIdentifier")
            summary["get_task_allow"] = (p.get("Entitlements") or {}).get("get-task-allow")
            summary["devices"] = list(p.get("ProvisionedDevices") or [])

    shutil.rmtree(tmp, ignore_errors=True)
    return bundle_id, build_ver, short_ver, summary


ipa_bytes, ipa_name = resolve_ipa_bytes()
if not ipa_name.lower().endswith(".ipa"):
    ipa_name = "App.ipa"
# Stable name for OTA URL
ipa_name = "App.ipa"

bundle_id, build_ver, short_ver, prov = read_ipa_info(ipa_bytes)
print("PASS  IPA Info.plist", bundle_id, "build", build_ver, "short", short_ver)
print(
    "PASS  provision",
    prov.get("name"),
    "get-task-allow=",
    prov.get("get_task_allow"),
    "devices=",
    len(prov.get("devices") or []),
)

if prov.get("get_task_allow") is True:
    raise SystemExit("FAIL  IPA is development-signed (get-task-allow=true); need Ad Hoc distribution")

want = os.environ.get("IOS_DEVICE_UDID") or ""
if want:
    wn = re.sub(r"[^0-9A-Fa-f]", "", want).upper()
    devices = [re.sub(r"[^0-9A-Fa-f]", "", d).upper() for d in (prov.get("devices") or [])]
    if wn not in devices:
        raise SystemExit(
            f"FAIL  IOS_DEVICE_UDID not in embedded.mobileprovision "
            f"(want={want}, have={prov.get('devices')})"
        )
    print("PASS  IOS_DEVICE_UDID is in embedded.mobileprovision")
elif not (prov.get("devices") or []):
    print("WARN  profile has zero ProvisionedDevices")

# Host IPA + manifest + page on Netlify (HTTPS, no redirect).
alias = f"ota-{tag_safe}"[:60].rstrip("-")
# Placeholder — real URL known after deploy; we use relative App.ipa in the final manifest.
# For the first zip we embed a relative URL that Safari resolves against the page origin.
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
          <string>__IPA_URL__</string>
        </dict>
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key>
        <string>{bundle_id}</string>
        <key>bundle-version</key>
        <string>{build_ver}</string>
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

page = textwrap.dedent(
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
      <p class="hint">Open in <strong>Safari</strong> on your registered iPhone, then tap Install.</p>
      <p><a class="btn" id="install" href="#">Install {app_name}</a></p>
      <p class="hint">Tag <code>{tag_safe}</code> · {bundle_id} · build {build_ver}</p>
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

# Two-step: first deploy to learn SSL URL, then redeploy with absolute IPA URL in manifest.
# Or: compute expected alias URL. Netlify branch deploys are:
#   https://<branch>--<site-subdomain>.netlify.app
# We don't know subdomain from site id alone — deploy once, read URL, rewrite manifest, redeploy.

tmpdir = Path(tempfile.mkdtemp(prefix="floor-ota-", dir="/tmp"))


def zip_deploy(files: dict[str, bytes], branch: str) -> dict:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in files.items():
            zf.writestr(name, data)
    endpoint = (
        f"https://api.netlify.com/api/v1/sites/{urllib.parse.quote(netlify_site)}/deploys"
        f"?title={urllib.parse.quote('floor-ota-' + branch)}"
        f"&branch={urllib.parse.quote(branch)}"
    )
    req = urllib.request.Request(
        endpoint,
        data=buf.getvalue(),
        method="POST",
        headers={
            "Authorization": f"Bearer {netlify_token}",
            "Content-Type": "application/zip",
            "User-Agent": "floor-ota",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            meta = json.load(resp)
    except urllib.error.HTTPError as e:
        raise SystemExit(f"netlify deploy HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:800]}") from e

    deploy_id = meta["id"]
    for _ in range(60):
        state = (meta.get("state") or "").lower()
        if state in ("ready", "current"):
            return meta
        if state in ("error", "failed"):
            raise SystemExit(f"netlify deploy failed: {meta}")
        time.sleep(2)
        with urllib.request.urlopen(
            urllib.request.Request(
                f"https://api.netlify.com/api/v1/deploys/{deploy_id}",
                headers={"Authorization": f"Bearer {netlify_token}", "User-Agent": "floor-ota"},
            ),
            timeout=30,
        ) as resp:
            meta = json.load(resp)
    raise SystemExit(f"netlify deploy timeout: {meta}")


headers_file = b"/*\n  X-Frame-Options: DENY\n/manifest.plist\n  Content-Type: application/xml\n/App.ipa\n  Content-Type: application/octet-stream\n  Content-Disposition: attachment\n"

# Pass 1 — discover HTTPS deploy URL (manifest IPA url placeholder still broken until pass 2)
meta1 = zip_deploy(
    {
        "index.html": page.encode(),
        "manifest.plist": manifest.replace("__IPA_URL__", "https://invalid.example/App.ipa").encode(),
        "App.ipa": ipa_bytes,
        "_headers": headers_file,
    },
    alias,
)
base = ensure_https(
    meta1.get("deploy_ssl_url") or meta1.get("ssl_url") or meta1.get("deploy_url") or meta1.get("url") or ""
)
ipa_url = base.rstrip("/") + "/App.ipa"
manifest_final = manifest.replace("__IPA_URL__", ipa_url)
print("PASS  Netlify base", base)

# Pass 2 — rewrite manifest with absolute HTTPS IPA URL on same host
meta2 = zip_deploy(
    {
        "index.html": page.encode(),
        "manifest.plist": manifest_final.encode(),
        "App.ipa": ipa_bytes,
        "_headers": headers_file,
    },
    alias,
)
install_page_url = ensure_https(
    meta2.get("deploy_ssl_url") or meta2.get("ssl_url") or meta2.get("deploy_url") or meta2.get("url") or base
)
manifest_url = install_page_url.rstrip("/") + "/manifest.plist"

# Verify public IPA download: HTTPS, 200, no auth, minimal redirects
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError(f"unexpected redirect {code} -> {newurl}")


opener = urllib.request.build_opener(NoRedirect)
try:
    with opener.open(ipa_url, timeout=60) as resp:
        code = getattr(resp, "status", 200)
        final = resp.geturl()
        # read a few bytes to prove body
        chunk = resp.read(64)
except RuntimeError as e:
    # One redirect is unacceptable per requirements — fail
    raise SystemExit(f"FAIL  IPA URL redirected (iOS OTA hates this): {e}") from e
except urllib.error.HTTPError as e:
    raise SystemExit(f"FAIL  IPA URL HTTP {e.code}") from e

if code != 200 or not chunk:
    raise SystemExit(f"FAIL  IPA URL bad response code={code} bytes={len(chunk) if chunk else 0}")
if final != ipa_url:
    raise SystemExit(f"FAIL  IPA URL changed to {final}")
print("PASS  IPA URL public HTTPS no-redirect", ipa_url)

# Verify manifest matches IPA
man = urllib.request.urlopen(manifest_url, timeout=30).read().decode()
if f"<string>{bundle_id}</string>" not in man:
    raise SystemExit("FAIL  manifest bundle-identifier mismatch")
if f"<string>{build_ver}</string>" not in man:
    raise SystemExit(f"FAIL  manifest bundle-version mismatch want={build_ver}")
if ipa_url not in man:
    raise SystemExit("FAIL  manifest IPA url mismatch")
print("PASS  manifest matches IPA Info.plist exactly")

itms = "itms-services://?action=download-manifest&url=" + urllib.parse.quote(manifest_url, safe="")
qr = "https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=" + urllib.parse.quote(
    install_page_url, safe=""
)

banner = f"""
================================================================================
FLOOR AD-HOC OTA INSTALL
================================================================================
Safari on iPhone:
  {install_page_url}
QR:
  {qr}
bundle {bundle_id}  build {build_ver}  devices_in_profile {len(prov.get('devices') or [])}
================================================================================
"""
print(banner)
Path("/tmp/floor-ota-install-url.txt").write_text(install_page_url + "\n")
Path("/tmp/floor-ota-itms-url.txt").write_text(itms + "\n")
Path("/tmp/floor-ota-qr-url.txt").write_text(qr + "\n")

# GitHub release notes
tag = os.environ.get("CM_TAG") or ""
gh_token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or ""
if tag and gh_token:
    notes = (
        f"Ad-hoc sandbox build.\n\n"
        f"**OTA (Safari):** {install_page_url}\n\n"
        f"`{bundle_id}` build `{build_ver}`\n"
    )
    repo = os.environ.get("CM_REPO_SLUG") or os.environ.get("GITHUB_REPOSITORY") or "Lordsleezy/inventory"
    api = f"https://api.github.com/repos/{repo}"

    def gh(method, url, data=None):
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

    try:
        try:
            rel = gh("GET", f"{api}/releases/tags/{tag}")
            gh("PATCH", f"{api}/releases/{rel['id']}", {"body": notes, "prerelease": True})
        except Exception:
            gh(
                "POST",
                f"{api}/releases",
                {"tag_name": tag, "name": tag, "body": notes, "prerelease": True},
            )
        print("PASS  GitHub release notes updated")
    except Exception as e:
        print("WARN  GitHub release:", e, file=sys.stderr)
PY
