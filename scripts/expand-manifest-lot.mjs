/**
 * Expand truncated TRA-7096264 names with Gemini Search, then fill category,
 * brand, known specifics, and Costco photos/sizes. Never writes cost or price.
 *
 *   node scripts/expand-manifest-lot.mjs [--limit N] [--offset N] [--force]
 */
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { acceptedExpansion, categoryFits } from "../netlify/lib/manifest-expand.mjs";
import { colorOf, sizeOf } from "../netlify/lib/costco-receive.mjs";
import { costcoByItemNumber } from "../netlify/lib/costco-lookup.mjs";
import { suggestCategories } from "../netlify/lib/ebay-catalog.mjs";

const LOT = "TRA-7096264";
const KEY = `manifest_line_enrichment_${LOT}`;
const STORE = "5487ca47-6147-4fe8-bc6d-46b6472726ba";
const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : (args[index + 1] ?? true);
};
const limit = Number(flag("--limit", "0")) || 0;
const offset = Number(flag("--offset", "0")) || 0;
const force = args.includes("--force");
const repairCategories = args.includes("--repair-categories");

const cached = JSON.parse(fs.readFileSync(path.join(process.env.TEMP, "netlify-env-inventoryobi.json"), "utf8"));
for (const row of cached) {
  if (!process.env[row.key] && row.values?.[0]?.value) process.env[row.key] = row.values[0].value;
}

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } });

function parseRow(line) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') { quoted = !quoted; continue; }
    if (char === "," && !quoted) { cells.push(current); current = ""; continue; }
    current += char;
  }
  cells.push(current);
  return cells;
}

function vendorsByItem() {
  const text = fs.readFileSync(path.resolve("data/manifests/TRA-7096264_raw.csv"), "utf8");
  const [header, ...rows] = text.split(/\r?\n/).filter(Boolean);
  const columns = parseRow(header);
  const itemAt = columns.indexOf("Item #");
  const vendorAt = columns.indexOf("Vendor");
  const map = new Map();
  for (const row of rows) {
    const cells = parseRow(row);
    map.set(String(cells[itemAt] || "").replace(/\D/g, ""), cells[vendorAt] || "");
  }
  return map;
}

async function expandName(line, vendor) {
  const modelName = process.env.GEMINI_RECEIVE_MODEL || "gemini-3.5-flash-lite";
  const schema = {
    type: "object",
    properties: {
      title: { type: "string" }, brand: { type: "string" }, model: { type: "string" },
      manufacturer_upc: { type: "string" }, description: { type: "string" },
    },
    required: ["title", "brand", "model", "manufacturer_upc", "description"],
  };
  const prompt = [
    "This Costco B-Stock manifest line is cut off. Use Google Search to find the full product name and model.",
    `Manifest description: ${line.description || ""}`,
    `Brand: ${line.brand || ""}`,
    `Vendor: ${vendor || ""}`,
    `Costco item number: ${line.item_number || line.tcin || ""}`,
    "Fill a field only when a page matches this brand or these description words.",
    "Leave a field as an empty string rather than guess. Never include a price. Never invent a UPC.",
  ].join("\n");
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      tools: [{ googleSearch: {} }],
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: schema,
        maxOutputTokens: 400,
        thinkingConfig: { thinkingLevel: "LOW" },
      },
    }),
    signal: AbortSignal.timeout(60000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || `Gemini ${response.status}`);
  const text = body.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "{}";
  return JSON.parse(text);
}

function knownSpecifics(title) {
  const specifics = {};
  const color = colorOf(title);
  const size = sizeOf(title);
  if (color && title.toLowerCase().includes(color)) specifics.Color = color;
  if (size && title.toLowerCase().includes(String(size).toLowerCase())) specifics.Size = size;
  return specifics;
}

async function categoryFor(name) {
  try {
    const rows = await suggestCategories(name);
    const first = rows.find((row) => row.categoryId && row.categoryId !== "20713" && categoryFits(name, row.categoryName));
    if (!first) return {};
    return { ebay_category_id: first.categoryId, ebay_category_name: first.categoryName };
  } catch (error) {
    return { category_error: String(error.message || error).slice(0, 160) };
  }
}

const vendors = vendorsByItem();
const { data: lines, error } = await sb.from("manifest_lines")
  .select("tcin,item_number,description,brand,upc_normalized")
  .eq("lot_id", LOT)
  .order("line_number");
if (error) throw new Error(error.message);
const { data: setting } = await sb.from("store_settings").select("value").eq("store_id", STORE).eq("key", KEY).maybeSingle();
const book = setting?.value && typeof setting.value === "object" ? setting.value : {};
const slice = (lines || []).slice(offset, limit ? offset + limit : undefined);
let written = 0;
for (const line of slice) {
  const item = String(line.tcin || line.item_number || "");
  if (!item) continue;
  if (repairCategories) {
    const current = book[item] || {};
    const name = current.expanded_title || line.description || "";
    const leaf = String(current.ebay_category_name || "").split(">").pop() || "";
    if (current.ebay_category_id && categoryFits(name, leaf)) continue;
    const category = await categoryFor(`${name} ${line.description || ""}`);
    book[item] = {
      ...current,
      ebay_category_id: category.ebay_category_id || "",
      ebay_category_name: category.ebay_category_name || "",
    };
    written += 1;
    if (written % 10 === 0) {
      await sb.from("store_settings").upsert({ store_id: STORE, key: KEY, value: book }, { onConflict: "store_id,key" });
      console.log(`category ${written} ${line.item_number} ${category.ebay_category_name || "blank"}`);
    }
    continue;
  }
  if (!force && book[item]?.expanded_title) continue;
  const vendor = vendors.get(String(line.item_number || line.tcin || "").replace(/\D/g, "")) || "";
  let raw = {};
  try { raw = await expandName(line, vendor); }
  catch (err) { raw = { error: String(err.message || err).slice(0, 160) }; }
  const accepted = acceptedExpansion({
    description: line.description, brand: line.brand, vendor,
    title: raw.title, expandedBrand: raw.brand, model: raw.model, manufacturerUpc: raw.manufacturer_upc,
  });
  const name = accepted.expanded_title || line.description;
  const category = await categoryFor(name);
  let photos = {};
  try {
    const costco = await costcoByItemNumber(line.item_number || line.tcin);
    if (costco.found) {
      photos = {
        images: (costco.images || []).filter((url) => /^https?:/i.test(url)).slice(0, 4),
        package: costco.package || {},
      };
    }
  } catch { /* a blocked Costco page leaves the photo blank */ }
  const specifics = knownSpecifics(accepted.expanded_title || "");
  book[item] = {
    ...(book[item] || {}),
    ...accepted,
    expanded_description: accepted.expanded_title ? String(raw.description || "").slice(0, 500) : "",
    vendor,
    ...category,
    ...photos,
    specifics,
    expanded_at: new Date().toISOString(),
    expand_error: raw.error || "",
  };
  written += 1;
  if (written % 5 === 0) {
    await sb.from("store_settings").upsert({ store_id: STORE, key: KEY, value: book }, { onConflict: "store_id,key" });
    console.log(`saved ${written} ${line.item_number} ${accepted.expanded_title || "stub"}`);
  }
}
await sb.from("store_settings").upsert({ store_id: STORE, key: KEY, value: book }, { onConflict: "store_id,key" });
const ready = Object.values(book).filter((row) => row.expanded_title).length;
console.log(JSON.stringify({ lines: (lines || []).length, written, expanded: ready }));
