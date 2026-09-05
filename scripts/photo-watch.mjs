#!/usr/bin/env node
/**
 * Folder watcher for Floor photos. Runs outside Next so webpack never
 * bundles node:fs / chokidar. Drop files named 11130.jpg into photoDropPath.
 */
import { existsSync, readFileSync, watch } from "node:fs";
import { join } from "node:path";

const root = process.env.FLOOR_ROOT || process.cwd();
const configPath = join(root, "config", "floor.json");
const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
const drop = config.photoDropPath;
if (!drop) {
  console.error("photoDropPath is empty in config/floor.json");
  process.exit(1);
}
const pin = process.env.FLOOR_DEV_PIN;
if (!pin) {
  console.error("FLOOR_DEV_PIN is required");
  process.exit(1);
}
const base = process.env.FLOOR_URL || "http://127.0.0.1:3000";
const login = await fetch(`${base}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    username: process.env.INVENTREE_ADMIN_USER || "admin",
    pin,
  }),
});
if (!login.ok) {
  console.error("photo-watch login failed", login.status, await login.text());
  process.exit(1);
}
const cookie = (login.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("floor_session="))?.split(";")[0];
let timer;
function ingest() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const res = await fetch(`${base}/api/photos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    console.log(JSON.stringify({ ts: new Date().toISOString(), src: "floor", event: "photo_watch_ingest", status: res.status, results: data.results }));
  }, 400);
}
watch(drop, () => ingest());
ingest();
console.log(JSON.stringify({ ts: new Date().toISOString(), src: "floor", event: "photo_watch_start", drop }));
