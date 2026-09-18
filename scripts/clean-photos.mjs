/**
 * Hybrid photo cleanup + local review + upload-back.
 *
 *   npm run photos:clean -- --dir exports\listings-...
 *   npm run photos:clean -- --dir exports\listings-... --only 11203
 *   npm run photos:review -- --dir exports\listings-...
 *
 * Cutout: rembg (default) or CUTOUT_PROVIDER=photoroom ($0.02/image, PHOTOROOM_API_KEY).
 * Dirt inpaint: Clipdrop Cleanup, 1 credit/image (~$0.02–$0.05 after 100 free). Skipped without CLIPDROP_API_KEY.
 * Review is localhost only. SUPABASE_SERVICE_ROLE never goes to the page.
 */
import "./load-env.mjs";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  CLIPDROP_CLEANUP_COST,
  approveAllClean,
  archiveStoragePath,
  brightnessGain,
  createServiceClient,
  dirtMaskPngPrep,
  folderMatchesSku,
  inspectCutout,
  nextVersionedStoragePath,
  parseOnlyFlag,
  requiredStoreId,
  uploadAction,
  whiteBalanceRgba,
} from "@floor/cloud";
import sharp from "sharp";
import { removeWebDerivatives, syncWebDerivatives } from "./web-derivatives.mjs";

const argv = process.argv.slice(2);
const reviewOnly = argv.includes("--review");
const cleanOnly = argv.includes("--clean-only");
const only = parseOnlyFlag(process.argv);
const dirFlag = argv.findIndex((a) => a === "--dir");
const dirArg = dirFlag >= 0 ? argv[dirFlag + 1] : "";
const port = Number(process.env.PHOTO_REVIEW_PORT || 8787);
const repoRoot = process.cwd();
const python = process.env.PYTHON || "py";
const cutoutProvider = (process.env.CUTOUT_PROVIDER || "rembg").toLowerCase();

function latestExportDir() {
  const root = path.join(repoRoot, "exports");
  if (!existsSync(root)) return "";
  const names = readdirSyncSafe(root)
    .filter((n) => n.startsWith("listings-"))
    .sort();
  return names.length ? path.join(root, names[names.length - 1]) : "";
}

function readdirSyncSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

const exportDir = path.resolve(dirArg || latestExportDir());
if (!exportDir || !existsSync(exportDir)) {
  throw new Error("Pass --dir exports\\listings-YYYYMMDD-HHMM (or run export:listings first).");
}

const photosRoot = path.join(exportDir, "photos");
const manifestPath = path.join(photosRoot, "manifest.json");
const reshootPath = path.join(exportDir, "needs-reshoot.txt");
const statePath = path.join(photosRoot, "review-state.json");
const cutoutScript = path.join(repoRoot, "scripts", "cutout-rembg.py");

console.log("Clipdrop generative dirt removal:");
console.log(`  ${CLIPDROP_CLEANUP_COST.provider}`);
console.log(`  ${CLIPDROP_CLEANUP_COST.meter}`);
console.log(`  ${CLIPDROP_CLEANUP_COST.usd}`);
if (!process.env.CLIPDROP_API_KEY) {
  console.log("  CLIPDROP_API_KEY is unset — exteriors that look dirty will get a rembg+Sharp clean only.");
}

async function loadManifest() {
  if (!existsSync(manifestPath)) {
    throw new Error("photos/manifest.json missing. Re-run npm run export:listings so upload-back has storage keys.");
  }
  return JSON.parse(await readFile(manifestPath, "utf8"));
}

async function loadState() {
  if (!existsSync(statePath)) return { choices: {}, restored: {} };
  return JSON.parse(await readFile(statePath, "utf8"));
}

async function saveState(state) {
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
}

async function loadReshoot() {
  const map = new Map();
  if (!existsSync(reshootPath)) return map;
  const text = await readFile(reshootPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    map.set(line.slice(0, tab), line.slice(tab + 1));
  }
  return map;
}

function generativeName(file) {
  return file.replace(/\.jpg$/i, "-declean.jpg");
}

async function cutoutToPng(infile, outfile) {
  await mkdir(path.dirname(outfile), { recursive: true });
  if (cutoutProvider === "photoroom") {
    const key = process.env.PHOTOROOM_API_KEY;
    if (!key) throw new Error("CUTOUT_PROVIDER=photoroom needs PHOTOROOM_API_KEY");
    const bytes = await readFile(infile);
    const form = new FormData();
    form.append("image_file", new Blob([bytes]), path.basename(infile));
    const res = await fetch("https://sdk.photoroom.com/v1/segment", {
      method: "POST",
      headers: { "x-api-key": key },
      body: form,
    });
    if (!res.ok) throw new Error(`photoroom ${res.status}: ${(await res.text()).slice(0, 200)}`);
    await writeFile(outfile, Buffer.from(await res.arrayBuffer()));
    return;
  }
  const r = spawnSync(python, ["-3", cutoutScript, infile, outfile], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error((r.stderr || r.stdout || `rembg exit ${r.status}`).trim());
  }
}

function applyGain(rgba, gain) {
  if (gain === 1) return rgba;
  const out = new Uint8Array(rgba);
  for (let i = 0; i < out.length; i += 4) {
    if ((out[i + 3] ?? 0) < 16) continue;
    out[i] = Math.min(255, Math.round((out[i] ?? 0) * gain));
    out[i + 1] = Math.min(255, Math.round((out[i + 1] ?? 0) * gain));
    out[i + 2] = Math.min(255, Math.round((out[i + 2] ?? 0) * gain));
  }
  return out;
}

async function squareWhiteJpeg(rgba, width, height) {
  let png = await sharp(Buffer.from(rgba), { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
  try {
    png = await sharp(png).trim({ threshold: 2 }).png().toBuffer();
  } catch {
    /* empty trim — keep the full frame */
  }
  const fitted = await sharp(png)
    .resize({ width: 1400, height: 1400, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
  return sharp({
    create: { width: 1600, height: 1600, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite([{ input: fitted, gravity: "centre" }])
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function clipdropCleanup(jpegBuf, maskPng) {
  const key = process.env.CLIPDROP_API_KEY;
  if (!key) return null;
  const form = new FormData();
  form.append("image_file", new Blob([jpegBuf], { type: "image/jpeg" }), "photo.jpg");
  form.append("mask_file", new Blob([maskPng], { type: "image/png" }), "mask.png");
  const res = await fetch("https://clipdrop-api.co/cleanup/v1", {
    method: "POST",
    headers: { "x-api-key": key },
    body: form,
  });
  if (!res.ok) throw new Error(`clipdrop ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

async function processOne(folder, file) {
  const orig = path.join(photosRoot, folder, file);
  const cleanDir = path.join(photosRoot, folder, "clean");
  const cutPng = path.join(cleanDir, file.replace(/\.jpg$/i, "-cut.png"));
  const cleanJpg = path.join(cleanDir, file);
  const genJpg = path.join(cleanDir, generativeName(file));
  await mkdir(cleanDir, { recursive: true });

  let cutoutOk = true;
  let cutoutErr = "";
  try {
    await cutoutToPng(orig, cutPng);
  } catch (err) {
    cutoutOk = false;
    cutoutErr = err instanceof Error ? err.message : String(err);
  }

  const source = cutoutOk ? cutPng : orig;
  const { data, info } = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const rgba = new Uint8Array(data);
  const flags = inspectCutout(rgba, info.width, info.height);
  const reshoot = [...flags.reshoot];
  if (!cutoutOk) reshoot.push(`cutout failed: ${cutoutErr}`);

  const balanced = applyGain(whiteBalanceRgba(rgba), brightnessGain(flags.subjectMeanLuma));
  const jpeg = await squareWhiteJpeg(balanced, info.width, info.height);
  await writeFile(cleanJpg, jpeg);

  let generative = false;
  if (flags.looksDirty && process.env.CLIPDROP_API_KEY) {
    const maskRgba = dirtMaskPngPrep(balanced, info.width, info.height);
    const maskPng = await sharp(Buffer.from(maskRgba), {
      raw: { width: info.width, height: info.height, channels: 4 },
    })
      .png()
      .toBuffer();
    try {
      const cleaned = await clipdropCleanup(jpeg, maskPng);
      if (cleaned) {
        await writeFile(genJpg, cleaned);
        generative = true;
      }
    } catch (err) {
      reshoot.push(`generative failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { reshoot, generative, dirty: flags.looksDirty };
}

async function runClean() {
  const folders = (await readdir(photosRoot, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => folderMatchesSku(name, only));
  const reshootLines = [];
  let done = 0;
  for (const folder of folders) {
    const files = (await readdir(path.join(photosRoot, folder)))
      .filter((n) => /\.jpe?g$/i.test(n) && !n.includes("-declean"));
    for (const file of files) {
      console.log(`clean ${folder}/${file}`);
      try {
        const result = await processOne(folder, file);
        if (result.reshoot.length) {
          reshootLines.push(`${folder}/${file}\t${result.reshoot.join("; ")}`);
        }
      } catch (err) {
        reshootLines.push(`${folder}/${file}\t${err instanceof Error ? err.message : String(err)}`);
      }
      done += 1;
    }
  }
  await writeFile(reshootPath, reshootLines.length ? reshootLines.join("\n") + "\n" : "", "utf8");
  console.log(JSON.stringify({ ok: true, cleaned: done, reshoot: reshootLines.length, exportDir }, null, 2));
}

function catalogItems(manifest, state, reshoot) {
  return (manifest.photos || [])
    .filter((p) => folderMatchesSku(p.folder, only))
    .map((p) => {
      const rel = `${p.folder}/${p.file}`;
      const cleanRel = `${p.folder}/clean/${p.file}`;
      const genRel = `${p.folder}/clean/${generativeName(p.file)}`;
      const reasons = reshoot.get(rel) ? String(reshoot.get(rel)).split("; ").filter(Boolean) : [];
      const hasClean = existsSync(path.join(photosRoot, cleanRel));
      const hasGenerative = existsSync(path.join(photosRoot, genRel));
      const live = p.storagePath;
      const archived = archiveStoragePath(live);
      const alreadyArchived =
        String(p.originalPath || "").includes("/archive/") || existsSync(path.join(photosRoot, p.folder, "archived-flag"));
      return {
        id: p.id,
        sku: p.sku,
        folder: p.folder,
        file: p.file,
        isPrimary: !!p.isPrimary,
        storagePath: live,
        originalPath: p.originalPath || live,
        archivePath: archived,
        originalUrl: `/file/photos/${p.folder}/${p.file}`,
        cleanUrl: hasClean ? `/file/photos/${cleanRel}` : null,
        generativeUrl: hasGenerative ? `/file/photos/${genRel}` : null,
        hasClean,
        hasGenerative,
        reshoot: reasons,
        choice: state.choices[String(p.id)] || "pending",
        restored: !!state.restored?.[String(p.id)],
        alreadyArchived,
      };
    });
}

function reviewHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Photo review</title>
<style>
  :root { font-family: ui-sans-serif, system-ui, sans-serif; background:#111; color:#eee; }
  body { margin: 0; }
  header { position: sticky; top: 0; background:#1b1b1b; padding: 12px 16px; display:flex; gap:12px; align-items:center; flex-wrap:wrap; z-index:2; border-bottom:1px solid #333; }
  button { background:#2d6a4f; color:#fff; border:0; padding:8px 12px; border-radius:6px; cursor:pointer; }
  button.secondary { background:#333; }
  button.warn { background:#9a3412; }
  .shot { padding:16px; border-bottom:1px solid #2a2a2a; }
  .row { display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap:12px; }
  figure { margin:0; background:#222; padding:8px; border-radius:8px; }
  img { width:100%; height:240px; object-fit:contain; background:#fff; }
  .muted { color:#aaa; font-size:13px; }
  .reshoot { color:#fbbf24; }
  label { margin-right:12px; }
  pre { white-space:pre-wrap; background:#0b0b0b; padding:12px; border-radius:8px; }
</style>
</head>
<body>
<header>
  <strong>Photo review</strong>
  <span class="muted">localhost only · service key stays on the PC</span>
  <button id="approveClean">Approve all clean</button>
  <button id="upload">Upload approved</button>
  <span id="status" class="muted"></span>
</header>
<main id="list"></main>
<script>
const list = document.getElementById("list");
const status = document.getElementById("status");
let items = [];

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function render() {
  list.innerHTML = items.map((p) => {
    const reshoot = p.reshoot.length ? '<p class="reshoot">needs reshoot: ' + p.reshoot.join("; ") + "</p>" : "";
    const gen = p.hasGenerative
      ? '<figure><img src="' + p.generativeUrl + '"/><figcaption>generative</figcaption></figure>'
      : "";
    const clean = p.hasClean
      ? '<figure><img src="' + p.cleanUrl + '"/><figcaption>clean</figcaption></figure>'
      : "<p class=muted>no clean file</p>";
    const restore = '<button class="secondary" data-restore="' + p.id + '">Restore original</button>';
    return '<section class="shot" data-id="' + p.id + '">'
      + "<h3>SKU " + p.sku + " · " + p.file + (p.isPrimary ? " · primary" : "") + "</h3>"
      + reshoot
      + '<div class="row"><figure><img src="' + p.originalUrl + '"/><figcaption>original</figcaption></figure>'
      + clean + gen + "</div>"
      + '<p>'
      + '<label><input type="radio" name="c' + p.id + '" value="original"' + (p.choice === "original" ? " checked" : "") + '> keep original</label>'
      + '<label><input type="radio" name="c' + p.id + '" value="clean"' + (p.choice === "clean" ? " checked" : "") + (p.hasClean && !p.reshoot.length ? "" : " disabled") + '> use clean</label>'
      + '<label><input type="radio" name="c' + p.id + '" value="generative"' + (p.choice === "generative" ? " checked" : "") + (p.hasGenerative && !p.reshoot.length ? "" : " disabled") + '> use generative</label>'
      + "</p>" + restore
      + "</section>";
  }).join("");
}

async function load() {
  const data = await api("/api/catalog");
  items = data.items;
  render();
}

list.addEventListener("change", async (e) => {
  const input = e.target;
  if (input.name && input.name.startsWith("c")) {
    const id = input.name.slice(1);
    await api("/api/choice", { id, choice: input.value });
  }
});
list.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-restore]");
  if (!btn) return;
  status.textContent = "Restoring…";
  try {
    const data = await api("/api/restore", { id: btn.getAttribute("data-restore") });
    status.textContent = data.ok ? "Restored original for SKU " + data.sku : JSON.stringify(data);
    await load();
  } catch (err) {
    status.textContent = err.message;
  }
});
document.getElementById("approveClean").onclick = async () => {
  await api("/api/approve-all-clean", {});
  await load();
};
document.getElementById("upload").onclick = async () => {
  status.textContent = "Uploading…";
  try {
    const data = await api("/api/upload", {});
    status.textContent = "";
    const lines = ["Replaced per SKU:"];
    for (const [sku, n] of Object.entries(data.replacedBySku || {})) lines.push("  " + sku + ": " + n);
    if (!Object.keys(data.replacedBySku || {}).length) lines.push("  (none)");
    if ((data.failures || []).length) {
      lines.push("Failures:");
      for (const f of data.failures) lines.push("  " + f.sku + " " + f.file + " — " + f.reason);
    }
    const pre = document.createElement("pre");
    pre.textContent = lines.join("\\n");
    list.prepend(pre);
  } catch (err) {
    status.textContent = err.message;
  }
};
load().catch((err) => { status.textContent = err.message; });
</script>
</body>
</html>`;
}

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function safeFile(rel) {
  const cleaned = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  if (cleaned.includes("..")) return "";
  const abs = path.resolve(exportDir, cleaned);
  if (!abs.startsWith(path.resolve(exportDir))) return "";
  return abs;
}

async function replaceLive(client, item, localFile) {
  const live = item.storagePath;
  const archive = String(item.originalPath || "").includes("/archive/")
    ? item.originalPath
    : archiveStoragePath(live);
  const bytes = await readFile(localFile);
  if (!String(item.originalPath || "").includes("/archive/")) {
    const origBytes = await readFile(path.join(photosRoot, item.folder, item.file));
    const upArch = await client.storage.from("unit-photos").upload(archive, origBytes, {
      upsert: true,
      contentType: "image/jpeg",
    });
    if (upArch.error) throw new Error(`archive ${archive}: ${upArch.error.message}`);
  }
  const nextLive = nextVersionedStoragePath(live);
  const upLive = await client.storage.from("unit-photos").upload(nextLive, bytes, {
    upsert: false,
    contentType: "image/jpeg",
    cacheControl: "3600",
  });
  if (upLive.error) throw new Error(`live ${nextLive}: ${upLive.error.message}`);
  await syncWebDerivatives(client, nextLive, bytes);
  const { error } = await client
    .from("photos")
    .update({ original_path: archive, path: nextLive })
    .eq("id", item.id);
  if (error) throw new Error(error.message);
  if (live !== nextLive && live !== archive) {
    await removeWebDerivatives(client, live).catch(() => undefined);
    await client.storage.from("unit-photos").remove([live]);
  }
}

async function restoreLive(client, item) {
  const archive = String(item.originalPath || "").includes("/archive/") ? item.originalPath : item.archivePath;
  const dl = await client.storage.from("unit-photos").download(archive);
  if (dl.error || !dl.data) throw new Error(dl.error?.message || `no archive at ${archive}`);
  const buf = Buffer.from(await dl.data.arrayBuffer());
  const nextLive = nextVersionedStoragePath(item.storagePath);
  const up = await client.storage.from("unit-photos").upload(nextLive, buf, {
    upsert: false,
    contentType: "image/jpeg",
    cacheControl: "3600",
  });
  if (up.error) throw new Error(up.error.message);
  await syncWebDerivatives(client, nextLive, buf);
  const { error } = await client.from("photos").update({ path: nextLive }).eq("id", item.id);
  if (error) throw new Error(error.message);
  if (item.storagePath !== nextLive) {
    await removeWebDerivatives(client, item.storagePath).catch(() => undefined);
    await client.storage.from("unit-photos").remove([item.storagePath]);
  }
  await writeFile(path.join(photosRoot, item.folder, item.file), buf);
}

async function handleUpload() {
  const storeId = requiredStoreId();
  const client = createServiceClient();
  const [manifest, state, reshoot] = await Promise.all([loadManifest(), loadState(), loadReshoot()]);
  if (manifest.storeId && manifest.storeId !== storeId) {
    throw new Error("STORE_ID does not match photos/manifest.json");
  }
  const items = catalogItems(manifest, state, reshoot);
  const replacedBySku = {};
  const failures = [];
  const skipped = [];
  for (const item of items) {
    const decision = {
      reshoot: item.reshoot,
      hasClean: item.hasClean,
      hasGenerative: item.hasGenerative,
      choice: item.choice,
    };
    const plan = uploadAction(decision);
    if (plan.action === "skip") {
      skipped.push({ sku: item.sku, file: item.file, reason: plan.reason });
      continue;
    }
    const local =
      plan.source === "generative"
        ? path.join(photosRoot, item.folder, "clean", generativeName(item.file))
        : path.join(photosRoot, item.folder, "clean", item.file);
    try {
      if (!existsSync(local)) throw new Error(`missing ${plan.source} file`);
      await replaceLive(client, item, local);
      replacedBySku[item.sku] = (replacedBySku[item.sku] || 0) + 1;
    } catch (err) {
      failures.push({ sku: item.sku, file: item.file, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { replacedBySku, failures, skipped };
}

function startReview() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(reviewHtml());
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/catalog") {
        const [manifest, state, reshoot] = await Promise.all([loadManifest(), loadState(), loadReshoot()]);
        json(res, 200, { items: catalogItems(manifest, state, reshoot) });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/choice") {
        const body = await readBody(req);
        const state = await loadState();
        const choice = body.choice;
        if (!["original", "clean", "generative", "pending"].includes(choice)) {
          json(res, 400, { error: "bad choice" });
          return;
        }
        state.choices[String(body.id)] = choice;
        await saveState(state);
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/approve-all-clean") {
        const [manifest, state, reshoot] = await Promise.all([loadManifest(), loadState(), loadReshoot()]);
        const items = catalogItems(manifest, state, reshoot);
        const next = approveAllClean(items);
        for (const item of next) state.choices[String(item.id)] = item.choice;
        await saveState(state);
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/upload") {
        const summary = await handleUpload();
        json(res, 200, summary);
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/restore") {
        const body = await readBody(req);
        const client = createServiceClient();
        const [manifest, state, reshoot] = await Promise.all([loadManifest(), loadState(), loadReshoot()]);
        const item = catalogItems(manifest, state, reshoot).find((p) => String(p.id) === String(body.id));
        if (!item) {
          json(res, 404, { error: "photo not in this export" });
          return;
        }
        await restoreLive(client, item);
        state.restored = state.restored || {};
        state.restored[String(item.id)] = true;
        state.choices[String(item.id)] = "original";
        await saveState(state);
        json(res, 200, { ok: true, sku: item.sku, file: item.file });
        return;
      }
      if (req.method === "GET" && url.pathname.startsWith("/file/")) {
        const abs = safeFile(url.pathname.slice("/file/".length));
        if (!abs || !existsSync(abs)) {
          res.writeHead(404);
          res.end("missing");
          return;
        }
        const buf = await readFile(abs);
        const type = abs.endsWith(".png") ? "image/png" : abs.endsWith(".json") ? "application/json" : "image/jpeg";
        res.writeHead(200, { "content-type": type });
        res.end(buf);
        return;
      }
      res.writeHead(404);
      res.end("not found");
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Review at http://127.0.0.1:${port}/  (dir ${exportDir})`);
  });
}

if (!reviewOnly) await runClean();
if (!cleanOnly) startReview();
