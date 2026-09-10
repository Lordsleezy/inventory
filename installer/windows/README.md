# Floor on Windows (ARM64 and x64)

This package is the shop Floor stack for a Windows PC: the Floor adapter in a browser, plus InvenTree in Docker.

Live Zorin tablets keep using `floor-*-linux-x64.run`. Do not run this zip on the tablet.

## What you need

1. **Windows 11 ARM64** (Surface-class) or **Windows 10/11 x64**
2. **Docker Desktop for Windows** with the WSL2 engine, running  
   On ARM64 install the ARM64 Docker Desktop build. `inventree/inventree:stable` publishes **linux/arm64**, so Docker pulls a native image (not x64 emulation).
3. Internet for the first InvenTree image pull

Node is bundled (`runtime/node-win-arm64` and `runtime/node-win-x64`). You do not install Node yourself.

## First-time install

Open PowerShell in this folder (the folder that contains `Install-Floor.ps1`):

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\Install-Floor.ps1
```

It will:

- Create `state\` (config, data, secrets). That folder is yours; updates do not replace it.
- Copy `infra\inventree\.env.example` to `infra\inventree\.env` if missing and ask for an InvenTree admin password
- Ask for a Floor unlock PIN and write it only to `state\floor.env` (never printed)
- Run `docker compose … invoke update` then start InvenTree
- Start the Floor adapter on http://127.0.0.1:3000

Sign in on that URL as **admin** with the PIN you just set.

## Every later start

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\Start-Floor.ps1
```

Stop with `.\Stop-Floor.ps1` or quit the adapter window and `docker compose down` from `infra\inventree`.

## Layout

| Path | Role |
|---|---|
| `Start-Floor.ps1` / `Install-Floor.ps1` / `Stop-Floor.ps1` | The scripts this README describes |
| `app\` | Packaged Floor adapter (Next standalone) |
| `runtime\node-win-arm64\` / `runtime\node-win-x64\` | Bundled Node 22 |
| `infra\inventree\docker-compose.yml` | InvenTree + worker |
| `state\` | `FLOOR_ROOT` — `config\`, `data\`, `floor.env` |
| `state\inventree\` | SQLite + InvenTree media (Docker volume) |

`Start-Floor.ps1` sets `FLOOR_ROOT` to `state\` and `INVENTREE_URL` to `http://127.0.0.1:8000`. Do not point those at the live tablet.

## Updating

Unzip a newer `floor-*-windows.zip` next to (not into) the old folder, copy `state\` and `infra\inventree\.env` across, then `.\Start-Floor.ps1`.
