# Phone access (PWA + iOS)

The iPhone loads the **live Floor adapter on the Surface**. It does not ship a frozen copy of the Next.js UI. API routes and InvenTree stay on the tablet.

## Bind (LAN + Tailscale, not the public internet)

`floor-adapter` listens on `0.0.0.0:3000` so Tailscale and LAN can connect.

Set in `/etc/floor/floor.env` (do not commit this file):

```
HOSTNAME=0.0.0.0
FLOOR_PUBLIC_URL=http://YOUR-TAILSCALE-NAME:3000
FLOOR_ORIGIN=http://YOUR-TAILSCALE-NAME:3000
```

`FLOOR_PUBLIC_URL` is what the Capacitor iOS shell opens (`capacitor.config.ts` `server.url`). Tailscale hostname is more stable than a DHCP LAN IP.

Do **not** port-forward 3000 or 80 on the WAN router.

Firewall (example `ufw`). Allow the shop LAN and Tailscale (`100.64.0.0/10`), deny the rest of the world:

```
sudo ufw allow from 192.168.0.0/16 to any port 3000 proto tcp
sudo ufw allow from 10.0.0.0/8 to any port 3000 proto tcp
sudo ufw allow from 100.64.0.0/10 to any port 3000 proto tcp
sudo ufw deny 3000/tcp
```

InvenTree on port 80 can stay localhost-only; the phone talks only to the adapter on 3000.

Cookies: `floor_session` is host-only, `SameSite=Lax`, not `Secure` (HTTP on Tailscale/LAN). Sign in on the same hostname you bookmark.

## PWA today (no App Store build)

On the iPhone, join Tailscale (or the shop LAN), open `http://<tailscale-or-lan>:3000/login`, sign in, then **Share → Add to Home Screen**. That is a standalone Floor icon. There is no service worker caching `/api`, so inventory stays live.

## Capacitor iOS

- Bundle ID: `com.openboxindustries.floor`
- Apple Team ID: `4SRR4NV35F` (Xcode / Codemagic only; not shown in the app)
- `npx cap add ios` is run on macOS or Codemagic. This Linux tree keeps `capacitor.config.ts` and points `server.url` at `FLOOR_PUBLIC_URL`.

## Codemagic

Create an App ID and provisioning profile for `com.openboxindustries.floor` on the Apple Developer account for team `4SRR4NV35F`. In Codemagic UI paste:

- `CM_CERTIFICATE` — distribution (or development) .p12, base64
- `CM_CERTIFICATE_PASSWORD`
- `CM_PROVISIONING_PROFILE` — matching profile, base64
- `FLOOR_PUBLIC_URL` — the Surface Tailscale origin, e.g. `http://floor:3000`

Do not put certs or the PIN in git. Pipeline: `codemagic.yaml`, trigger on tag `ios-*` or a manual run.
