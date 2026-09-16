import { BrowserView, ipcMain, session } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CHANNEL_HOMES = {
  ebay: "https://www.ebay.com/",
  facebook: "https://www.facebook.com/marketplace",
  tiktok: "https://www.tiktok.com/",
  amazon: "https://www.amazon.com/",
};

const CHANNEL_ALLOW_HOSTS = {
  ebay: ["ebay.com", "ebaystatic.com", "ebayimg.com", "ebayrtm.com", "ebayadservices.com"],
  facebook: ["facebook.com", "fbcdn.net", "facebook.net", "messenger.com"],
  tiktok: ["tiktok.com", "tiktokcdn.com", "tiktokv.com", "bytedance.com"],
  amazon: ["amazon.com", "amazon-adsystem.com", "ssl-images-amazon.com", "media-amazon.com"],
};

function floorRoot() {
  return process.env.FLOOR_ROOT || join(dirname(fileURLToPath(import.meta.url)), "../..");
}

function marketplaceUnrestricted() {
  const path = join(floorRoot(), "config", "floor.json");
  if (!existsSync(path)) return true;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (raw?.marketplace?.unrestricted === undefined) return true;
    return Boolean(raw.marketplace.unrestricted);
  } catch {
    return true;
  }
}

function hostAllowed(channel, url) {
  if (marketplaceUnrestricted()) return true;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  const host = parsed.hostname.toLowerCase();
  const allowed = CHANNEL_ALLOW_HOSTS[channel] ?? [];
  return allowed.some((base) => host === base || host.endsWith(`.${base}`));
}

function partitionName(channel) {
  return `persist:${channel}`;
}

export function attachMarketplace(win) {
  const views = new Map();
  let current = null;
  let bounds = { x: 0, y: 180, width: 800, height: 600 };

  function show(channel) {
    const view = views.get(channel);
    if (!view) return;
    current = channel;
    win.setBrowserView(view);
    view.setBounds(bounds);
    view.setAutoResize({ width: true, height: true });
  }

  function hide() {
    win.setBrowserView(null);
    current = null;
  }

  function viewFor(channel) {
    if (views.has(channel)) return views.get(channel);
    const view = new BrowserView({
      webPreferences: {
        partition: partitionName(channel),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (hostAllowed(channel, url)) {
        view.webContents.loadURL(url);
      }
      return { action: "deny" };
    });
    view.webContents.on("will-navigate", (event, url) => {
      if (!hostAllowed(channel, url)) event.preventDefault();
    });
    view.webContents.on("did-navigate", (_event, url) => {
      win.webContents.send("marketplace:url", url);
    });
    view.webContents.on("did-navigate-in-page", (_event, url) => {
      win.webContents.send("marketplace:url", url);
    });
    views.set(channel, view);
    return view;
  }

  ipcMain.handle("marketplace:open", async (_event, channel) => {
    const id = String(channel || "ebay");
    const view = viewFor(id);
    show(id);
    const url = view.webContents.getURL();
    if (!url) await view.webContents.loadURL(CHANNEL_HOMES[id] || "https://www.ebay.com/");
    return status(id);
  });

  ipcMain.handle("marketplace:navigate", async (_event, raw) => {
    if (!current) return status(null);
    let url = String(raw || "").trim();
    if (!url) return status(current);
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    if (!hostAllowed(current, url)) {
      return { ...status(current), error: "That site is not on the allowlist" };
    }
    await views.get(current).webContents.loadURL(url);
    return status(current);
  });

  ipcMain.handle("marketplace:back", async () => {
    if (!current) return status(null);
    const contents = views.get(current).webContents;
    if (contents.canGoBack()) contents.goBack();
    return status(current);
  });

  ipcMain.handle("marketplace:bounds", (_event, next) => {
    bounds = {
      x: Math.round(next.x ?? bounds.x),
      y: Math.round(next.y ?? bounds.y),
      width: Math.max(100, Math.round(next.width ?? bounds.width)),
      height: Math.max(100, Math.round(next.height ?? bounds.height)),
    };
    if (current && views.get(current)) views.get(current).setBounds(bounds);
    return bounds;
  });

  ipcMain.handle("marketplace:hide", () => {
    hide();
    return { ok: true };
  });

  ipcMain.handle("marketplace:status", async () => status(current));

  async function status(channel) {
    const unrestricted = marketplaceUnrestricted();
    if (!channel) {
      return { channel: null, url: "", signedIn: false, unrestricted };
    }
    const view = views.get(channel);
    const url = view?.webContents.getURL() ?? "";
    const cookies = await session.fromPartition(partitionName(channel)).cookies.get({});
    return {
      channel,
      url,
      signedIn: cookies.length > 0,
      unrestricted,
    };
  }

  win.on("closed", () => hide());
}
