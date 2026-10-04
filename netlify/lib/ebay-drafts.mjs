import { serviceClient } from "./server.mjs";
import { ebayFetch, listSku, userToken, withdrawSku } from "./ebay.mjs";
import { formatEbayError } from "./ebay-errors.mjs";
import { publicPhotoUrl } from "./ebay-photos.mjs";
import { composeChannelDescription, parseListingSpecs } from "./listing-copy.mjs";
import { fillAspects, pickCategorySuggestion } from "./ebay-aspects.mjs";
import {
  fetchLiveAspects,
  fetchLiveConditions,
  resolveFloorCategory,
  categoryName,
  suggestCategories,
} from "./ebay-catalog.mjs";
import { inventoryConditionEnum, mapFloorCondition } from "./ebay-conditions.mjs";
import { ebayDraftEligibility } from "./ebay-eligibility.mjs";
import { ensureMarket, summarizeMarket } from "./ebay-market.mjs";
import {
  addressTo,
  allowedCarriers,
  liveRates,
} from "./shippo.mjs";
import {
  draftReadiness,
  ebayPriceCents,
  fallbackLabelCents,
  farZoneAddress,
  priceQuotes,
  shippingModeForLabel,
} from "./ebay-price.mjs";
import { getShippingServiceDetails } from "./ebay-trading.mjs";

export const POLICY_SETUP = [
  "eBay business policies are not ready on this account.",
  "1. Sign in to Seller Hub → Account → Business policies, and opt in if eBay asks.",
  "2. Create a payment policy.",
  "3. Create a return policy (30 days is fine).",
  "4. Create a shipping policy with FREE shipping (buyer pays $0).",
  "5. Create a second shipping policy with CALCULATED shipping (buyer pays the carrier rate from the package weight and dimensions).",
  "Then come back to eBay drafts and push again.",
].join("\n");

const SETTING_KEYS = [
  "ebay_fee_pct", "ebay_per_order_cents", "ebay_free_ship_cutoff_cents", "ebay_shipping_buffer_cents", "ebay_price_ending", "ebay_far_zip",
  "ship_excluded_categories", "ship_excluded_keywords", "ship_max_weight_lb", "ship_max_length_in",
  "ship_max_length_girth_in", "ship_from", "ebay_policy_status",
];

function scalar(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === "number" || typeof value === "string") return value;
  return fallback;
}

export function readEbaySettings(rows) {
  const map = Object.fromEntries((rows || []).map((row) => [row.key, row.value]));
  const list = (key) => (Array.isArray(map[key]) ? map[key].map((x) => String(x)) : []);
  return {
    feePct: Number(scalar(map.ebay_fee_pct, 13.25)) || 13.25,
    perOrderCents: Math.round(Number(scalar(map.ebay_per_order_cents, 40)) || 0),
    cutoffCents: Math.round(Number(scalar(map.ebay_free_ship_cutoff_cents, 1500)) || 1500),
    bufferCents: Math.round(Number(scalar(map.ebay_shipping_buffer_cents, 200)) || 0),
    ending: Math.round(Number(scalar(map.ebay_price_ending, 99)) || 99),
    farZip: String(scalar(map.ebay_far_zip, "10001") || "10001"),
    excludedCategories: list("ship_excluded_categories"),
    excludedKeywords: list("ship_excluded_keywords"),
    maxWeightLb: Number(scalar(map.ship_max_weight_lb, 70)) || 70,
    maxLengthIn: Number(scalar(map.ship_max_length_in, 108)) || 108,
    maxGirthIn: Number(scalar(map.ship_max_length_girth_in, 165)) || 165,
    shipFrom: map.ship_from && typeof map.ship_from === "object" ? map.ship_from : null,
    policyStatus: map.ebay_policy_status && typeof map.ebay_policy_status === "object" ? map.ebay_policy_status : null,
  };
}

export async function loadEbaySettings(storeId) {
  const sb = serviceClient();
  const { data, error } = await sb.from("store_settings").select("key,value").eq("store_id", storeId).in("key", SETTING_KEYS);
  if (error) throw new Error(error.message);
  return readEbaySettings(data);
}

function boxOf(unit) {
  return {
    length_in: numOrNull(unit?.package_length_in),
    width_in: numOrNull(unit?.package_width_in),
    height_in: numOrNull(unit?.package_height_in),
    weight_lb: numOrNull(unit?.package_weight_lb),
  };
}

function numOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function boxKey(box) {
  if (!box?.length_in || !box.width_in || !box.height_in || !box.weight_lb) return "";
  return `${box.length_in}x${box.width_in}x${box.height_in}@${box.weight_lb}`;
}

function clipTitle(value) {
  const title = String(value || "").replace(/\s+/g, " ").trim();
  return title.length > 80 ? title.slice(0, 77).trimEnd() + "..." : title;
}

function aspectMap(unit) {
  const specs = parseListingSpecs(unit?.listing_specs) || {};
  const fromSpecs = specs.ebay_aspects && typeof specs.ebay_aspects === "object" ? specs.ebay_aspects : {};
  const fromColumn = unit?.ebay_item_specifics && typeof unit.ebay_item_specifics === "object" ? unit.ebay_item_specifics : {};
  const out = {};
  for (const [name, value] of Object.entries({ ...fromColumn, ...fromSpecs })) {
    const text = Array.isArray(value) ? value.filter(Boolean).join(", ") : value == null ? "" : String(value).trim();
    if (text) out[name] = text;
  }
  return out;
}

function locked(draft, field) {
  return Array.isArray(draft?.locks) && draft.locks.includes(field);
}

function autoTitle(unit) {
  if (unit.ebay_title) return clipTitle(unit.ebay_title);
  const name = [unit.brand, unit.model].filter((p) => String(p || "").trim()).join(" ").trim() || unit.title || `SKU ${unit.sku}`;
  return clipTitle([name, unit.condition].filter(Boolean).join(" — "));
}

function autoDescription(unit) {
  return composeChannelDescription({
    listingBody: unit.listing_body,
    brand: unit.brand,
    model: unit.model,
    title: unit.title,
    specs: parseListingSpecs(unit.listing_specs),
    condition: unit.condition,
    testStatus: unit.test_status,
    defectNotes: unit.defect_notes,
    sku: unit.sku,
  });
}

function localCategoryId(unit) {
  const raw = String(unit?.ebay_category || "").trim();
  if (/^\d+$/.test(raw)) return raw;
  return resolveFloorCategory(unit?.category || raw)?.ebayCategoryId || null;
}

function applyPrice(row, settings) {
  if (row.status === "live") return row;
  const box = row.box;
  const key = boxKey(box);
  if (!key) {
    row.label_cents = null;
    row.shipping_buffer_cents = 0;
    row.label_source = null;
    row.label_key = "";
    if (!locked(row, "shipping")) row.shipping_mode = null;
    if (!locked(row, "price")) row.price_cents = null;
    return row;
  }
  if (row.label_key !== key) {
    row.label_cents = null;
    row.label_source = null;
  }
  if (!locked(row, "shipping") && row.label_cents != null) {
    row.shipping_mode = shippingModeForLabel(row.label_cents, settings.cutoffCents);
  }
  row.shipping_buffer_cents = row.shipping_mode === "free" ? settings.bufferCents : 0;
  if (!locked(row, "price") && row.shipping_mode && row.label_cents != null) {
    row.price_cents = ebayPriceCents({
      floorCents: row.floor_cents,
      labelCents: row.label_cents,
      bufferCents: settings.bufferCents,
      mode: row.shipping_mode,
      feePct: settings.feePct,
      perOrderCents: settings.perOrderCents,
      ending: settings.ending,
    });
  }
  return row;
}

function withReadiness(row) {
  const check = draftReadiness(row);
  row.checklist = check.items;
  row.ready = check.ready;
  return row;
}

function draftFromUnit(unit, photos, listing, previous, settings) {
  const prev = previous || {};
  const box = boxOf(unit);
  const row = {
    store_id: unit.store_id,
    sku: unit.sku,
    status: listing?.status === "listed" ? "live" : "draft",
    title: locked(prev, "title") ? prev.title : autoTitle(unit),
    description: locked(prev, "description") ? prev.description : autoDescription(unit),
    category_id: locked(prev, "category") ? prev.category_id : (prev.category_id || localCategoryId(unit)),
    category_name: locked(prev, "category") ? prev.category_name : (prev.category_name || null),
    suggestions: prev.suggestions || [],
    condition_id: locked(prev, "condition") ? prev.condition_id : (prev.condition_id || null),
    condition_enum: locked(prev, "condition") ? prev.condition_enum : (prev.condition_enum || null),
    condition_notes: locked(prev, "condition_notes") ? prev.condition_notes : (unit.defect_notes || ""),
    aspects: locked(prev, "aspects") ? prev.aspects || {} : { ...aspectMap(unit), ...(prev.aspects || {}) },
    aspect_defs: prev.aspect_defs || [],
    conditions: prev.conditions || [],
    photo_paths: locked(prev, "photos") ? prev.photo_paths || [] : photos,
    shipping_mode: prev.shipping_mode || null,
    price_cents: prev.price_cents ?? null,
    shipping_buffer_cents: prev.shipping_buffer_cents ?? 0,
    label_cents: prev.label_cents ?? null,
    label_source: prev.label_source || null,
    label_key: prev.label_key || "",
    ebay_error: prev.ebay_error || null,
    listing_id: listing?.listing_id || prev.listing_id || null,
    offer_id: listing?.offer_id || prev.offer_id || null,
    view_url: prev.view_url || null,
    locks: prev.locks || [],
    floor_cents: unit.ask_cents,
    box,
    updated_at: new Date().toISOString(),
  };
  if (listing?.status === "listed" && listing.listing_id) {
    row.view_url = prev.view_url || null;
  }
  return withReadiness(applyPrice(row, settings));
}

async function unitsForDrafts(sb, storeId) {
  const units = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await sb
      .from("units")
      .select("store_id,sku,title,brand,model,category,condition,test_status,defect_notes,ask_cents,state,listing_body,listing_specs,ebay_title,ebay_category,ebay_item_specifics,package_length_in,package_width_in,package_height_in,package_weight_lb")
      .eq("store_id", storeId)
      .eq("state", "available")
      .gt("ask_cents", 0)
      .range(from, from + 499);
    if (error) throw new Error(error.message);
    units.push(...(data || []));
    if (!data || data.length < 500) break;
  }
  return units;
}

async function photosBySku(sb, storeId, skus) {
  const map = new Map();
  for (let i = 0; i < skus.length; i += 100) {
    const slice = skus.slice(i, i + 100);
    const { data, error } = await sb
      .from("photos")
      .select("sku,path,is_primary,created_at")
      .eq("store_id", storeId)
      .in("sku", slice);
    if (error) throw new Error(error.message);
    for (const row of data || []) {
      if (!row.path || String(row.path).includes("/official-")) continue;
      const list = map.get(row.sku) || [];
      list.push(row);
      map.set(row.sku, list);
    }
  }
  for (const [sku, list] of map) {
    list.sort((a, b) => Number(b.is_primary) - Number(a.is_primary) || String(a.created_at).localeCompare(String(b.created_at)));
    map.set(sku, list.map((row) => row.path));
  }
  return map;
}

export async function syncDrafts(storeId, { quoteLimit = 4 } = {}) {
  const sb = serviceClient();
  const settings = await loadEbaySettings(storeId);
  const [units, existingRes, listingRes] = await Promise.all([
    unitsForDrafts(sb, storeId),
    sb.from("ebay_drafts").select("*").eq("store_id", storeId),
    sb.from("listings").select("sku,status,listing_id,offer_id").eq("store_id", storeId).eq("channel", "ebay"),
  ]);
  if (existingRes.error) throw new Error(existingRes.error.message);
  if (listingRes.error) throw new Error(listingRes.error.message);
  const photos = await photosBySku(sb, storeId, units.map((unit) => unit.sku));
  const previous = new Map((existingRes.data || []).map((row) => [row.sku, row]));
  const listings = new Map((listingRes.data || []).map((row) => [row.sku, row]));
  const keep = [];
  for (const unit of units) {
    const paths = photos.get(unit.sku) || [];
    const gate = ebayDraftEligibility({ ...unit, photo_count: paths.length }, settings);
    const listing = listings.get(unit.sku);
    const live = listing?.status === "listed";
    if (!gate.ok && !live) continue;
    keep.push(draftFromUnit({ ...unit, store_id: storeId }, paths, listing, previous.get(unit.sku), settings));
  }
  const keepSkus = new Set(keep.map((row) => row.sku));
  const drop = (existingRes.data || []).filter((row) => !keepSkus.has(row.sku)).map((row) => row.sku);
  if (drop.length) {
    const { error } = await sb.from("ebay_drafts").delete().eq("store_id", storeId).in("sku", drop);
    if (error) throw new Error(error.message);
  }
  let quoted = 0;
  for (const row of keep) {
    if (quoted >= quoteLimit) break;
    if (row.status === "live") continue;
    if (row.label_cents != null && row.label_key === boxKey(row.box)) continue;
    if (!boxKey(row.box)) continue;
    const quote = await quoteLabel(sb, storeId, settings, row.box);
    row.label_cents = quote.cents;
    row.label_source = quote.source;
    row.label_key = boxKey(row.box);
    applyPrice(row, settings);
    withReadiness(row);
    quoted += 1;
  }
  for (let i = 0; i < keep.length; i += 50) {
    const slice = keep.slice(i, i + 50).map(persistShape);
    const { error } = await sb.from("ebay_drafts").upsert(slice, { onConflict: "store_id,sku" });
    if (error) throw new Error(error.message);
  }
  const ready = keep.filter((row) => row.ready).length;
  const needsBox = keep.filter((row) => row.checklist?.some((item) => item.label === "Needs box size" && !item.ok)).length;
  return { total: keep.length, ready, needsBox, live: keep.filter((row) => row.status === "live").length, quoted };
}

function persistShape(row) {
  const { floor_cents, box, quotes, dims_source, market, ...rest } = row;
  return rest;
}

export async function quoteLabel(sb, storeId, settings, box) {
  const pkg = { length_in: box.length_in, width_in: box.width_in, height_in: box.height_in, weight_lb: box.weight_lb };
  try {
    const from = settings.shipFrom || {
      name: "Open Box Industries", street1: "3121 Penryn Rd", city: "Penryn", state: "CA", zip: "95663", country: "US", phone: "2799770722",
    };
    const live = await liveRates({
      shipFrom: from,
      to: addressTo(farZoneAddress(settings.farZip)),
      pkg,
      carriers: await allowedCarriers(sb, storeId),
    });
    const cents = live.rates?.[0]?.amount_cents || live.all?.[0]?.amount_cents;
    if (cents > 0) return { cents, source: "shippo" };
  } catch {
    /* Shippo down or no rate: use the fallback estimate. */
  }
  return { cents: fallbackLabelCents(pkg), source: "fallback" };
}

function summary(row) {
  const fails = (row.checklist || []).filter((item) => !item.ok).map((item) => item.label);
  return {
    sku: row.sku,
    title: row.title,
    status: row.status,
    ready: row.ready,
    price_cents: row.price_cents,
    floor_cents: row.floor_cents,
    shipping_mode: row.shipping_mode,
    label_cents: row.label_cents,
    shipping_buffer_cents: row.shipping_buffer_cents,
    label_source: row.label_source,
    category_name: row.category_name,
    category_id: row.category_id,
    photo_url: row.photo_paths?.[0] ? publicPhotoUrl(row.photo_paths[0]) : null,
    fails,
    ebay_error: row.ebay_error,
    view_url: row.view_url,
    listing_id: row.listing_id,
  };
}

function detail(row, unit) {
  return {
    ...summary(row),
    description: row.description,
    condition_id: row.condition_id,
    condition_enum: row.condition_enum,
    condition_notes: row.condition_notes,
    suggestions: row.suggestions || [],
    conditions: row.conditions || [],
    aspect_defs: (row.aspect_defs || []).filter((def) => def.required || def.recommended),
    aspects: row.aspects || {},
    photos: (row.photo_paths || []).map((path) => ({ path, url: publicPhotoUrl(path) })),
    box: boxOf(unit),
    floor_condition: unit?.condition || "",
    floor_cents: row.floor_cents ?? unit?.ask_cents ?? null,
    dims_source: unit?.dims_source || null,
    quotes: row.quotes || null,
    market: row.market || null,
    market_needs_refresh: unit ? !(Date.now() - Date.parse(parseListingSpecs(unit.listing_specs)?.market?.checked_at || "") < 30 * 86400_000) : false,
    checklist: row.checklist || [],
    locks: row.locks || [],
  };
}

async function loadDraft(sb, storeId, sku) {
  const { data, error } = await sb.from("ebay_drafts").select("*").eq("store_id", storeId).eq("sku", sku).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`No eBay draft for SKU ${sku}`);
  return data;
}

async function loadUnit(sb, storeId, sku) {
  const { data, error } = await sb.from("units").select("*").eq("store_id", storeId).eq("sku", sku).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export async function listDraftPage(storeId, { refresh = false } = {}) {
  // The scheduled eBay sync runs every minute. A normal page read should not
  // requote labels and rewrite every draft before it can render.
  const sync = refresh ? await syncDrafts(storeId) : null;
  const sb = serviceClient();
  const [settings, { data: drafts, error }, connection] = await Promise.all([
    loadEbaySettings(storeId),
    sb.from("ebay_drafts").select("sku,title,status,ready,price_cents,shipping_mode,label_cents,shipping_buffer_cents,label_source,category_name,category_id,photo_paths,checklist,ebay_error,view_url,listing_id").eq("store_id", storeId).order("sku"),
    sb.from("connections").select("status,last_error").eq("store_id", storeId).eq("provider", "ebay").maybeSingle(),
  ]);
  if (error) throw new Error(error.message);
  const rows = (drafts || []).map(summary);
  return {
    sync,
    connected: connection.data?.status === "connected",
    connection_error: connection.data?.last_error || null,
    settings: {
      feePct: settings.feePct,
      perOrderCents: settings.perOrderCents,
      cutoffCents: settings.cutoffCents,
      bufferCents: settings.bufferCents,
      ending: settings.ending,
      farZip: settings.farZip,
    },
    policies: settings.policyStatus,
    drafts: rows,
    counts: {
      total: rows.length,
      ready: rows.filter((row) => row.ready && row.status !== "live").length,
      needsBox: rows.filter((row) => row.fails.includes("Needs box size")).length,
      live: rows.filter((row) => row.status === "live").length,
    },
  };
}

function stringsToAspects(aspects) {
  const out = {};
  for (const [name, value] of Object.entries(aspects || {})) {
    const text = String(value || "").trim();
    if (text) out[name] = [text];
  }
  return out;
}

async function refreshCategoryRules(row, unit) {
  if (!row.category_id) return row;
  const [defs, conditions] = await Promise.all([
    fetchLiveAspects(row.category_id),
    fetchLiveConditions(row.category_id),
  ]);
  row.aspect_defs = defs;
  row.conditions = conditions;
  if (!locked(row, "condition")) {
    const mapped = mapFloorCondition(unit?.condition, conditions);
    row.condition_id = mapped?.conditionId || null;
    row.condition_enum = mapped ? inventoryConditionEnum(mapped) : null;
  } else if (row.condition_id) {
    const mapped = conditions.find((c) => String(c.conditionId) === String(row.condition_id));
    row.condition_enum = mapped ? inventoryConditionEnum(mapped) : row.condition_enum;
  }
  if (!locked(row, "aspects")) {
    const specs = parseListingSpecs(unit?.listing_specs) || {};
    specs.ebay_aspects = { ...aspectMap(unit), ...(row.aspects || {}) };
    const filled = fillAspects(defs, unit || {}, specs, {
      categoryName: row.category_name,
      title: row.title,
      description: row.description,
    });
    const next = {};
    for (const [name, value] of Object.entries(filled.aspects || {})) {
      next[name] = Array.isArray(value) ? value[0] : String(value);
    }
    row.aspects = next;
  }
  return row;
}

function mergeBlankAspects(row, unit) {
  if (!row.aspect_defs?.length) return;
  const specs = parseListingSpecs(unit?.listing_specs) || {};
  if (specs.height_in == null && unit?.product_height_in) specs.height_in = unit.product_height_in;
  if (specs.width_in == null && unit?.product_width_in) specs.width_in = unit.product_width_in;
  if (specs.depth_in == null && unit?.product_depth_in) specs.depth_in = unit.product_depth_in;
  if (specs.weight_lb == null && unit?.product_weight_lb) specs.weight_lb = unit.product_weight_lb;
  specs.ebay_aspects = { ...aspectMap(unit), ...(row.aspects || {}) };
  const filled = fillAspects(row.aspect_defs, unit || {}, specs, {
    categoryName: row.category_name,
    title: row.title,
    description: row.description,
  });
  const next = { ...(row.aspects || {}) };
  for (const [name, value] of Object.entries(filled.aspects || {})) {
    const text = Array.isArray(value) ? value[0] : String(value || "");
    if (!String(next[name] || "").trim() && text) next[name] = text;
  }
  row.aspects = next;
}

export async function prepareDraft(storeId, sku) {
  const sb = serviceClient();
  const [settings, row, unit] = await Promise.all([
    loadEbaySettings(storeId), loadDraft(sb, storeId, sku), loadUnit(sb, storeId, sku),
  ]);
  row.floor_cents = unit?.ask_cents || null;
  row.box = boxOf(unit);
  if (!locked(row, "category") && !row.suggestions?.length && !row.category_id) {
    try {
      const query = [row.title, unit?.brand, unit?.title, unit?.ebay_category].filter(Boolean).join(" ");
      const suggestions = await suggestCategories(query);
      if (suggestions.length) row.suggestions = suggestions;
      const picked = pickCategorySuggestion(row.suggestions, [row.title, unit?.title, unit?.category, unit?.ebay_category]);
      if (picked && String(picked.categoryId) !== String(row.category_id || "")) {
        row.category_id = String(picked.categoryId);
        row.category_name = picked.categoryName;
        row.aspect_defs = [];
        row.conditions = [];
        if (!locked(row, "condition")) row.condition_id = null;
        if (!locked(row, "aspects")) row.aspects = { ...aspectMap(unit) };
      } else if (picked) row.category_name = picked.categoryName;
    } catch (err) {
      row.ebay_error = err instanceof Error ? err.message : String(err);
    }
  } else if (!row.suggestions?.length) {
    try { row.suggestions = await suggestCategories([row.title, unit?.brand, unit?.title].filter(Boolean).join(" ")); }
    catch (err) { row.ebay_error = err instanceof Error ? err.message : String(err); }
  }
  const needsRules = row.category_id && (
    !row.aspect_defs?.length
    || !row.conditions?.length
    || (!locked(row, "condition") && !row.condition_id)
  );
  if (needsRules) {
    try {
      await refreshCategoryRules(row, unit);
    } catch (err) {
      row.ebay_error = err instanceof Error ? err.message : String(err);
    }
  }
  if (boxKey(row.box) && (row.label_key !== boxKey(row.box) || row.label_cents == null)) {
    const quote = await quoteLabel(sb, storeId, settings, row.box);
    row.label_cents = quote.cents;
    row.label_source = quote.source;
    row.label_key = boxKey(row.box);
  }
  if (row.category_id) {
    const known = (row.suggestions || []).find((s) => String(s.categoryId) === String(row.category_id))?.categoryName;
    if (known) row.category_name = known;
    else if (!row.category_name) {
      try {
        const official = await categoryName(row.category_id);
        if (official) row.category_name = official;
      } catch {
        /* Keep the stored name when taxonomy is unavailable. */
      }
    }
  }
  if (!locked(row, "aspects") && row.aspects) {
    for (const key of Object.keys(row.aspects)) {
      const lower = key.toLowerCase();
      const value = String(row.aspects[key] || "");
      if ((lower === "mpn" || lower === "model" || lower.includes("manufacturer part")) && !(/\d/.test(value) && !/^\d{5,}$/.test(value))) {
        delete row.aspects[key];
      }
    }
  }
  if (row.aspect_defs?.length) mergeBlankAspects(row, unit);
  applyPrice(row, settings);
  withReadiness(row);
  const saved = persistShape(row);
  const { error } = await sb.from("ebay_drafts").upsert(saved, { onConflict: "store_id,sku" });
  if (error) throw new Error(error.message);
  row.quotes = priceQuotes(row.floor_cents, row.label_cents, settings);
  row.market = storedMarket(unit);
  return detail(row, unit);
}

function storedMarket(unit) {
  if (!unit) return null;
  const saved = parseListingSpecs(unit.listing_specs)?.market;
  return saved || summarizeMarket("retail", unit.retail_price_sources);
}

export async function lookupDraftMarket(storeId, sku) {
  const sb = serviceClient();
  const unit = await loadUnit(sb, storeId, sku);
  if (!unit) throw new Error(`No unit for SKU ${sku}`);
  return ensureMarket(sb, storeId, unit);
}

function lock(row, field) {
  const locks = new Set(row.locks || []);
  locks.add(field);
  row.locks = [...locks];
}

export async function saveDraft(storeId, sku, fields) {
  const sb = serviceClient();
  const settings = await loadEbaySettings(storeId);
  const row = await loadDraft(sb, storeId, sku);
  const unit = await loadUnit(sb, storeId, sku);
  row.floor_cents = unit?.ask_cents || null;
  row.box = boxOf(unit);
  if (fields.title != null) { row.title = clipTitle(fields.title); lock(row, "title"); }
  if (fields.description != null) { row.description = String(fields.description); lock(row, "description"); }
  if (fields.condition_notes != null) { row.condition_notes = String(fields.condition_notes); lock(row, "condition_notes"); }
  if (fields.condition_id != null) {
    const allowed = (row.conditions || []).find((c) => String(c.conditionId) === String(fields.condition_id));
    if (!allowed) throw new Error("That condition is not allowed for this category.");
    row.condition_id = String(allowed.conditionId);
    row.condition_enum = inventoryConditionEnum(allowed);
    lock(row, "condition");
  }
  if (fields.aspects && typeof fields.aspects === "object") {
    row.aspects = { ...row.aspects, ...fields.aspects };
    lock(row, "aspects");
  }
  if (Array.isArray(fields.photo_paths)) {
    const allowed = new Set(row.photo_paths || []);
    const next = fields.photo_paths.map(String).filter((path) => allowed.has(path));
    if (next.length) { row.photo_paths = next; lock(row, "photos"); }
  }
  if (fields.category_id != null && String(fields.category_id) !== String(row.category_id)) {
    const suggestion = (row.suggestions || []).find((s) => String(s.categoryId) === String(fields.category_id));
    row.category_id = String(fields.category_id);
    row.category_name = suggestion?.categoryName || fields.category_name || row.category_name;
    row.aspect_defs = [];
    row.conditions = [];
    lock(row, "category");
    await refreshCategoryRules(row, unit);
  }
  if (fields.shipping_mode === "free" || fields.shipping_mode === "calculated") {
    row.shipping_mode = fields.shipping_mode;
    lock(row, "shipping");
  }
  if (fields.price_cents != null) {
    const cents = Math.round(Number(fields.price_cents));
    if (!(cents > 0)) throw new Error("Enter an eBay price.");
    row.price_cents = cents;
    lock(row, "price");
  }
  applyPrice(row, settings);
  withReadiness(row);
  const { error } = await sb.from("ebay_drafts").upsert(persistShape(row), { onConflict: "store_id,sku" });
  if (error) throw new Error(error.message);
  if (row.status === "live") {
    const pushed = await pushOne(storeId, sku, { revise: true });
    row.ebay_error = pushed.ok ? null : pushed.error;
    if (pushed.ok) {
      row.listing_id = pushed.listingId;
      row.view_url = pushed.viewUrl;
    }
  }
  row.quotes = priceQuotes(row.floor_cents, row.label_cents, settings);
  row.market = storedMarket(unit);
  return detail(row, unit);
}

export async function saveBox(storeId, sku, box) {
  const length = Number(box.length_in);
  const width = Number(box.width_in);
  const height = Number(box.height_in);
  const weight = Number(box.weight_lb);
  if (![length, width, height, weight].every((n) => n > 0)) throw new Error("Enter length, width, height, and weight.");
  const sb = serviceClient();
  const { error } = await sb.from("units").update({
    package_length_in: length,
    package_width_in: width,
    package_height_in: height,
    package_weight_lb: weight,
    dims_source: "measured",
    updated_at: new Date().toISOString(),
  }).eq("store_id", storeId).eq("sku", sku);
  if (error) throw new Error(error.message);
  const settings = await loadEbaySettings(storeId);
  const row = await loadDraft(sb, storeId, sku);
  const unit = await loadUnit(sb, storeId, sku);
  row.box = { length_in: length, width_in: width, height_in: height, weight_lb: weight };
  row.floor_cents = unit?.ask_cents || null;
  const quote = await quoteLabel(sb, storeId, settings, row.box);
  row.label_cents = quote.cents;
  row.label_source = quote.source;
  row.label_key = boxKey(row.box);
  applyPrice(row, settings);
  withReadiness(row);
  const saved = await sb.from("ebay_drafts").upsert(persistShape(row), { onConflict: "store_id,sku" });
  if (saved.error) throw new Error(saved.error.message);
  row.quotes = priceQuotes(row.floor_cents, row.label_cents, settings);
  row.market = storedMarket(unit);
  return detail(row, unit);
}

export async function repriceDraft(storeId, sku) {
  const sb = serviceClient();
  const settings = await loadEbaySettings(storeId);
  const row = await loadDraft(sb, storeId, sku).catch(() => null);
  if (!row) return null;
  const unit = await loadUnit(sb, storeId, sku);
  row.floor_cents = unit?.ask_cents || null;
  row.box = boxOf(unit);
  if (!locked(row, "description") && unit) row.description = autoDescription(unit);
  if (boxKey(row.box) && (row.label_key !== boxKey(row.box) || row.label_cents == null)) {
    const quote = await quoteLabel(sb, storeId, settings, row.box);
    row.label_cents = quote.cents;
    row.label_source = quote.source;
    row.label_key = boxKey(row.box);
  }
  applyPrice(row, settings);
  withReadiness(row);
  const { error } = await sb.from("ebay_drafts").upsert(persistShape(row), { onConflict: "store_id,sku" });
  if (error) throw new Error(error.message);
  return row.sku;
}

function policyMode(policy) {
  const options = policy?.shippingOptions || [];
  const services = options.flatMap((opt) => opt?.shippingServices || []);
  const calculated = options.some((opt) => String(opt.costType || "").toUpperCase() === "CALCULATED");
  const free = services.some((svc) => svc.freeShipping) || (services.length > 0 && services.every((svc) => Number(svc.shippingCost?.value || 0) === 0) && !calculated);
  if (calculated) return "calculated";
  if (free) return "free";
  return null;
}

async function listPolicy(storeId, kind) {
  const market = process.env.EBAY_MARKETPLACE_ID || "EBAY_US";
  const json = await ebayFetch(storeId, "GET", `/sell/account/v1/${kind}_policy?marketplace_id=${market}`);
  return json?.[`${kind}Policies`] || [];
}

function policyId(row, kind) {
  return row?.[`${kind}PolicyId`] || null;
}

async function createSandboxPolicies(storeId) {
  const market = process.env.EBAY_MARKETPLACE_ID || "EBAY_US";
  try {
    await ebayFetch(storeId, "POST", "/sell/account/v1/program/opt_in", { programType: "SELLING_POLICY_MANAGEMENT" });
  } catch (err) {
    if (!/already/i.test(err.message || "")) console.log("ebay_opt_in", err.message);
  }
  let service = { shippingService: "USPSPriority", shippingCarrier: "USPS" };
  let calculated = { shippingService: "USPSParcel", shippingCarrier: "USPS" };
  try {
    const catalog = await getShippingServiceDetails(await userToken(storeId));
    const usable = catalog.filter((row) => row.validForSellingFlow && !row.international && /usps/i.test(row.shippingService));
    const flat = usable.find((row) => (row.serviceTypes || []).some((t) => /flat/i.test(t)));
    const calc = usable.find((row) => (row.serviceTypes || []).some((t) => /calc/i.test(t)));
    if (flat) service = flat;
    if (calc) calculated = calc;
  } catch {
    /* hardcoded USPS codes are the fallback */
  }
  const base = { marketplaceId: market, categoryTypes: [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES", default: true }], handlingTime: { value: 1, unit: "DAY" } };
  await ebayFetch(storeId, "POST", "/sell/account/v1/fulfillment_policy", {
    ...base,
    name: "Floor free shipping",
    shippingOptions: [{
      optionType: "DOMESTIC",
      costType: "FLAT_RATE",
      shippingServices: [{
        sortOrder: 1,
        shippingCarrierCode: service.shippingCarrier || "USPS",
        shippingServiceCode: service.shippingService,
        freeShipping: true,
        shippingCost: { value: "0.0", currency: "USD" },
        buyerResponsibleForShipping: false,
      }],
    }],
  });
  await ebayFetch(storeId, "POST", "/sell/account/v1/fulfillment_policy", {
    ...base,
    name: "Floor calculated shipping",
    shippingOptions: [{
      optionType: "DOMESTIC",
      costType: "CALCULATED",
      shippingServices: [{
        sortOrder: 1,
        shippingCarrierCode: calculated.shippingCarrier || "USPS",
        shippingServiceCode: calculated.shippingService,
        freeShipping: false,
        buyerResponsibleForShipping: true,
      }],
    }],
  });
}

export async function resolveBusinessPolicies(storeId, { force = false } = {}) {
  const cached = (await loadEbaySettings(storeId)).policyStatus;
  if (!force && cached?.ok && Date.now() - Date.parse(cached.checked_at || 0) < 10 * 60_000
    && cached.payment && cached.return && cached.free && cached.calculated) {
    return { payment: cached.payment, returnP: cached.return, fulfillmentFree: cached.free, fulfillmentCalculated: cached.calculated };
  }
  let payments = [];
  let returns = [];
  let fulfillments = [];
  try {
    [payments, returns, fulfillments] = await Promise.all([
      listPolicy(storeId, "payment"),
      listPolicy(storeId, "return"),
      listPolicy(storeId, "fulfillment"),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${POLICY_SETUP}\n\neBay said: ${message}`);
  }
  let free = fulfillments.find((row) => policyMode(row) === "free");
  let calculated = fulfillments.find((row) => policyMode(row) === "calculated");
  if (process.env.EBAY_ENV !== "production" && (!free || !calculated || !payments[0] || !returns[0])) {
    try {
      if (!payments[0]) {
        await ebayFetch(storeId, "POST", "/sell/account/v1/payment_policy", {
          name: "Floor payments",
          marketplaceId: process.env.EBAY_MARKETPLACE_ID || "EBAY_US",
          categoryTypes: [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES", default: true }],
          immediatePay: false,
        });
      }
      if (!returns[0]) {
        await ebayFetch(storeId, "POST", "/sell/account/v1/return_policy", {
          name: "Floor returns",
          marketplaceId: process.env.EBAY_MARKETPLACE_ID || "EBAY_US",
          categoryTypes: [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES", default: true }],
          returnsAccepted: true,
          returnPeriod: { value: 30, unit: "DAY" },
          refundMethod: "MONEY_BACK",
          returnShippingCostPayer: "BUYER",
        });
      }
      if (!free || !calculated) await createSandboxPolicies(storeId);
      [payments, returns, fulfillments] = await Promise.all([
        listPolicy(storeId, "payment"),
        listPolicy(storeId, "return"),
        listPolicy(storeId, "fulfillment"),
      ]);
      free = fulfillments.find((row) => policyMode(row) === "free");
      calculated = fulfillments.find((row) => policyMode(row) === "calculated");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`${POLICY_SETUP}\n\nSandbox setup failed: ${message}`);
    }
  }
  const missing = [];
  if (!payments[0]) missing.push("payment policy");
  if (!returns[0]) missing.push("return policy");
  if (!free) missing.push("free-shipping policy");
  if (!calculated) missing.push("calculated-shipping policy");
  const status = {
    ok: missing.length === 0,
    missing,
    payment: policyId(payments[0], "payment"),
    return: policyId(returns[0], "return"),
    free: policyId(free, "fulfillment"),
    calculated: policyId(calculated, "fulfillment"),
    checked_at: new Date().toISOString(),
  };
  const sb = serviceClient();
  await sb.from("store_settings").upsert({ store_id: storeId, key: "ebay_policy_status", value: status }, { onConflict: "store_id,key" });
  if (missing.length) throw new Error(`${POLICY_SETUP}\n\nMissing: ${missing.join(", ")}.`);
  return {
    payment: status.payment,
    returnP: status.return,
    fulfillmentFree: status.free,
    fulfillmentCalculated: status.calculated,
  };
}

function packagePayload(box) {
  return {
    dimensions: { length: String(box.length_in), width: String(box.width_in), height: String(box.height_in), unit: "INCH" },
    weight: { value: String(box.weight_lb), unit: "POUND" },
  };
}

async function pushOne(storeId, sku, { revise = false, getPolicies = () => resolveBusinessPolicies(storeId) } = {}) {
  const sb = serviceClient();
  const row = await loadDraft(sb, storeId, sku);
  const unit = await loadUnit(sb, storeId, sku);
  row.box = boxOf(unit);
  row.floor_cents = unit?.ask_cents || null;
  const wasLive = row.status === "live" || revise;
  withReadiness(row);
  if (!row.ready) {
    return { sku, ok: false, error: `Not ready: ${(row.checklist || []).filter((item) => !item.ok).map((item) => item.label).join("; ")}` };
  }
  try {
    const policies = await getPolicies();
    const fulfillment = row.shipping_mode === "free" ? policies.fulfillmentFree : policies.fulfillmentCalculated;
    const published = await listSku(storeId, sku, {
      title: row.title,
      description: row.description,
      imageUrls: (row.photo_paths || []).slice(0, 12).map((path) => publicPhotoUrl(path)),
      aspects: stringsToAspects(row.aspects),
      categoryId: row.category_id,
      conditionPayload: { condition: row.condition_enum, conditionId: String(row.condition_id) },
      conditionNotes: row.condition_notes || undefined,
      package: packagePayload(row.box),
      priceCents: row.price_cents,
      policies: { payment: policies.payment, returnP: policies.returnP, fulfillment },
    });
    await sb.from("ebay_drafts").update({
      status: "live",
      listing_id: published.listingId,
      offer_id: published.offerId,
      view_url: published.viewUrl,
      ebay_error: null,
      updated_at: new Date().toISOString(),
    }).eq("store_id", storeId).eq("sku", sku);
    return { sku, ok: true, listingId: published.listingId, viewUrl: published.viewUrl };
  } catch (err) {
    const message = formatEbayError(err.body, err instanceof Error ? err.message : String(err));
    await sb.from("ebay_drafts").update({
      status: wasLive ? "live" : "draft",
      ebay_error: message,
      updated_at: new Date().toISOString(),
    }).eq("store_id", storeId).eq("sku", sku);
    return { sku, ok: false, error: message };
  }
}

export async function pushDrafts(storeId, skus) {
  const results = new Array(skus.length);
  let policyPromise;
  const getPolicies = () => (policyPromise ??= resolveBusinessPolicies(storeId));
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(2, skus.length) }, async () => {
    while (cursor < skus.length) {
      const index = cursor++;
      results[index] = await pushOne(storeId, String(skus[index]), { getPolicies });
    }
  }));
  return results;
}

export async function endDraft(storeId, sku) {
  await withdrawSku(storeId, sku);
  const sb = serviceClient();
  await sb.from("ebay_drafts").delete().eq("store_id", storeId).eq("sku", sku);
  return { sku, ended: true };
}

export async function saveEbaySettings(storeId, input) {
  const feePct = Number(input.feePct);
  const perOrderCents = Math.round(Number(input.perOrderCents));
  const cutoffCents = Math.round(Number(input.cutoffCents));
  const bufferCents = Math.round(Number(input.bufferCents));
  const ending = Math.round(Number(input.ending));
  const farZip = String(input.farZip || "").replace(/\D/g, "").slice(0, 5);
  if (!(feePct >= 0 && feePct < 100)) throw new Error("eBay fee percent must be between 0 and 100.");
  if (!(perOrderCents >= 0)) throw new Error("Per-order fee must be zero or more.");
  if (!(cutoffCents >= 0)) throw new Error("Free-shipping cutoff must be zero or more.");
  if (!(bufferCents >= 0)) throw new Error("Shipping buffer must be zero or more.");
  if (!(ending >= 0 && ending <= 99)) throw new Error("Price ending must be 0 to 99.");
  if (!/^\d{5}$/.test(farZip)) throw new Error("Far-zone ZIP must be 5 digits.");
  const sb = serviceClient();
  const rows = [
    ["ebay_fee_pct", feePct],
    ["ebay_per_order_cents", perOrderCents],
    ["ebay_free_ship_cutoff_cents", cutoffCents],
    ["ebay_shipping_buffer_cents", bufferCents],
    ["ebay_price_ending", ending],
    ["ebay_far_zip", farZip],
  ].map(([key, value]) => ({ store_id: storeId, key, value }));
  const { error } = await sb.from("store_settings").upsert(rows, { onConflict: "store_id,key" });
  if (error) throw new Error(error.message);
  await syncDrafts(storeId, { quoteLimit: 0 });
  return loadEbaySettings(storeId);
}
