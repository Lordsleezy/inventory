import { app, BrowserWindow } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { attachMarketplace } from "./marketplace.mjs";

const ADAPTER = process.env.FLOOR_ADAPTER_URL || "http://127.0.0.1:3000";
const here = dirname(fileURLToPath(import.meta.url));

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
  win.loadURL(ADAPTER);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  attachMarketplace(win);
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
