# Phone access (standalone iOS + PWA fallback)

The **iOS product is a standalone app**. Capacitor bundles the Floor UI inside the ipa (`apps/adapter/www`). It does **not** open the Surface Next.js site in a WebView. `server.url` is not used.

Next.js API routes and InvenTree **cannot run inside iOS**. The first installable ipa has UI on the phone; live stock still needs the Surface (or another host) as a JSON API until an on-device database exists.

## Split

| Piece | Where it lives |
| --- | --- |
| Inventory / unit / photos / mark sold / receipts UI | Bundled in the ipa |
| `/api/*`, session, InvenTree, SQLite | Surface (`floor-adapter` on port 3000) |
| API origin | Phone setting, or optional `FLOOR_API_URL` in `www/config.json` |

On first launch the app asks for the API address (for example `http://192.168.68.51:3000`), pings `/api/ping`, then signs in with a PIN. The session token is sent as `Authorization: Bearer` — cookies are for the tablet browser only.

## Build the ipa (Codemagic)

This Linux tablet cannot archive an ipa. Codemagic (macOS) does.

### Apple Developer (team `4SRR4NV35F`)

1. [Identifiers](https://developer.apple.com/account/resources/identifiers/list/bundleId) → **+** → App IDs → App → explicit bundle `com.openboxindustries.floor` → name **Floor**.
2. [Certificates](https://developer.apple.com/account/resources/certificates/list) — skip if you connect Apple to Codemagic (it creates an Apple Distribution cert).
3. [App Store Connect → Apps](https://appstoreconnect.apple.com/apps) → **+** → New App → iOS → name **Floor**, SKU `floor`, bundle `com.openboxindustries.floor`.

### Codemagic (preferred — no p12 in git)

1. [codemagic.io](https://codemagic.io/login) → sign in (GitHub is easiest).
2. Add application → GitHub → `Lordsleezy/inventory`.
3. Teams → integrations → **Apple Developer Portal** → sign in with the same Apple ID (2FA). Codemagic then issues the Distribution cert + App Store profile for `com.openboxindustries.floor`.
4. App settings → `codemagic.yaml` workflow **ios-capacitor** → Start build (branch with the bundled UI, not an old `server.url` commit).
5. When the ipa finishes: artifact download, or enable publishing to App Store Connect → Testers → Internal → your Apple ID. Install **TestFlight** on the iPhone.

Manual signing instead of the Apple integration (never commit these):

- `CM_CERTIFICATE` — .p12, base64
- `CM_CERTIFICATE_PASSWORD`
- `CM_PROVISIONING_PROFILE` — matching profile, base64

`FLOOR_API_URL` defaults to `http://192.168.68.51:3000` in `codemagic.yaml` (JSON API only). The phone can change it.

Pipeline: `npm ci` → `npm run build -w @floor/mobile` → `npx cap add ios` if needed → `npx cap sync ios` → `scripts/ios-prepare.sh` → archive ipa.

Ad Hoc / Developer install needs the iPhone **UDID** on the profile. TestFlight does not.

Local (Linux can build `www`; Xcode archive needs macOS/CI):

```
npm run cap:www -w @floor/adapter
# on macOS:
cd apps/adapter && npx cap add ios && npx cap sync ios
bash scripts/ios-prepare.sh
```

`apps/adapter/ios/` and `apps/adapter/www/` are generated and gitignored.

## Surface API (still required for live stock)

`floor-adapter` listens on `0.0.0.0:3000`. Deploy the adapter so CORS and Bearer tokens are live.

Do **not** port-forward 3000 or 80 on the WAN router.

Firewall (example `ufw`). Allow the shop LAN and Tailscale (`100.64.0.0/10`):

```
sudo ufw allow from 192.168.0.0/16 to any port 3000 proto tcp
sudo ufw allow from 10.0.0.0/8 to any port 3000 proto tcp
sudo ufw allow from 100.64.0.0/10 to any port 3000 proto tcp
sudo ufw deny 3000/tcp
```

InvenTree on port 80 can stay localhost-only; the phone talks only to the adapter on 3000.

## PWA fallback (not the iOS product)

On the iPhone you can still open `http://<lan-or-tailscale>:3000/login` and **Add to Home Screen**. That loads the live Next UI from the Surface. There is no service worker caching `/api`.
