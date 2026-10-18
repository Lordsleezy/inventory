/**
 * Queue + run calculated-shipping listings on the selling account (ikonikdeals2026)
 * with local pickup also offered. Uses "OBI Calculated Shipping – Buyer Pays + Local Pickup"
 * (separate from pickup-only). Agents without Netlify secrets can upsert
 * store_settings.ebay_ship_list_request and let ebay-sync claim it.
 */
import { requireEnv, serviceClient } from "./server.mjs";
import { loadEbayAccount, resolveEbayAccount } from "./ebay-accounts.mjs";
import { policiesForCalculatedWithPickup, POLICY_NAMES } from "./ebay-policies.mjs";
import { listSku } from "./ebay.mjs";
import { composeChannelDescription, parseListingSpecs } from "./listing-copy.mjs";
import { ebayDescription, ebayIdentifiers } from "./ebay-product.mjs";
import { ebayItemViewUrl } from "./ebay-env.mjs";
import { floorLog } from "./floor-log.mjs";
import { prohibitedReason } from "./ebay-eligibility.mjs";
import { preparePickupListingMeta } from "./ebay-pickup-list.mjs";
import { clearanceCondition } from "./ebay-listing-standards.mjs";
import { listingConditionPayload, mapFloorCondition } from "./ebay-conditions.mjs";
import { refreshCategoryConditions } from "./ebay-catalog.mjs";

export const SHIP_LIST_REQUEST_KEY = "ebay_ship_list_request";

const DEFAULT_PACE_MS = { min: 60_000, max: 90_000 };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function paceDelay(pace = DEFAULT_PACE_MS) {
  const min = Math.max(15_000, Number(pace.min) || DEFAULT_PACE_MS.min);
  const max = Math.max(min, Number(pace.max) || DEFAULT_PACE_MS.max);
  return min + Math.floor(Math.random() * (max - min + 1));
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

function shipDescription(unit) {
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
  const cleaned = String(base)
    .replace(/\nSold as-is\. Local pickup unless arranged\.\s*$/i, "\nSold as-is. No returns. Local pickup available in Penryn, CA.")
    .trim();
  return ebayDescription(cleaned, unit.sku);
}

export function shipCandidateBlocked(unit) {
  if (!unit) return "missing_unit";
  if (unit.state !== "available") return `state_${unit.state}`;
  if (unit.is_test) return "test_unit";
  if (!(Number(unit.ask_cents) > 0)) return "no_price";
  const banned = prohibitedReason(unit);
  if (banned) return `prohibited_${banned}`;
  return null;
}

/**
 * Prefer Open box via clearanceCondition; fall back to Floor grade mapping.
 */
async function resolveShipCondition(categoryId, unit) {
  const conditions = await refreshCategoryConditions(categoryId);
  const preferred = clearanceCondition(conditions);
  if (preferred) {
    const payload = listingConditionPayload({
      conditionId: preferred.conditionId,
      name: preferred.name,
    });
    if (payload) {
      return {
        conditionPayload: payload,
        conditionName: preferred.name,
        conditionId: preferred.conditionId,
        conditionFallback: preferred.fallback,
        conditionReason: preferred.reason,
        allowed: conditions,
      };
    }
  }
  const mapped = mapFloorCondition(unit.condition, conditions);
  const payload = listingConditionPayload(mapped);
  if (!mapped || !payload) {
    const allowed = (conditions || []).map((row) => `${row.name} (${row.conditionId})`).join(", ") || "none";
    throw new Error(
      `eBay category ${categoryId} has no honest match for Floor grade “${unit.condition || "(blank)"}”. Allowed: ${allowed}.`,
    );
  }
  return {
    conditionPayload: payload,
    conditionName: mapped.name,
    conditionId: mapped.conditionId,
    conditionFallback: true,
    conditionReason: "floor_map",
    allowed: conditions,
  };
}

function packageFromJobOrUnit(job, unit) {
  const override = job?.package;
  if (override?.dimensions && override?.weight) {
    return {
      dimensions: {
        length: String(override.dimensions.length),
        width: String(override.dimensions.width),
        height: String(override.dimensions.height),
        unit: override.dimensions.unit || "INCH",
      },
      weight: {
        value: String(override.weight.value),
        unit: override.weight.unit || "POUND",
      },
    };
  }
  const L = Number(unit.package_length_in);
  const W = Number(unit.package_width_in);
  const H = Number(unit.package_height_in);
  const Wt = Number(unit.package_weight_lb);
  if (L > 0 && W > 0 && H > 0 && Wt > 0) {
    return {
      dimensions: { length: String(L), width: String(W), height: String(H), unit: "INCH" },
      weight: { value: String(Wt), unit: "POUND" },
    };
  }
  return null;
}

export async function queueShipListRequest(
  storeId,
  { skus, requestedBy = "queue", paceMs = null, imageUrlsBySku = null, package: pkg = null, note = null } = {},
) {
  if (!Array.isArray(skus) || !skus.length) throw new Error("skus_required");
  const sb = serviceClient();
  const value = {
    status: "queued",
    skus: skus.map(String),
    requested_at: new Date().toISOString(),
    requested_by: requestedBy || "queue",
    pace_ms: paceMs,
    results: [],
    ...(note ? { note } : {}),
    ...(imageUrlsBySku ? { image_urls_by_sku: imageUrlsBySku } : {}),
    ...(pkg ? { package: pkg } : {}),
  };
  const { error } = await sb.from("store_settings").upsert(
    { store_id: storeId, key: SHIP_LIST_REQUEST_KEY, value },
    { onConflict: "store_id,key" },
  );
  if (error) throw new Error(error.message);
  return value;
}

/** Claim queued ship-list jobs and start the background worker (Netlify has secrets). */
export async function dispatchQueuedShipListRequests() {
  const sb = serviceClient();
  const { data: rows, error } = await sb
    .from("store_settings")
    .select("store_id,value")
    .eq("key", SHIP_LIST_REQUEST_KEY);
  if (error) throw new Error(error.message);
  const base = (process.env.URL || "https://inventoryobi.netlify.app").replace(/\/$/, "");
  const token = requireEnv("SUPABASE_SERVICE_ROLE");
  const results = [];
  for (const row of rows || []) {
    const val = parseSettingValue(row.value);
    const staleMs = Date.now() - new Date(val.updated_at || val.started_at || val.dispatched_at || 0).getTime();
    const stuck =
      (val.status === "started" || val.status === "running" || val.status === "dispatched") &&
      Number.isFinite(staleMs) &&
      staleMs > 20 * 60 * 1000;
    if (val.status !== "queued" && !stuck) continue;
    const claimed = {
      ...val,
      status: "dispatched",
      dispatched_at: new Date().toISOString(),
    };
    await sb.from("store_settings").upsert(
      { store_id: row.store_id, key: SHIP_LIST_REQUEST_KEY, value: claimed },
      { onConflict: "store_id,key" },
    );
    try {
      const res = await fetch(`${base}/.netlify/functions/ebay-ship-list-background`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          store_id: row.store_id,
          created_by: val.requested_by || "ebay_ship_list_request",
        }),
      });
      const ok = res.ok || res.status === 202;
      const next = {
        ...claimed,
        status: ok ? "started" : "dispatch_failed",
        http_status: res.status,
        started_at: ok ? new Date().toISOString() : claimed.dispatched_at,
        error: ok ? null : (await res.text()).slice(0, 300),
      };
      await sb.from("store_settings").upsert(
        { store_id: row.store_id, key: SHIP_LIST_REQUEST_KEY, value: next },
        { onConflict: "store_id,key" },
      );
      results.push({ storeId: row.store_id, ok, status: res.status });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await sb.from("store_settings").upsert(
        {
          store_id: row.store_id,
          key: SHIP_LIST_REQUEST_KEY,
          value: { ...claimed, status: "dispatch_failed", error: message.slice(0, 300) },
        },
        { onConflict: "store_id,key" },
      );
      results.push({ storeId: row.store_id, ok: false, error: message });
    }
  }
  return results;
}

async function persistProgress(storeId, value) {
  const sb = serviceClient();
  await sb.from("store_settings").upsert(
    { store_id: storeId, key: SHIP_LIST_REQUEST_KEY, value },
    { onConflict: "store_id,key" },
  );
}

/**
 * List each SKU on the selling account with calculated shipping + local pickup.
 */
export async function runShipListJob(storeId, { createdBy = "ebay-ship-list-background" } = {}) {
  const sb = serviceClient();
  const { data: row, error } = await sb
    .from("store_settings")
    .select("value")
    .eq("store_id", storeId)
    .eq("key", SHIP_LIST_REQUEST_KEY)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const job = parseSettingValue(row?.value);
  const skus = Array.isArray(job.skus) ? job.skus.map(String) : [];
  if (!skus.length) {
    const done = { ...job, status: "done", error: "no_skus", finished_at: new Date().toISOString() };
    await persistProgress(storeId, done);
    return done;
  }

  const selling = await resolveEbayAccount(storeId, { role: "selling" });
  if (selling.role !== "selling") {
    throw new Error(`Refusing to list: account ${selling.username} role=${selling.role}`);
  }
  await loadEbayAccount(storeId, { id: selling.id, role: "selling" }).catch(() => selling);

  const policies = await policiesForCalculatedWithPickup(selling);
  const results = Array.isArray(job.results) ? [...job.results] : [];
  const already = new Set(results.filter((r) => r?.ok && r?.sku).map((r) => String(r.sku)));
  const imageMap = job.image_urls_by_sku && typeof job.image_urls_by_sku === "object" ? job.image_urls_by_sku : {};

  let progress = {
    ...job,
    status: "running",
    worker: createdBy,
    running_at: new Date().toISOString(),
    ship_policy: {
      name: POLICY_NAMES.calculatedWithPickup,
      fulfillmentPolicyId: policies.fulfillment,
      paymentPolicyId: policies.payment,
      returnPolicyId: policies.returnP,
      reused: policies.reused,
    },
    selling_username: selling.username,
    results,
  };
  await persistProgress(storeId, progress);

  const pace = job.pace_ms
    ? { min: Number(job.pace_ms), max: Number(job.pace_ms) }
    : DEFAULT_PACE_MS;

  for (let i = 0; i < skus.length; i++) {
    const sku = skus[i];
    if (already.has(sku)) continue;

    const { data: unit, error: unitErr } = await sb
      .from("units")
      .select("*")
      .eq("store_id", storeId)
      .eq("sku", sku)
      .maybeSingle();
    if (unitErr) throw new Error(unitErr.message);

    const blocked = shipCandidateBlocked(unit);
    if (blocked) {
      results.push({ sku, ok: false, skipped: true, reason: blocked });
      progress = { ...progress, results: [...results], updated_at: new Date().toISOString() };
      await persistProgress(storeId, progress);
      continue;
    }

    const { data: live } = await sb
      .from("listings")
      .select("status,listing_id")
      .eq("store_id", storeId)
      .eq("sku", sku)
      .eq("channel", "ebay")
      .eq("status", "listed")
      .maybeSingle();
    if (live) {
      results.push({
        sku,
        ok: false,
        skipped: true,
        reason: "already_listed",
        listingId: live.listing_id,
        viewUrl: ebayItemViewUrl(live.listing_id),
      });
      progress = { ...progress, results: [...results], updated_at: new Date().toISOString() };
      await persistProgress(storeId, progress);
      continue;
    }

    const pkg = packageFromJobOrUnit(job, unit);
    if (!pkg) {
      results.push({
        sku,
        ok: false,
        error: "package_dims_required_for_calculated_shipping",
        floorAskCents: unit.ask_cents,
      });
      progress = { ...progress, results: [...results], updated_at: new Date().toISOString() };
      await persistProgress(storeId, progress);
      continue;
    }

    const imageUrls = Array.isArray(imageMap[sku])
      ? imageMap[sku].map(String).filter(Boolean).slice(0, 12)
      : [];

    let meta;
    let conditionInfo;
    try {
      meta = await preparePickupListingMeta(storeId, unit);
      conditionInfo = await resolveShipCondition(meta.categoryId, unit);
      // Prefer clearance/open-box resolution over pickup meta's floor map.
      meta = { ...meta, conditionPayload: conditionInfo.conditionPayload };
      const ids = ebayIdentifiers(unit, meta.aspects);
      meta.aspects = { ...meta.aspects, Brand: [ids.brand], MPN: [ids.mpn] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        sku,
        ok: false,
        error: message.slice(0, 500),
        floorAskCents: unit.ask_cents,
        ebayPriceCents: unit.ask_cents,
      });
      progress = { ...progress, results: [...results], updated_at: new Date().toISOString() };
      await persistProgress(storeId, progress);
      if (i < skus.length - 1) await sleep(paceDelay(pace));
      continue;
    }

    const draft = {
      title: titleForUnit(unit),
      description: shipDescription(unit),
      priceCents: unit.ask_cents,
      policies: {
        payment: policies.payment,
        returnP: policies.returnP,
        fulfillment: policies.fulfillment,
      },
      pickupOnly: false,
      bestOfferEnabled: false,
      categoryId: meta.categoryId,
      aspects: meta.aspects,
      conditionPayload: meta.conditionPayload,
      conditionNotes: unit.defect_notes || undefined,
      package: pkg,
      ...(imageUrls.length ? { imageUrls } : {}),
    };

    try {
      const listed = await listSku(storeId, sku, draft);
      results.push({
        sku,
        ok: true,
        title: draft.title,
        floorAskCents: unit.ask_cents,
        ebayPriceCents: unit.ask_cents,
        listingId: listed.listingId,
        offerId: listed.offerId,
        viewUrl: listed.viewUrl || ebayItemViewUrl(listed.listingId),
        account: listed.username || selling.username,
        categoryId: meta.categoryId,
        categoryName: meta.categoryName,
        conditionId: conditionInfo.conditionId,
        conditionName: conditionInfo.conditionName,
        conditionFallback: conditionInfo.conditionFallback,
        conditionReason: conditionInfo.conditionReason,
        package: pkg,
        imageCount: imageUrls.length || null,
        listed_at: new Date().toISOString(),
      });
      await floorLog({
        storeId,
        sku,
        event: "ebay.ship_list.ok",
        message: `ship listed ${sku}`,
        detail: { listingId: listed.listingId, priceCents: unit.ask_cents, categoryId: meta.categoryId },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        sku,
        ok: false,
        error: message.slice(0, 500),
        floorAskCents: unit.ask_cents,
        ebayPriceCents: unit.ask_cents,
        categoryId: meta?.categoryId || null,
      });
      await floorLog({
        storeId,
        sku,
        level: "error",
        event: "ebay.ship_list.fail",
        message,
      });
    }

    progress = { ...progress, results: [...results], updated_at: new Date().toISOString() };
    await persistProgress(storeId, progress);

    if (i < skus.length - 1) {
      await sleep(paceDelay(pace));
    }
  }

  const finished = {
    ...progress,
    status: "done",
    finished_at: new Date().toISOString(),
    results,
    ok_count: results.filter((r) => r.ok).length,
    fail_count: results.filter((r) => !r.ok && !r.skipped).length,
    skip_count: results.filter((r) => r.skipped).length,
  };
  await persistProgress(storeId, finished);
  return finished;
}
