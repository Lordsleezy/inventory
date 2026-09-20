# Floor register (Linux / Tauri)

In-store POS on the Ubuntu iMac. Phone remains card reader and mobile intake.
The register is the full store computer (sell + inventory) inside a kiosk.

## Build on this machine

```bash
sudo apt-get install -y build-essential pkg-config libssl-dev \
  libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev \
  librsvg2-dev libxdo-dev patchelf

# Repo root .env (gitignored):
#   VITE_SUPABASE_URL
#   VITE_SUPABASE_ANON_KEY
#   VITE_FUNCTIONS_URL=https://inventoryobi.netlify.app

. ~/.cargo/env   # after rustup
cd /path/to/inventory
npm ci
npm run tauri:dev -w @floor/pos      # or: npm run tauri:build -w @floor/pos
```

Release binary: `apps/pos/src-tauri/target/release/floor-pos` (gitignored).
CI can produce a `.deb` via `.github/workflows/pos-linux.yml`.

## Desktop launcher (pre-kiosk)

While the iMac still boots to a normal Ubuntu desktop, install a **Floor** app-grid / dock launcher that runs the same `floor-pos-kiosk` wrapper (so `/etc/floor-pos/webkit.env` is sourced):

```bash
bash apps/pos/packaging/install-desktop.sh
```

Re-run after each `npm run tauri:build -w @floor/pos` to refresh the binary. The `.deb` installs the same `.desktop` + hicolor icons system-wide. This does **not** enable greetd/Cage; use `install-kiosk.sh` only when you are ready for full kiosk mode.

## First run

1. Sign in as owner/manager.
2. Settings → set **tax rate** (required before checkout), receipt legal, Google review URL, CUPS printer.
3. Optional: pair phone reader when card is ready.
4. Set the admin PIN on this machine (shutdown / void).

## Printer

CUPS queue name or `/dev/usb/lp0` in Settings. Use letter/CUPS until the thermal arrives, then `roll80` or `roll58`.

## Kiosk install

```bash
sudo apt install ./floor-pos_VERSION_amd64.deb
# or install the release binary as /usr/bin/floor-pos and run install-kiosk.sh
sudo /usr/share/floor-pos/install-kiosk.sh
sudo passwd floor-admin
sudo reboot
```

After reboot: greetd autologins `floor-kiosk` into Cage → Floor.
Admin shell: **Ctrl+Alt+F2** as `floor-admin`.

### Optional WebKit workarounds (nouveau)

If the UI flickers or feels sticky:

```bash
sudo mkdir -p /etc/floor-pos
sudo nano /etc/floor-pos/webkit.env
```

Uncomment as needed:

```bash
# WEBKIT_DISABLE_DMABUF_RENDERER=1
# WEBKIT_DISABLE_COMPOSITING_MODE=1
```

The kiosk launcher sources `/etc/floor-pos/webkit.env` when present.
