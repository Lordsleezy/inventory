/**
 * List units that got their first Floor photo today on ikonikdeals2026.
 *
 * Pricing rule (per user):
 *   free ship price = (floor ask + ship label) grossed up for 10% eBay fees (.99 ending)
 *   if that free price would exceed known retail → buyer-pays calculated shipping instead
 *
 * Agents without secrets: upsert store_settings.ebay_photo_day_list_request {status:queued, skus:[...]}.
 */
import { requireEnv, serviceClient } from "./server.mjs";
import { loadEbayAccount } from "./ebay-accounts.mjs";
import { listSku } from "./ebay.mjs";
import { ebayDescription, ebayIdentifiers } from "./ebay-product.mjs";
import { ebayItemViewUrl } from "./ebay-env.mjs";
import { floorLog } from "./floor-log.mjs";
import { prohibitedReason } from "./ebay-eligibility.mjs";
import { composeChannelDescription, parseListingSpecs } from "./listing-copy.mjs";
import { ebayPriceCents, fallbackLabelCents, farZoneAddress } from "./ebay-price.mjs";
import { liveRates, addressTo, allowedCarriers } from "./shippo.mjs";
import { preparePickupListingMeta } from "./ebay-pickup-list.mjs";
import { ensureFreeShippingPolicy } from "./ebay-free-ship-bump.mjs";
import { resolveBusinessPolicies } from "./ebay-drafts.mjs";
import {
  listingMeasures,
  refreshCategoryAspects,
  refreshCategoryConditions,
  resolveFloorCategory,
  suggestCategories,
} from "./ebay-catalog.mjs";
import { fillAspects, pickCategorySuggestion } from "./ebay-aspects.mjs";
import { listingConditionPayload } from "./ebay-conditions.mjs";

export const PHOTO_DAY_REQUEST_KEY = "ebay_photo_day_list_request";
export const PHOTO_DAY_RESULT_KEY = "ebay_photo_day_list_result";
export const STORE_DEFAULT = "5487ca47-6147-4fe8-bc6d-46b6472726ba";
export const SELLING_USERNAME = "ikonikdeals2026";
export const FEE_PCT = 10;
export const PRICE_ENDING = 99;

const DEFAULT_PACE_MS = 1800;
const DEFAULT_BOX = { length_in: 12, width_in: 9, height_in: 4, weight_lb: 2 };

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseSettingValue(raw) {
  if (raw == null) return {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;
  return {};
}

async function setSetting(sb, storeId, key, value) {
  const { error } = await sb.from("store_settings").upsert({ store_id: storeId, key, value }, { onConflict: "store_id,key" });
  if (error) throw new Error(error.message);
}

async function getSetting(sb, storeId, key) {
  const { data, error } = await sb.from("store_settings").select("value").eq("store_id", storeId).eq("key", key).maybeSingle();
  if (error) throw new Error(error.message);
  return data?.value ?? null;
}

function titleForUnit(unit) {
  if (unit.ebay_title && String(unit.ebay_title).trim()) {
    let t = String(unit.ebay_title).trim();
    if (!/\bSKU\b/i.test(t)) t = `${t} | SKU ${unit.sku}`;
    return t.length > 80 ? `${t.slice(0, 77)}...` : t;
  }
  const name =
    [unit.brand, unit.model].filter((p) => String(p || "").trim()).join(" ").trim() ||
    unit.title ||
    `SKU ${unit.sku}`;
  const bits = [name, unit.condition].filter((p) => p && String(p).trim());
  let title = `${bits.join(" — ")} | SKU ${unit.sku}`;
  if (title.length > 80) title = `${title.slice(0, 77)}...`;
  return title;
}

function shipDescription(unit, mode) {
  const base = composeChannelDescription({
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
  const shipLine =
    mode === "free"
      ? "FREE shipping within the contiguous US."
      : "Buyer pays calculated shipping (carrier rates from package weight/size).";
  const cleaned = String(base)
    .replace(/\nSold as-is\. Local pickup unless arranged\.\s*$/i, "\nSold as-is.")
    .trim();
  return ebayDescription(`${cleaned}\n\n${shipLine}\nSold as-is. No returns.`, unit.sku);
}

function boxOf(unit) {
  const length_in = Number(unit?.package_length_in);
  const width_in = Number(unit?.package_width_in);
  const height_in = Number(unit?.package_height_in);
  const weight_lb = Number(unit?.package_weight_lb);
  const ok = length_in > 0 && width_in > 0 && height_in > 0 && weight_lb > 0;
  if (ok) return { length_in, width_in, height_in, weight_lb, assumed: false };
  return { ...DEFAULT_BOX, assumed: true };
}

function packagePayload(box) {
  return {
    dimensions: {
      length: String(box.length_in),
      width: String(box.width_in),
      height: String(box.height_in),
      unit: "INCH",
    },
    weight: { value: String(box.weight_lb), unit: "POUND" },
  };
}

/** Pure pricing decision used by tests + worker. */
export function photoDayPricePlan({ floorCents, labelCents, retailCents, feePct = FEE_PCT, ending = PRICE_ENDING } = {}) {
  const floor = Math.max(1, Math.round(Number(floorCents) || 0));
  const label = Math.max(0, Math.round(Number(labelCents) || 0));
  const free = ebayPriceCents({
    floorCents: floor,
    labelCents: label,
    bufferCents: 0,
    mode: "free",
    feePct,
    perOrderCents: 0,
    ending,
  });
  const calculated = ebayPriceCents({
    floorCents: floor,
    labelCents: label,
    bufferCents: 0,
    mode: "calculated",
    feePct,
    perOrderCents: 0,
    ending,
  });
  const retail = Number(retailCents);
  if (Number.isFinite(retail) && retail > 0 && free > retail) {
    return {
      mode: "calculated",
      price_cents: calculated,
      free_would_be_cents: free,
      retail_cents: retail,
      over_retail_if_free: true,
      label_cents: label,
    };
  }
  return {
    mode: "free",
    price_cents: free,
    free_would_be_cents: free,
    retail_cents: Number.isFinite(retail) && retail > 0 ? retail : null,
    over_retail_if_free: false,
    label_cents: label,
  };
}

export function pacificDayStartIso(now = new Date()) {
  const laNow = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const startLa = new Date(laNow.getFullYear(), laNow.getMonth(), laNow.getDate(), 0, 0, 0, 0);
  const diff = now.getTime() - laNow.getTime();
  return new Date(startLa.getTime() + diff).toISOString();
}

export async function skusFirstPhotoToday(storeId = STORE_DEFAULT) {
  const sb = serviceClient();
  const dayStart = pacificDayStartIso();
  const { data: todayPhotos, error: pErr } = await sb
    .from("photos")
    .select("sku")
    .eq("store_id", storeId)
    .gte("created_at", dayStart);
  if (pErr) throw new Error(pErr.message);
  const candidates = [...new Set((todayPhotos || []).map((r) => r.sku))];
  if (!candidates.length) return [];
  const { data: priorRows, error: priorErr } = await sb
    .from("photos")
    .select("sku")
    .eq("store_id", storeId)
    .in("sku", candidates)
    .lt("created_at", dayStart);
  if (priorErr) throw new Error(priorErr.message);
  const prior = new Set((priorRows || []).map((r) => r.sku));
  return candidates.filter((sku) => !prior.has(sku));
}

/** When Floor grade has no honest eBay match (blank / Excellent on sealed cats), prefer New. */
async function prepareListingMetaPreferNew(storeId, unit) {
  const floor = resolveFloorCategory(unit.category);
  let categoryId = floor?.ebayCategoryId || null;
  let categoryName = floor?.name || null;
  if (!categoryId) {
    const query = [unit.brand, unit.model, unit.title, unit.category].filter(Boolean).join(" ");
    const suggestions = await suggestCategories(query);
    const picked = pickCategorySuggestion(suggestions, [unit.brand, unit.model, unit.title, unit.category]);
    if (!picked?.categoryId) throw new Error(`No eBay category suggestion for SKU ${unit.sku}`);
    categoryId = String(picked.categoryId);
    categoryName = picked.categoryName || null;
  }
  const defs = await refreshCategoryAspects(categoryId);
  const conditions = await refreshCategoryConditions(categoryId);
  const prefer =
    (conditions || []).find((row) => /factory sealed/i.test(row.name || "")) ||
    (conditions || []).find((row) => /^new\b/i.test(row.name || "") && !/other|open/i.test(row.name || "")) ||
    (conditions || []).find((row) => /brand new/i.test(row.name || "")) ||
    (conditions || [])[0];
  if (!prefer?.conditionId) throw new Error(`No usable eBay condition for ${categoryName || categoryId}`);
  const conditionPayload = listingConditionPayload({
    conditionId: String(prefer.conditionId),
    conditionEnum: prefer.conditionEnum || prefer.enum || null,
    name: prefer.name,
  }) || { conditionId: String(prefer.conditionId) };

  const specs = listingMeasures(unit);
  const filled = fillAspects(defs, unit, specs, {
    categoryDefaults: floor?.defaults || {},
    standalone: floor?.standalone || false,
    categoryName,
    title: unit.title,
  });
  const aspects = {};
  for (const [name, value] of Object.entries(filled.aspects || {})) {
    const text = Array.isArray(value) ? value[0] : String(value || "");
    if (text) aspects[name] = [text];
  }
  for (const row of filled.filled || []) {
    if (row.required && !aspects[row.name]) aspects[row.name] = ["Does not apply"];
  }
  const ids = ebayIdentifiers(unit, aspects);
  if (!ids.validBrand) {
    const brand = String(unit.brand || unit.title || "Unbranded").trim().slice(0, 65) || "Unbranded";
    aspects.Brand = [brand];
  } else {
    aspects.Brand = [ids.brand];
  }
  aspects.MPN = [ids.mpn || "Does Not Apply"];

  return {
    categoryId: String(categoryId),
    categoryName,
    aspects,
    conditionPayload,
    floorSlug: floor?.slug || null,
    forcedNew: true,
  };
}

async function quoteShipCents(sb, storeId, box) {
  try {
    const live = await liveRates({
      shipFrom: {
        name: "Open Box Industries",
        street1: "3121 Penryn Rd",
        city: "Penryn",
        state: "CA",
        zip: "95663",
        country: "US",
        phone: "2799770722",
      },
      to: addressTo(farZoneAddress("10001")),
      pkg: {
        length_in: box.length_in,
        width_in: box.width_in,
        height_in: box.height_in,
        weight_lb: box.weight_lb,
      },
      carriers: await allowedCarriers(sb, storeId),
    });
    const cents = live.rates?.[0]?.amount_cents || live.all?.[0]?.amount_cents;
    if (cents > 0) return { cents, source: "shippo" };
  } catch {
    /* fallback */
  }
  const cents = fallbackLabelCents(box);
  return { cents: cents || 1200, source: cents ? "fallback" : "default" };
}

async function retailHighCents(sb, unit) {
  const upc = String(unit.upc || "").replace(/\D/g, "");
  if (upc.length >= 12) {
    const { data } = await sb.from("upc_lookup_cache").select("payload").eq("upc", upc).maybeSingle();
    const prices = [];
    const payload = data?.payload;
    const walk = (obj) => {
      if (!obj || typeof obj !== "object") return;
      if (Array.isArray(obj)) {
        obj.forEach(walk);
        return;
      }
      for (const [k, v] of Object.entries(obj)) {
        if (/price|msrp|list/i.test(k) && (typeof v === "number" || typeof v === "string")) {
          const n = Number(v);
          if (n > 1 && n < 100000) prices.push(n < 1000 ? Math.round(n * 100) : Math.round(n));
        } else if (v && typeof v === "object") walk(v);
      }
    };
    walk(payload);
    if (prices.length) return Math.max(...prices);
  }
  const specs = parseListingSpecs(unit.listing_specs);
  const market = specs?.market || specs?.retail || null;
  const high = Number(market?.high_cents || market?.retail_high_cents || market?.msrp_cents);
  if (Number.isFinite(high) && high > 0) return Math.round(high);
  return null;
}

export async function dispatchQueuedPhotoDayLists() {
  const sb = serviceClient();
  const { data: rows, error } = await sb.from("store_settings").select("store_id,value").eq("key", PHOTO_DAY_REQUEST_KEY);
  if (error) throw new Error(error.message);
  const base = (process.env.URL || "https://inventoryobi.netlify.app").replace(/\/$/, "");
  const token = requireEnv("SUPABASE_SERVICE_ROLE");
  const results = [];
  for (const row of rows || []) {
    const val = parseSettingValue(row.value);
    if (val.status !== "queued") continue;
    const claimed = { ...val, status: "dispatched", dispatched_at: new Date().toISOString() };
    await setSetting(sb, row.store_id, PHOTO_DAY_REQUEST_KEY, claimed);
    try {
      const res = await fetch(`${base}/.netlify/functions/ebay-photo-day-list-background`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ store_id: row.store_id }),
      });
      const ok = res.ok || res.status === 202;
      await setSetting(sb, row.store_id, PHOTO_DAY_REQUEST_KEY, {
        ...claimed,
        status: ok ? "started" : "dispatch_failed",
        http_status: res.status,
        error: ok ? null : (await res.text()).slice(0, 300),
      });
      results.push({ storeId: row.store_id, ok, status: res.status });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await setSetting(sb, row.store_id, PHOTO_DAY_REQUEST_KEY, {
        ...claimed,
        status: "dispatch_failed",
        error: message.slice(0, 300),
      });
      results.push({ storeId: row.store_id, ok: false, error: message });
    }
  }
  return results;
}

export async function runPhotoDayList(storeId = STORE_DEFAULT) {
  const startedAt = new Date().toISOString();
  const sb = serviceClient();
  const req = parseSettingValue(await getSetting(sb, storeId, PHOTO_DAY_REQUEST_KEY));
  let skus = Array.isArray(req.skus) ? req.skus.map(String) : [];
  if (!skus.length) skus = await skusFirstPhotoToday(storeId);
  if (!skus.length) throw new Error("No first-photo-today SKUs to list");

  const feePct = Number(req.fee_pct) > 0 ? Number(req.fee_pct) : FEE_PCT;
  const paceMs = Number(req.pace_ms) > 0 ? Number(req.pace_ms) : DEFAULT_PACE_MS;

  const progress = async (patch) => {
    const cur = parseSettingValue(await getSetting(sb, storeId, PHOTO_DAY_REQUEST_KEY)) || {};
    await setSetting(sb, storeId, PHOTO_DAY_REQUEST_KEY, {
      ...cur,
      status: "running",
      skus,
      fee_pct: feePct,
      ...patch,
      updated_at: new Date().toISOString(),
    });
  };
  await progress({ phase: "start", total: skus.length, done: 0 });

  const account = await loadEbayAccount(storeId, { username: SELLING_USERNAME });
  if (String(account.role) !== "selling") throw new Error("expected selling account");
  const freePol = await ensureFreeShippingPolicy(account);
  let calcPolId = account.fulfillment_policy_id;
  let paymentId = account.payment_policy_id || freePol.paymentPolicyId;
  let returnId = account.return_policy_id || freePol.returnPolicyId;
  try {
    const resolved = await resolveBusinessPolicies(storeId);
    calcPolId = resolved.fulfillmentCalculated || calcPolId;
    paymentId = resolved.payment || paymentId;
    returnId = resolved.returnP || returnId;
    if (resolved.fulfillmentFree) freePol.fulfillmentPolicyId = resolved.fulfillmentFree;
  } catch {
    /* use account + ensured free policy */
  }

  const results = [];
  let done = 0;
  for (const sku of skus) {
    done += 1;
    if (done % 3 === 0 || done === skus.length) await progress({ phase: "listing", done, total: skus.length });

    const { data: unit, error: unitErr } = await sb.from("units").select("*").eq("store_id", storeId).eq("sku", sku).maybeSingle();
    if (unitErr) throw new Error(unitErr.message);
    if (!unit) {
      results.push({ sku, ok: false, skipped: true, reason: "missing_unit" });
      continue;
    }
    if (unit.state !== "available") {
      results.push({ sku, ok: false, skipped: true, reason: `state_${unit.state}` });
      continue;
    }
    const banned = prohibitedReason(unit);
    if (banned) {
      results.push({ sku, ok: false, skipped: true, reason: `prohibited_${banned}` });
      continue;
    }
    if (!(Number(unit.ask_cents) > 0)) {
      results.push({ sku, ok: false, skipped: true, reason: "no_price" });
      continue;
    }

    const { data: live } = await sb
      .from("listings")
      .select("listing_id,status")
      .eq("store_id", storeId)
      .eq("sku", sku)
      .eq("channel", "ebay")
      .eq("status", "listed")
      .maybeSingle();
    if (live) {
      results.push({ sku, ok: false, skipped: true, reason: "already_listed", listingId: live.listing_id });
      continue;
    }

    const box = boxOf(unit);
    const quote = await quoteShipCents(sb, storeId, box);
    const retail = await retailHighCents(sb, unit);
    const plan = photoDayPricePlan({
      floorCents: unit.ask_cents,
      labelCents: quote.cents,
      retailCents: retail,
      feePct,
    });

    let meta;
    try {
      meta = await preparePickupListingMeta(storeId, unit);
    } catch (err) {
      const message = String(err?.message || err);
      try {
        meta = await prepareListingMetaPreferNew(storeId, unit);
      } catch (err2) {
        results.push({
          sku,
          ok: false,
          error: `${message.slice(0, 180)} | retry: ${String(err2?.message || err2).slice(0, 180)}`,
          plan,
          quote,
          dims_assumed: box.assumed,
        });
        await sleep(paceMs);
        continue;
      }
    }

    const fulfillment =
      plan.mode === "free" ? freePol.fulfillmentPolicyId : calcPolId;
    if (!fulfillment || !paymentId || !returnId) {
      results.push({ sku, ok: false, error: "missing_business_policies", plan });
      continue;
    }

    const draft = {
      title: titleForUnit(unit),
      description: shipDescription(unit, plan.mode),
      priceCents: plan.price_cents,
      policies: { payment: paymentId, returnP: returnId, fulfillment },
      categoryId: meta.categoryId,
      aspects: meta.aspects,
      conditionPayload: meta.conditionPayload,
      package: packagePayload(box),
      bestOfferEnabled: false,
    };

    const tryList = async (d) => listSku(storeId, sku, d);
    try {
      let listed;
      try {
        listed = await tryList(draft);
      } catch (err) {
        const message = String(err?.message || err);
        if (!/condition|Brand needed|25059/i.test(message)) throw err;
        const retryMeta = await prepareListingMetaPreferNew(storeId, unit);
        const retryDraft = {
          ...draft,
          categoryId: retryMeta.categoryId,
          aspects: retryMeta.aspects,
          conditionPayload: retryMeta.conditionPayload,
        };
        listed = await tryList(retryDraft);
        meta = retryMeta;
      }
      results.push({
        sku,
        ok: true,
        title: draft.title,
        mode: plan.mode,
        floor_cents: unit.ask_cents,
        label_cents: quote.cents,
        label_source: quote.source,
        price_cents: plan.price_cents,
        retail_cents: plan.retail_cents,
        over_retail_if_free: plan.over_retail_if_free,
        dims_assumed: box.assumed,
        listingId: listed.listingId,
        viewUrl: listed.viewUrl || ebayItemViewUrl(listed.listingId),
        forced_new: Boolean(meta?.forcedNew),
      });
      await floorLog({
        storeId,
        sku,
        event: "ebay.photo_day_list.ok",
        message: `listed ${sku} ${plan.mode} $${(plan.price_cents / 100).toFixed(2)}`,
        detail: { plan, quote, listingId: listed.listingId },
      });
    } catch (err) {
      const message = String(err?.message || err).slice(0, 500);
      results.push({
        sku,
        ok: false,
        error: message,
        plan,
        quote,
        dims_assumed: box.assumed,
      });
      await floorLog({
        storeId,
        sku,
        level: "error",
        event: "ebay.photo_day_list.fail",
        message,
      });
    }
    await sleep(paceMs);
  }

  const okRows = results.filter((r) => r.ok);
  const failRows = results.filter((r) => !r.ok && !r.skipped);
  const skipped = results.filter((r) => r.skipped);
  const freeN = okRows.filter((r) => r.mode === "free").length;
  const calcN = okRows.filter((r) => r.mode === "calculated").length;
  const finishedAt = new Date().toISOString();
  const summary = {
    account: SELLING_USERNAME,
    started_at: startedAt,
    finished_at: finishedAt,
    targets: skus.length,
    listed: okRows.length,
    failed: failRows.length,
    skipped: skipped.length,
    free_ship: freeN,
    calculated_ship: calcN,
    fee_pct: feePct,
  };
  const txt = [
    `Photo-day eBay list — ${SELLING_USERNAME}`,
    `Started:  ${startedAt}`,
    `Finished: ${finishedAt}`,
    `Targets ${skus.length} | Listed ${okRows.length} (free ${freeN} / calculated ${calcN}) | Failed ${failRows.length} | Skipped ${skipped.length}`,
    `Fee gross-up: ${feePct}%  | free = (ask + ship) / (1 - fee)`,
    "",
    "--- LISTED ---",
    ...okRows.map(
      (r) =>
        `${r.sku} | ${r.mode} | ask $${(r.floor_cents / 100).toFixed(2)} + ship $${(r.label_cents / 100).toFixed(2)} → $${(r.price_cents / 100).toFixed(2)}${r.retail_cents ? ` (retail $${(r.retail_cents / 100).toFixed(2)})` : ""}${r.dims_assumed ? " [dims assumed]" : ""} | ${r.viewUrl}`,
    ),
    "",
    "--- FAILURES ---",
    ...(failRows.length ? failRows.map((r) => `${r.sku} | ${r.error}`) : ["(none)"]),
    "",
  ].join("\n");

  const result = { status: "done", summary, txt, results };
  await setSetting(sb, storeId, PHOTO_DAY_RESULT_KEY, result);
  await setSetting(sb, storeId, PHOTO_DAY_REQUEST_KEY, { status: "done", finished_at: finishedAt, summary });
  return result;
}
