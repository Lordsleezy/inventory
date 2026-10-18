/**
 * Read-only ikonikdeals2026 ACTIVE listing audit.
 * Pulls live eBay listings (Trading API), matches Floor, quotes Shippo rates
 * (no label purchase), and gathers Amazon/UPCitemdb retail comps.
 * Never ends, revises, or reprices listings. Ignores pgg124-5.
 */
import { serviceClient, requireEnv } from "./server.mjs";
import { loadEbayAccount, userTokenForAccount } from "./ebay-accounts.mjs";
import {
  getMyEbaySellingActive,
  getSellerListActive,
  getTradingItem,
} from "./ebay-trading.mjs";
import { liveRates, addressTo, allowedCarriers, shippoMode } from "./shippo.mjs";
import { farZoneAddress } from "./ebay-price.mjs";
import { lookupUpc } from "./upc-lookup.mjs";

export const AUDIT_REQUEST_KEY = "ebay_listing_audit_request";
export const AUDIT_RESULT_KEY = "ebay_listing_audit_result";
export const SELLING_USERNAME = "ikonikdeals2026";
/** Mid-country reference ZIP for calculated-shipping estimates (Kansas City, MO). */
export const MID_COUNTRY_ZIP = "64101";
export const STORE_DEFAULT = "5487ca47-6147-4fe8-bc6d-46b6472726ba";

const MONEY = (cents) =>
  Number.isFinite(cents) ? `$${(Number(cents) / 100).toFixed(2)}` : "";

function dollarsToCents(value) {
  const n = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function packageDims(unit) {
  const length_in = Number(unit?.package_length_in);
  const width_in = Number(unit?.package_width_in);
  const height_in = Number(unit?.package_height_in);
  const weight_lb = Number(unit?.package_weight_lb);
  const ok =
    length_in > 0 && width_in > 0 && height_in > 0 && weight_lb > 0;
  return {
    length_in: ok ? length_in : null,
    width_in: ok ? width_in : null,
    height_in: ok ? height_in : null,
    weight_lb: ok ? weight_lb : null,
    ready: ok,
    dims_source: unit?.dims_source || null,
  };
}

/** Normalize shipping / pickup fields from parseTradingItem (+ optional ActiveList summary). */
export function shippingFromTradingItem(item = {}, summary = {}) {
  const shippingType = item.shippingType || summary.shippingType || "";
  const services = (item.shippingServices || []).map((s) => ({
    service: s.service,
    cost_cents: dollarsToCents(s.cost),
    free: Boolean(s.free) || Number(s.cost || 0) === 0,
    priority: Number(s.priority || 0),
  }));
  const localPickup = Boolean(item.localPickup || summary.pickup) ||
    services.some((s) => /pickup/i.test(s.service || ""));
  const profile = item.shippingProfile || summary.shippingProfile || "";
  const type = String(shippingType || "").toLowerCase();
  let mode = "unknown";
  if (/free/i.test(type) || (services.some((s) => s.free) && /free/i.test(profile))) mode = "free";
  else if (/flat/i.test(type)) mode = "flat";
  else if (/calculated|freight/i.test(type) || /calculated/i.test(profile)) mode = "calculated";
  else if (/free/i.test(profile) && services.some((s) => s.free)) mode = "free";
  else if (services.length && services.every((s) => s.cost_cents != null) && !/calculated/i.test(profile)) {
    mode = services.every((s) => s.free) ? "free" : "flat";
  } else if (/calculated/i.test(profile)) mode = "calculated";
  const flatCents =
    mode === "flat"
      ? (services.find((s) => s.priority === 1)?.cost_cents ?? services[0]?.cost_cents ?? null)
      : mode === "free"
        ? 0
        : null;
  return {
    shipping_type: shippingType || null,
    shipping_mode: mode,
    shipping_profile: profile || null,
    flat_shipping_cents: flatCents,
    local_pickup: localPickup,
    shipping_services: services,
  };
}

async function mapPool(items, concurrency, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return out;
}

async function loadFloorMaps(sb, storeId, accountId) {
  const listed = [];
  let from = 0;
  for (;;) {
    const { data, error } = await sb
      .from("listings")
      .select("sku,listing_id,offer_id,status,ebay_account_id,listed_at")
      .eq("store_id", storeId)
      .eq("channel", "ebay")
      .eq("status", "listed")
      .eq("ebay_account_id", accountId)
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    listed.push(...(data || []));
    if (!data?.length || data.length < 1000) break;
    from += 1000;
  }

  const tagged = [];
  from = 0;
  for (;;) {
    const { data, error } = await sb
      .from("units")
      .select(
        "sku,title,brand,model,upc,category,condition,state,ask_cents,msrp_cents,floor_cents,acquisition_cost_cents,retail_source_name,retail_source_url,package_length_in,package_width_in,package_height_in,package_weight_lb,dims_source,listed_on,ebay_title",
      )
      .eq("store_id", storeId)
      .contains("listed_on", ["ebay"])
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    tagged.push(...(data || []));
    if (!data?.length || data.length < 1000) break;
    from += 1000;
  }

  // Also load units for SKUs on live eBay that may not be tagged yet.
  const bySku = new Map(tagged.map((u) => [String(u.sku), u]));
  const byListingId = new Map(
    listed.filter((r) => r.listing_id).map((r) => [String(r.listing_id), r]),
  );
  const listedBySku = new Map(listed.map((r) => [String(r.sku), r]));
  return { listed, tagged, bySku, byListingId, listedBySku };
}

async function ensureUnitsForSkus(sb, storeId, bySku, skus) {
  const missing = [...new Set(skus.map(String))].filter((sku) => sku && !bySku.has(sku));
  for (let i = 0; i < missing.length; i += 80) {
    const slice = missing.slice(i, i + 80);
    const { data, error } = await sb
      .from("units")
      .select(
        "sku,title,brand,model,upc,category,condition,state,ask_cents,msrp_cents,floor_cents,acquisition_cost_cents,retail_source_name,retail_source_url,package_length_in,package_width_in,package_height_in,package_weight_lb,dims_source,listed_on,ebay_title",
      )
      .eq("store_id", storeId)
      .in("sku", slice);
    if (error) throw new Error(error.message);
    for (const row of data || []) bySku.set(String(row.sku), row);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function quoteShippo(sb, storeId, shipFrom, pkg, { retries = 3 } = {}) {
  if (!shippoMode()) return { status: "no_shippo_key", estimate_cents: null, detail: null };
  if (!pkg?.ready) return { status: "missing_dims", estimate_cents: null, detail: null };
  const from = {
    name: shipFrom.name || "Open Box Industries",
    street1: shipFrom.street1 || shipFrom.line1,
    street2: shipFrom.street2 || "",
    city: shipFrom.city,
    state: shipFrom.state || shipFrom.region,
    zip: shipFrom.zip || shipFrom.postal,
    country: shipFrom.country || "US",
    phone: shipFrom.phone || "",
    email: shipFrom.email || "",
  };
  const parcel = {
    length_in: pkg.length_in,
    width_in: pkg.width_in,
    height_in: pkg.height_in,
    weight_lb: pkg.weight_lb,
  };
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (attempt) await sleep(800 * attempt);
      const carriers = await allowedCarriers(sb, storeId);
      const live = await liveRates({
        shipFrom: from,
        to: addressTo(farZoneAddress(MID_COUNTRY_ZIP)),
        pkg: parcel,
        carriers,
      });
      const best = live.rates?.[0] || live.all?.[0] || null;
      if (!best?.amount_cents) {
        return {
          status: "no_rate",
          estimate_cents: null,
          detail: (live.messages || []).join("; ").slice(0, 200) || null,
        };
      }
      return {
        status: "ok",
        estimate_cents: best.amount_cents,
        detail: `${best.carrier} ${best.service}${best.days != null ? ` · ~${best.days}d` : ""} → ${MID_COUNTRY_ZIP}`,
      };
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err);
      if (!/429|rate/i.test(msg) || attempt === retries) {
        return { status: "error", estimate_cents: null, detail: msg.slice(0, 200) };
      }
    }
  }
  return {
    status: "error",
    estimate_cents: null,
    detail: String(lastErr?.message || lastErr || "shippo_failed").slice(0, 200),
  };
}

function retailFromUnit(unit) {
  const rows = [];
  if (Number(unit?.msrp_cents) > 0) {
    rows.push({
      outlet: unit.retail_source_name || "Floor MSRP",
      price_cents: Number(unit.msrp_cents),
      url: unit.retail_source_url || "",
      confidence: unit.retail_source_url ? "likely" : "guess",
    });
  }
  return rows;
}

function retailFromLookup(lookup) {
  const rows = [];
  const m = lookup?.merged || lookup;
  if (!m) return rows;
  if (Number(m.retail_cents) > 0) {
    const asin = m.asin;
    rows.push({
      outlet: String(m.retail_source || "Amazon").includes("amazon") || asin ? "Amazon" : String(m.retail_source || "Catalog"),
      price_cents: Number(m.retail_cents),
      url: asin ? `https://www.amazon.com/dp/${asin}` : "",
      confidence: "exact",
    });
  }
  if (Number(m.msrp_cents) > 0 && !rows.some((r) => r.price_cents === Number(m.msrp_cents))) {
    rows.push({
      outlet: "List/MSRP",
      price_cents: Number(m.msrp_cents),
      url: m.asin ? `https://www.amazon.com/dp/${m.asin}` : "",
      confidence: "likely",
    });
  }
  // UPCitemdb merchant offers (Walmart, etc.) when present on raw source
  const offers = lookup?.upcitemdb?.offers || lookup?.upcitemdb?.raw_offers || [];
  for (const offer of offers) {
    const cents = Math.round(Number(offer.price) * 100);
    const merchant = String(offer.merchant || offer.domain || "").trim();
    if (!(cents > 0) || !merchant) continue;
    const name = /amazon/i.test(merchant)
      ? "Amazon"
      : /walmart/i.test(merchant)
        ? "Walmart"
        : /best.?buy/i.test(merchant)
          ? "Best Buy"
          : /home.?depot/i.test(merchant)
            ? "Home Depot"
            : /lowe'?s/i.test(merchant)
              ? "Lowe's"
              : /target/i.test(merchant)
                ? "Target"
                : null;
    if (!name) continue;
    if (rows.some((r) => r.outlet === name && r.price_cents === cents)) continue;
    rows.push({
      outlet: name,
      price_cents: cents,
      url: offer.link || offer.url || "",
      confidence: "likely",
    });
  }
  return rows;
}

function priceFlags(ebayCents, retailRows) {
  if (!retailRows.length || !(ebayCents > 0)) {
    return { pct_of_high_retail: null, flag: retailRows.length ? "" : "no_retail_match" };
  }
  const prices = retailRows.map((r) => r.price_cents).filter((n) => n > 0);
  const high = Math.max(...prices);
  const low = Math.min(...prices);
  const pct = Math.round((ebayCents / high) * 1000) / 10;
  let flag = "";
  if (ebayCents > high) flag = "OVER_RETAIL";
  else if (pct <= 35) flag = "SUSPICIOUSLY_LOW";
  else if (pct <= 50) flag = "LOW_VS_RETAIL";
  return { pct_of_high_retail: pct, high_retail_cents: high, low_retail_cents: low, flag };
}

function csvEscape(value) {
  const s = value == null ? "" : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function rowsToCsv(rows) {
  const headers = [
    "ebay_item_id",
    "ebay_url",
    "floor_sku",
    "floor_match",
    "product_name",
    "brand",
    "model",
    "upc",
    "ebay_price_cents",
    "ebay_price",
    "shipping_mode",
    "shipping_profile",
    "shipping_display",
    "shippo_estimate_cents",
    "shippo_estimate",
    "shippo_detail",
    "local_pickup",
    "package_dims",
    "dims_missing",
    "retail_outlets",
    "retail_high_cents",
    "retail_high",
    "retail_low_cents",
    "retail_low",
    "retail_links",
    "match_confidence",
    "pct_of_high_retail",
    "price_flag",
    "unit_state",
    "floor_ask_cents",
    "notes",
  ];
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

export function buildSummaryText({ account, liveCount, rows, mismatches, startedAt, finishedAt, notes }) {
  const listedValue = rows.reduce((n, r) => n + (Number(r.ebay_price_cents) || 0), 0);
  const noRetail = rows.filter((r) => r.price_flag === "no_retail_match" || !r.retail_high_cents);
  const missingDims = rows.filter((r) => r.dims_missing === "yes" || r.dims_missing === true);
  const over = rows.filter((r) => r.price_flag === "OVER_RETAIL");
  const low = rows.filter((r) => r.price_flag === "SUSPICIOUSLY_LOW" || r.price_flag === "LOW_VS_RETAIL");
  const noFloor = rows.filter((r) => r.floor_match === "ebay_only");
  const lines = [
    `eBay listing audit — ${account} ONLY (pgg124-5 ignored)`,
    `Started:  ${startedAt}`,
    `Finished: ${finishedAt}`,
    "",
    `Live ACTIVE listings:     ${liveCount}`,
    `Total listed value:       ${MONEY(listedValue)}`,
    `No retail match:          ${noRetail.length}`,
    `Missing package dims:     ${missingDims.length}`,
    `Over retail:              ${over.length}`,
    `Low / suspiciously low:   ${low.length}`,
    `eBay live, no Floor unit: ${noFloor.length}`,
    `Floor listed, not live:   ${mismatches.floor_not_live.length}`,
    "",
    "--- OVER RETAIL ---",
  ];
  for (const r of over.slice(0, 50)) {
    lines.push(
      `${r.floor_sku || "?"} | ${r.ebay_item_id} | ${r.ebay_price} vs high ${r.retail_high} (${r.pct_of_high_retail}%) | ${r.product_name}`,
    );
  }
  if (!over.length) lines.push("(none)");
  lines.push("", "--- SUSPICIOUSLY / LOW VS RETAIL ---");
  for (const r of low.slice(0, 80)) {
    lines.push(
      `${r.price_flag} | ${r.floor_sku || "?"} | ${r.ebay_item_id} | ${r.ebay_price} vs high ${r.retail_high} (${r.pct_of_high_retail}%) | ${r.product_name}`,
    );
  }
  if (!low.length) lines.push("(none)");
  lines.push("", "--- eBay LIVE WITH NO FLOOR MATCH ---");
  for (const r of noFloor.slice(0, 80)) {
    lines.push(`${r.ebay_item_id} | ${r.ebay_price} | ${r.product_name}`);
  }
  if (!noFloor.length) lines.push("(none)");
  lines.push("", "--- FLOOR MARKED LISTED ON ikonikdeals2026 BUT NOT LIVE ---");
  for (const r of mismatches.floor_not_live.slice(0, 80)) {
    lines.push(`${r.sku} | listing_id=${r.listing_id || ""} | ${r.title || ""}`);
  }
  if (!mismatches.floor_not_live.length) lines.push("(none)");
  if (notes?.length) {
    lines.push("", "--- NOTES / TRIP-UPS ---");
    for (const n of notes) lines.push(`- ${n}`);
  }
  lines.push("");
  return lines.join("\n");
}

async function setSetting(sb, storeId, key, value) {
  const { error } = await sb.from("store_settings").upsert(
    { store_id: storeId, key, value },
    { onConflict: "store_id,key" },
  );
  if (error) throw new Error(error.message);
}

async function getSetting(sb, storeId, key) {
  const { data, error } = await sb
    .from("store_settings")
    .select("value")
    .eq("store_id", storeId)
    .eq("key", key)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data?.value ?? null;
}

/**
 * Queue audit via store_settings so ebay-migrate-dispatch can start the
 * background worker without an agent-held Netlify/eBay secret.
 */
export async function queueEbayListingAudit(storeId = STORE_DEFAULT, { requestedBy = "queue" } = {}) {
  const sb = serviceClient();
  const value = {
    status: "queued",
    requested_at: new Date().toISOString(),
    requested_by: requestedBy,
    account: SELLING_USERNAME,
  };
  await setSetting(sb, storeId, AUDIT_REQUEST_KEY, value);
  return value;
}

export async function dispatchQueuedEbayListingAudits() {
  const sb = serviceClient();
  const { data: rows, error } = await sb
    .from("store_settings")
    .select("store_id,value")
    .eq("key", AUDIT_REQUEST_KEY);
  if (error) throw new Error(error.message);
  const base = (process.env.URL || "https://inventoryobi.netlify.app").replace(/\/$/, "");
  const token = requireEnv("SUPABASE_SERVICE_ROLE");
  const results = [];
  for (const row of rows || []) {
    const val = row.value && typeof row.value === "object" ? row.value : {};
    if (val.status !== "queued") continue;
    const claimed = { ...val, status: "dispatched", dispatched_at: new Date().toISOString() };
    await setSetting(sb, row.store_id, AUDIT_REQUEST_KEY, claimed);
    try {
      const res = await fetch(`${base}/.netlify/functions/ebay-listing-audit-background`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ store_id: row.store_id, requested_by: val.requested_by || "dispatch" }),
      });
      const ok = res.ok || res.status === 202;
      await setSetting(sb, row.store_id, AUDIT_REQUEST_KEY, {
        ...claimed,
        status: ok ? "started" : "dispatch_failed",
        http_status: res.status,
        started_at: ok ? new Date().toISOString() : claimed.dispatched_at,
        error: ok ? null : (await res.text()).slice(0, 300),
      });
      results.push({ storeId: row.store_id, ok, status: res.status });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await setSetting(sb, row.store_id, AUDIT_REQUEST_KEY, {
        ...claimed,
        status: "dispatch_failed",
        error: message.slice(0, 300),
      });
      results.push({ storeId: row.store_id, ok: false, error: message });
    }
  }
  return results;
}

export async function runEbayListingAudit(storeId = STORE_DEFAULT, { onProgress } = {}) {
  const startedAt = new Date().toISOString();
  const notes = [];
  const sb = serviceClient();
  const progress = async (patch) => {
    if (onProgress) await onProgress(patch);
    const cur = (await getSetting(sb, storeId, AUDIT_REQUEST_KEY)) || {};
    await setSetting(sb, storeId, AUDIT_REQUEST_KEY, {
      ...cur,
      status: "running",
      ...patch,
      updated_at: new Date().toISOString(),
    });
  };

  await progress({ phase: "load_account", account: SELLING_USERNAME });
  const account = await loadEbayAccount(storeId, { username: SELLING_USERNAME });
  if (String(account.role) !== "selling") {
    notes.push(`Account ${SELLING_USERNAME} role is ${account.role} (expected selling).`);
  }
  const token = await userTokenForAccount(account);

  await progress({ phase: "pull_active_list" });
  let active = [];
  let sellerList = [];
  try {
    active = await getMyEbaySellingActive(token);
  } catch (err) {
    notes.push(`GetMyeBaySelling failed: ${String(err?.message || err).slice(0, 200)}`);
  }
  try {
    sellerList = await getSellerListActive(token);
  } catch (err) {
    notes.push(`GetSellerList failed: ${String(err?.message || err).slice(0, 200)}`);
  }
  const byId = new Map();
  for (const row of [...active, ...sellerList]) {
    if (row?.itemId) byId.set(String(row.itemId), row);
  }
  const live = [...byId.values()];
  await progress({ phase: "active_loaded", live_count: live.length, active_list: active.length, seller_list: sellerList.length });

  const floor = await loadFloorMaps(sb, storeId, account.id);
  await ensureUnitsForSkus(
    sb,
    storeId,
    floor.bySku,
    live.map((r) => r.sku).filter(Boolean),
  );

  const shipFrom =
    (await getSetting(sb, storeId, "ship_from")) || {
      name: "Open Box Industries",
      street1: "3121 Penryn Rd",
      street2: "Suite 320",
      city: "Penryn",
      state: "CA",
      zip: "95663",
      country: "US",
      phone: "+12799770722",
      email: "pgg124@gmail.com",
    };

  await progress({ phase: "enrich_items", total: live.length, done: 0 });
  let done = 0;
  // Keep concurrency low so Shippo live-rate calls do not 429 mid-audit.
  const enriched = await mapPool(live, 2, async (summary) => {
    let detail = null;
    try {
      detail = await getTradingItem(token, summary.itemId);
    } catch (err) {
      notes.push(`GetItem ${summary.itemId}: ${String(err?.message || err).slice(0, 120)}`);
    }
    const ship = shippingFromTradingItem(detail || {}, summary);

    const sku = String(detail?.sku || summary.sku || "").trim();
    const listingRow = floor.byListingId.get(String(summary.itemId)) || (sku ? floor.listedBySku.get(sku) : null);
    const unit = (sku && floor.bySku.get(sku)) || (listingRow && floor.bySku.get(String(listingRow.sku))) || null;
    const floorSku = unit?.sku || listingRow?.sku || sku || "";
    let floorMatch = "matched";
    if (!unit && !listingRow) floorMatch = "ebay_only";
    else if (!unit) floorMatch = "listing_row_no_unit";
    else if (!listingRow) floorMatch = "unit_no_listing_row";

    const pkg = packageDims(unit);
    let shippo = { status: "n/a", estimate_cents: null, detail: null };
    let shippingDisplay = "";
    if (ship.shipping_mode === "free") {
      shippingDisplay = "Free shipping";
      shippo = { status: "free", estimate_cents: 0, detail: "listing free shipping" };
    } else if (ship.shipping_mode === "flat" && ship.flat_shipping_cents != null) {
      shippingDisplay = `Flat ${MONEY(ship.flat_shipping_cents)}`;
      shippo = { status: "flat", estimate_cents: ship.flat_shipping_cents, detail: "listing flat rate" };
    } else if (ship.shipping_mode === "calculated" || /calculated/i.test(ship.shipping_profile || "")) {
      ship.shipping_mode = "calculated";
      // Pace Shippo: one quote every ~350ms per worker (2 workers ≈ ~6/sec max).
      await sleep(350);
      shippo = await quoteShippo(sb, storeId, shipFrom, pkg);
      if (shippo.status === "ok") shippingDisplay = `Calculated est. ${MONEY(shippo.estimate_cents)} (${MID_COUNTRY_ZIP})`;
      else if (shippo.status === "missing_dims") shippingDisplay = "Calculated — dims/weight missing in Floor (no estimate)";
      else shippingDisplay = `Calculated — ${shippo.status}${shippo.detail ? `: ${shippo.detail}` : ""}`;
    } else {
      shippingDisplay = ship.shipping_type || ship.shipping_profile || "unknown";
    }

    const retailRows = [...retailFromUnit(unit)];
    const upc = String(unit?.upc || "").replace(/\D/g, "");
    if (upc.length >= 12 && upc.length <= 14) {
      try {
        const looked = await lookupUpc(storeId, upc, { force: false });
        retailRows.push(...retailFromLookup(looked));
      } catch (err) {
        notes.push(`UPC ${upc} sku ${floorSku}: ${String(err?.message || err).slice(0, 100)}`);
      }
    }

    // Dedupe retail by outlet+price
    const retailDedup = [];
    const seenRetail = new Set();
    for (const r of retailRows) {
      const key = `${r.outlet}|${r.price_cents}`;
      if (seenRetail.has(key)) continue;
      seenRetail.add(key);
      retailDedup.push(r);
    }

    const ebayCents = dollarsToCents(detail?.price || summary.currentPrice || summary.price);
    const flags = priceFlags(ebayCents, retailDedup);
    const productName =
      unit?.ebay_title || unit?.title || detail?.title || summary.title || "";
    const conf =
      retailDedup.map((r) => r.confidence).sort((a, b) => {
        const rank = { exact: 0, likely: 1, guess: 2 };
        return (rank[a] ?? 9) - (rank[b] ?? 9);
      })[0] || (upc ? "exact" : retailDedup.length ? "likely" : "");

    done += 1;
    if (done % 10 === 0 || done === live.length) {
      await progress({ phase: "enrich_items", total: live.length, done });
    }

    return {
      ebay_item_id: String(summary.itemId),
      ebay_url: detail?.viewItemUrl || summary.viewItemUrl || `https://www.ebay.com/itm/${summary.itemId}`,
      floor_sku: floorSku,
      floor_match: floorMatch,
      product_name: productName,
      brand: unit?.brand || detail?.aspects?.Brand?.[0] || "",
      model: unit?.model || detail?.aspects?.Model?.[0] || "",
      upc: unit?.upc || "",
      ebay_price_cents: ebayCents,
      ebay_price: MONEY(ebayCents),
      shipping_mode: ship.shipping_mode,
      shipping_profile: ship.shipping_profile || "",
      shipping_display: shippingDisplay,
      shippo_estimate_cents: shippo.estimate_cents,
      shippo_estimate: MONEY(shippo.estimate_cents),
      shippo_detail: shippo.detail || shippo.status || "",
      local_pickup: ship.local_pickup ? "yes" : "no",
      package_dims: pkg.ready
        ? `${pkg.length_in}x${pkg.width_in}x${pkg.height_in} in / ${pkg.weight_lb} lb`
        : "",
      dims_missing: pkg.ready ? "no" : "yes",
      retail_outlets: retailDedup.map((r) => `${r.outlet} ${MONEY(r.price_cents)}`).join(" | "),
      retail_high_cents: flags.high_retail_cents ?? "",
      retail_high: MONEY(flags.high_retail_cents),
      retail_low_cents: flags.low_retail_cents ?? "",
      retail_low: MONEY(flags.low_retail_cents),
      retail_links: retailDedup.map((r) => r.url).filter(Boolean).join(" | "),
      match_confidence: conf,
      pct_of_high_retail: flags.pct_of_high_retail ?? "",
      price_flag: flags.flag || "",
      unit_state: unit?.state || "",
      floor_ask_cents: unit?.ask_cents ?? "",
      notes: "",
      _retail: retailDedup,
    };
  });

  const liveIds = new Set(live.map((r) => String(r.itemId)));
  const floorNotLive = floor.listed
    .filter((r) => r.listing_id && !liveIds.has(String(r.listing_id)))
    .map((r) => ({
      sku: r.sku,
      listing_id: r.listing_id,
      title: floor.bySku.get(String(r.sku))?.title || "",
    }));

  // Units tagged ebay with no live listing id on ikonik
  const taggedNotLive = floor.tagged
    .filter((u) => {
      const listing = floor.listedBySku.get(String(u.sku));
      if (!listing?.listing_id) return true;
      return !liveIds.has(String(listing.listing_id));
    })
    .map((u) => ({
      sku: u.sku,
      listing_id: floor.listedBySku.get(String(u.sku))?.listing_id || "",
      title: u.title || "",
    }));

  const mismatches = {
    floor_not_live: [...new Map([...floorNotLive, ...taggedNotLive].map((r) => [r.sku, r])).values()],
  };

  const rows = enriched.sort((a, b) => String(a.floor_sku).localeCompare(String(b.floor_sku)));
  const finishedAt = new Date().toISOString();
  notes.push(
    `Shippo quotes use mid-country ZIP ${MID_COUNTRY_ZIP} from ${shipFrom.street1}, ${shipFrom.city} ${shipFrom.zip}. Rate quotes only — no labels purchased.`,
  );
  notes.push("Retail comps: Amazon SP-API + UPCitemdb (+ Floor MSRP when stored). Major-outlet web fill may be incomplete when UPC/offers missing.");
  if (!shippoMode()) notes.push("SHIPPO_API_KEY missing in functions env — calculated shipping estimates skipped.");

  const csv = rowsToCsv(rows);
  const txt = buildSummaryText({
    account: SELLING_USERNAME,
    liveCount: live.length,
    rows,
    mismatches,
    startedAt,
    finishedAt,
    notes,
  });

  const summary = {
    account: SELLING_USERNAME,
    live_count: live.length,
    total_listed_value_cents: rows.reduce((n, r) => n + (Number(r.ebay_price_cents) || 0), 0),
    no_retail_match: rows.filter((r) => !r.retail_high_cents).length,
    missing_dims: rows.filter((r) => r.dims_missing === "yes").length,
    over_retail: rows.filter((r) => r.price_flag === "OVER_RETAIL").length,
    low_vs_retail: rows.filter((r) => r.price_flag === "SUSPICIOUSLY_LOW" || r.price_flag === "LOW_VS_RETAIL").length,
    ebay_only: rows.filter((r) => r.floor_match === "ebay_only").length,
    floor_not_live: mismatches.floor_not_live.length,
    started_at: startedAt,
    finished_at: finishedAt,
    mid_country_zip: MID_COUNTRY_ZIP,
    notes,
  };

  // Persist CSV + summary text (not the full in-memory row objects — keeps jsonb smaller).
  const result = {
    status: "done",
    summary,
    csv,
    txt,
    mismatches,
    row_count: rows.length,
  };
  await setSetting(sb, storeId, AUDIT_RESULT_KEY, result);
  await setSetting(sb, storeId, AUDIT_REQUEST_KEY, {
    status: "done",
    account: SELLING_USERNAME,
    finished_at: finishedAt,
    live_count: live.length,
    summary,
  });
  return result;
}
