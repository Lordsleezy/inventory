/**
 * List marketplace-board "ready" units that are not yet on eBay.
 *
 * Rules (user):
 *   - ask < $100 → buyer pays calculated shipping
 *   - +10% floor hike when the hiked ask stays ≤ known retail; update Floor ask
 *   - open-box items clearly advertised as UNUSED
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
import { summarizeMarket } from "./ebay-market.mjs";
import {
  listingMeasures,
  refreshCategoryAspects,
  refreshCategoryConditions,
  resolveFloorCategory,
  suggestCategories,
} from "./ebay-catalog.mjs";
import { fillAspects } from "./ebay-aspects.mjs";
import { listingConditionPayload } from "./ebay-conditions.mjs";

export const READY_LIST_REQUEST_KEY = "ebay_ready_list_request";
export const READY_LIST_RESULT_KEY = "ebay_ready_list_result";
export const STORE_DEFAULT = "5487ca47-6147-4fe8-bc6d-46b6472726ba";
export const SELLING_USERNAME = "ikonikdeals2026";
export const FEE_PCT = 10;
export const PRICE_ENDING = 99;
/** Ask under this amount → calculated / buyer-pays shipping. */
export const BUYER_PAYS_UNDER_CENTS = 10000;

export const OPEN_BOX_UNUSED_NOTE =
  "OPEN BOX — UNUSED. Packaging may show shelf wear; the item itself is unused. Real seller photos on this listing.";

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

export function isOpenBox(unit) {
  const blob = [unit?.condition, unit?.title, unit?.ebay_title, unit?.defect_notes].filter(Boolean).join(" ");
  return /open\s*[- ]?\s*box/i.test(blob);
}

/** Floor ask after +pct (default 10%). Plain round — eBay .99 ending is applied later on list price. */
export function hikeAskCents(askCents, pct = 10) {
  const ask = Math.max(1, Math.round(Number(askCents) || 0));
  return Math.round(ask * (1 + Number(pct) / 100));
}

/**
 * Apply +10% only when retail is known and hiked ask ≤ retail.
 * Returns { ask_cents, hiked, retail_cents }.
 */
export function planFloorHike({ askCents, retailCents, pct = 10 } = {}) {
  const ask = Math.max(1, Math.round(Number(askCents) || 0));
  const retail = Number(retailCents);
  const hiked = hikeAskCents(ask, pct);
  if (!Number.isFinite(retail) || retail <= 0) {
    return { ask_cents: ask, hiked: false, retail_cents: null, hiked_would_be_cents: hiked };
  }
  if (hiked <= retail) {
    return { ask_cents: hiked, hiked: true, retail_cents: retail, hiked_would_be_cents: hiked };
  }
  return { ask_cents: ask, hiked: false, retail_cents: retail, hiked_would_be_cents: hiked };
}

/**
 * Shipping + eBay price after Floor ask is final.
 * Under $100 → always calculated. At/over $100 → free unless free would exceed retail.
 */
export function readyListPricePlan({
  floorCents,
  labelCents,
  retailCents,
  feePct = FEE_PCT,
  ending = PRICE_ENDING,
  buyerPaysUnderCents = BUYER_PAYS_UNDER_CENTS,
} = {}) {
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
  const hasRetail = Number.isFinite(retail) && retail > 0;
  const capAtRetail = (cents) => (hasRetail ? Math.min(cents, Math.round(retail)) : cents);
  const underCutoff = floor < Number(buyerPaysUnderCents);
  if (underCutoff) {
    return {
      mode: "calculated",
      price_cents: capAtRetail(calculated),
      free_would_be_cents: free,
      retail_cents: hasRetail ? retail : null,
      under_100: true,
      over_retail_if_free: hasRetail && free > retail,
      label_cents: label,
    };
  }
  if (hasRetail && free > retail) {
    return {
      mode: "calculated",
      price_cents: capAtRetail(calculated),
      free_would_be_cents: free,
      retail_cents: retail,
      under_100: false,
      over_retail_if_free: true,
      label_cents: label,
    };
  }
  return {
    mode: "free",
    price_cents: capAtRetail(free),
    free_would_be_cents: free,
    retail_cents: hasRetail ? retail : null,
    under_100: false,
    over_retail_if_free: false,
    label_cents: label,
  };
}

export function openBoxUnusedTitle(unit) {
  const skuBit = `SKU ${unit.sku}`;
  let base =
    (unit.ebay_title && String(unit.ebay_title).trim()) ||
    [unit.brand, unit.model].filter((p) => String(p || "").trim()).join(" ").trim() ||
    unit.title ||
    skuBit;
  base = String(base)
    .replace(/\s*[—|-]\s*Open\s*[- ]?\s*box\b/gi, "")
    .replace(/\bOpen\s*[- ]?\s*box\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!/\bunused\b/i.test(base)) base = `${base} — Open Box Unused`;
  else if (!/open\s*[- ]?\s*box/i.test(base)) base = `${base} — Open Box`;
  let title = /\bSKU\b/i.test(base) ? base : `${base} | ${skuBit}`;
  if (title.length > 80) title = `${title.slice(0, 77)}...`;
  return title;
}

function titleForUnit(unit) {
  if (isOpenBox(unit)) return openBoxUnusedTitle(unit);
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
  const open = isOpenBox(unit);
  const base = composeChannelDescription({
    listingBody: unit.listing_body,
    brand: unit.brand,
    model: unit.model,
    title: unit.title,
    specs: parseListingSpecs(unit.listing_specs),
    condition: open ? "Open box — unused" : unit.condition,
    testStatus: unit.test_status,
    defectNotes: open ? OPEN_BOX_UNUSED_NOTE : unit.defect_notes,
    sku: unit.sku,
  });
  const shipLine =
    mode === "free"
      ? "FREE shipping within the contiguous US."
      : "Buyer pays calculated shipping (carrier rates from package weight/size).";
  const unusedLead = open ? `${OPEN_BOX_UNUSED_NOTE}\n\n` : "";
  const cleaned = String(base)
    .replace(/\nSold as-is\. Local pickup unless arranged\.\s*$/i, "\nSold as-is.")
    .trim();
  return ebayDescription(`${unusedLead}${cleaned}\n\n${shipLine}\nSold as-is. No returns.`, unit.sku);
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

async function prepareListingMetaPreferNew(storeId, unit) {
  const floor = resolveFloorCategory(unit.category);
  let categoryId = floor?.ebayCategoryId || null;
  let categoryName = floor?.name || null;
  if (!categoryId) {
    const query = [unit.brand, unit.model, unit.title, unit.category].filter(Boolean).join(" ");
    const suggestions = await suggestCategories(query);
    const picked = suggestions[0] || null;
    if (!picked?.categoryId) throw new Error(`No eBay category suggestion for SKU ${unit.sku}`);
    categoryId = String(picked.categoryId);
    categoryName = picked.categoryName || null;
  }
  const defs = await refreshCategoryAspects(categoryId);
  const conditions = await refreshCategoryConditions(categoryId);
  const prefer =
    (conditions || []).find((row) => /open\s*box/i.test(row.name || "")) ||
    (conditions || []).find((row) => /new\s*other/i.test(row.name || "")) ||
    (conditions || []).find((row) => /factory sealed/i.test(row.name || "")) ||
    (conditions || []).find((row) => /^new\b/i.test(row.name || "") && !/other|open/i.test(row.name || "")) ||
    (conditions || [])[0];
  if (!prefer?.conditionId) throw new Error(`No usable eBay condition for ${categoryName || categoryId}`);
  const conditionPayload =
    listingConditionPayload({
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

export async function retailHighCents(sb, unit) {
  const msrp = Number(unit?.msrp_cents);
  if (Number.isFinite(msrp) && msrp > 0) return Math.round(msrp);
  const fromSources = summarizeMarket("retail", unit?.retail_price_sources);
  if (fromSources?.cents > 0) return Math.round(fromSources.cents);
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
  const high = Number(market?.high_cents || market?.retail_high_cents || market?.msrp_cents || market?.cents);
  if (Number.isFinite(high) && high > 0) return Math.round(high);
  return null;
}

/** Board-ready SKUs: available, not blocked on marketplace board cache, not listed on eBay. */
export async function readyNotListedSkus(storeId = STORE_DEFAULT) {
  const sb = serviceClient();
  const { data: setting, error } = await sb
    .from("store_settings")
    .select("value")
    .eq("store_id", storeId)
    .eq("key", "marketplace_board_catalog_ebay")
    .maybeSingle();
  if (error) throw new Error(error.message);
  const pack = parseSettingValue(setting?.value)?.pack || parseSettingValue(setting?.value);
  const notListed = Array.isArray(pack?.not_listed) ? pack.not_listed : [];
  const fromBoard = notListed
    .filter((row) => row && row.blocked !== true && String(row.blocked) !== "true")
    .map((row) => String(row.sku || "").trim())
    .filter(Boolean);

  const { data: listedRows, error: listErr } = await sb
    .from("listings")
    .select("sku")
    .eq("store_id", storeId)
    .eq("channel", "ebay")
    .eq("status", "listed");
  if (listErr) throw new Error(listErr.message);
  const listed = new Set((listedRows || []).map((r) => String(r.sku)));

  const { data: units, error: unitErr } = await sb
    .from("units")
    .select("sku,state,ask_cents")
    .eq("store_id", storeId)
    .eq("state", "available")
    .in("sku", fromBoard.length ? fromBoard : ["__none__"]);
  if (unitErr) throw new Error(unitErr.message);
  const available = new Set((units || []).filter((u) => Number(u.ask_cents) > 0).map((u) => String(u.sku)));

  return fromBoard.filter((sku) => available.has(sku) && !listed.has(sku));
}

export async function runReadyList(storeId = STORE_DEFAULT, { skus: explicitSkus = null, paceMs = DEFAULT_PACE_MS, dryRun = false } = {}) {
  const sb = serviceClient();
  requireEnv("SUPABASE_SERVICE_ROLE");
  const startedAt = new Date().toISOString();
  const skus = explicitSkus?.length ? explicitSkus.map(String) : await readyNotListedSkus(storeId);

  await setSetting(sb, storeId, READY_LIST_REQUEST_KEY, {
    status: dryRun ? "dry_run" : "running",
    skus,
    started_at: startedAt,
    requested_by: "ebay-ready-list",
  });

  const progress = async (detail) => {
    await setSetting(sb, storeId, READY_LIST_REQUEST_KEY, {
      status: dryRun ? "dry_run" : "running",
      skus,
      started_at: startedAt,
      requested_by: "ebay-ready-list",
      ...detail,
    });
  };

  let freePol;
  let calcPolId;
  let paymentId;
  let returnId;
  if (!dryRun) {
    const selling = await loadEbayAccount(storeId, { role: "selling" }).catch(async () => loadEbayAccount(storeId));
    if (String(selling?.username || "").toLowerCase() === "pgg124-5") {
      throw new Error("Refusing to list on the personal eBay account.");
    }
    freePol = await ensureFreeShippingPolicy(selling);
    const resolved = await resolveBusinessPolicies(storeId);
    calcPolId = resolved.fulfillmentCalculated;
    paymentId = resolved.payment;
    returnId = resolved.returnP;
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

    const retail = await retailHighCents(sb, unit);
    const hike = planFloorHike({ askCents: unit.ask_cents, retailCents: retail });
    let working = unit;
    if (hike.hiked && hike.ask_cents !== unit.ask_cents) {
      if (!dryRun) {
        const { error: priceErr } = await sb
          .from("units")
          .update({ ask_cents: hike.ask_cents, updated_at: new Date().toISOString() })
          .eq("store_id", storeId)
          .eq("sku", sku);
        if (priceErr) throw new Error(priceErr.message);
      }
      working = { ...unit, ask_cents: hike.ask_cents };
    }

    const box = boxOf(working);
    const quote = await quoteShipCents(sb, storeId, box);
    const plan = readyListPricePlan({
      floorCents: working.ask_cents,
      labelCents: quote.cents,
      retailCents: retail,
    });

    if (dryRun) {
      results.push({
        sku,
        ok: true,
        dry_run: true,
        title: titleForUnit(working),
        open_box_unused: isOpenBox(working),
        floor_was_cents: unit.ask_cents,
        floor_cents: working.ask_cents,
        hiked: hike.hiked,
        mode: plan.mode,
        price_cents: plan.price_cents,
        retail_cents: plan.retail_cents,
        label_cents: quote.cents,
      });
      continue;
    }

    let meta;
    try {
      meta = await preparePickupListingMeta(storeId, working);
    } catch (err) {
      const message = String(err?.message || err);
      try {
        meta = await prepareListingMetaPreferNew(storeId, working);
      } catch (err2) {
        results.push({
          sku,
          ok: false,
          error: `${message.slice(0, 180)} | retry: ${String(err2?.message || err2).slice(0, 180)}`,
          plan,
          quote,
          hiked: hike.hiked,
          floor_cents: working.ask_cents,
        });
        await sleep(paceMs);
        continue;
      }
    }

    const fulfillment = plan.mode === "free" ? freePol.fulfillmentPolicyId : calcPolId;
    if (!fulfillment || !paymentId || !returnId) {
      results.push({ sku, ok: false, error: "missing_business_policies", plan, hiked: hike.hiked });
      continue;
    }

    const draft = {
      title: titleForUnit(working),
      description: shipDescription(working, plan.mode),
      priceCents: plan.price_cents,
      policies: { payment: paymentId, returnP: returnId, fulfillment },
      categoryId: meta.categoryId,
      aspects: meta.aspects,
      conditionPayload: meta.conditionPayload,
      conditionNotes: isOpenBox(working) ? OPEN_BOX_UNUSED_NOTE : working.defect_notes || undefined,
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
        const retryMeta = await prepareListingMetaPreferNew(storeId, working);
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
        floor_was_cents: unit.ask_cents,
        floor_cents: working.ask_cents,
        hiked: hike.hiked,
        label_cents: quote.cents,
        label_source: quote.source,
        price_cents: plan.price_cents,
        retail_cents: plan.retail_cents,
        under_100: plan.under_100,
        open_box_unused: isOpenBox(working),
        listingId: listed.listingId,
        viewUrl: listed.viewUrl || ebayItemViewUrl(listed.listingId),
        forced_new: Boolean(meta?.forcedNew),
      });
      await floorLog({
        storeId,
        sku,
        event: "ebay.ready_list.ok",
        message: `listed ${sku} ${plan.mode} $${(plan.price_cents / 100).toFixed(2)}${hike.hiked ? " hiked" : ""}`,
        detail: { plan, quote, hike, listingId: listed.listingId },
      });
    } catch (err) {
      const message = String(err?.message || err).slice(0, 500);
      results.push({
        sku,
        ok: false,
        error: message,
        plan,
        quote,
        hiked: hike.hiked,
        floor_cents: working.ask_cents,
      });
      await floorLog({
        storeId,
        sku,
        level: "error",
        event: "ebay.ready_list.fail",
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
  const hikedN = okRows.filter((r) => r.hiked).length;
  const finishedAt = new Date().toISOString();
  const summary = {
    account: SELLING_USERNAME,
    started_at: startedAt,
    finished_at: finishedAt,
    targets: skus.length,
    listed: okRows.filter((r) => !r.dry_run).length,
    dry_run: okRows.filter((r) => r.dry_run).length,
    failed: failRows.length,
    skipped: skipped.length,
    free_ship: freeN,
    calculated_ship: calcN,
    floor_hiked: hikedN,
    fee_pct: FEE_PCT,
    dryRun,
  };
  const txt = [
    `Ready eBay list — ${SELLING_USERNAME}${dryRun ? " (DRY RUN)" : ""}`,
    `Started:  ${startedAt}`,
    `Finished: ${finishedAt}`,
    `Targets ${skus.length} | Listed ${summary.listed} (free ${freeN} / calculated ${calcN}) | Failed ${failRows.length} | Skipped ${skipped.length} | Floor hiked ${hikedN}`,
    `Under $${BUYER_PAYS_UNDER_CENTS / 100}: buyer pays shipping. +10% Floor when ≤ retail.`,
    "",
    "--- LISTED ---",
    ...okRows.map(
      (r) =>
        `${r.sku} | ${r.mode} | floor $${((r.floor_was_cents ?? r.floor_cents) / 100).toFixed(2)}${r.hiked ? `→$${(r.floor_cents / 100).toFixed(2)}` : ""} → eBay $${(r.price_cents / 100).toFixed(2)}${r.retail_cents ? ` (retail $${(r.retail_cents / 100).toFixed(2)})` : ""}${r.open_box_unused ? " [UNUSED open box]" : ""}${r.viewUrl ? ` | ${r.viewUrl}` : ""}`,
    ),
    "",
    "--- FAILURES ---",
    ...(failRows.length ? failRows.map((r) => `${r.sku} | ${r.error}`) : ["(none)"]),
    "",
  ].join("\n");

  const result = { status: "done", summary, txt, results };
  await setSetting(sb, storeId, READY_LIST_RESULT_KEY, result);
  await setSetting(sb, storeId, READY_LIST_REQUEST_KEY, { status: "done", finished_at: finishedAt, summary, dryRun });
  return result;
}
