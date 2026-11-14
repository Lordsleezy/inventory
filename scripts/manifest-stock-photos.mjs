/**
 * Fill a matching stock photo for every TRA-7096264 line.
 * Order: barcode catalog, eBay Browse by GTIN, Costco.com item page, Gemini search.
 * A picture is kept only when it belongs to that manifest line.
 *
 *   node scripts/manifest-stock-photos.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { chooseStockPhoto } from "../netlify/lib/manifest-expand.mjs";
import { browseGtinImages, catalogProductByGtin } from "../netlify/lib/ebay-catalog.mjs";
import { costcoByItemNumber } from "../netlify/lib/costco-lookup.mjs";

const LOT = "TRA-7096264";
const KEY = `manifest_line_enrichment_${LOT}`;
const STORE = "5487ca47-6147-4fe8-bc6d-46b6472726ba";
const cached = JSON.parse(fs.readFileSync(path.join(process.env.TEMP, "netlify-env-inventoryobi.json"), "utf8"));
for (const row of cached) {
  if (!process.env[row.key] && row.values?.[0]?.value) process.env[row.key] = row.values[0].value;
}
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } });

async function geminiImage(lineText) {
  const modelName = process.env.GEMINI_RECEIVE_MODEL || "gemini-3.5-flash-lite";
  const schema = {
    type: "object",
    properties: { title: { type: "string" }, image_url: { type: "string" } },
    required: ["title", "image_url"],
  };
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: `Find one official product photo for: ${lineText}. Use Google Search. Return the direct https image URL and the product title. Leave image_url empty if you cannot verify it is this exact product. Do not guess.` }] }],
      tools: [{ googleSearch: {} }],
      generationConfig: { responseMimeType: "application/json", responseJsonSchema: schema, maxOutputTokens: 300, thinkingConfig: { thinkingLevel: "LOW" } },
    }),
    signal: AbortSignal.timeout(60000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) return null;
  const text = body.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "{}";
  try { return JSON.parse(text); } catch { return null; }
}

const { data: lines, error } = await sb.from("manifest_lines")
  .select("tcin,item_number,description,brand,upc_normalized")
  .eq("lot_id", LOT);
if (error) throw new Error(error.message);
const { data: setting } = await sb.from("store_settings").select("value").eq("store_id", STORE).eq("key", KEY).maybeSingle();
const book = setting?.value && typeof setting.value === "object" ? setting.value : {};
const gtins = (lines || []).map((line) => String(line.upc_normalized || "").padStart(14, "0")).filter((code) => !code.startsWith("4999"));
const [products, caches] = await Promise.all([
  sb.from("floor_products").select("gtin14,title,images,aspects").in("gtin14", gtins),
  sb.from("upc_lookup_cache").select("gtin14,payload").in("gtin14", gtins),
]);
const productBy = new Map((products.data || []).map((row) => [row.gtin14, row]));
const cacheBy = new Map((caches.data || []).map((row) => [row.gtin14, row.payload || {}]));

const logFile = path.join(process.env.TEMP, "floor-stock-photos.log");
fs.writeFileSync(logFile, "");
function log(message) {
  fs.appendFileSync(logFile, `${message}\n`);
  console.log(message);
}
let found = 0;
let tried = 0;
const queue = [...(lines || [])];
async function one(line) {
  const item = String(line.tcin || "");
  const entry = book[item] || {};
  const lineText = [line.description, line.brand, entry.expanded_title].filter(Boolean).join(" ");
  const internal = String(line.upc_normalized || "").startsWith("4999");
  const gtin = String(line.upc_normalized || "").padStart(14, "0");
  const product = productBy.get(gtin);
  const payload = cacheBy.get(gtin) || {};
  const candidates = [];
  if (Array.isArray(entry.images)) candidates.push(...entry.images.map((url) => ({ url, title: lineText, trusted: true })));
  if (payload.amazon?.identifier_match) candidates.push(...(payload.amazon.images || []).map((url) => ({ url, title: payload.amazon.title, trusted: true })));
  candidates.push(...(payload.upcitemdb?.images || []).map((url) => ({ url, title: payload.upcitemdb?.title || payload.merged?.title || "", trusted: false })));
  if (product && String(product.aspects?.identifier_match) === "true") candidates.push(...(product.images || []).map((url) => ({ url, title: product.title, trusted: true })));
  let url = chooseStockPhoto(lineText, candidates);
  if (!url && !internal) {
    try {
      const catalog = await catalogProductByGtin(line.upc_normalized);
      if (catalog?.imageUrls?.length) url = chooseStockPhoto(lineText, catalog.imageUrls.map((image) => ({ url: image, title: catalog.title, trusted: false })));
    } catch { /* catalog is optional */ }
  }
  if (!url && !internal) {
    try {
      const rows = await browseGtinImages(line.upc_normalized);
      url = chooseStockPhoto(lineText, rows);
    } catch { /* browse is optional */ }
  }
  if (!url && line.item_number) {
    try {
      const costco = await costcoByItemNumber(line.item_number);
      if (costco.images?.[0]) url = chooseStockPhoto(lineText, [{ url: costco.images[0], title: costco.title || "", trusted: false }]);
    } catch { /* costco is optional */ }
  }
  let searched = null;
  if (!url) {
    try {
      searched = await geminiImage(lineText);
      if (searched?.image_url) url = chooseStockPhoto(lineText, [{ url: String(searched.image_url).replace(/^http:\/\//i, "https://"), title: searched.title || "", trusted: false }]);
    } catch { /* search is optional */ }
  }
  if (!url) log(`miss ${line.item_number} ${JSON.stringify({ title: searched?.title || "", image: searched?.image_url || "" })}`);
  tried += 1;
  if (url) {
    book[item] = { ...entry, images: [url], image_at: new Date().toISOString() };
    found += 1;
  }
  if (tried % 20 === 0) {
    await sb.from("store_settings").upsert({ store_id: STORE, key: KEY, value: book }, { onConflict: "store_id,key" });
    log(`photos ${found} of ${tried}`);
  }
}
log(`start ${queue.length} lines`);
await Promise.all(Array.from({ length: 4 }, async () => {
  while (queue.length) await one(queue.shift());
}));
await sb.from("store_settings").upsert({ store_id: STORE, key: KEY, value: book }, { onConflict: "store_id,key" });
const withPhoto = Object.values(book).filter((row) => Array.isArray(row.images) && row.images.length).length;
log(JSON.stringify({ lines: (lines || []).length, withPhoto, missing: (lines || []).length - withPhoto }));
