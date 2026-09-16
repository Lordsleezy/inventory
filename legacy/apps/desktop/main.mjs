import { app, BrowserWindow } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { attachMarketplace } from "./marketplace.mjs";

app.setName("Floor");

const ADAPTER = (process.env.FLOOR_ADAPTER_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const LOGIN = `${ADAPTER}/login`;
const here = dirname(fileURLToPath(import.meta.url));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when the adapter is up enough to show the PIN screen (not a 5xx crash). */
async function adapterReady() {
  try {
    const res = await fetch(LOGIN, { redirect: "manual" });
    return res.status > 0 && res.status < 500;
  } catch {
    return false;
  }
}

async function waitForAdapter(win) {
  const waiting = `data:text/html,${encodeURIComponent(`<!doctype html>
<html><head><meta charset="utf-8"><title>Floor</title>
<style>
  html,body{margin:0;height:100%;background:#101010;color:#ffd60a;
  font:600 28px/1.2 system-ui,sans-serif;display:grid;place-items:center}
  p{color:#bbb;font:400 16px/1.4 system-ui,sans-serif;margin-top:12px}
</style></head>
<body><div style="text-align:center"><div>FLOOR</div><p>Starting…</p></div></body></html>`)}`;

  await win.loadURL(waiting);

  for (let i = 0; i < 120; i++) {
    if (await adapterReady()) {
      await win.loadURL(LOGIN);
      return;
    }
    await sleep(1000);
  }

  const failed = `data:text/html,${encodeURIComponent(`<!doctype html>
<html><head><meta charset="utf-8"><title>Floor</title>
<style>
  html,body{margin:0;height:100%;background:#101010;color:#ffd60a;
  font:600 28px/1.2 system-ui,sans-serif;display:grid;place-items:center}
  p{color:#bbb;font:400 16px/1.4 system-ui,sans-serif;margin:12px 24px 0;max-width:28rem}
</style></head>
<body><div style="text-align:center"><div>FLOOR</div>
<p>The adapter did not start. Check that floor-adapter is running, then open Floor again.</p>
</div></body></html>`)}`;
  await win.loadURL(failed);
}

function createWindow() {
  const win = new BrowserWindow({
    fullscreen: true,
    autoHideMenuBar: true,
    backgroundColor: "#101010",
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: process.env.FLOOR_DEVTOOLS === "1",
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  attachMarketplace(win);
  waitForAdapter(win);
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
