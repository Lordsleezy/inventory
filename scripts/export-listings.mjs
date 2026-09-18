/**
 * Export units + photos for Facebook / channel listing prep.
 *
 *   set SUPABASE_URL=https://zoukmsmbztcuyoslvikp.supabase.co
 *   set SUPABASE_SERVICE_ROLE=...
 *   set STORE_ID=<uuid from Setup>
 *   npm run export:listings
 *
 * Sold units are skipped. Pass --sold to include them.
 * Default output: Desktop\\floor-photos (unzipped SKU folders + spreadsheet + manifest.json).
 * Optional: --out path\\to\\folder
 * Optional: --only 11203,10421
 */
import "./load-env.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createServiceClient,
  parseOnlyFlag,
  photoFileName,
  photoFolderName,
  skuAllowed,
  spreadsheetRow,
  toCsv,
  toXlsx,
  type ExportUnit,
} from "@floor/cloud";

const PAGE = 1000;
const includeSold = process.argv.includes("--sold") || process.env.INCLUDE_SOLD === "1";
const outFlag = process.argv.findIndex((a) => a === "--out");
const outArg = outFlag >= 0 ? process.argv[outFlag + 1] : "";

async function allRows(fetchPage) {
  const rows = [];
  let from = 0;
  for (;;) {
    const { data, error } = await fetchPage(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE) return rows;
    from += PAGE;
  }
}

function text(v) {
  return v == null ? "" : String(v);
}

function intish(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toUnit(row): ExportUnit {
  return {
    sku: text(row.sku),
    brand: text(row.brand),
    model: text(row.model),
    title: text(row.title),
    category: text(row.category) || null,
    condition: text(row.condition) || null,
    testStatus: text(row.test_status) || null,
    defectNotes: text(row.defect_notes) || null,
    askCents: intish(row.ask_cents),
    msrpCents: intish(row.msrp_cents),
    state: text(row.state) || "available",
    location: text(row.location) || null,
  };
}

function isJpeg(bytes) {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

async function resolveStoreId(client) {
  const id = process.env.STORE_ID?.trim();
  if (id) return id;
  const { data, error } = await client.from("stores").select("id");
  if (error) throw new Error(error.message);
  const rows = data ?? [];
  if (rows.length === 1) return rows[0].id;
  if (!rows.length) {
    throw new Error("No stores found. Create one in the app, then paste STORE_ID into .env.local.");
  }
  throw new Error("Several stores exist. Paste STORE_ID from Setup into .env.local.");
}

const client = createServiceClient();
const storeId = await resolveStoreId(client);
const only = parseOnlyFlag(process.argv);

async function fetchUnits(from, to) {
  let q = client
    .from("units")
    .select(
      "sku, brand, model, title, category, condition, test_status, defect_notes, ask_cents, msrp_cents, state, location",
    )
    .eq("store_id", storeId)
    .order("sku", { ascending: true });
  if (!includeSold) q = q.neq("state", "sold");
  return q.range(from, to);
}

const units = (await allRows(fetchUnits)).map(toUnit).filter((u) => skuAllowed(u.sku, only));

const photos = await allRows((from, to) =>
  client
    .from("photos")
    .select("id, sku, path, original_path, is_primary, created_at")
    .eq("store_id", storeId)
    .order("id", { ascending: true })
    .range(from, to),
);

const listings = await allRows((from, to) =>
  client
    .from("listings")
    .select("sku, channel, status")
    .eq("store_id", storeId)
    .eq("status", "listed")
    .range(from, to),
);

const listedBySku = new Map();
for (const row of listings) {
  const sku = text(row.sku);
  const list = listedBySku.get(sku) ?? [];
  list.push(text(row.channel));
  listedBySku.set(sku, list);
}

const photosBySku = new Map();
for (const row of photos) {
  const sku = text(row.sku);
  const list = photosBySku.get(sku) ?? [];
  list.push(row);
  photosBySku.set(sku, list);
}

const desktopPhotos = path.join(os.homedir(), "Desktop", "floor-photos");
const root = path.resolve(outArg || desktopPhotos);
const photosRoot = root;
await mkdir(photosRoot, { recursive: true });

const rows = [];
const missing = [];
const manifestPhotos = [];

for (const unit of units) {
  const folder = photoFolderName(unit.sku, unit.brand, unit.model);
  const shots = [...(photosBySku.get(unit.sku) ?? [])].sort((a, b) => {
    const ap = a.is_primary === true || a.is_primary === 1 ? 0 : 1;
    const bp = b.is_primary === true || b.is_primary === 1 ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return Number(a.id) - Number(b.id);
  });
  const names = [];
  if (shots.length) await mkdir(path.join(photosRoot, folder), { recursive: true });
  let n = 1;
  for (const shot of shots) {
    const storagePath = text(shot.path);
    const destName = photoFileName(unit.sku, n);
    const dest = path.join(photosRoot, folder, destName);
    const dl = await client.storage.from("unit-photos").download(storagePath);
    if (dl.error || !dl.data) {
      missing.push(`${unit.sku}\t${storagePath}\t${dl.error?.message ?? "empty download"}`);
      continue;
    }
    const buf = Buffer.from(await dl.data.arrayBuffer());
    if (!isJpeg(buf)) {
      missing.push(`${unit.sku}\t${storagePath}\tnot a jpeg, saved anyway as ${destName}`);
    }
    await writeFile(dest, buf);
    names.push(destName);
    manifestPhotos.push({
      id: shot.id,
      sku: unit.sku,
      folder,
      file: destName,
      storagePath,
      originalPath: text(shot.original_path) || storagePath,
      isPrimary: shot.is_primary === true || shot.is_primary === 1,
    });
    n += 1;
  }
  rows.push(
    spreadsheetRow({
      unit,
      listedOn: listedBySku.get(unit.sku) ?? [],
      photoFolder: folder,
      photoFiles: names,
    }),
  );
}

await writeFile(path.join(root, "listings.csv"), toCsv(rows), "utf8");
await writeFile(path.join(root, "listings.xlsx"), toXlsx(rows));
await writeFile(
  path.join(root, "manifest.json"),
  JSON.stringify({ storeId, photos: manifestPhotos }, null, 2),
  "utf8",
);
if (missing.length) await writeFile(path.join(root, "missing-photos.txt"), missing.join("\n") + "\n", "utf8");

const readme = `Floor listing export
Store: ${storeId}
When: ${new Date().toISOString()}
Units: ${rows.length} (${includeSold ? "including sold" : "sold skipped"})
Photos folder: this folder (SKU folders next to the spreadsheet)
Spreadsheet: listings.csv and listings.xlsx
Manifest: manifest.json

listing_title and listing_description are ready to paste into Facebook Marketplace and similar.
Primary photo is 01 in each SKU folder.
`;
await writeFile(path.join(root, "README.txt"), readme, "utf8");

console.log(
  JSON.stringify(
    {
      ok: true,
      storeId,
      out: root,
      units: rows.length,
      only,
      includeSold,
      photosMissing: missing.length,
    },
    null,
    2,
  ),
);
