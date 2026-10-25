/**
 * Marketplace board data + paced bulk jobs for eBay, Amazon, and TikTok.
 * Reads the same sale_ledger numbers as Reports. Writes go through the existing
 * listing-manager publish / end paths, or finalize_sale for Mark sold.
 * Admin-only: listing-manager already requires portalAdminFromEvent.
 */
import { serviceClient } from "./server.mjs";
import {
  endAmazonListing,
  endDepopListing,
  endEbayListing,
  endTikTokListing,
  listAmazonListings,
  listEbayListings,
  listTikTokListings,
  publishCreate,
} from "./listing-manager.mjs";
import {
  aggregateChannelStats,
  buildNotListed,
  collectQuarters,
  currentQuarter,
  quarterBounds,
  shippingTag,
} from "./marketplace-board-math.mjs";
import { channelGaps } from "./listing-requirements.mjs";

const JOB_KEY = "marketplace_board_job";
const CHANNELS = new Set(["ebay", "amazon", "tiktok"]);
/** Short in-memory TTL for board_catalog on a warm Netlify instance. */
const CATALOG_TTL_MS = 50_000;
/** Durable store_settings TTL so cold instances still paint under ~2s. */
const DURABLE_CATALOG_TTL_MS = 90_000;
/** Sign this many listed thumbs server-side; the rest paint as placeholders (keeps catalog under 2s). */
const LISTED_SIGN_LIMIT = 80;
const catalogCache = new Map();

function durableCatalogKey(channel) {
  return `marketplace_board_catalog_${channel}`;
}

function channelOf(channel) {
  const ch = String(channel || "").toLowerCase();
  if (!CHANNELS.has(ch)) {
    const error = new Error("channel_required");
    error.status = 400;
    throw error;
  }
  return ch;
}

async function paged(fetchPage) {
  const rows = [];
  for (let offset = 0; offset < 20000; offset += 1000) {
    const batch = await fetchPage(offset);
    rows.push(...(batch || []));
    if (!batch || batch.length < 1000) break;
  }
  return rows;
}

function realPhoto(path) {
  const value = String(path || "");
  return Boolean(value) && !value.includes("/official-") && !/ai[-_]?gen/i.test(value);
}

/** Prefer `{store}/{sku}/web/400/{stem}.webp` for board thumbs (same as AppInventory). */
export function web400Path(originalPath) {
  const parts = String(originalPath || "").replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length < 3 || parts[1] === "archive" || parts[2] === "web") return null;
  const file = parts[parts.length - 1] || "photo.jpg";
  const stem = file.replace(/\.[^.]+$/, "") || "photo";
  return `${parts[0]}/${parts[1]}/web/400/${stem}.webp`;
}

async function signStoragePaths(paths) {
  const sb = serviceClient();
  const urls = {};
  const list = [...new Set((paths || []).map((p) => String(p || "").trim()).filter(Boolean))];
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    const { data, error } = await sb.storage.from("unit-photos").createSignedUrls(chunk, 3600);
    if (error) throw new Error(error.message);
    for (const row of data || []) {
      if (row?.path && row.signedUrl && !row.error) urls[row.path] = row.signedUrl;
    }
  }
  return urls;
}

/** Map sku → primary photo storage path (no signing). */
async function primaryPhotoPaths(storeId, skus) {
  const sb = serviceClient();
  const list = [...new Set((skus || []).map((sku) => String(sku || "").trim()).filter(Boolean))];
  const chosen = {};
  for (let i = 0; i < list.length; i += 200) {
    const chunk = list.slice(i, i + 200);
    const { data, error } = await sb
      .from("photos")
      .select("sku, path, is_primary")
      .eq("store_id", storeId)
      .in("sku", chunk);
    if (error) throw new Error(error.message);
    for (const row of data || []) {
      if (!realPhoto(row.path)) continue;
      const prev = chosen[row.sku];
      if (!prev || (row.is_primary && !prev.is_primary)) chosen[row.sku] = row;
    }
  }
  const out = {};
  for (const [sku, row] of Object.entries(chosen)) out[sku] = row.path;
  return out;
}

async function primaryPhotoUrls(storeId, skus, { signLimit = Infinity, fallbackOriginals = true } = {}) {
  const list = [...new Set((skus || []).map((sku) => String(sku || "").trim()).filter(Boolean))];
  const signSkus = Number.isFinite(signLimit) ? list.slice(0, Math.max(0, signLimit)) : list;
  const pathsBySku = await primaryPhotoPaths(storeId, signSkus);
  const prefer = {};
  const originals = [];
  for (const [sku, path] of Object.entries(pathsBySku)) {
    const thumb = web400Path(path);
    if (thumb) prefer[sku] = thumb;
    else originals.push(path);
  }
  const preferPaths = Object.values(prefer);
  const urls = await signStoragePaths([...preferPaths, ...originals]);
  if (fallbackOriginals) {
    const missingOriginals = [];
    for (const [sku, path] of Object.entries(pathsBySku)) {
      const thumb = prefer[sku];
      if (thumb && !urls[thumb]) missingOriginals.push(path);
    }
    if (missingOriginals.length) {
      Object.assign(urls, await signStoragePaths(missingOriginals));
    }
  }
  const out = {};
  for (const sku of list) {
    const path = pathsBySku[sku];
    if (!path) {
      out[sku] = null;
      continue;
    }
    const thumb = prefer[sku];
    out[sku] = (thumb && urls[thumb]) || urls[path] || null;
  }
  return out;
}

async function unitsFor(storeId, skus, columns) {
  const sb = serviceClient();
  const map = {};
  const list = [...new Set((skus || []).map((sku) => String(sku || "").trim()).filter(Boolean))];
  for (let i = 0; i < list.length; i += 200) {
    const chunk = list.slice(i, i + 200);
    const { data, error } = await sb.from("units").select(columns).eq("store_id", storeId).in("sku", chunk);
    if (error) throw new Error(error.message);
    for (const row of data || []) map[row.sku] = row;
  }
  return map;
}

async function mapIn(storeId, table, column, values, select) {
  const sb = serviceClient();
  const map = {};
  const list = [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
  for (let i = 0; i < list.length; i += 200) {
    const chunk = list.slice(i, i + 200);
    const { data, error } = await sb.from(table).select(select).eq("store_id", storeId).in(column, chunk);
    if (error) throw new Error(error.message);
    for (const row of data || []) {
      const key = row[column];
      if (map[key]) continue;
      map[key] = row;
    }
  }
  return map;
}

function listedRow(row) {
  const sku = row.sku ? String(row.sku) : null;
  return {
    key: sku || String(row.item_id || row.offer_id || row.product_id || row.offer_sku || ""),
    sku,
    title: row.title || (sku ? `SKU ${sku}` : "Listing"),
    price_cents: row.price_cents ?? null,
    qty: row.qty ?? null,
    asin: row.asin || null,
    upc: null,
    condition: null,
    listed_at: null,
    shipping: row.shipping_mode ? shippingTag(row.shipping_mode) : "unknown",
    floor_ask_cents: row.floor_ask_cents ?? null,
    photo_url: null,
    offer_id: row.offer_id || null,
    offer_sku: row.offer_sku || null,
    account_id: row.account_id || null,
    account: row.account || null,
    product_id: row.product_id || null,
    item_id: row.item_id || null,
    url: row.url || null,
    live: true,
    blocked: false,
    blocked_reason: null,
  };
}

async function listingsForChannel(storeId, channel, skus) {
  const sb = serviceClient();
  const map = {};
  const list = [...new Set(skus.filter(Boolean))];
  for (let i = 0; i < list.length; i += 200) {
    const chunk = list.slice(i, i + 200);
    const { data, error } = await sb
      .from("listings")
      .select("sku, listed_at, status")
      .eq("store_id", storeId)
      .eq("channel", channel)
      .in("sku", chunk);
    if (error) throw new Error(error.message);
    for (const row of data || []) map[row.sku] = row;
  }
  return map;
}

async function enrichListed(storeId, channel, items, { signLimit = LISTED_SIGN_LIMIT } = {}) {
  const rows = (items || []).map(listedRow).filter((row) => row.key);
  const skus = rows.map((row) => row.sku).filter(Boolean);
  const [units, photos, drafts, floorListings, amazon] = await Promise.all([
    unitsFor(storeId, skus, "sku, title, condition, upc, ask_cents"),
    primaryPhotoUrls(storeId, skus, { signLimit, fallbackOriginals: false }),
    channel === "ebay" ? mapIn(storeId, "ebay_drafts", "sku", skus, "sku, shipping_mode") : Promise.resolve({}),
    listingsForChannel(storeId, channel, skus),
    channel === "amazon" ? mapIn(storeId, "amazon_list_items", "sku", skus, "sku, asin, needs_review_reason") : Promise.resolve({}),
  ]);
  return rows.map((row) => {
    const unit = row.sku ? units[row.sku] : null;
    const floor = row.sku ? floorListings[row.sku] : null;
    const draft = row.sku ? drafts[row.sku] : null;
    const amz = row.sku ? amazon[row.sku] : null;
    return {
      ...row,
      condition: unit?.condition || null,
      upc: unit?.upc || null,
      asin: row.asin || amz?.asin || null,
      listed_at: floor?.listed_at || null,
      shipping: row.shipping && row.shipping !== "unknown" ? row.shipping : "unknown",
      floor_ask_cents: unit?.ask_cents ?? row.floor_ask_cents ?? null,
      photo_url: row.sku ? photos[row.sku] || null : null,
    };
  });
}

async function availableUnits(storeId) {
  const sb = serviceClient();
  return paged(async (offset) => {
    const { data, error } = await sb
      .from("units")
      .select("sku, title, condition, upc, ask_cents, state, brand, category, ebay_category, package_weight_lb, package_length_in, package_width_in, package_height_in, listing_specs")
      .eq("store_id", storeId)
      .eq("state", "available")
      .order("sku", { ascending: false })
      .range(offset, offset + 999);
    if (error) throw new Error(error.message);
    return data || [];
  });
}

async function amazonBlocks(storeId) {
  const sb = serviceClient();
  const { data, error } = await sb
    .from("amazon_list_items")
    .select("sku, asin, status, needs_review_reason")
    .eq("store_id", storeId)
    .eq("status", "not_on_amazon")
    .limit(2000);
  if (error) throw new Error(error.message);
  return data || [];
}

async function loadNotListed(storeId, channel, listed, { units: preloadedUnits = null } = {}) {
  const liveSkus = listed.map((row) => row.sku).filter(Boolean);
  const units = preloadedUnits || await availableUnits(storeId);
  const blocks = channel === "amazon" ? await amazonBlocks(storeId) : [];
  const blockedBySku = {};
  const unitBySku = Object.fromEntries(units.map((unit) => [unit.sku, unit]));
  for (const block of blocks) {
    const reason = block.needs_review_reason || "No ASIN match — this unit can't be created on Amazon";
    blockedBySku[block.sku] = reason;
    if (unitBySku[block.sku] && block.asin) unitBySku[block.sku] = { ...unitBySku[block.sku], asin: block.asin };
  }
  const candidates = units.map((unit) => unitBySku[unit.sku] || unit);
  const needPhotos = candidates
    .map((unit) => unit.sku)
    .filter((sku) => sku && !liveSkus.includes(sku));
  // Existence only — signing every not-listed thumb was the bulk of board_catalog cost.
  const photoPathBySku = await primaryPhotoPaths(storeId, needPhotos);
  const photoBySku = {};
  const drafts = channel === "ebay"
    ? await mapIn(storeId, "ebay_drafts", "sku", needPhotos, "sku, aspect_defs, aspects, category_id, category_name")
    : {};
  const gapsBySku = {};
  for (const unit of candidates) {
    if (!unit?.sku || liveSkus.includes(unit.sku)) continue;
    const draft = drafts[unit.sku] || null;
    const specs = unit.listing_specs && typeof unit.listing_specs === "object" ? unit.listing_specs : {};
    gapsBySku[unit.sku] = channelGaps(
      {
        ...unit,
        category: unit.category || draft?.category_name || null,
        aspects: draft?.aspects || specs.ebay_aspects || null,
        listing_specs: {
          ...specs,
          ebay_category_id: specs.ebay_category_id || draft?.category_id || null,
        },
      },
      {
        channel,
        photoCount: photoPathBySku[unit.sku] ? 1 : 0,
        aspectDefs: draft?.aspect_defs || null,
        amazonBlocked: blockedBySku[unit.sku] || null,
      },
    );
  }
  return buildNotListed(candidates, { liveSkus, photoBySku, gapsBySku }).map((row) => ({
    ...row,
    key: row.sku,
    qty: 1,
    listed_at: null,
    shipping: "unknown",
    offer_id: null,
    offer_sku: null,
    account_id: null,
    account: null,
    product_id: null,
    item_id: null,
    url: null,
    live: false,
  }));
}

function tiktokConnected(pack) {
  if (pack?.status && typeof pack.status.connected === "boolean") return pack.status.connected;
  const message = `${pack?.message || ""} ${pack?.error || ""}`;
  if (/not connected|Partner app|tiktok_env_missing|tiktok_not_connected/i.test(message)) return false;
  return !pack?.stub;
}

async function readDurableCatalog(storeId, channel) {
  const sb = serviceClient();
  const { data, error } = await sb
    .from("store_settings")
    .select("value")
    .eq("store_id", storeId)
    .eq("key", durableCatalogKey(channel))
    .maybeSingle();
  if (error || !data?.value?.at || !data.value.pack) return null;
  const at = Date.parse(data.value.at);
  if (!Number.isFinite(at) || Date.now() - at > DURABLE_CATALOG_TTL_MS) return null;
  return data.value.pack;
}

async function writeDurableCatalog(storeId, channel, pack) {
  try {
    const sb = serviceClient();
    await sb.from("store_settings").upsert(
      {
        store_id: storeId,
        key: durableCatalogKey(channel),
        value: { at: new Date().toISOString(), pack },
      },
      { onConflict: "store_id,key" },
    );
  } catch { /* best-effort cache */ }
}

export async function loadCatalog(storeId, channel, { force = false } = {}) {
  const ch = channelOf(channel);
  const cacheKey = `${storeId}:${ch}`;
  if (!force) {
    const hit = catalogCache.get(cacheKey);
    if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.pack;
    const durable = await readDurableCatalog(storeId, ch);
    if (durable) {
      catalogCache.set(cacheKey, { at: Date.now(), pack: durable });
      return durable;
    }
  }
  // Floor-first by default (live marketplace only on Refresh / force) so info + inventory paint together under ~2s.
  const live = Boolean(force);
  // Start available-units while the channel list loads.
  const availablePromise = availableUnits(storeId).catch(() => null);
  const pack = ch === "ebay"
    ? await listEbayListings(storeId, { limit: 2000, live })
    : ch === "amazon"
      ? await listAmazonListings(storeId, { limit: 2000, live })
      : await listTikTokListings(storeId, { limit: 2000, live });
  if (pack?.ok === false && !pack?.items) return { ok: false, error: pack.error || "list_failed", channel: ch };
  const connected = ch !== "tiktok" || tiktokConnected(pack);
  const [listed, preloadedUnits] = await Promise.all([
    enrichListed(storeId, ch, pack?.items || []),
    availablePromise,
  ]);
  const notListed = connected
    ? await loadNotListed(storeId, ch, listed, { units: preloadedUnits || undefined })
    : [];
  const result = {
    ok: true,
    channel: ch,
    connected,
    connect_message: connected
      ? null
      : pack?.message || "TikTok Shop isn't connected yet. Partner keys are still waiting — connect it in Marketplaces.",
    warnings: pack?.warnings || [],
    message: pack?.message || null,
    last_synced: pack?.last_synced || null,
    accounts: pack?.accounts || null,
    source: pack?.source || (live ? "live" : "floor"),
    listed,
    not_listed: notListed,
  };
  catalogCache.set(cacheKey, { at: Date.now(), pack: result });
  void writeDurableCatalog(storeId, ch, result);
  return result;
}

async function salesInQuarter(storeId, channel, bounds) {
  const sb = serviceClient();
  return paged(async (offset) => {
    const { data, error } = await sb
      .from("sale_ledger")
      .select("id, sku, qty, sold_at, voided_at, price_cents, shipping_cents, channel_fee_cents, ship_cost_cents, cost_cents, processing_fee_cents, profit_cents, receipt_no, payment_id, channel")
      .eq("store_id", storeId)
      .ilike("channel", channel)
      .gte("sold_at", bounds.from)
      .lt("sold_at", bounds.to)
      .order("sold_at", { ascending: false })
      .range(offset, offset + 999);
    if (error) throw new Error(error.message);
    return data || [];
  });
}

async function quarterSeeds(storeId, channel) {
  const sb = serviceClient();
  const instants = [];
  const dates = [];
  // Cap history — full ledger paging was dominating board_quarter for little UI value.
  const { data: sales, error } = await sb
    .from("sale_ledger")
    .select("sold_at")
    .eq("store_id", storeId)
    .ilike("channel", channel)
    .order("sold_at", { ascending: false })
    .limit(500);
  if (error) throw new Error(error.message);
  for (const row of sales || []) instants.push(row.sold_at);
  if (channel === "ebay") {
    const { data: expenses, error: expErr } = await sb
      .from("portal_expenses")
      .select("spent_on")
      .eq("store_id", storeId)
      .eq("source", "ebay")
      .is("voided_at", null)
      .order("spent_on", { ascending: false })
      .limit(200);
    if (expErr) throw new Error(expErr.message);
    for (const row of expenses || []) dates.push(row.spent_on);
  }
  return { instants, dates };
}

async function insertionCents(storeId, bounds) {
  const sb = serviceClient();
  const rows = await paged(async (offset) => {
    const { data, error } = await sb
      .from("portal_expenses")
      .select("amount_cents")
      .eq("store_id", storeId)
      .eq("source", "ebay")
      .is("voided_at", null)
      .gte("spent_on", bounds.start)
      .lt("spent_on", bounds.end)
      .range(offset, offset + 999);
    if (error) throw new Error(error.message);
    return data || [];
  });
  return rows.reduce((sum, row) => sum + (Number(row.amount_cents) || 0), 0);
}

function orderNumber(sale, channelOrder, webOrder) {
  if (channelOrder?.order_id) return String(channelOrder.order_id);
  if (webOrder?.order_no) return String(webOrder.order_no);
  const payment = String(sale.payment_id || "");
  const stripped = payment.replace(/^(ebay|amazon|tiktok):/i, "");
  if (stripped && stripped !== payment && !stripped.startsWith("board:")) return stripped;
  return sale.receipt_no || "";
}

async function shapeSold(storeId, sales) {
  const open = (sales || []).filter((row) => row.voided_at == null);
  const skus = open.map((row) => row.sku).filter(Boolean);
  const ids = open.map((row) => row.id).filter((id) => id != null);
  const [units, photos, channelOrders, webOrders] = await Promise.all([
    unitsFor(storeId, skus, "sku, title, brand, model, condition, upc"),
    // Cap sold thumbs — stats must not wait on signing every historical sale photo.
    primaryPhotoUrls(storeId, skus, { signLimit: 40, fallbackOriginals: false }),
    mapIn(storeId, "channel_orders", "sale_id", ids, "sale_id, order_id, buyer_username"),
    mapIn(storeId, "web_orders", "sale_id", ids, "sale_id, order_no, buyer_name, buyer_email"),
  ]);
  return open.map((sale) => {
    const unit = sale.sku ? units[sale.sku] : null;
    const title = unit?.title
      || [unit?.brand, unit?.model].filter(Boolean).join(" ")
      || (sale.sku ? `SKU ${sale.sku}` : "Sale");
    const fee = Number(sale.channel_fee_cents) || 0;
    const label = Number(sale.ship_cost_cents) || 0;
    const cost = Number(sale.cost_cents) || 0;
    const profit = sale.profit_cents == null ? null : Number(sale.profit_cents);
    return {
      key: String(sale.id),
      sale_id: sale.id,
      sku: sale.sku || null,
      title,
      condition: unit?.condition || null,
      upc: unit?.upc || null,
      qty: sale.qty || 1,
      sold_at: sale.sold_at,
      price_cents: Number(sale.price_cents) || 0,
      shipping_cents: Number(sale.shipping_cents) || 0,
      fee_cents: fee,
      label_cents: label,
      cost_cents: cost,
      processing_fee_cents: Number(sale.processing_fee_cents) || 0,
      profit_cents: profit,
      net_cents: profit,
      receipt_no: sale.receipt_no || "",
      order_no: orderNumber(sale, channelOrders[sale.id], webOrders[sale.id]),
      buyer_name: webOrders[sale.id]?.buyer_name || channelOrders[sale.id]?.buyer_username || null,
      buyer_email: webOrders[sale.id]?.buyer_email || null,
      photo_url: sale.sku ? photos[sale.sku] || null : null,
    };
  });
}

export async function loadQuarter(storeId, channel, quarterId) {
  const ch = channelOf(channel);
  const id = quarterId || currentQuarter().id;
  const bounds = quarterBounds(id);
  const salesP = salesInQuarter(storeId, ch, bounds);
  const [sales, seeds, insertion, sold] = await Promise.all([
    salesP,
    quarterSeeds(storeId, ch),
    ch === "ebay" ? insertionCents(storeId, bounds) : Promise.resolve(0),
    salesP.then((rows) => shapeSold(storeId, rows)),
  ]);
  const quarters = collectQuarters(seeds.instants, seeds.dates);
  if (!quarters.some((quarter) => quarter.id === bounds.id)) quarters.unshift({ id: bounds.id, label: bounds.label, year: bounds.year, q: bounds.q });
  return {
    ok: true,
    channel: ch,
    quarter: { id: bounds.id, label: bounds.label, start: bounds.start, end: bounds.end },
    quarters: quarters.map((quarter) => ({ id: quarter.id, label: quarter.label })),
    stats: aggregateChannelStats(sales, { insertionCents: insertion }),
    sold,
  };
}

export async function rememberShippingMode(storeId, sku, mode) {
  const shipping = mode === "free" ? "free" : "calculated";
  const sb = serviceClient();
  const { error } = await sb.from("ebay_drafts").upsert(
    { store_id: storeId, sku, shipping_mode: shipping, updated_at: new Date().toISOString() },
    { onConflict: "store_id,sku" },
  );
  if (error) return { ok: false, error: error.message };
  return { ok: true, shipping_mode: shipping };
}

export async function saveFloorListingFields(storeId, body = {}) {
  const sku = String(body.sku || "").trim();
  if (!sku) return { ok: false, error: "sku_required" };
  const patch = { updated_at: new Date().toISOString() };
  if (body.title != null && String(body.title).trim()) patch.title = String(body.title).trim().slice(0, 200);
  if (body.description != null) patch.listing_body = String(body.description);
  if (body.price_cents != null && Number.isFinite(Number(body.price_cents))) patch.ask_cents = Math.round(Number(body.price_cents));
  if (body.condition != null && String(body.condition).trim()) patch.condition = String(body.condition).trim();
  if (body.condition_note != null) patch.defect_notes = String(body.condition_note);
  const sb = serviceClient();
  const { error } = await sb.from("units").update(patch).eq("store_id", storeId).eq("sku", sku);
  if (error) return { ok: false, error: error.message };
  if (body.shipping_mode && String(body.channel || "") === "ebay") {
    const ship = await rememberShippingMode(storeId, sku, body.shipping_mode);
    if (!ship.ok) return { ok: true, sku, floor_only: true, shipping_warning: ship.error };
  }
  return { ok: true, sku, floor_only: true };
}

function jobValue(patch) {
  return { updated_at: new Date().toISOString(), ...patch };
}

async function writeJob(storeId, value) {
  const sb = serviceClient();
  const { error } = await sb.from("store_settings").upsert(
    { store_id: storeId, key: JOB_KEY, value },
    { onConflict: "store_id,key" },
  );
  if (error) throw new Error(error.message);
  return value;
}

export async function getBoardJobStatus(storeId) {
  const sb = serviceClient();
  const { data } = await sb.from("store_settings").select("value").eq("store_id", storeId).eq("key", JOB_KEY).maybeSingle();
  return data?.value || null;
}

function dispatchBoard(storeId, payload) {
  const base = (process.env.URL || "https://inventoryobi.netlify.app").replace(/\/$/, "");
  const token = process.env.SUPABASE_SERVICE_ROLE;
  return fetch(`${base}/.netlify/functions/listing-manager-background`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ job: "board", store_id: storeId, ...payload }),
  });
}

export async function queueBoardJob(storeId, { channel, kind, items = [], requestedBy = "portal" } = {}) {
  const ch = channelOf(channel);
  const allowed = new Set(["delist", "list", "mark_sold", "delete"]);
  if (!allowed.has(kind)) return { ok: false, error: "job_kind_required" };
  const list = (items || [])
    .map((item) => ({
      sku: item?.sku ? String(item.sku).trim() : "",
      offer_id: item?.offer_id || null,
      offer_sku: item?.offer_sku || null,
      account_id: item?.account_id || null,
      product_id: item?.product_id || null,
      item_id: item?.item_id || null,
      price_cents: item?.price_cents != null ? Math.round(Number(item.price_cents)) : null,
    }))
    .filter((item) => item.sku)
    .slice(0, 2000);
  if (!list.length) return { ok: false, error: "skus_required" };
  const current = await getBoardJobStatus(storeId);
  const updated = current?.updated_at ? Date.parse(current.updated_at) : 0;
  const fresh = updated && Date.now() - updated < 3 * 60 * 1000;
  if (current && (current.status === "running" || current.status === "queued") && fresh) {
    return { ok: false, error: "job_already_running", job: current };
  }
  const value = jobValue({
    status: "queued",
    kind,
    channel: ch,
    requested_by: requestedBy,
    requested_at: new Date().toISOString(),
    progress: { current: 0, total: list.length, message: "Queued — starting paced job…" },
    results: [],
  });
  await writeJob(storeId, value);
  const res = await dispatchBoard(storeId, { channel: ch, kind, items: list, results: [] });
  const ok = res.ok || res.status === 202;
  if (!ok) {
    const text = (await res.text()).slice(0, 200);
    await writeJob(storeId, jobValue({ ...value, status: "failed", progress: { current: 0, total: list.length, message: text || "Dispatch failed" } }));
    return { ok: false, error: text || "dispatch_failed" };
  }
  return { ok: true, started: true, kind, channel: ch, total: list.length, message: `Started ${kind} for ${list.length} unit(s).` };
}

function paceMs(kind) {
  if (kind === "list") return 9000 + Math.floor(Math.random() * 3000);
  return 4000 + Math.floor(Math.random() * 2000);
}

async function endOnChannel(storeId, channel, item) {
  if (channel === "ebay") {
    return endEbayListing(storeId, { sku: item.sku, offerId: item.offer_id, accountId: item.account_id });
  }
  if (channel === "amazon") return endAmazonListing(storeId, { sku: item.sku, offerSku: item.offer_sku || item.sku });
  if (channel === "tiktok") return endTikTokListing(storeId, { sku: item.sku, productId: item.product_id });
  if (channel === "depop") return endDepopListing(storeId, { sku: item.sku });
  return { ok: false, error: `end_not_supported:${channel}` };
}

export async function endEverywhere(storeId, sku, primaryChannel, item) {
  const sb = serviceClient();
  const { data, error } = await sb
    .from("listings")
    .select("channel, offer_id, listing_id, status")
    .eq("store_id", storeId)
    .eq("sku", sku)
    .eq("status", "listed");
  if (error) return [{ channel: primaryChannel, ok: false, error: error.message }];
  const channels = new Set((data || []).map((row) => row.channel));
  if (primaryChannel) channels.add(primaryChannel);
  const results = [];
  for (const ch of channels) {
    const row = (data || []).find((entry) => entry.channel === ch) || {};
    try {
      const result = await endOnChannel(storeId, ch, {
        sku,
        offer_id: item.offer_id || row.offer_id || null,
        offer_sku: item.offer_sku || sku,
        account_id: item.account_id || null,
        product_id: item.product_id || null,
      });
      results.push({ channel: ch, ok: result?.ok !== false, error: result?.error || null });
    } catch (err) {
      results.push({ channel: ch, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

async function runOne(storeId, channel, kind, item) {
  if (kind === "delist") {
    const result = await endOnChannel(storeId, channel, item);
    return { sku: item.sku, ok: result?.ok !== false, error: result?.error || null };
  }
  if (kind === "list") {
    const result = await publishCreate(storeId, { channel, sku: item.sku, priceCents: item.price_cents });
    const ok = Boolean(result?.ok) && !result?.needs_confirm;
    return {
      sku: item.sku,
      ok,
      error: ok ? null : result?.error || result?.message || "publish_failed",
      url: result?.url || null,
    };
  }
  if (kind === "mark_sold") {
    const price = item.price_cents;
    if (price == null || !Number.isFinite(price) || price < 0) return { sku: item.sku, ok: false, error: "price_required" };
    const sb = serviceClient();
    const { data, error } = await sb.rpc("finalize_sale", {
      p_sku: item.sku,
      p_channel: channel,
      p_price_cents: price,
      p_payment_method: channel,
      p_payment_id: `board:${channel}:${item.sku}:${Date.now()}`,
      p_note: "Marked sold from marketplace tab",
      p_tax_cents: 0,
      p_approval_id: null,
    });
    if (error) return { sku: item.sku, ok: false, error: error.message };
    const pulled = await endEverywhere(storeId, item.sku, channel, item);
    const pullError = pulled.filter((row) => !row.ok).map((row) => `${row.channel}: ${row.error}`).join(" · ");
    return {
      sku: item.sku,
      ok: !pullError,
      error: pullError || null,
      sale_id: data?.id || null,
      receipt_no: data?.receipt_no || null,
      pulled,
    };
  }
  if (kind === "delete") {
    const pulled = await endEverywhere(storeId, item.sku, channel, item);
    const sb = serviceClient();
    const { error } = await sb.rpc("delete_unit", { p_sku: item.sku, p_approval_id: null });
    if (error) {
      return {
        sku: item.sku,
        ok: false,
        error: error.message,
        pulled,
      };
    }
    const pullError = pulled.filter((row) => !row.ok).map((row) => `${row.channel}: ${row.error}`).join(" · ");
    return { sku: item.sku, ok: !pullError, error: pullError || null, deleted: true, pulled };
  }
  return { sku: item.sku, ok: false, error: "job_kind_required" };
}

export async function runBoardJob(storeId, { channel, kind, items = [], results = [] } = {}) {
  const ch = channelOf(channel);
  const done = Array.isArray(results) ? [...results] : [];
  const chunkSize = kind === "list" ? 12 : 20;
  const chunk = items.slice(0, chunkSize);
  const rest = items.slice(chunkSize);
  const total = done.length + items.length;
  for (let i = 0; i < chunk.length; i++) {
    const item = chunk[i];
    await writeJob(storeId, jobValue({
      status: "running",
      kind,
      channel: ch,
      progress: {
        current: done.length + 1,
        total,
        sku: item.sku,
        message: `${kind} ${item.sku} (${done.length + 1}/${total})…`,
      },
      results: done,
    }));
    let result;
    try {
      result = await runOne(storeId, ch, kind, item);
    } catch (err) {
      result = { sku: item.sku, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    done.push(result);
    if (i < chunk.length - 1 || rest.length) await new Promise((resolve) => setTimeout(resolve, paceMs(kind)));
  }
  if (rest.length) {
    const res = await dispatchBoard(storeId, { channel: ch, kind, items: rest, results: done });
    if (!res.ok && res.status !== 202) {
      const text = (await res.text()).slice(0, 200);
      await writeJob(storeId, jobValue({
        status: "failed",
        kind,
        channel: ch,
        results: done,
        progress: { current: done.length, total, message: `Stopped after ${done.length}: ${text || "could not continue"}` },
      }));
    }
    return { ok: true, continued: true, done: done.length, remaining: rest.length };
  }
  const summary = { total: done.length, ok: done.filter((row) => row.ok).length, failed: done.filter((row) => !row.ok).length };
  const finalValue = jobValue({
    status: "completed",
    kind,
    channel: ch,
    results: done,
    summary,
    finished_at: new Date().toISOString(),
    progress: { current: done.length, total: done.length, message: `Done · ${summary.ok}/${summary.total}` },
  });
  await writeJob(storeId, finalValue);
  return finalValue;
}
