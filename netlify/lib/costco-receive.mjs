/**
 * Receive prefill for a pre-warmed manifest line.
 * Reads floor_products, the lookup cache, and the manifest. No catalog calls.
 */
import { isCostcoInternalCode } from "./gtin.mjs";
import { barcodeLookupKeys, normalizeGtin } from "./gtin-normalize.mjs";

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

function packageFrom(product, amazon, pinned) {
  const box = pinned?.package || {};
  return {
    length_in: numberOrNull(product?.package_length_in) || numberOrNull(amazon?.package?.length_in) || numberOrNull(box.length_in),
    width_in: numberOrNull(product?.package_width_in) || numberOrNull(amazon?.package?.width_in) || numberOrNull(box.width_in),
    height_in: numberOrNull(product?.package_height_in) || numberOrNull(amazon?.package?.height_in) || numberOrNull(box.height_in),
    weight_lb: numberOrNull(product?.package_weight_lb) || numberOrNull(amazon?.package?.weight_lb) || numberOrNull(box.weight_lb) || numberOrNull(product?.aspects?.published_weight?.weight_lb || product?.aspects?.published_weight),
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

export function buildCostcoReceive({ line, enrich = {}, product = null, amazon = null, costco = null, stripMoney = false }) {
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
  const pkg = useCatalog ? packageFrom(product, amazon, pinned) : {
    length_in: numberOrNull(expandedPkg.length_in),
    width_in: numberOrNull(expandedPkg.width_in),
    height_in: numberOrNull(expandedPkg.height_in),
    weight_lb: numberOrNull(expandedPkg.weight_lb),
  };
  const aspects = useCatalog ? itemAspects(product, amazon, pinned) : specificsFrom(enrich?.specifics);
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

export async function costcoReceiveLookup(sb, storeId, raw, { stripMoney = false } = {}) {
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
    const { data, error } = await sb.from("manifest_lines").select(LINE_COLS).in("manifest_id", found.ids).limit(500);
    if (error) throw new Error(error.message);
    const near = nearestManifestLine(code, data || []);
    if (near) {
      const ctx = await loadContext(sb, storeId, near.line);
      const card = buildCostcoReceive({
        line: near.line,
        enrich: ctx.enrich,
        product: ctx.product,
        amazon: ctx.payload?.amazon || null,
        costco: ctx.payload?.costco || null,
        stripMoney,
      });
      card.receive.suggested = true;
      card.receive.scanned_code = code;
      return card;
    }
  }
  if (!found.line) return null;
  const ctx = await loadContext(sb, storeId, found.line);
  return buildCostcoReceive({
    line: found.line,
    enrich: ctx.enrich,
    product: ctx.product,
    amazon: ctx.payload?.amazon || null,
    costco: ctx.payload?.costco || null,
    stripMoney,
  });
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
  const located = await sb.from("manifest_lines").select("id, alternate_upcs, tcin")
    .in("manifest_id", found.ids)
    .eq("item_number", String(found.line.item_number || ""))
    .limit(1);
  const row = located.data?.[0];
  if (located.error || !row?.id) throw Object.assign(new Error(located.error?.message || "manifest_line_not_found"), { status: 404 });
  const next = [...new Set([...(row.alternate_upcs || []).map((item) => digits(item)).filter(Boolean), code])];
  const saved = await sb.from("manifest_lines").update({ alternate_upcs: next }).eq("id", row.id);
  if (saved.error) throw new Error(saved.error.message);
  const ctx = await loadContext(sb, storeId, found.line);
  await remember(sb, storeId, ctx.key, ctx.book, String(found.line.tcin || row.tcin || ""), { alternate_upcs: next });
  return { ok: true, item_number: found.line.item_number, alternate: code };
}
