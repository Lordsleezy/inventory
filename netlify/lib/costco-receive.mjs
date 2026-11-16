/**
 * Receive prefill for a pre-warmed manifest line.
 * Reads floor_products, the lookup cache, and the manifest. No catalog calls.
 */
import { isCostcoInternalCode } from "./gtin.mjs";
import { barcodeLookupKeys, normalizeGtin } from "./gtin-normalize.mjs";
import { keepStockPhoto } from "./stock-photo.mjs";

const LOT_KEY = "manifest_line_enrichment_TRA-7096264";
const COLORS = ["brushed nickel", "polished gold", "obsidian", "stainless", "black", "white", "silver", "gold", "blue", "green", "red", "navy", "gray", "grey", "pink", "brown"];
function digits(value) {
  return String(value ?? "").replace(/\D/g, "");
}

export function hamming(left, right) {
  if (!left || left.length !== right.length) return 99;
  let distance = 0;
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) distance += 1;
  return distance;
}

/** One manifest item number named by a Costco page. Two different items means no guess. */
export function manifestItemFromText(text, itemNumbers) {
  const want = new Set((itemNumbers || []).map(value => String(value || "").replace(/\D/g, "")).filter(value => value.length >= 6 && value.length <= 8));
  const found = new Set();
  const source = String(text || "");
  for (const match of source.matchAll(/costco\.com\/p\/[^"'\\\s<>]*?\/(\d{6,8})\b/gi)) {
    if (want.has(match[1])) found.add(match[1]);
  }
  for (const match of source.matchAll(/"sku"\s*:\s*"(\d{6,8})"/gi)) {
    if (want.has(match[1])) found.add(match[1]);
  }
  for (const match of source.matchAll(/\bItem\s+#?\s*(\d{6,8})\b/gi)) {
    if (want.has(match[1])) found.add(match[1]);
  }
  return found.size === 1 ? [...found][0] : null;
}

async function defaultRetailUpcSearch(code, itemNumbers) {
  const headers = { "User-Agent": "Mozilla/5.0" };
  try {
    const search = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(`${code} site:costco.com`)}`, {
      headers, signal: AbortSignal.timeout(8000),
    });
    const html = await search.text();
    const direct = manifestItemFromText(html, itemNumbers);
    if (direct) return direct;
    const links = [...new Set([...html.matchAll(/uddg=([^&"]+)/g)].map(match => {
      try { return decodeURIComponent(match[1]); } catch { return ""; }
    }).filter(url => /^https:\/\/www\.costco\.com\/p\//i.test(url)))].slice(0, 2);
    for (const page of links) {
      const res = await fetch(page, { headers, signal: AbortSignal.timeout(8000) });
      const item = manifestItemFromText(await res.text(), itemNumbers);
      if (item) return item;
    }
  } catch { /* a miss stays a miss */ }
  return null;
}

/** A unique same-length barcode within `max` digit changes. A tie stays unmatched. */
export function nearestManifestLine(scanned, lines, max = 3) {
  const code = digits(scanned);
  if (code.length < 8) return null;
  let best = [];
  let distance = 99;
  for (const line of lines || []) {
    const upc = digits(line?.upc_normalized || line?.upc_raw);
    if (!upc || upc === code || upc.length !== code.length) continue;
    const next = hamming(upc, code);
    if (next < distance) { distance = next; best = [line]; }
    else if (next === distance) best.push(line);
  }
  if (best.length === 1 && distance >= 1 && distance <= max) return { line: best[0], distance };
  return null;
}

function categoryIdOf(...values) {
  for (const value of values) {
    const id = clean(value);
    if (/^\d+$/.test(id) && id !== "20713") return id;
  }
  return null;
}

function specificsFrom(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (/cost|price|ask|fee/i.test(key)) continue;
    const text = clean(value);
    if (!text || /^(unknown|n\/a|none|guess)$/i.test(text)) continue;
    out[String(key).slice(0, 40)] = text.slice(0, 80);
  }
  return out;
}

function clean(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || "";
}

export function candidateTitles(why) {
  const match = clean(why).match(/^Several Amazon results match:\s*(.+)$/i);
  if (!match) return [];
  return match[1].split("|").map((part) => clean(part)).filter((part) => part.length > 8);
}

export function colorOf(title) {
  const text = title.toLowerCase();
  return COLORS.find((color) => text.includes(color)) || "";
}

export function sizeOf(title) {
  const match = title.match(/\b(?:XXS|XS|S\/M|L\/XL|\dXL|X{0,3}[SML]|\d+(?:\.\d+)?\s*(?:oz|fl oz|ct|count|pack|pk))\b/i);
  return match ? match[0] : "";
}

export function packCountOf(description, note, aspects) {
  const stored = Number(aspects?.pack_count);
  if (Number.isInteger(stored) && stored > 1) return stored;
  const blob = `${description || ""} ${note || ""}`;
  const match = blob.match(/\b(\d+)\s*(?:ct|count|pk|pack)\b/i);
  const n = match ? Number(match[1]) : null;
  return n && n > 1 && n < 10000 ? n : null;
}

function allowedPhoto(url) {
  return /images-amazon\.com|media-amazon\.com|ssl-images-amazon\.com|m\.media-amazon\.com|images\.philips\.com|mediaserver\.goepson\.com/i.test(String(url || ""));
}

function httpsImages(list) {
  return [...new Set((list || []).filter((url) => typeof url === "string" && /^https:\/\//i.test(url) && !/\/1x1[./]|pixel|placeholder|spacer|blank\./i.test(url)))].slice(0, 6);
}

function photosOf(product, amazon) {
  return httpsImages([...(product?.images || []), ...(amazon?.images || [])]);
}

/** Stock photos for this manifest line. A fuzzy catalog picture is left out, even when its title repeats the manifest words. */
export function stockImagesForLine({ enrich = {}, product = null, amazon = null, trusted = false }) {
  const rejected = new Set((enrich?.rejected_images || []).filter((url) => typeof url === "string"));
  const stored = httpsImages(enrich?.images).filter((url) => !rejected.has(url));
  const catalog = (trusted || amazon?.identifier_match === true ? photosOf(product, amazon) : []).filter((url) => !rejected.has(url));
  return [...new Set([...stored, ...catalog])].slice(0, 6);
}

export function conflictFor(itemNumber, enrich) {
  const item = String(itemNumber || "");
  const saved = enrich?.resolved && typeof enrich.resolved === "object" ? enrich.resolved : {};
  const named = item === "1937993"
    ? { field: "lumens", note: "Check the lumen count on the box. One source says 5000, another says 3600.", values: ["5000", "3600"] }
    : item === "1896208"
      ? { field: "pack", note: "Check the swab count on the box. The manifest says 1875 and the barcode record says 875.", values: ["1875", "875"] }
      : item === "1806358"
        ? { field: "count", note: "Confirm the box is the 40-count Power Boost. Leave the other Duracell 40-count alone.", values: ["40"] }
        : item === "1539810"
          ? { field: "generation", note: "Check the Nest generation printed on the box.", values: [] }
          : null;
  const stored = Array.isArray(enrich?.conflicts) ? enrich.conflicts.find((row) => row?.field && row.field !== "color") : null;
  const base = named || (stored
    ? {
      field: String(stored.field),
      note: stored.note || `Check ${stored.field} on the box${stored.values?.length ? `: ${stored.values.join(" vs ")}` : ""}.`,
      values: stored.values || [],
    }
    : null);
  if (!base) return null;
  return { ...base, saved: clean(saved[base.field]) || null };
}

/**
 * A catalog row is usable only when the source matched this GTIN.
 * A title search is not a match, and it never becomes a picker.
 */
export function catalogTrusted({ amazon = null, enrich = {} } = {}) {
  if (amazon?.identifier_match === true && (amazon?.found || clean(amazon?.title))) return true;
  return enrich?.via === "gtin" && Boolean(clean(enrich?.title));
}

/**
 * Decide what Receive should show. Pure: no I/O.
 * A manifest line is always found. Catalog details are added only for a GTIN match.
 */
export function classifyCostcoLine({ line, enrich = {}, product = null, amazon = null }) {
  const item = String(line?.tcin || line?.item_number || "");
  const internal = isCostcoInternalCode(line?.upc_raw) || isCostcoInternalCode(line?.upc_normalized);
  const pinnedTitle = clean(product?.aspects?.pinned_title || enrich?.pinned?.title || enrich?.pinned_title);
  const trusted = catalogTrusted({ amazon, enrich });
  const fuzzy = candidateTitles(enrich?.why);
  const review = !enrich?.identity_accepted && !trusted && (fuzzy.length > 0 || Boolean(clean(product?.title) && !pinnedTitle));
  return {
    item,
    internal,
    bucket: "ready",
    photo: false,
    candidates: [],
    pinnedTitle: trusted ? pinnedTitle : "",
    review,
    trusted,
    conflict: conflictFor(item, { ...enrich, resolved: { ...(enrich?.resolved || {}), ...(product?.aspects?.resolved || {}) } }),
  };
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function measurementSource(product, key) {
  const sources = product?.dim_sources && typeof product.dim_sources === "object" ? product.dim_sources : {};
  return String(sources[key] || sources[`package_${key}`] || "");
}

/** A box saved on this barcode. Estimates and guesses are not measurements. */
function storedBoxMeasure(product, column) {
  const key = column.replace(/^package_/, "");
  if (/estimat|\bai\b|gemini/i.test(measurementSource(product, key))) return null;
  return numberOrNull(product?.[column]);
}

const GENERIC_MEASURE_WORDS = new Set(["pack", "piece", "pieces", "black", "white", "square", "metal", "small", "large", "size", "inch", "inches", "count", "with", "from", "blue", "gray", "grey", "home", "set"]);

function measureWords(value) {
  return new Set(clean(value).toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 3 && !GENERIC_MEASURE_WORDS.has(token)));
}

/** A catalog size belongs to this receive only when it is the same product. */
function measurementAgrees(source, identity) {
  const sourceBrand = clean(source?.brand);
  const identityBrand = clean(identity?.brand);
  const sourceTitle = clean(source?.title);
  const identityTitle = clean(identity?.title);
  if (!sourceTitle && !sourceBrand) return true;
  if (!identityTitle && !identityBrand) return true;
  const brandHit = (left, right) => {
    const a = left.toLowerCase();
    const b = right.toLowerCase();
    return a === b || a.includes(b) || b.includes(a);
  };
  if (sourceBrand && identityBrand && !brandHit(sourceBrand, identityBrand)) {
    const sourceInTitle = identityTitle && identityTitle.toLowerCase().includes(sourceBrand.toLowerCase());
    const identityInTitle = sourceTitle && sourceTitle.toLowerCase().includes(identityBrand.toLowerCase());
    if (!sourceInTitle && !identityInTitle) return false;
  }
  if (sourceBrand && identityBrand && brandHit(sourceBrand, identityBrand)) return true;
  const left = measureWords(`${sourceBrand || ""} ${sourceTitle || ""}`);
  const right = measureWords(`${identityBrand || ""} ${identityTitle || ""}`);
  if (!left.size || !right.size) return false;
  for (const token of left) if (right.has(token)) return true;
  return false;
}

function packageFrom(product, amazon, pinned) {
  const box = pinned?.package || {};
  return {
    length_in: storedBoxMeasure(product, "package_length_in") || numberOrNull(amazon?.package?.length_in) || numberOrNull(box.length_in),
    width_in: storedBoxMeasure(product, "package_width_in") || numberOrNull(amazon?.package?.width_in) || numberOrNull(box.width_in),
    height_in: storedBoxMeasure(product, "package_height_in") || numberOrNull(amazon?.package?.height_in) || numberOrNull(box.height_in),
    weight_lb: storedBoxMeasure(product, "package_weight_lb") || numberOrNull(amazon?.package?.weight_lb) || numberOrNull(box.weight_lb) || numberOrNull(product?.aspects?.published_weight?.weight_lb || product?.aspects?.published_weight),
  };
}

/** Item size, not the shipping carton. A matched catalog measurement wins over a saved guess. */
function itemSize(product, amazon, upcitemdb) {
  const stored = product?.aspects && typeof product.aspects === "object" ? product.aspects : {};
  const saved = stored.item_dims && typeof stored.item_dims === "object" ? stored.item_dims : {};
  const catalog = amazon?.item || {};
  const listed = upcitemdb?.item || {};
  const trusted = amazon?.identifier_match === true;
  const length = numberOrNull(catalog.length_in);
  const width = numberOrNull(catalog.width_in);
  const height = numberOrNull(catalog.height_in);
  const placeholder = !trusted && length && width && height && length === width && width === height;
  const pick = (aspectKey, itemKey) => {
    if (/estimat|\bai\b|gemini/i.test(measurementSource(product, aspectKey))) {
      return placeholder ? null : (numberOrNull(catalog[itemKey]) || numberOrNull(listed[itemKey]));
    }
    return numberOrNull(stored[aspectKey]) || numberOrNull(saved[itemKey])
      || (placeholder ? null : numberOrNull(catalog[itemKey]))
      || numberOrNull(listed[itemKey]);
  };
  return {
    product_depth_in: pick("product_depth_in", "length_in"),
    product_width_in: pick("product_width_in", "width_in"),
    product_height_in: pick("product_height_in", "height_in"),
    product_weight_lb: pick("product_weight_lb", "weight_lb"),
  };
}

function itemAspects(product, amazon, pinned) {
  const item = pinned?.item || product?.aspects?.item_dims || amazon?.item || {};
  const aspects = {};
  if (numberOrNull(item.height_in)) aspects.product_height_in = String(item.height_in);
  if (numberOrNull(item.width_in)) aspects.product_width_in = String(item.width_in);
  if (numberOrNull(item.length_in)) aspects.product_depth_in = String(item.length_in);
  if (numberOrNull(item.weight_lb)) aspects.product_weight_lb = String(item.weight_lb);
  const weight = numberOrNull(product?.aspects?.published_weight?.weight_lb || product?.aspects?.published_weight);
  if (weight && !aspects.product_weight_lb && !numberOrNull(product?.package_weight_lb)) aspects.product_weight_lb = String(weight);
  return aspects;
}

export function buildCostcoReceive({ line, enrich = {}, product = null, amazon = null, upcitemdb = null, costco = null, stripMoney = false }) {
  const decision = classifyCostcoLine({ line, enrich, product, amazon });
  const pinned = enrich?.pinned && typeof enrich.pinned === "object" ? enrich.pinned : null;
  const useCatalog = decision.trusted;
  const expandedTitle = clean(enrich?.expanded_title);
  const expandedBrand = clean(enrich?.expanded_brand);
  const brand = clean(useCatalog ? (product?.brand || pinned?.brand || amazon?.brand || enrich?.brand || line?.brand) : (line?.brand || expandedBrand || enrich?.brand));
  const title = clean(useCatalog
    ? (decision.pinnedTitle || product?.title || pinned?.title || amazon?.title || enrich?.title || expandedTitle || line?.description)
    : (expandedTitle || line?.description || ""));
  const model = clean(useCatalog ? (product?.model || pinned?.model || amazon?.model || enrich?.model || enrich?.expanded_model) : (enrich?.expanded_model || ""));
  const description = clean(useCatalog ? (product?.description || pinned?.description || amazon?.description || line?.description) : (enrich?.expanded_description || line?.description || ""));
  const features = useCatalog ? (product?.features || pinned?.features || amazon?.features || []).filter((row) => typeof row === "string").slice(0, 12) : [];
  const images = stockImagesForLine({
    line, enrich: { ...enrich, images: [...(Array.isArray(enrich?.images) ? enrich.images : []), ...(pinned?.images || [])] },
    product, amazon, expandedTitle, trusted: useCatalog,
  });
  const expandedPkg = enrich?.package && typeof enrich.package === "object" ? enrich.package : {};
  const identity = { title, brand };
  const agreedAmazon = measurementAgrees(amazon, identity) ? amazon : null;
  const agreedProduct = measurementAgrees(product, identity) ? product : null;
  // The title can stay untrusted. A box saved for this barcode still fills Receive.
  // Another product's item size does not.
  const catalogBox = packageFrom(product, agreedAmazon, useCatalog ? pinned : null);
  const listed = upcitemdb?.package || {};
  const pkg = {
    length_in: catalogBox.length_in || numberOrNull(expandedPkg.length_in) || numberOrNull(listed.length_in),
    width_in: catalogBox.width_in || numberOrNull(expandedPkg.width_in) || numberOrNull(listed.width_in),
    height_in: catalogBox.height_in || numberOrNull(expandedPkg.height_in) || numberOrNull(listed.height_in),
    weight_lb: catalogBox.weight_lb || numberOrNull(expandedPkg.weight_lb) || numberOrNull(listed.weight_lb),
  };
  const aspects = useCatalog ? itemAspects(agreedProduct, agreedAmazon, pinned) : specificsFrom(enrich?.specifics);
  for (const [key, value] of Object.entries(itemSize(agreedProduct, agreedAmazon, upcitemdb))) {
    if (value) aspects[key] = String(value);
  }
  const pack = packCountOf(line?.description, enrich?.variant_note, product?.aspects);
  const retail = stripMoney ? null : (Number.isInteger(line?.unit_retail_cents) ? line.unit_retail_cents : null);
  const gtin = decision.internal ? null : (normalizeGtin(line?.upc_normalized || line?.upc_raw).gtin14 || null);
  const candidates = decision.candidates.map((row) => ({ title: row, color: colorOf(row), size: sizeOf(row), photo: null }));
  return {
    ok: true,
    prewarmed: true,
    cached: true,
    floor_product: Boolean(useCatalog && product?.title),
    gtin: gtin ? { gtin14: gtin } : null,
    amazon: { found: false, skipped: "prewarmed" },
    upcitemdb: { found: false, skipped: "prewarmed" },
    ebay: null,
    stock_photos: images.map((url) => ({ url, source: "catalog" })),
    merged: {
      title: brand && title && !title.toLowerCase().startsWith(brand.toLowerCase()) ? `${brand} ${title}` : (title || brand || null),
      brand: brand || null,
      model: model || null,
      description: [description, features.length ? features.map((row) => `• ${row}`).join("\n") : ""].filter(Boolean).join("\n\n") || null,
      features,
      category: clean(useCatalog ? (product?.category || costco?.category || line?.seller_category || line?.category) : (line?.seller_category || line?.category)) || null,
      aspects,
      images,
      package: pkg,
      asin: useCatalog ? (product?.asin || pinned?.asin || amazon?.asin || null) : null,
      not_found: false,
    },
    fieldCoverage: { package: pkg.length_in || pkg.weight_lb ? "published" : null },
    receive: {
      bucket: decision.bucket,
      item_number: decision.item,
      manifest_id: line?.manifest_id || null,
      lot_id: line?.lot_id || null,
      pack_count: pack,
      condition_hint: "",
      review: decision.review,
      manifest_retail_cents: retail,
      conflict: decision.conflict,
      candidates,
      photo: decision.photo,
      internal: decision.internal,
      ebay_category_id: categoryIdOf(costco?.ebay_category_id, enrich?.ebay_category_id),
    },
  };
}

async function manifestIds(sb, storeId) {
  const { data, error } = await sb.from("store_manifests").select("id").eq("store_id", storeId);
  if (error) throw new Error(error.message);
  return (data || []).map((row) => row.id);
}

const LINE_COLS = "line_number,upc_raw,upc_normalized,tcin,item_number,description,brand,category,seller_category,qty,unit_retail_cents,condition,lot_id,manifest_id";

async function lineBy(sb, ids, column, value) {
  if (!ids.length || !value) return null;
  const { data, error } = await sb.from("manifest_lines")
    .select(LINE_COLS)
    .in("manifest_id", ids)
    .eq(column, value)
    .limit(1);
  if (error) throw new Error(error.message);
  return data?.[0] || null;
}

function preferLine(rows, keys) {
  const want = new Set(keys);
  return (rows || []).find((row) => want.has(row.upc_normalized) || want.has(row.upc_raw) || (row.alternate_upcs || []).some((code) => want.has(String(code))))
    || (rows || []).find((row) => want.has(row.tcin) || want.has(row.item_number))
    || null;
}

async function lineByStoredAlternate(sb, storeId, ids, keys) {
  const { data, error } = await sb.from("store_settings").select("value").eq("store_id", storeId).like("key", "manifest_line_enrichment_%");
  if (error || !data?.length) return null;
  const want = new Set(keys);
  for (const row of data) {
    const book = row.value && typeof row.value === "object" ? row.value : {};
    for (const [tcin, entry] of Object.entries(book)) {
      const alts = Array.isArray(entry?.alternate_upcs) ? entry.alternate_upcs : [];
      if (!alts.some((code) => want.has(String(code).replace(/\D/g, "")))) continue;
      const line = await lineBy(sb, ids, "tcin", tcin) || await lineBy(sb, ids, "item_number", tcin);
      if (line) return line;
    }
  }
  return null;
}

export async function findManifestLine(sb, storeId, raw) {
  const ids = await manifestIds(sb, storeId);
  const text = clean(raw);
  const keys = barcodeLookupKeys(text);
  if (!ids.length || !text) return { ids, line: null, many: [] };
  if (keys.length) {
    const filter = keys.map((key) => `upc_normalized.eq.${key},upc_raw.eq.${key},tcin.eq.${key},item_number.eq.${key}`).join(",");
    const { data, error } = await sb.from("manifest_lines").select(LINE_COLS).in("manifest_id", ids).or(filter).limit(8);
    if (error) throw new Error(error.message);
    const line = preferLine(data, keys);
    if (line) return { ids, line, many: [] };
    const alt = await sb.from("manifest_lines").select(LINE_COLS).in("manifest_id", ids).overlaps("alternate_upcs", keys).limit(1);
    if (!alt.error && alt.data?.[0]) return { ids, line: alt.data[0], many: [] };
    const stored = await lineByStoredAlternate(sb, storeId, ids, keys);
    if (stored) return { ids, line: stored, many: [] };
  }
  if (text.length >= 3 && /[a-z]/i.test(text)) {
    const safe = text.replace(/[%_\\]/g, " ").slice(0, 60);
    const { data, error } = await sb.from("manifest_lines")
      .select(LINE_COLS)
      .in("manifest_id", ids)
      .ilike("description", `%${safe}%`)
      .limit(8);
    if (error) throw new Error(error.message);
    return { ids, line: data?.length === 1 ? data[0] : null, many: data?.length > 1 ? data : [] };
  }
  return { ids, line: null, many: [] };
}

async function loadContext(sb, storeId, line) {
  const gtin = normalizeGtin(line.upc_normalized || line.upc_raw);
  const internal = isCostcoInternalCode(line.upc_raw) || isCostcoInternalCode(line.upc_normalized) || !gtin.ok;
  const key = String(line.lot_id || "").startsWith("TRA-") ? `manifest_line_enrichment_${line.lot_id}` : LOT_KEY;
  const setting = await sb.from("store_settings").select("value").eq("store_id", storeId).eq("key", key).maybeSingle();
  const book = setting.data?.value && typeof setting.data.value === "object" ? setting.data.value : {};
  const internalEnrich = book[String(line.tcin)] || {};
  if (internal) return { gtin: null, payload: null, product: null, enrich: internalEnrich, key, book };
  const [cache, product] = await Promise.all([
    sb.from("upc_lookup_cache").select("payload").eq("gtin14", gtin.gtin14).maybeSingle(),
    sb.from("floor_products").select("*").eq("gtin14", gtin.gtin14).maybeSingle(),
  ]);
  const payload = cache.data?.payload || null;
  return {
    gtin,
    payload,
    product: product.data || null,
    enrich: { ...(payload?.enrichment || {}), ...internalEnrich },
    key,
    book,
  };
}

function searchCard(rows, stripMoney) {
  return {
    ok: true,
    prewarmed: true,
    cached: true,
    amazon: { found: false, skipped: "prewarmed" },
    upcitemdb: { found: false, skipped: "prewarmed" },
    merged: { not_found: false, title: null, brand: null },
    receive: {
      bucket: "search",
      photo: false,
      internal: false,
      candidates: [],
      conflict: null,
      matches: rows.map((row) => ({
        item_number: String(row.tcin || ""),
        title: clean(row.description),
        brand: clean(row.brand),
        code: isCostcoInternalCode(row.upc_normalized) ? String(row.tcin || "") : String(row.upc_normalized || row.tcin || ""),
        retail_cents: stripMoney ? null : row.unit_retail_cents,
      })),
    },
  };
}

async function linesForStore(sb, ids) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("manifest_lines").select(LINE_COLS).in("manifest_id", ids).range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

function ownedCatalogImages(product) {
  return httpsImages(product?.images).filter((url) => keepStockPhoto(url)).slice(0, 6);
}

function cardWithImages(card, images) {
  return {
    ...card,
    stock_photos: images.map((url) => ({ url, source: "catalog" })),
    merged: { ...card.merged, images },
  };
}

async function persistShownPhotos(sb, ctx, images) {
  const urls = [...new Set((images || []).filter((url) => keepStockPhoto(url)))].slice(0, 6);
  if (!urls.length || !ctx?.gtin?.ok || isCostcoInternalCode(ctx.gtin.gtin14)) return;
  if (ctx.product) {
    const saved = [...new Set([...urls, ...(ctx.product.images || [])])].slice(0, 8);
    await sb.from("floor_products").update({
      images: saved,
      updated_at: new Date().toISOString(),
    }).eq("gtin14", ctx.gtin.gtin14);
  }
  if (ctx.payload) {
    await sb.from("upc_lookup_cache").update({
      payload: {
        ...ctx.payload,
        stock_photos: urls.map((url) => ({ url, source: "catalog" })),
        merged: { ...(ctx.payload.merged || {}), images: urls },
      },
    }).eq("gtin14", ctx.gtin.gtin14);
  }
}

async function withCatalogStock(sb, storeId, ctx, line, card) {
  let shown = card;
  const owned = ownedCatalogImages(ctx?.product);
  const sameItem = measurementAgrees(ctx?.product, { title: card?.merged?.title, brand: card?.merged?.brand });
  if (!shown?.merged?.images?.length && sameItem && owned.length) shown = cardWithImages(shown, owned);
  if (shown?.merged?.images?.length) {
    await persistShownPhotos(sb, ctx, shown.merged.images).catch(() => undefined);
    return shown;
  }
  if (shown?.receive?.internal || shown?.receive?.bucket === "search" || (ctx?.enrich?.stock_photo_checked && sameItem)) {
    return shown;
  }
  const { catalogStockPhotos, stockPhotoSearchTimed } = await import("./receive-stock-photos.mjs");
  const foundPhotos = await stockPhotoSearchTimed(catalogStockPhotos(storeId, {
    brand: card?.merged?.brand || line?.brand,
    title: card?.merged?.title || line?.description,
  }), 20000).catch(() => ({ images: [], timedOut: true }));
  const images = foundPhotos.images || [];
  const item = String(line?.tcin || line?.item_number || "");
  if (!images.length) {
    if (foundPhotos.timedOut) return card;
    if (item) await remember(sb, storeId, ctx.key, ctx.book || {}, item, { stock_photo_checked: true }).catch(() => undefined);
    return card;
  }
  if (item) await remember(sb, storeId, ctx.key, ctx.book || {}, item, { images, stock_photo_checked: true }).catch(() => undefined);
  if (ctx?.gtin?.ok && !isCostcoInternalCode(ctx.gtin.gtin14)) {
    const saved = [...new Set([...images, ...(sameItem ? (ctx.product?.images || []) : [])])].slice(0, 8);
    if (ctx.product) {
      const patch = { images: saved, updated_at: new Date().toISOString() };
      if (!sameItem && ctx.product.aspects?.item_dims) {
        const aspects = { ...ctx.product.aspects };
        delete aspects.item_dims;
        patch.aspects = aspects;
      }
      await sb.from("floor_products").update(patch).eq("gtin14", ctx.gtin.gtin14);
    } else {
      const { saveFloorProduct } = await import("./floor-products.mjs");
      await saveFloorProduct(sb, ctx.gtin, {
        brand: card.merged?.brand || line.brand,
        title: card.merged?.title || line.description,
        images: saved,
      }, { source: "lookup" });
    }
    if (ctx.payload) {
      await sb.from("upc_lookup_cache").update({
        payload: {
          ...ctx.payload,
          stock_photos: images.map((url) => ({ url, source: "catalog" })),
          merged: { ...(ctx.payload.merged || {}), images },
        },
      }).eq("gtin14", ctx.gtin.gtin14);
    }
  }
  return {
    ...card,
    stock_photos: images.map((url) => ({ url, source: "catalog" })),
    merged: { ...card.merged, images },
  };
}

export async function costcoReceiveLookup(sb, storeId, raw, { stripMoney = false, retailUpcSearch } = {}) {
  const found = await findManifestLine(sb, storeId, raw);
  if (found.many.length > 1) return searchCard(found.many, stripMoney);
  const code = digits(raw);
  if (!found.line && isCostcoInternalCode(code)) {
    return {
      ok: true,
      prewarmed: true,
      cached: true,
      amazon: { found: false, skipped: "costco_internal" },
      upcitemdb: { found: false, skipped: "costco_internal" },
      merged: { title: null, brand: null, not_found: true },
      receive: { bucket: "manifest", photo: true, internal: true, candidates: [], conflict: null, item_number: "" },
    };
  }
  if (!found.line && found.ids.length && code.length >= 8 && !isCostcoInternalCode(code)) {
    const lines = await linesForStore(sb, found.ids);
    const near = nearestManifestLine(code, lines);
    if (near) {
      const ctx = await loadContext(sb, storeId, near.line);
      const card = buildCostcoReceive({
        line: near.line,
        enrich: ctx.enrich,
        product: ctx.product,
        amazon: ctx.payload?.amazon || null,
        upcitemdb: ctx.payload?.upcitemdb || null,
        costco: ctx.payload?.costco || null,
        stripMoney,
      });
      card.receive.suggested = true;
      card.receive.scanned_code = code;
      return withCatalogStock(sb, storeId, ctx, near.line, card);
    }
    if (code.length >= 12) {
      const numbers = lines.flatMap(line => [line.tcin, line.item_number]);
      let item = null;
      try { item = await (retailUpcSearch || defaultRetailUpcSearch)(code, numbers); } catch { item = null; }
      const line = item ? lines.find(row => String(row.tcin) === item || String(row.item_number) === item) : null;
      if (line) {
        try { await attachManifestAlternate(sb, storeId, { scanned: code, itemNumber: item }); } catch { /* this scan still opens the line */ }
        const ctx = await loadContext(sb, storeId, line);
        const card = buildCostcoReceive({
          line,
          enrich: ctx.enrich,
          product: ctx.product,
          amazon: ctx.payload?.amazon || null,
          upcitemdb: ctx.payload?.upcitemdb || null,
          costco: ctx.payload?.costco || null,
          stripMoney,
        });
        card.receive.scanned_code = code;
        return withCatalogStock(sb, storeId, ctx, line, card);
      }
    }
  }
  if (!found.line) return null;
  const ctx = await loadContext(sb, storeId, found.line);
  const card = buildCostcoReceive({
    line: found.line,
    enrich: ctx.enrich,
    product: ctx.product,
    amazon: ctx.payload?.amazon || null,
    upcitemdb: ctx.payload?.upcitemdb || null,
    costco: ctx.payload?.costco || null,
    stripMoney,
  });
  return withCatalogStock(sb, storeId, ctx, found.line, card);
}

async function searchVariant(storeId, title, deps) {
  if (deps?.search) return deps.search(storeId, title);
  const { marketplaceId, parseCatalogItem, spapiFetch } = await import("./amazon.mjs");
  const path = `/catalog/2022-04-01/items?marketplaceIds=${marketplaceId()}&keywords=${encodeURIComponent(clean(title).slice(0, 80))}&includedData=summaries,attributes,images,dimensions,identifiers,productTypes&pageSize=5`;
  const json = await spapiFetch(storeId, "GET", path);
  return (json?.items || []).map(parseCatalogItem).filter(Boolean);
}

function sameTitle(a, b) {
  const left = clean(a).toLowerCase();
  const right = clean(b).toLowerCase();
  return left === right || (left && right && (left.startsWith(right.slice(0, 48)) || right.startsWith(left.slice(0, 48))));
}

async function remember(sb, storeId, key, book, item, patch) {
  const next = { ...book, [item]: { ...(book[item] || {}), ...patch, at: new Date().toISOString() } };
  await sb.from("store_settings").upsert({ store_id: storeId, key, value: next }, { onConflict: "store_id,key" });
}

export async function rejectManifestStockPhoto(sb, storeId, { itemNumber, url, replacement = "" }) {
  const found = await findManifestLine(sb, storeId, itemNumber);
  if (!found.line) throw Object.assign(new Error("That item is not on a manifest"), { status: 404 });
  const ctx = await loadContext(sb, storeId, found.line);
  const item = String(found.line.tcin || "");
  const entry = ctx.book?.[item] || ctx.enrich || {};
  const rejected = [...new Set([...(entry.rejected_images || []), url].filter((row) => typeof row === "string" && row !== replacement))].slice(0, 20);
  const images = [...new Set([replacement, ...(entry.images || [])].filter((row) => typeof row === "string" && row && row !== url && !rejected.includes(row)))].slice(0, 4);
  await remember(sb, storeId, ctx.key, ctx.book || {}, item, { images, rejected_images: rejected });
  return { ok: true, images };
}

export async function pinCostcoVariant(sb, storeId, { code, title, itemNumber }, deps = {}) {
  const found = await findManifestLine(sb, storeId, itemNumber || code);
  if (!found.line) throw Object.assign(new Error("That barcode is not on a manifest"), { status: 404 });
  const chosen = clean(title);
  if (chosen.length < 8) throw Object.assign(new Error("Pick one of the listed variants"), { status: 400 });
  const ctx = await loadContext(sb, storeId, found.line);
  const allowed = candidateTitles(ctx.enrich?.why);
  if (allowed.length && !allowed.some((row) => sameTitle(row, chosen))) {
    throw Object.assign(new Error("That variant is not one of the matches for this barcode"), { status: 400 });
  }
  let pulled = null;
  try {
    const items = await searchVariant(storeId, chosen, deps);
    pulled = items.find((item) => sameTitle(item.title, chosen)) || null;
  } catch {
    pulled = null;
  }
  const images = (pulled?.images || []).filter(allowedPhoto).slice(0, 6);
  const pinned = {
    title: pulled?.title || chosen,
    brand: pulled?.brand || found.line.brand || null,
    model: pulled?.model || null,
    description: pulled?.description || found.line.description,
    features: (pulled?.features || []).slice(0, 12),
    images,
    package: pulled?.package || {},
    item: pulled?.item || {},
    asin: pulled?.asin || null,
  };
  const item = String(found.line.tcin || "");
  if (ctx.gtin?.ok && !isCostcoInternalCode(ctx.gtin.gtin14)) {
    const aspects = {
      ...(ctx.product?.aspects || {}),
      costco_item_number: item,
      pinned_title: pinned.title,
      variant_pinned: true,
      item_dims: pinned.item?.length_in || pinned.item?.weight_lb ? pinned.item : (ctx.product?.aspects?.item_dims || null),
      manifest_description: found.line.description,
      manifest_retail_cents: found.line.unit_retail_cents,
    };
    const { saveFloorProduct } = await import("./floor-products.mjs");
    await saveFloorProduct(sb, ctx.gtin, {
      ...pinned,
      aspects,
      category: ctx.product?.category || null,
    }, {
      source: "amazon",
      dimSources: Object.fromEntries(["length_in", "width_in", "height_in", "weight_lb"]
        .filter((key) => numberOrNull(pinned.package?.[key]))
        .map((key) => [key, "published"])),
    });
  }
  await remember(sb, storeId, ctx.key, ctx.book, item, { pinned, pinned_title: pinned.title });
  const product = ctx.gtin?.ok ? (await sb.from("floor_products").select("*").eq("gtin14", ctx.gtin.gtin14).maybeSingle()).data : null;
  return buildCostcoReceive({
    line: found.line,
    enrich: { ...ctx.enrich, pinned, pinned_title: pinned.title },
    product,
    amazon: null,
    costco: ctx.payload?.costco || null,
    stripMoney: deps.stripMoney === true,
  });
}

export async function saveCostcoCorrection(sb, storeId, { code, itemNumber, field, value }) {
  const name = clean(field).toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 40);
  const entered = clean(value).slice(0, 80);
  if (!name || /cost|ask|price|fee/.test(name)) throw Object.assign(new Error("That field is not a box check"), { status: 400 });
  if (!entered) throw Object.assign(new Error("Enter what the box says"), { status: 400 });
  const found = await findManifestLine(sb, storeId, itemNumber || code);
  if (!found.line) throw Object.assign(new Error("That barcode is not on a manifest"), { status: 404 });
  const ctx = await loadContext(sb, storeId, found.line);
  const resolved = { ...(ctx.enrich?.resolved || {}), ...(ctx.product?.aspects?.resolved || {}), [name]: entered };
  if (ctx.gtin?.ok && ctx.product && !isCostcoInternalCode(ctx.gtin.gtin14)) {
    await sb.from("floor_products").update({
      aspects: { ...(ctx.product.aspects || {}), resolved },
      updated_at: new Date().toISOString(),
    }).eq("gtin14", ctx.gtin.gtin14);
  }
  await remember(sb, storeId, ctx.key, ctx.book, String(found.line.tcin || ""), { resolved });
  return { ok: true, field: name, value: entered };
}

/** Clerk keeps the manifest name and drops a fuzzy catalog guess from the review list. */
export async function acceptManifestIdentity(sb, storeId, raw) {
  const found = await findManifestLine(sb, storeId, raw);
  if (!found.line) throw Object.assign(new Error("That barcode is not on a manifest"), { status: 404 });
  const ctx = await loadContext(sb, storeId, found.line);
  const title = clean(found.line.description);
  await remember(sb, storeId, ctx.key, ctx.book, String(found.line.tcin || ""), {
    identity_accepted: true,
    pinned_title: title,
    status: "confirmed",
    via: "manifest",
  });
  return buildCostcoReceive({
    line: found.line,
    enrich: { ...ctx.enrich, identity_accepted: true, pinned_title: title, via: "manifest" },
    product: null,
    amazon: null,
    stripMoney: false,
  });
}

/** Save a box barcode on the manifest line the clerk confirmed. The next box with that code is an exact hit. */
export async function attachManifestAlternate(sb, storeId, { scanned, itemNumber }) {
  const code = digits(scanned);
  if (!/^\d{8,14}$/.test(code)) throw Object.assign(new Error("That is not a barcode"), { status: 400 });
  const found = await findManifestLine(sb, storeId, itemNumber);
  if (!found.line) throw Object.assign(new Error("That item is not on a manifest"), { status: 404 });
  const item = String(found.line.item_number || found.line.tcin || "");
  if (!/^\d{4,12}$/.test(item)) throw Object.assign(new Error("That item is not on a manifest"), { status: 404 });
  const located = await sb.from("manifest_lines").select("manifest_id,line_number,alternate_upcs,tcin,item_number")
    .in("manifest_id", found.ids)
    .or(`item_number.eq.${item},tcin.eq.${item}`);
  const rows = located.data || [];
  if (located.error || !rows.length) throw Object.assign(new Error(located.error?.message || "manifest_line_not_found"), { status: 404 });
  const next = [...new Set([...rows.flatMap(row => (row.alternate_upcs || []).map(value => digits(value))), code].filter(Boolean))];
  for (const row of rows) {
    const saved = await sb.from("manifest_lines").update({ alternate_upcs: next })
      .eq("manifest_id", row.manifest_id)
      .eq("line_number", row.line_number);
    if (saved.error) throw new Error(saved.error.message);
  }
  const ctx = await loadContext(sb, storeId, found.line);
  await remember(sb, storeId, ctx.key, ctx.book, String(found.line.tcin || rows[0].tcin || ""), { alternate_upcs: next });
  return { ok: true, item_number: item, alternate: code };
}
