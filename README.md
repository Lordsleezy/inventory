# Floor

Desktop operating system for a one-machine liquidation store. Every physical unit is one-of-one. Staff never see InvenTree.

One Surface Pro (or any Zorin/Ubuntu box) is the server, the inventory terminal, the register, and the listing station. Everything binds to localhost.

**License:** UNLICENSED. InvenTree remains MIT.

Do not commit `.env.local`, `config/floor.json`, `config/staff.json`, or any `*.sqlite3` file. Those are live store data.

---

## Install (download one file)

Fresh Zorin, nothing installed. Get the installer from the
[latest release](https://github.com/Lordsleezy/inventory/releases/latest) — one file,
`floor-<version>-linux-x64.run`. Then:

```bash
cd ~/Downloads
sudo bash floor-1.0.2-linux-x64.run
```

Run it with `sudo bash`, not `sudo ./file`. Browsers save downloads without the
execute bit, and on some setups `chmod +x` in `~/Downloads` does not stick — `bash`
does not care either way.

It asks once for an InvenTree admin password and once for a Floor unlock PIN, then
does the rest: InvenTree on SQLite, config, probe, bootstrap, desktop launcher, and
starting on boot. When it prints `PASS Floor is installed and running`, open the Floor
icon in the applications menu and sign in with your PIN.

Needs internet while it runs, and takes several minutes — almost all of it InvenTree.

Works on Zorin 17 and 18, Ubuntu 20.04/22.04/24.04, and the Ubuntu-based
derivatives (Mint, Pop!_OS, elementary). It reads the Ubuntu base out of
`/etc/os-release` rather than the distro's own name, which is what upstream's
installer gets wrong on anything that is not literally Ubuntu.

### What is in the file, and what is not

| Bundled in the installer | Fetched while installing |
|---|---|
| Node runtime (your system Node is never touched) | **InvenTree** — a Python/Django stack, from get.inventree.org |
| Electron desktop shell | `curl` and `tar`, only if missing |
| Floor and every npm dependency, prebuilt for x64 | |

InvenTree is genuinely not bundled and cannot honestly be made so: it is a Python
application that compiles a virtualenv against the machine it lands on. Everything
Floor itself needs is in the file.

### Update without losing anything

Download the newer `.run` and run the same command:

```bash
sudo bash floor-<new-version>-linux-x64.run
```

It detects the existing install and replaces only the program files. Your inventory,
SQLite database, `config/floor.json`, photos, password, and PIN are all kept. To force
it, add `--update`; it will refuse rather than do a fresh install.

To change just the unlock PIN: `sudo bash floor-<version>-linux-x64.run --reconfigure`.

Re-running after a failed install is safe. It skips whatever already succeeded,
clears a half-configured apt state, and never re-asks for secrets it already has.

### Where things live after install

| | |
|---|---|
| Your data (config, SKU ledger, photos) | `/var/lib/floor` |
| Inventory database | `/opt/inventree/data/inventree.sqlite3` |
| Secrets, root-owned | `/etc/floor/floor.env` |
| Program files, replaced on update | `/opt/floor` |
| Backup everything | `sudo floor-backup` |
| Health check | `sudo floor-probe` |
| Logs | `journalctl -u floor-adapter -f` |

### If it fails

The installer stops at the first failure and prints what to do. It is safe to fix the
problem and run it again — nothing is left half-installed.

---

## Build the installer

Releases are cut by CI, because the artifact is linux-x64 and has to be built and
tested on linux-x64:

```bash
npm version patch
git push && git push --tags
```

The tag triggers `.github/workflows/release.yml`, which runs the tests, builds
`floor-<version>-linux-x64.run`, and publishes it as a release with a SHA-256.

To build one by hand on a Linux x64 box:

```bash
npm ci
installer/make-run.sh          # -> build/floor-<version>-linux-x64.run
```

`installer/make-run.sh` refuses to run anywhere else, since a cross-built artifact
would not be trustworthy. Two checks run without any special machine:

```bash
bash installer/selftest-header.sh   # payload offset and round trip
bash installer/selftest-env.sh      # secret quoting
```

---

## Install from source (developers)

Nothing else installed. Internet once, for packages. After that it can stay unplugged.

Pick two secrets now and write them down. You will type them several times.

- **InvenTree admin password** — long, not a PIN.
- **Floor unlock PIN** — 4–8 digits. This is how you sign into Floor. It is not the InvenTree password.

### 1. Base packages

```bash
sudo apt-get update
sudo apt-get install -y git wget curl ca-certificates gnupg unzip
```

**PASS:** `git --version` and `curl --version` print versions.  
**FAIL:** `apt-get` errors. Fix networking and rerun. Do not install Docker.

### 2. Node.js 22

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version
```

**PASS:** `v22.x.x` or newer.  
**FAIL:** `v12` / `v18` from Ubuntu’s repo. `sudo apt-get remove -y nodejs` and rerun the NodeSource commands.

### 3. Clone

```bash
git clone https://github.com/Lordsleezy/inventory.git ~/liquidation-os
cd ~/liquidation-os
```

**PASS:** `ls README.md scripts/setup.sh infra/inventree/bootstrap.mjs` lists all three files.  
**FAIL:** clone error. Check the URL and that `git` works.

### 4. Floor setup script

```bash
chmod +x scripts/setup.sh
./scripts/setup.sh
```

**PASS:** last line includes `PASS  npm install`, and it wrote `apps/adapter/.env.local` and `config/floor.json` if they were missing.  
**FAIL:** Node too old, or `npm install` error. Fix Node, then rerun. The script is safe to run again.

### 5. Edit config (required)

```bash
nano apps/adapter/.env.local
```

Set:

- `INVENTREE_ADMIN_PASSWORD` to the InvenTree admin password you picked
- `FLOOR_DEV_PIN` to your unlock PIN
- `FLOOR_SESSION_SECRET` to a long random string (`openssl rand -hex 32`)

Save. Then:

```bash
nano config/floor.json
```

Set store name, tax, conditions, and payment methods. Leave the rest until you know you need it.

**PASS:** `.env.local` has no `YOUR_` placeholders left.  
**FAIL:** you skipped this and later login says `Wrong PIN` or InvenTree says 401.

### 6. Install InvenTree (SQLite)

```bash
export INVENTREE_ADMIN_USER=admin
export INVENTREE_ADMIN_PASSWORD='YOUR_INVENTREE_ADMIN_PASSWORD'
export INVENTREE_ADMIN_EMAIL=admin@localhost
export INVENTREE_DB_ENGINE=sqlite3
export INVENTREE_DB_NAME=/opt/inventree/data/inventree.sqlite3
export SETUP_NO_CALLS=true

wget -qO /tmp/inventree-install.sh https://get.inventree.org
sudo --preserve-env=INVENTREE_ADMIN_USER,INVENTREE_ADMIN_PASSWORD,INVENTREE_ADMIN_EMAIL,INVENTREE_DB_ENGINE,INVENTREE_DB_NAME,SETUP_NO_CALLS \
  bash /tmp/inventree-install.sh
```

Use the real admin password, not the placeholder. This takes several minutes.

**PASS:**

```bash
inventree run invoke version
ls -l /opt/inventree/data/inventree.sqlite3
```

prints a version and a sqlite file larger than 0 bytes.

**FAIL:** see the table under “Install InvenTree” in the runbook below. Do not install Docker.

Then pin SQLite and find the API URL:

```bash
cd ~/liquidation-os
chmod +x infra/inventree/find-url.sh
# follow “Pin a small localhost SQLite process” below, then:
infra/inventree/find-url.sh
export INVENTREE_URL=http://127.0.0.1    # use whatever find-url printed
export INVENTREE_ADMIN_USER=admin
export INVENTREE_ADMIN_PASSWORD='YOUR_INVENTREE_ADMIN_PASSWORD'
nano apps/adapter/.env.local             # set INVENTREE_URL to the same origin
```

### 7. Prove InvenTree, then start Floor

```bash
cd ~/liquidation-os
export INVENTREE_URL=http://127.0.0.1    # same as find-url
export INVENTREE_ADMIN_USER=admin
export INVENTREE_ADMIN_PASSWORD='YOUR_INVENTREE_ADMIN_PASSWORD'
node infra/inventree/probe.mjs
```

**PASS:** last line is `PASS  probe` and `/api/user/me/token/` returned a token.  
**FAIL:** stop. A 404 on that token path is a hard failure — do not guess another path.

```bash
node infra/inventree/bootstrap.mjs
```

**PASS:** last line is `PASS  M1 proof`.  
**FAIL:** see the bootstrap table below.

```bash
npm run adapter
```

**PASS:** `Local: http://127.0.0.1:3000`. Open that in Firefox. Sign in as **Admin** with your PIN. Inventory loads.  
**FAIL:** `INVENTREE_URL is not set` — edit `.env.local`. `Wrong PIN` — `FLOOR_DEV_PIN` does not match what you typed. Port in use — something else is on 3000.

Optional desktop shell (after the adapter is already running):

```bash
npm run desktop
```

---

## What this repo is

Target machine: one Surface Pro 7 on Zorin OS, ~8GB RAM. That machine is the server, the inventory terminal, the register, and the listing station. Everything is localhost.

`infra/inventree/docker-compose.yml` is **Windows-dev only**. It is not how this runs on the floor. Do not install Docker on the Surface.

**WSL is a development-verification environment only.** It exists so we can prove the installer scripts, settings keys, and token path on Ubuntu 22.04 (jammy) without the Surface in the room. It is not the deployment path.

The official Zorin `.deb` is still unverified. **Source install is the verified arm64 fallback** (proven on this WSL box: Python 3.12, `invoke install` / `invoke update`, SQLite under `/home/inventree/data`). If the Surface `.deb` fights us, use that same source path. RAM and SQLite-under-load still have to be answered on the Surface.

Work inside WSL only on the Linux filesystem (`~/liquidation-os`, InvenTree data under `/home/inventree/data`). Do not put the app or SQLite on `/mnt/c`.

---

## Milestone 1 on a fresh Surface (the real proof)

Assume: brand-new Zorin, nothing else installed, you have this repo on a USB stick, and the Surface can reach the internet for the one-time package download. After that it can stay unplugged.

Pick an admin password now and reuse it everywhere below. Example used in this runbook: `YOUR_INVENTREE_ADMIN_PASSWORD`. Use something longer on the real machine.

### 0. Copy the repo onto the Surface

**On the Windows PC** (repo at `C:\Users\pgg12\Desktop\everything\liquidation-os`), plug in a USB drive. If it is `E:`:

```powershell
powershell -File C:\Users\pgg12\Desktop\everything\liquidation-os\scripts\pack-for-surface.ps1 E:\
```

**PASS:** prints `PASS  copied to E:\liquidation-os`  
**FAIL:** robocopy error. Do not copy `node_modules` by hand — leave it behind.

**On the Surface:** plug in the same drive and copy the folder to your home directory.

```bash
cp -a /media/$USER/*/liquidation-os ~/liquidation-os
ls ~/liquidation-os/infra/inventree/bootstrap.mjs
```

**PASS:** that file exists.  
**FAIL:** you copied the wrong folder. The USB root should contain `liquidation-os/`, not a nest of `Desktop/everything/...`.

If the USB auto-mount path is different, `ls /media/$USER` and copy from there.

### 1. Base packages

```bash
. /etc/os-release
echo "$NAME $VERSION_ID  ubuntu=$UBUNTU_CODENAME"
sudo apt-get update
sudo apt-get install -y wget curl ca-certificates gnupg unzip
```

**PASS:** `UBUNTU_CODENAME` is `jammy` (Zorin 17 / Ubuntu 22.04) or `noble` (Ubuntu 24.04). The InvenTree installer supports those.  
**FAIL:** a different codename. Stop. Do not install Docker as a workaround. Note the codename and we will pick a supported install path.

### 2. Node.js 22 (needed to run the probe and bootstrap scripts)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version
```

**PASS:** `v22.x.x` or newer.  
**FAIL:** `command not found`, or `v12` / `v18` from Ubuntu’s default repo. You installed the wrong Node. Remove it (`sudo apt-get remove -y nodejs`) and rerun the NodeSource commands.

You do **not** need `npm install` for milestone 1. `bootstrap.mjs` and `probe.mjs` are plain Node. No project dependencies.

### 3. Install InvenTree (SQLite, official package)

```bash
export INVENTREE_ADMIN_USER=admin
export INVENTREE_ADMIN_PASSWORD='YOUR_INVENTREE_ADMIN_PASSWORD'
export INVENTREE_ADMIN_EMAIL=admin@localhost
export INVENTREE_DB_ENGINE=sqlite3
export INVENTREE_DB_NAME=/opt/inventree/data/inventree.sqlite3
export SETUP_NO_CALLS=true

wget -qO /tmp/inventree-install.sh https://get.inventree.org
sudo --preserve-env=INVENTREE_ADMIN_USER,INVENTREE_ADMIN_PASSWORD,INVENTREE_ADMIN_EMAIL,INVENTREE_DB_ENGINE,INVENTREE_DB_NAME,SETUP_NO_CALLS \
  bash /tmp/inventree-install.sh
```

This takes several minutes.

**PASS:** the script exits 0 and these work:

```bash
inventree run invoke version
ls -l /opt/inventree/data/inventree.sqlite3
```

`invoke version` prints an InvenTree version. The sqlite file exists and is larger than 0 bytes.

**FAIL:**

| What you see | Meaning |
|---|---|
| `permission denied` on `install.sh` | rerun with `sudo --preserve-env=...` as above |
| installer says the OS is unsupported | stop — do not switch to Docker |
| `inventree: command not found` | package did not install; `sudo apt-get install -y inventree` after adding their repo, or rerun the script and read the last 50 lines |
| sqlite file missing or 0 bytes | migrations did not run; `sudo inventree run invoke update` then `sudo inventree restart` and check the file again |
| it installed PostgreSQL / a `postgres` service you did not ask for | wrong engine leaked in; set the `INVENTREE_DB_*` values in step 4 and rerun `invoke update` before continuing |

### 4. Pin a small localhost SQLite process

```bash
sudo inventree config:set INVENTREE_DB_ENGINE=sqlite3
sudo inventree config:set INVENTREE_DB_NAME=/opt/inventree/data/inventree.sqlite3
sudo inventree config:set INVENTREE_DB_WAL_MODE=True
sudo inventree config:set INVENTREE_DB_TIMEOUT=30
sudo inventree config:set INVENTREE_PLUGINS_ENABLED=False
sudo inventree config:set INVENTREE_GUNICORN_WORKERS=1
sudo inventree scale worker=1
sudo inventree restart
```

**PASS:** `sudo inventree logs --tail` shows the web process up, no Postgres connection errors, no Redis connection errors.  
**FAIL:** repeated database errors. Run `sudo inventree run invoke update`, then `sudo inventree restart`, and read `sudo inventree logs --tail`. Still failing = stop and keep the log.

Confirm it is SQLite, not Postgres:

```bash
sudo inventree config | grep -i db
```

**PASS:** engine is `sqlite3` and the name path ends in `inventree.sqlite3`.  
**FAIL:** engine is `postgresql` or `mysql`. Set the three `INVENTREE_DB_*` values again, `invoke update`, restart.

### 5. Find the API URL

The package serves InvenTree behind nginx. It is usually `http://127.0.0.1`, **not** port 8000 (that port is Windows Docker only).

```bash
cd ~/liquidation-os
chmod +x infra/inventree/find-url.sh
infra/inventree/find-url.sh
```

**PASS:**

```
PASS  InvenTree API at http://127.0.0.1
export INVENTREE_URL=http://127.0.0.1
```

Copy that `export` into this terminal. Then:

```bash
export INVENTREE_URL=http://127.0.0.1          # use whatever find-url printed
export INVENTREE_ADMIN_USER=admin
export INVENTREE_ADMIN_PASSWORD='YOUR_INVENTREE_ADMIN_PASSWORD'
curl -fsS -u "$INVENTREE_ADMIN_USER:$INVENTREE_ADMIN_PASSWORD" "$INVENTREE_URL/api/" | head
```

**PASS:** JSON containing `"server-version"`.  
**FAIL:**

| What you see | Meaning |
|---|---|
| `FAIL  no InvenTree API on localhost` | nginx/InvenTree is down — `sudo inventree restart` and `sudo inventree logs --tail` |
| `401` / `403` | wrong password. Check `/etc/inventree/admin_password` if the installer invented one: `sudo cat /etc/inventree/admin_password` |
| HTML login page instead of JSON | you hit the website, not `/api/`. The URL must include the origin only; scripts append `/api/` |

### 6. Probe settings and the token path

```bash
cd ~/liquidation-os
node infra/inventree/probe.mjs
```

**PASS:** last line is `PASS  probe`, and you also see:

- `PASS  API http://…  InvenTree <version>`
- `PASS  unique-serials key is SERIAL_NUMBER_GLOBALLY_UNIQUE = …`
- `PASS  delete-serialized key is …`
- `PASS  /api/user/me/token/ returned a token`

**FAIL:** last line is `FAIL  probe` or the process exits non-zero. A 404 on `/api/user/me/token/` is a hard failure — do not fall back to `/api/user/token/`.

| What you see | Meaning |
|---|---|
| `INVENTREE_URL is required` | you skipped the `export` in step 5 |
| `INVENTREE_ADMIN_PASSWORD is required` | same |
| `FAIL  probe could not reach InvenTree` | URL or service is wrong; rerun step 5 |
| `FAIL  no globally-unique-serials setting` | this InvenTree build is too old or the settings API changed — stop, keep the probe output |
| `FAIL  neither token path returned a token` | do not invent a login path; keep the output |

Write down the token endpoint line. Milestone 2 login uses that exact path.

### 7. Bootstrap — five units and a collision reject

```bash
cd ~/liquidation-os
node infra/inventree/bootstrap.mjs
```

**PASS:** last status line is `PASS  M1 proof`, and you also see:

- `PASS  settings SERIAL_NUMBER_GLOBALLY_UNIQUE=on …=off`
- `PASS  token endpoint /api/user/…/token/`
- `PASS  created SKU 11111` … `11115` (or `already exists — skip create` on a rerun)
- `PASS  collision on 11111 rejected`
- `PASS  11113 ask=145000 condition=Excellent; 11112 ask empty (not zero)`

A JSON block at the end repeats version, token path, setting keys, and the SKU list.

**FAIL:** last line is `FAIL  M1 proof` and a non-zero exit.

| What you see | Meaning |
|---|---|
| `SKU collision was NOT rejected` | globally unique serials did not stick. Rerun probe, confirm the unique-serials key is `true`, then rerun bootstrap |
| `metadata round-trip failed` / `condition lost` | metadata PATCH is not sticking. Keep the error body |
| `empty ask became a number` / `empty acquisition cost should be blank` | empty was coerced to zero — stop, that is a data bug |
| `400` on `POST /api/part/` or `/api/stock/` | read the printed body; often `trackable` was rejected or auth is not admin |

Rerunning bootstrap is safe. Existing SKUs are skipped. The collision check still runs.

### 8. What “M1 done” means on this machine

All of these are true:

1. InvenTree is the Zorin package, talking to `/opt/inventree/data/inventree.sqlite3`.
2. `node infra/inventree/probe.mjs` prints `PASS  probe`.
3. `node infra/inventree/bootstrap.mjs` prints `PASS  M1 proof`.
4. Admin can open InvenTree in a browser at the same origin as `INVENTREE_URL` and see parts / stock. Staff will never use that UI once Floor exists.

You can unplug the network after step 3. Everything above is localhost.

---

## Admin access to InvenTree

Staff do not use this. Admin only, for edge cases.

Open the origin printed by `find-url.sh` (usually `http://127.0.0.1`) in Firefox on the Surface. Log in as `admin` with the password from step 3. Do not expose that port off the machine.

---

## Where the database lives

| Install | Database file | Media / attachments |
|---|---|---|
| **Zorin package (production)** | `/opt/inventree/data/inventree.sqlite3` | `/opt/inventree/data/` |
| Windows Docker (dev only) | `data/inventree/inventree.sqlite3` in this repo | `data/inventree/` |

Backup on the Surface (stop first so WAL checkpoints):

```bash
sudo inventree stop
sudo cp -a /opt/inventree/data /opt/inventree/data-backup-$(date +%F)
sudo inventree restart
```

Restore: stop, replace `/opt/inventree/data` with the backup directory, start.

---

## Staff PINs (after M1)

Django rejects a 4-digit PIN as a user password. Floor stores a PIN hash plus a generated InvenTree password in `config/staff.json` (not checked in).

1. Put real 4–8 digit PINs in `config/staff.example.json`.
2. Same env vars as step 5, then `node infra/inventree/provision-staff.mjs`.

Login uses the hard-configured token path `/api/user/me/token/`. A 404 is a hard failure — do not fall back to `/api/user/token/`.

---

## Milestone 2 — Floor app (inventory)

Adapter + Electron shell. Staff can sign in, browse inventory, search, and open a unit. No POS. No marketplace scaffolding.

The UI never talks to InvenTree. Token login is `/api/user/me/token/` only.

On WSL, with InvenTree already running on `127.0.0.1:8000`:

```bash
cd ~/liquidation-os
rsync -a --exclude node_modules --exclude .git --exclude data \
  /mnt/c/Users/pgg12/Desktop/everything/liquidation-os/ ~/liquidation-os/
cd ~/liquidation-os
npm install
export INVENTREE_URL=http://127.0.0.1:8000
export INVENTREE_ADMIN_USER=admin
export INVENTREE_ADMIN_PASSWORD='YOUR_INVENTREE_ADMIN_PASSWORD'
npm run adapter
```

Open `http://127.0.0.1:3000`. Sign in as **Admin** with the PIN you put in `FLOOR_DEV_PIN` (not the InvenTree password). After the adapter is up, Electron is `npm run desktop`. Electron is the Surface shell; WSL verification is the browser.

**PASS:** inventory lists SKUs `11111`–`11115`, search finds `11113`, unit detail shows Excellent and $1,450.00, `11112` ask is blank (not `$0.00`). A wrong SKU on the keypad says there is no item.

---

## Marketplace sessions (milestone 6 — not built yet)

Each channel gets its own Electron persistent partition. Sign in by hand, once. We do not store marketplace passwords and we do not script the login form. When a session expires, the channel shows **NEEDS RE-LOGIN**.

---

## Seed import (milestone 3)

`seed_inventory.csv` in the repo root is the first input, not the schema. The importer takes a column map and runs against an empty database. Re-running must not duplicate SKUs.

---

## WSL verification only

Use Ubuntu-22.04 WSL to run the same probe/bootstrap scripts before the Surface is available. This is not how the store machine is deployed.

- Enable systemd (`[boot]` / `systemd=true` in `/etc/wsl.conf`) if `systemctl is-system-running` is not `running`.
- Copy the repo to `~/liquidation-os` on the Linux filesystem. Never run the app or SQLite from `/mnt/c`.
- This workstation’s WSL is **arm64**. The official InvenTree `.deb` has no arm64 package (`Unable to locate package inventree`). **Source install is the verified arm64 fallback** (Python 3.12, `invoke install` / `invoke update`, SQLite under `/home/inventree/data`). The Zorin `.deb` on the Surface is still unverified — if that install fights us, use this same source path. RAM and SQLite-under-load still have to be answered on the Surface.

---

## Windows ARM64 and x64

Do not do this on the live Zorin tablet. Shop Windows PCs (including Surface ARM64) use the zip from GitHub Releases: `floor-*-windows.zip`. Unzip, then:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\Install-Floor.ps1
```

That script matches `installer/windows/README.md`. It starts InvenTree with `infra/inventree/docker-compose.yml` (official `inventree/inventree:stable`, linux/arm64 on ARM machines) and the packaged adapter with a bundled Node (`runtime/node-win-arm64` or `node-win-x64`). Data lives in `state\` (`FLOOR_ROOT`). Later starts: `.\Start-Floor.ps1`.

Developers working from a git checkout can still use compose by hand:

```powershell
cd infra\inventree
copy .env.example .env
# set INVENTREE_ADMIN_PASSWORD and INVENTREE_SECRET_KEY
docker compose run --rm inventree invoke update
docker compose up -d
```

```powershell
$env:INVENTREE_URL="http://127.0.0.1:8000"
$env:INVENTREE_ADMIN_PASSWORD="YOUR_INVENTREE_ADMIN_PASSWORD"
node infra\inventree\probe.mjs
```

Mapper / money / PIN tests (no InvenTree):

```powershell
npm install
npm test
```

---

## Mapping

| Floor | InvenTree |
|---|---|
| Model (LG LRFLC2716S) | Part |
| Physical unit | StockItem |
| 5-digit SKU | StockItem.serial (globally unique; Floor can retag, old SKU stays retired) |
| Manufacturer serial | `metadata.lros.mfrSerial` |
| Acquisition cost | StockItem.purchase_price (cents at the adapter) |
| Lot | StockItem.batch |
| Condition, test, prices, listings | `metadata.lros` |
| Reserved | Allocated to a parked sales order |
| Photos | StockItem attachments |
