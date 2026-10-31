/**
 * Read-only listing feed for marketplace agents (Codex).
 * Selects and signed photo URLs only. No inserts, updates, deletes, or RPCs.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { isMattressAccessory } from "../../shared/receive-category.mjs";

export const PHOTO_TTL_SECONDS = 3600;
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 50;
export const MAX_SKUS = 100;
export const RATE_LIMIT = 60;
export const AUTH_FAIL_LIMIT = 10;
export const RATE_WINDOW_MS = 60_000;
export const SCOOTER_SKUS = new Set(["11284"]);
export const SITE_ITEM_URL = "https://openboxindustries.com/item";

const UNIT_LIST = [
  "store_id", "sku", "title", "brand", "model", "state", "ask_cents", "qty_on_hand", "is_test",
  "category", "updated_at",
].join(",");

const UNIT_FULL = [
  "store_id", "sku", "title", "brand", "model", "upc", "category", "condition", "test_status",
  "defect_notes", "ask_cents", "floor_cents", "acquisition_cost_cents", "msrp_cents",
  "retail_source_name", "retail_source_url", "product_height_in", "product_width_in",
  "product_depth_in", "product_weight_lb", "package_length_in", "package_width_in",
  "package_height_in", "package_weight_lb", "dims_source", "qty_on_hand", "state",
  "received_at", "updated_at", "listed_on", "is_test", "show_on_website",
].join(",");

const buckets = new Map();

export function resetRateLimits() {
  buckets.clear();
}

export function consumeRate(id, limit, now = Date.now(), windowMs = RATE_WINDOW_MS) {
  const bucket = buckets.get(id) || { start: now, count: 0 };
  if (now - bucket.start >= windowMs) {
    bucket.start = now;
    bucket.count = 0;
  }
  bucket.count += 1;
  buckets.set(id, bucket);
  const reset = Math.max(1, Math.ceil((bucket.start + windowMs - now) / 1000));
  return {
    ok: bucket.count <= limit,
    limit,
    remaining: Math.max(0, limit - bucket.count),
    reset,
  };
}

export function keysMatch(provided, expected) {
  if (!provided || !expected) return false;
  const a = createHash("sha256").update(String(provided)).digest();
  const b = createHash("sha256").update(String(expected)).digest();
  return timingSafeEqual(a, b);
}

export function headerValue(headers, name) {
  const want = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === want && value) return String(value).trim();
  }
  return "";
}

function bad(status, error) {
  const err = new Error(error);
  err.status = status;
  return err;
}

function skuOk(value) {
  return /^[0-9]{1,12}$/.test(value);
}

export function parseListingFeedQuery(params = {}) {
  const viewRaw = String(params.view || "available").trim().toLowerCase().replace(/_/g, "-");
  if (!["available", "all", "photo-ready"].includes(viewRaw)) throw bad(400, "invalid_view");

  const check = String(params.check || "").trim();
  if (check && !skuOk(check)) throw bad(400, "invalid_sku");

  const skuRaw = String(params.sku || "").trim();
  const skus = skuRaw
    ? skuRaw.split(/[\s,]+/).map((sku) => sku.trim()).filter(Boolean)
    : [];
  if (skus.length > MAX_SKUS) throw bad(400, "too_many_skus");
  if (skus.some((sku) => !skuOk(sku))) throw bad(400, "invalid_sku");
  if (check && skus.length && (skus.length !== 1 || skus[0] !== check)) throw bad(400, "invalid_sku");

  let limit = DEFAULT_LIMIT;
  if (params.limit != null && params.limit !== "") {
    limit = Number(params.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw bad(400, "invalid_limit");
  }

  const cursor = String(params.cursor || "").trim();
  if (cursor && !skuOk(cursor)) throw bad(400, "invalid_cursor");

  const category = String(params.category || "").trim();
  if (category.length > 80 || /[\u0000-\u001f]/.test(category)) throw bad(400, "invalid_category");

  let since = null;
  if (params.since != null && String(params.since).trim() !== "") {
    const ms = Date.parse(String(params.since).trim());
    if (!Number.isFinite(ms)) throw bad(400, "invalid_since");
    if (ms > Date.now() + 5 * 60_000) throw bad(400, "invalid_since");
    since = new Date(ms).toISOString();
  }

  const eligibleOnly = ["1", "true", "only", "yes"].includes(String(params.eligible || "").trim().toLowerCase());

  return {
    view: viewRaw,
    check: check || null,
    skus: check ? [check] : skus,
    limit,
    cursor: cursor || null,
    category: category || null,
    since,
    eligibleOnly,
  };
}

export function marketplaceBlocks(unit = {}) {
  const reasons = [];
  const sku = String(unit.sku || "").trim();
  const blob = [unit.title, unit.brand, unit.model, unit.category].filter(Boolean).join(" ");
  if (SCOOTER_SKUS.has(sku) || /\b(scooters?|hoverboards?|m365|segway)\b/i.test(blob)) reasons.push("scooter");
  if (/\b(fridges?|refrigerators?)\b/i.test(blob)) reasons.push("fridge");
  if (/\bdishwashers?\b/i.test(blob)) reasons.push("dishwasher");
  const mattressBlob = isMattressAccessory(blob) ? blob.replace(/\bmattress\s+(?:pads?|toppers?|protectors?)\b/gi, " ") : blob;
  if (/\bmattress(?:es)?\b|\bbox\s*springs?\b/i.test(mattressBlob)) reasons.push("mattress");
  return reasons;
}

export function decideUnit(unit, flags) {
  const reasons = [];
  const state = unit.state || "";
  const qty = Number(unit.qty_on_hand ?? 0);
  const priced = Number(unit.ask_cents) > 0;
  const photos = Number(flags.photoCount) > 0;
  if (unit.is_test) reasons.push("test");
  if (state === "sold" || flags.sale) reasons.push("sold");
  if (flags.sale && state === "available") reasons.push("open_sale");
  if (state === "reserved" || flags.reservation || flags.hold) reasons.push("reserved");
  if ((flags.reservation || flags.hold) && state === "available") reasons.push("open_hold");
  if (!["available", "sold", "reserved"].includes(state) || (state === "available" && qty <= 0)) {
    reasons.push("unavailable");
  }
  reasons.push(...marketplaceBlocks(unit));
  if (!photos) reasons.push("missing_photo");
  if (!priced) reasons.push("missing_price");
  const available = state === "available"
    && qty > 0
    && !unit.is_test
    && !flags.sale
    && !flags.reservation
    && !flags.hold;
  const eligible = available && photos && priced && marketplaceBlocks(unit).length === 0;
  return { available, eligible, reasons: [...new Set(reasons)] };
}

export function includeInView(decision, view, photoCount) {
  if (view === "all") return true;
  if (!decision.available) return false;
  if (view === "photo-ready") return photoCount > 0;
  return photoCount > 0 && !decision.reasons.includes("missing_price");
}

export function pageSkus(skus, { limit, cursor }) {
  const sorted = [...new Set(skus)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const start = cursor ? sorted.findIndex((sku) => sku > cursor) : 0;
  const from = start < 0 ? sorted.length : start;
  const slice = sorted.slice(from, from + limit);
  const next = from + limit < sorted.length ? slice[slice.length - 1] : null;
  return { skus: slice, total: sorted.length, next_cursor: next };
}

export function listingUrl(channel, listingId, sku) {
  const id = String(listingId || "").trim();
  const ch = String(channel || "").toLowerCase();
  if (ch === "website" && sku) return `${SITE_ITEM_URL}/${encodeURIComponent(sku)}`;
  if (!id) return null;
  if (/^https?:\/\//i.test(id)) return id;
  if (ch === "ebay" && /^\d+$/.test(id)) return `https://www.ebay.com/itm/${id}`;
  if (ch === "depop" && /^\d+$/.test(id)) return `https://www.depop.com/products/${id}/`;
  if (ch === "amazon" && /^[A-Z0-9]{10}$/.test(id)) return `https://www.amazon.com/dp/${id}`;
  return null;
}

function num(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function displayName(unit) {
  const title = String(unit.title || "").trim();
  if (title) return title;
  const named = [unit.brand, unit.model].map((part) => String(part || "").trim()).filter(Boolean).join(" ");
  return named || `SKU ${unit.sku}`;
}

export function photoSort(a, b) {
  const ao = a.sort_order == null ? Number.MAX_SAFE_INTEGER : Number(a.sort_order);
  const bo = b.sort_order == null ? Number.MAX_SAFE_INTEGER : Number(b.sort_order);
  if (ao !== bo) return ao - bo;
  if (Boolean(a.is_primary) !== Boolean(b.is_primary)) return a.is_primary ? -1 : 1;
  const at = String(a.created_at || "");
  const bt = String(b.created_at || "");
  if (at !== bt) return at < bt ? -1 : 1;
  return Number(a.id) - Number(b.id);
}

export function shapeUnit(unit, { photos, listings, accounts, onWebsite, signed, decision }) {
  const photoRows = [...photos].sort(photoSort).map((photo) => ({
    url: signed.get(photo.path) || null,
    created_at: photo.created_at,
    sort_order: photo.sort_order == null ? null : Number(photo.sort_order),
    is_primary: Boolean(photo.is_primary),
  }));
  const channels = listings.map((row) => {
    const account = row.ebay_account_id ? accounts.get(row.ebay_account_id) : null;
    return {
      channel: row.channel,
      status: row.status,
      listing_id: row.listing_id || null,
      offer_id: row.offer_id || null,
      url: listingUrl(row.channel, row.listing_id, unit.sku),
      listed_at: row.listed_at || null,
      ebay_account: account ? { username: account.username, role: account.role } : null,
    };
  });
  if (onWebsite && !channels.some((row) => row.channel === "website")) {
    channels.push({
      channel: "website",
      status: "listed",
      listing_id: unit.sku,
      offer_id: null,
      url: listingUrl("website", null, unit.sku),
      listed_at: null,
      ebay_account: null,
    });
  }
  const reasons = photoRows.some((photo) => photo.url) || photos.length === 0
    ? decision.reasons
    : [...new Set([...decision.reasons, "photo_unavailable"])];
  const eligible = decision.eligible && !reasons.includes("photo_unavailable");
  return {
    sku: unit.sku,
    store_id: unit.store_id,
    name: displayName(unit),
    title: String(unit.title || "").trim(),
    brand: unit.brand || "",
    model: unit.model || "",
    upc: unit.upc || null,
    category: unit.category || null,
    condition: unit.condition || null,
    condition_notes: unit.defect_notes || null,
    test_status: unit.test_status || null,
    floor_price_cents: num(unit.ask_cents),
    minimum_cents: num(unit.floor_cents),
    cost_cents: num(unit.acquisition_cost_cents),
    retail_cents: num(unit.msrp_cents),
    retail_source_name: unit.retail_source_name || null,
    retail_source_url: unit.retail_source_url || null,
    dimensions: {
      source: unit.dims_source || null,
      product: {
        height_in: num(unit.product_height_in),
        width_in: num(unit.product_width_in),
        depth_in: num(unit.product_depth_in),
        weight_lb: num(unit.product_weight_lb),
      },
      package: {
        length_in: num(unit.package_length_in),
        width_in: num(unit.package_width_in),
        height_in: num(unit.package_height_in),
        weight_lb: num(unit.package_weight_lb),
      },
    },
    quantity: num(unit.qty_on_hand),
    status: unit.state,
    created_at: unit.received_at,
    updated_at: unit.updated_at,
    show_on_website: Boolean(unit.show_on_website),
    listed_on: Array.isArray(unit.listed_on) ? unit.listed_on : [],
    listings: channels,
    photos: photoRows,
    available: decision.available,
    eligible,
    reasons,
  };
}

async function fetchAll(sb, table, select, apply) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    let query = sb.from(table).select(select).range(from, from + 999);
    if (apply) query = apply(query);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

function keyOf(row) {
  return `${row.store_id || ""}:${row.sku}`;
}

async function signPaths(sb, paths) {
  const signed = new Map();
  const unique = [...new Set(paths)];
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const { data, error } = await sb.storage.from("unit-photos").createSignedUrls(chunk, PHOTO_TTL_SECONDS);
    if (error) throw new Error(error.message);
    for (const row of data || []) {
      if (row?.path && row.signedUrl) signed.set(row.path, row.signedUrl);
    }
  }
  return signed;
}

function flagsFor(unit, blockers, photoCount) {
  const key = keyOf(unit);
  return {
    photoCount,
    sale: blockers.sales.has(key),
    reservation: blockers.reservations.has(key),
    hold: blockers.holds.has(key),
  };
}

async function blockerSets(sb, nowIso) {
  const [sales, reservations, orders] = await Promise.all([
    fetchAll(sb, "sales", "store_id,sku", (q) => q.is("voided_at", null).order("sku")),
    fetchAll(sb, "reservations", "store_id,sku", (q) => q.is("released_at", null).is("finalized_at", null).gt("expires_at", nowIso).order("sku")),
    fetchAll(sb, "web_orders", "store_id,sku,status,sale_id", (q) => q.in("status", ["claimed", "paid"]).order("sku")),
  ]);
  return {
    sales: new Set(sales.map(keyOf)),
    reservations: new Set(reservations.map(keyOf)),
    holds: new Set(orders.filter((row) => row.status === "claimed" || (row.status === "paid" && !row.sale_id)).map(keyOf)),
  };
}

async function photoCounts(sb) {
  const rows = await fetchAll(sb, "photos", "store_id,sku,path", (q) => q.order("id"));
  const counts = new Map();
  for (const row of rows) {
    if (String(row.path || "").includes("/web/")) continue;
    const key = keyOf(row);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

async function changedKeys(sb, since) {
  const [photos, listed, delisted] = await Promise.all([
    fetchAll(sb, "photos", "store_id,sku", (q) => q.gte("created_at", since).order("id")),
    fetchAll(sb, "listings", "store_id,sku", (q) => q.gte("listed_at", since).order("sku")),
    fetchAll(sb, "listings", "store_id,sku", (q) => q.gte("delisted_at", since).order("sku")),
  ]);
  return new Set([...photos, ...listed, ...delisted].map(keyOf));
}

async function hydrate(sb, skus, decisions) {
  if (!skus.length) return [];
  const [units, photos, listings, website] = await Promise.all([
    fetchAll(sb, "units", UNIT_FULL, (q) => q.in("sku", skus).order("sku")),
    fetchAll(sb, "photos", "id,store_id,sku,path,created_at,is_primary,sort_order", (q) => q.in("sku", skus).order("id")),
    fetchAll(sb, "listings", "store_id,sku,channel,status,listing_id,offer_id,listed_at,ebay_account_id", (q) => q.in("sku", skus).eq("status", "listed").order("sku")),
    fetchAll(sb, "storefront_items", "store_id,sku", (q) => q.in("sku", skus).order("sku")),
  ]);
  const accountIds = [...new Set(listings.map((row) => row.ebay_account_id).filter(Boolean))];
  const accountRows = accountIds.length
    ? await fetchAll(sb, "ebay_accounts", "id,username,role", (q) => q.in("id", accountIds).order("username"))
    : [];
  const accounts = new Map(accountRows.map((row) => [row.id, row]));
  const photosBy = new Map();
  for (const photo of photos) {
    if (String(photo.path || "").includes("/web/")) continue;
    const key = keyOf(photo);
    const list = photosBy.get(key) || [];
    list.push(photo);
    photosBy.set(key, list);
  }
  const listingsBy = new Map();
  for (const row of listings) {
    const key = keyOf(row);
    const list = listingsBy.get(key) || [];
    list.push(row);
    listingsBy.set(key, list);
  }
  const websiteKeys = new Set(website.map(keyOf));
  const signed = await signPaths(sb, photos.map((photo) => photo.path).filter((path) => path && !String(path).includes("/web/")));
  const order = new Map(skus.map((sku, index) => [sku, index]));
  return units
    .sort((a, b) => (order.get(a.sku) ?? 0) - (order.get(b.sku) ?? 0))
    .map((unit) => {
      const key = keyOf(unit);
      const unitPhotos = photosBy.get(key) || [];
      const decision = decisions.get(key);
      return shapeUnit(unit, {
        photos: unitPhotos,
        listings: listingsBy.get(key) || [],
        accounts,
        onWebsite: websiteKeys.has(key),
        signed,
        decision,
      });
    });
}

export async function loadListingFeed(sb, query, now = new Date()) {
  const nowIso = now.toISOString();
  const [units, counts, blockers, changed] = await Promise.all([
    fetchAll(sb, "units", UNIT_LIST, (q) => q.order("sku")),
    photoCounts(sb),
    blockerSets(sb, nowIso),
    query.since ? changedKeys(sb, query.since) : Promise.resolve(null),
  ]);
  const wanted = query.skus.length ? new Set(query.skus) : null;
  const decisions = new Map();
  const matched = [];
  for (const unit of units) {
    if (wanted && !wanted.has(unit.sku)) continue;
    const key = keyOf(unit);
    const photoCount = counts.get(key) || 0;
    const decision = decideUnit(unit, flagsFor(unit, blockers, photoCount));
    decisions.set(key, decision);
    if (query.check) {
      matched.push(unit.sku);
      continue;
    }
    if (query.category && String(unit.category || "").trim().toLowerCase() !== query.category.toLowerCase()) continue;
    if (query.since) {
      const unitChanged = Date.parse(unit.updated_at) >= Date.parse(query.since);
      if (!unitChanged && !changed.has(key)) continue;
    }
    if (query.eligibleOnly && !decision.eligible) continue;
    if (!includeInView(decision, query.view, photoCount)) continue;
    matched.push(unit.sku);
  }

  if (query.check) {
    if (!matched.length) return { status: 404, body: { ok: false, error: "not_found", sku: query.check } };
    const [unit] = await hydrate(sb, [query.check], decisions);
    return {
      status: 200,
      body: {
        ok: true,
        mode: "check",
        generated_at: nowIso,
        photo_url_ttl_seconds: PHOTO_TTL_SECONDS,
        available: unit.available,
        eligible: unit.eligible,
        reasons: unit.reasons,
        unit,
      },
    };
  }

  const page = pageSkus(matched, query);
  const pageDecisions = decisions;
  const rows = await hydrate(sb, page.skus, pageDecisions);
  return {
    status: 200,
    body: {
      ok: true,
      mode: "feed",
      view: query.view,
      generated_at: nowIso,
      photo_url_ttl_seconds: PHOTO_TTL_SECONDS,
      filters: {
        category: query.category,
        since: query.since,
        skus: query.skus,
        eligible_only: query.eligibleOnly,
        cursor: query.cursor,
      },
      limit: query.limit,
      count: rows.length,
      total: page.total,
      next_cursor: page.next_cursor,
      units: rows,
    },
  };
}
