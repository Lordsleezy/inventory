/**
 * Recheck every TRA-7096264 stock photo with vision.
 * Identifiers first (Costco item number, then the barcode). A name search is last.
 * A box back or another year's set is removed and never picked again.
 *
 *   node scripts/verify-manifest-photos.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { browseGtinImages, catalogProductByGtin } from "../netlify/lib/ebay-catalog.mjs";
import { costcoByItemNumber, costcoByItemSearch } from "../netlify/lib/costco-lookup.mjs";
import { judgeStockPhoto, keepStockJudgment } from "../netlify/lib/stock-photo-verify.mjs";

const LOT = "TRA-7096264";
const KEY = `manifest_line_enrichment_${LOT}`;
const STORE = "5487ca47-6147-4fe8-bc6d-46b6472726ba";
const cached = JSON.parse(fs.readFileSync(path.join(process.env.TEMP, "netlify-env-inventoryobi.json"), "utf8"));
for (const row of cached) {
  if (!process.env[row.key] && row.values?.[0]?.value) process.env[row.key] = row.values[0].value;
}
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } });
const missingOnly = process.env.MISSING_ONLY === "1";
const logFile = path.join(process.env.TEMP, missingOnly ? "floor-photo-missing.log" : "floor-photo-verify.log");
fs.writeFileSync(logFile, "");
function log(message) {
  fs.appendFileSync(logFile, `${message}\n`);
  console.log(message);
}

async function nameImage(identity) {
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
      contents: [{ role: "user", parts: [{ text: `Find the official product photo for this exact Costco item. Item number ${identity.item_number}. UPC ${identity.upc}. Name: ${identity.expanded_title || identity.description}. A different year with a similar name is the wrong product. Return one direct https image URL of the product or the front of its box, or leave image_url empty.` }] }],
      tools: [{ googleSearch: {} }],
      generationConfig: { responseMimeType: "application/json", responseJsonSchema: schema, maxOutputTokens: 300, thinkingConfig: { thinkingLevel: "LOW" } },
    }),
    signal: AbortSignal.timeout(60000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) return "";
  const text = body.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "{}";
  try { return String(JSON.parse(text).image_url || "").replace(/^http:\/\//i, "https://"); } catch { return ""; }
}

async function candidatesFor(line, entry) {
  const urls = [];
  const push = (list) => {
    for (const url of list || []) {
      if (typeof url === "string" && /^https:\/\//i.test(url) && !urls.includes(url)) urls.push(url);
    }
  };
  if (line.item_number) {
    try { push((await costcoByItemNumber(line.item_number)).images); } catch { /* costco is optional */ }
    if (!urls.length) {
      try { push((await costcoByItemSearch(line.item_number)).images); } catch { /* search is optional */ }
    }
  }
  const internal = String(line.upc_normalized || "").startsWith("4999");
  if (!internal) {
    try {
      const catalog = await catalogProductByGtin(line.upc_normalized);
      push(catalog?.imageUrls);
    } catch { /* catalog is optional */ }
    try {
      const rows = await browseGtinImages(line.upc_normalized);
      push(rows.map((row) => row.url));
    } catch { /* browse is optional */ }
  }
  const found = await nameImage({
    item_number: line.item_number,
    upc: line.upc_normalized,
    description: line.description,
    expanded_title: entry.expanded_title,
  });
  if (found) push([found]);
  return urls;
}

const { data: lines, error } = await sb.from("manifest_lines")
  .select("tcin,item_number,description,brand,upc_normalized")
  .eq("lot_id", LOT);
if (error) throw new Error(error.message);
const { data: setting } = await sb.from("store_settings").select("value").eq("store_id", STORE).eq("key", KEY).maybeSingle();
const book = setting?.value && typeof setting.value === "object" ? setting.value : {};
let checked = 0;
let wrong = 0;
let replaced = 0;
const queue = [...(lines || [])];

async function one(line) {
  const item = String(line.tcin || "");
  const entry = book[item] || {};
  const rejected = new Set(Array.isArray(entry.rejected_images) ? entry.rejected_images : []);
  const identity = {
    description: line.description,
    brand: line.brand || entry.expanded_brand || "",
    item_number: line.item_number,
    upc: line.upc_normalized,
    expanded_title: entry.expanded_title || line.description,
    expanded_description: entry.expanded_description || "",
  };
  const current = Array.isArray(entry.images) ? entry.images.filter((url) => typeof url === "string" && !rejected.has(url)) : [];
  if (missingOnly && current.length) return;
  let kept = "";
  let fallback = "";
  for (const url of current) {
    try {
      const judgment = await judgeStockPhoto(url, identity);
      if (judgment.skipped) { kept = url; break; }
      if (keepStockJudgment(judgment)) { kept = url; break; }
      if (judgment.same_product && !judgment.low_quality) { fallback = url; continue; }
      rejected.add(url);
      wrong += 1;
      log(`wrong ${line.item_number} ${judgment.shot} ${judgment.reason || ""}`);
    } catch (err) {
      kept = url;
      log(`skip ${line.item_number} ${err.message || err}`);
      break;
    }
  }
  if (!kept) {
    const fresh = (await candidatesFor(line, entry)).filter((url) => !rejected.has(url));
    for (const url of fresh.slice(0, 6)) {
      try {
        const judgment = await judgeStockPhoto(url, identity);
        if (judgment.skipped) continue;
        if (keepStockJudgment(judgment)) { kept = url; if (current.length) replaced += 1; break; }
        if (judgment.same_product && !judgment.low_quality && !fallback) fallback = url;
        else rejected.add(url);
      } catch { /* one bad candidate does not stop the line */ }
    }
  }
  if (!kept && fallback) kept = fallback;
  book[item] = {
    ...entry,
    images: kept ? [kept] : [],
    rejected_images: [...rejected].slice(0, 20),
    image_verified_at: new Date().toISOString(),
  };
  checked += 1;
  if (checked % 15 === 0) {
    await sb.from("store_settings").upsert({ store_id: STORE, key: KEY, value: book }, { onConflict: "store_id,key" });
    log(`checked ${checked} wrong ${wrong} replaced ${replaced}`);
  }
}

log(`start ${queue.length}`);
await Promise.all(Array.from({ length: missingOnly ? 2 : 4 }, async () => {
  while (queue.length) await one(queue.shift());
}));
await sb.from("store_settings").upsert({ store_id: STORE, key: KEY, value: book }, { onConflict: "store_id,key" });
const withPhoto = Object.values(book).filter((row) => Array.isArray(row.images) && row.images.length).length;
log(JSON.stringify({ lines: (lines || []).length, wrong, replaced, withPhoto, missing: (lines || []).length - withPhoto }));
