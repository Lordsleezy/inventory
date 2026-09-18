/**
 * Export units + photos for Facebook / channel listing prep.
 *
 *   set SUPABASE_URL=https://zoukmsmbztcuyoslvikp.supabase.co
 *   set SUPABASE_SERVICE_ROLE=...
 *   set STORE_ID=<uuid from Setup>
 *   npm run export:listings
 *
 * Sold units are skipped. Pass --sold to include them.
 * Optional: --out path\to\folder
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createServiceClient,
  photoFileName,
  photoFolderName,
  requiredStoreId,
  spreadsheetRow,
  toCsv,
  toXlsx,
  type ExportUnit,
} from "@floor/cloud";

const PAGE = 1000;
const includeSold = process.argv.includes("--sold") || process.env.INCLUDE_SOLD === "1";
const outFlag = process.argv.findIndex((a) => a === "--out");
const outArg = outFlag >= 0 ? process.argv[outFlag + 1] : "";

function stampFolder(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `listings-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

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

const storeId = requiredStoreId();
const client = createServiceClient();

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

const units = (await allRows(fetchUnits)).map(toUnit);

const photos = await allRows((from, to) =>
  client
    .from("photos")
    .select("id, sku, path, is_primary, created_at")
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

const root = path.resolve(outArg || path.join("exports", stampFolder()));
const photosRoot = path.join(root, "photos");
await mkdir(photosRoot, { recursive: true });

const rows = [];
const missing = [];

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
if (missing.length) await writeFile(path.join(root, "missing-photos.txt"), missing.join("\n") + "\n", "utf8");

const readme = `Floor listing export
Store: ${storeId}
When: ${new Date().toISOString()}
Units: ${rows.length} (${includeSold ? "including sold" : "sold skipped"})
Photos folder: photos/
Spreadsheet: listings.csv and listings.xlsx

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
      includeSold,
      photosMissing: missing.length,
    },
    null,
    2,
  ),
);
