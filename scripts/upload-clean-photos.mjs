/**
 * Preview or upload edited photos from Desktop\\floor-photos-clean.
 *
 * Same folder + filename as Desktop\\floor-photos (from the listing export).
 * Default: localhost before/after for a few shots. Pass --go only after that check.
 */
import "./load-env.mjs";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  archiveStoragePath,
  createServiceClient,
  nextVersionedStoragePath,
  planCleanImport,
} from "@floor/cloud";
import { removeWebDerivatives, syncWebDerivatives } from "./web-derivatives.mjs";

const go = process.argv.includes("--go");
const port = Number(process.env.PHOTO_PREVIEW_PORT || 8788);
const origRoot = path.join(os.homedir(), "Desktop", "floor-photos");
const cleanRoot = path.join(os.homedir(), "Desktop", "floor-photos-clean");
const manifestPath = path.join(origRoot, "manifest.json");

function isJpegName(name) {
  return /\.jpe?g$/i.test(name);
}

async function listCleanRels() {
  if (!existsSync(cleanRoot)) return [];
  const rels = [];
  const folders = await readdir(cleanRoot, { withFileTypes: true });
  for (const dir of folders) {
    if (!dir.isDirectory()) continue;
    const files = await readdir(path.join(cleanRoot, dir.name));
    for (const file of files) {
      if (isJpegName(file)) rels.push(`${dir.name}/${file}`);
    }
  }
  return rels;
}

async function loadManifest() {
  if (!existsSync(manifestPath)) {
    throw new Error(`Missing ${manifestPath}. Run the listing export first.`);
  }
  return JSON.parse(await readFile(manifestPath, "utf8"));
}

async function plan() {
  const manifest = await loadManifest();
  const photos = manifest.photos || [];
  const cleanRels = await listCleanRels();
  const matched = planCleanImport(photos, cleanRels);
  const byKey = new Map(photos.map((p) => [`${p.folder}/${p.file}`, p]));
  const toUpload = matched.toUpload.map((row) => byKey.get(`${row.folder}/${row.file}`)).filter(Boolean);
  return { manifest, matched, toUpload };
}

function previewHtml(samples, matched) {
  const cards = samples
    .map((p) => {
      const rel = `${p.folder}/${p.file}`;
      return `<section>
        <h3>SKU ${p.sku} · ${rel}${p.isPrimary ? " · primary" : ""}</h3>
        <div class="row">
          <figure><img src="/orig/${rel}" alt="before"/><figcaption>before (export)</figcaption></figure>
          <figure><img src="/clean/${rel}" alt="after"/><figcaption>after (clean)</figcaption></figure>
        </div>
      </section>`;
    })
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><title>Clean photo check</title>
<style>
body{font-family:ui-sans-serif,system-ui,sans-serif;margin:0;background:#111;color:#eee}
header{padding:16px 20px;background:#1a1a1a;border-bottom:1px solid #333}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
section{padding:16px 20px;border-bottom:1px solid #2a2a2a}
img{width:100%;height:280px;object-fit:contain;background:#fff}
.muted{color:#aaa}
</style></head>
<body>
<header>
  <h1>Before / after (sample)</h1>
  <p class="muted">Ready to upload: ${matched.toUpload.length}. Missing: ${matched.missing.length}. Extra (not in manifest, will not upload): ${matched.extra.length}.</p>
  <p class="muted">When this looks right, say “go” in chat. Do not upload from this page.</p>
</header>
${cards || "<p>No matching clean files yet.</p>"}
</body></html>`;
}

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function safeUnder(root, rel) {
  const cleaned = String(rel).replace(/\\/g, "/").replace(/^\/+/, "");
  if (cleaned.includes("..")) return "";
  const abs = path.resolve(root, cleaned);
  if (!abs.startsWith(path.resolve(root))) return "";
  return abs;
}

async function startPreview() {
  const { matched, toUpload } = await plan();
  const samples = toUpload.filter((p) => p.isPrimary).slice(0, 4);
  const extra = toUpload.filter((p) => !samples.includes(p)).slice(0, 2);
  const shown = [...samples, ...extra].slice(0, 6);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(previewHtml(shown, matched));
        return;
      }
      const orig = url.pathname.startsWith("/orig/") ? safeUnder(origRoot, url.pathname.slice(6)) : "";
      const clean = url.pathname.startsWith("/clean/") ? safeUnder(cleanRoot, url.pathname.slice(7)) : "";
      const file = orig || clean;
      if (file && existsSync(file)) {
        res.writeHead(200, { "content-type": "image/jpeg" });
        res.end(await readFile(file));
        return;
      }
      if (url.pathname === "/api/plan") {
        json(res, 200, {
          upload: matched.toUpload.length,
          missing: matched.missing,
          extra: matched.extra,
        });
        return;
      }
      res.writeHead(404);
      res.end("not found");
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(
      JSON.stringify(
        {
          preview: `http://127.0.0.1:${port}/`,
          uploadReady: matched.toUpload.length,
          missing: matched.missing.length,
          extra: matched.extra.length,
        },
        null,
        2,
      ),
    );
  });
}

async function resolveStoreId(client) {
  const id = process.env.STORE_ID?.trim();
  if (id) return id;
  const { data, error } = await client.from("stores").select("id");
  if (error) throw new Error(error.message);
  const rows = data ?? [];
  if (rows.length === 1) return rows[0].id;
  throw new Error("Paste STORE_ID from Setup into .env.local.");
}

async function bytesFromStorageOrLocal(client, item) {
  const dl = await client.storage.from("unit-photos").download(item.storagePath);
  if (!dl.error && dl.data) return Buffer.from(await dl.data.arrayBuffer());
  const local = path.join(origRoot, item.folder, item.file);
  if (existsSync(local)) return readFile(local);
  throw new Error(dl.error?.message || "could not read original to archive");
}

async function uploadAll() {
  if (!existsSync(cleanRoot)) throw new Error(`Missing ${cleanRoot}`);
  const client = createServiceClient();
  const storeId = await resolveStoreId(client);
  const { manifest, matched, toUpload } = await plan();
  if (manifest.storeId && manifest.storeId !== storeId) {
    throw new Error("STORE_ID does not match Desktop\\floor-photos\\manifest.json");
  }
  const replacedBySku = {};
  const failures = [];
  for (const item of toUpload) {
    const cleanFile = path.join(cleanRoot, item.folder, item.file);
    try {
      const live = item.storagePath;
      const alreadyArchived = String(item.originalPath || "").includes("/archive/");
      const archive = alreadyArchived ? item.originalPath : archiveStoragePath(live);
      if (!alreadyArchived) {
        const origBytes = await bytesFromStorageOrLocal(client, item);
        const upArch = await client.storage.from("unit-photos").upload(archive, origBytes, {
          upsert: true,
          contentType: "image/jpeg",
        });
        if (upArch.error) throw new Error(`archive: ${upArch.error.message}`);
      }
      const nextLive = nextVersionedStoragePath(live);
      const cleanBytes = await readFile(cleanFile);
      const upLive = await client.storage.from("unit-photos").upload(nextLive, cleanBytes, {
        upsert: false,
        contentType: "image/jpeg",
        cacheControl: "3600",
      });
      if (upLive.error) throw new Error(upLive.error.message);
      const { error } = await client
        .from("photos")
        .update({ path: nextLive, original_path: archive })
        .eq("id", item.id)
        .eq("store_id", storeId);
      if (error) throw new Error(error.message);
      await syncWebDerivatives(client, nextLive, cleanBytes);
      if (live !== nextLive && live !== archive) {
        await removeWebDerivatives(client, live).catch(() => undefined);
        await client.storage.from("unit-photos").remove([live]);
      }
      replacedBySku[item.sku] = (replacedBySku[item.sku] || 0) + 1;
    } catch (err) {
      failures.push({
        sku: item.sku,
        file: `${item.folder}/${item.file}`,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return {
    replacedBySku,
    failures,
    skippedMissing: matched.missing,
    skippedExtra: matched.extra,
  };
}

if (go) {
  const summary = await uploadAll();
  console.log(JSON.stringify(summary, null, 2));
} else {
  await startPreview();
}
