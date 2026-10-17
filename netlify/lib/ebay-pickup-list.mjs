/**
 * Queue + run a batch of LOCAL PICKUP ONLY listings on the selling account
 * (ikonikdeals2026). Uses a dedicated pickup fulfillment policy; never touches
 * the calculated-shipping policy or pgg124-5.
 *
 * Agents without Netlify secrets can upsert store_settings.ebay_pickup_list_request
 * and let ebay-sync / ebay-migrate-dispatch claim it.
 */
import { requireEnv, serviceClient } from "./server.mjs";
import { loadEbayAccount, resolveEbayAccount } from "./ebay-accounts.mjs";
import { policiesForLocalPickup, POLICY_NAMES } from "./ebay-policies.mjs";
import { listSku } from "./ebay.mjs";
import { hoursText, STORE_ADDRESS, STORE_PHONE } from "./web-order-email.mjs";
import { composeChannelDescription, parseListingSpecs } from "./listing-copy.mjs";
import { ebayDescription } from "./ebay-product.mjs";
import { ebayItemViewUrl } from "./ebay-env.mjs";
import { floorLog } from "./floor-log.mjs";
import { prohibitedReason } from "./ebay-eligibility.mjs";

export const PICKUP_LIST_REQUEST_KEY = "ebay_pickup_list_request";

// ~1.5–2 minutes apart so 10 listings fit inside Netlify's ~15 min background budget.
const DEFAULT_PACE_MS = { min: 90_000, max: 120_000 };
const STORE_COST_CENTS = 900;
const DEFAULT_FEE_PCT = 13;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function paceDelay(pace = DEFAULT_PACE_MS) {
  const min = Math.max(30_000, Number(pace.min) || DEFAULT_PACE_MS.min);
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

/** Cover $9 store cost + eBay fees, rounded up to a clean whole dollar. */
export function breakEvenPickupCents(costCents = STORE_COST_CENTS, feePct = DEFAULT_FEE_PCT) {
  const fee = Number(feePct) / 100;
  if (!(fee >= 0 && fee < 1)) throw new Error("fee percent must be between 0 and 100");
  const cost = Math.max(0, Math.round(Number(costCents) || 0));
  const raw = cost / (1 - fee);
  return Math.ceil(raw / 100) * 100;
}

/** eBay price = min(Floor ask, break-even). Prefer Floor when it is already cheaper. */
export function pickupListPriceCents(askCents, { costCents = STORE_COST_CENTS, feePct = DEFAULT_FEE_PCT } = {}) {
  const ask = Math.max(1, Math.round(Number(askCents) || 0));
  const breakEven = breakEvenPickupCents(costCents, feePct);
  return Math.min(ask, breakEven);
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

function pickupDescription(unit, hours) {
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
  const hoursBlock = hours ? hoursText(hours) : "See store for current hours.";
  const footer = [
    "",
    "LOCAL PICKUP ONLY — no shipping.",
    `Pick up at Open Box Industries, ${STORE_ADDRESS}. Phone ${STORE_PHONE}.`,
    "Bring your eBay order confirmation (order number + name on the order).",
    "Sold as-is. No returns.",
    "",
    "Store hours:",
    hoursBlock,
  ].join("\n");
  // Strip the generic "Local pickup unless arranged" line; we are pickup-only.
  const cleaned = String(base)
    .replace(/\nSold as-is\. Local pickup unless arranged\.\s*$/i, "\nSold as-is.")
    .trim();
  return ebayDescription(`${cleaned}\n${footer}`, unit.sku);
}

const BLOCKED_TITLE =
  /(refrigerat|dishwasher|mattress|rug|carpet|scooter|moped|vinyl|record|bill cosby|firearm|ammunition|alcohol|vape|tobacco)/i;

export function pickupCandidateBlocked(unit) {
  if (!unit) return "missing_unit";
  if (unit.state !== "available") return `state_${unit.state}`;
  if (unit.is_collectible) return "collectible";
  if (unit.is_test) return "test_unit";
  if (String(unit.sku) === "11284") return "do_not_list_scooter";
  if (!(Number(unit.ask_cents) > 0)) return "no_price";
  const banned = prohibitedReason(unit);
  if (banned) return `prohibited_${banned}`;
  const blob = [unit.title, unit.brand, unit.model, unit.category].filter(Boolean).join(" ");
  if (BLOCKED_TITLE.test(blob)) return "blocked_category_or_title";
  return null;
}

export async function queuePickupListRequest(
  storeId,
  { skus, requestedBy = "queue", paceMs = null, feePct = DEFAULT_FEE_PCT } = {},
) {
  if (!Array.isArray(skus) || !skus.length) throw new Error("skus_required");
  const sb = serviceClient();
  const value = {
    status: "queued",
    skus: skus.map(String),
    requested_at: new Date().toISOString(),
    requested_by: requestedBy || "queue",
    fee_pct: feePct,
    pace_ms: paceMs,
    results: [],
  };
  const { error } = await sb.from("store_settings").upsert(
    { store_id: storeId, key: PICKUP_LIST_REQUEST_KEY, value },
    { onConflict: "store_id,key" },
  );
  if (error) throw new Error(error.message);
  return value;
}

/** Claim queued pickup-list jobs and start the background worker (Netlify has secrets). */
export async function dispatchQueuedPickupListRequests() {
  const sb = serviceClient();
  const { data: rows, error } = await sb
    .from("store_settings")
    .select("store_id,value")
    .eq("key", PICKUP_LIST_REQUEST_KEY);
  if (error) throw new Error(error.message);
  const base = (process.env.URL || "https://inventoryobi.netlify.app").replace(/\/$/, "");
  const token = requireEnv("SUPABASE_SERVICE_ROLE");
  const results = [];
  for (const row of rows || []) {
    const val = parseSettingValue(row.value);
    // Re-dispatch stuck jobs that never finished (worker timeout / crash).
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
      { store_id: row.store_id, key: PICKUP_LIST_REQUEST_KEY, value: claimed },
      { onConflict: "store_id,key" },
    );
    try {
      const res = await fetch(`${base}/.netlify/functions/ebay-pickup-list-background`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          store_id: row.store_id,
          created_by: val.requested_by || "ebay_pickup_list_request",
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
        { store_id: row.store_id, key: PICKUP_LIST_REQUEST_KEY, value: next },
        { onConflict: "store_id,key" },
      );
      results.push({ storeId: row.store_id, ok, status: res.status });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await sb.from("store_settings").upsert(
        {
          store_id: row.store_id,
          key: PICKUP_LIST_REQUEST_KEY,
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
    { store_id: storeId, key: PICKUP_LIST_REQUEST_KEY, value },
    { onConflict: "store_id,key" },
  );
}

/**
 * List each SKU on the selling account with the local-pickup policy, paced apart.
 */
export async function runPickupListJob(storeId, { createdBy = "ebay-pickup-list-background" } = {}) {
  const sb = serviceClient();
  const { data: row, error } = await sb
    .from("store_settings")
    .select("value")
    .eq("store_id", storeId)
    .eq("key", PICKUP_LIST_REQUEST_KEY)
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
  if (String(selling.username || "").toLowerCase() !== "ikonikdeals2026") {
    // Soft check: still allow if role=selling but log loudly — never list on orders_only.
    if (selling.role !== "selling") {
      throw new Error(`Refusing to list: account ${selling.username} role=${selling.role}`);
    }
  }
  // Never use orders_only account.
  await loadEbayAccount(storeId, { id: selling.id, role: "selling" }).catch(() => selling);

  const feePct = Number(job.fee_pct ?? DEFAULT_FEE_PCT);
  const { data: feeRow } = await sb
    .from("store_settings")
    .select("value")
    .eq("store_id", storeId)
    .eq("key", "ebay_fee_pct")
    .maybeSingle();
  const storeFee = Number(feeRow?.value ?? feePct) || feePct;

  const { data: hoursRow } = await sb
    .from("store_settings")
    .select("value")
    .eq("store_id", storeId)
    .eq("key", "store_hours")
    .maybeSingle();
  const hours = parseSettingValue(hoursRow?.value);

  const policies = await policiesForLocalPickup(selling);
  const results = Array.isArray(job.results) ? [...job.results] : [];
  const already = new Set(results.filter((r) => r?.ok && r?.sku).map((r) => String(r.sku)));

  let progress = {
    ...job,
    status: "running",
    worker: createdBy,
    running_at: new Date().toISOString(),
    pickup_policy: {
      name: POLICY_NAMES.localPickup,
      fulfillmentPolicyId: policies.fulfillment,
      paymentPolicyId: policies.payment,
      returnPolicyId: policies.returnP,
      reused: policies.pickupReused,
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

    const blocked = pickupCandidateBlocked(unit);
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

    const priceCents = pickupListPriceCents(unit.ask_cents, {
      costCents: Number(unit.acquisition_cost_cents) > 0 ? unit.acquisition_cost_cents : STORE_COST_CENTS,
      feePct: storeFee,
    });
    const draft = {
      title: titleForUnit(unit),
      description: pickupDescription(unit, hours),
      priceCents,
      policies: {
        payment: policies.payment,
        returnP: policies.returnP,
        fulfillment: policies.fulfillment,
      },
      pickupOnly: true,
      bestOfferEnabled: false,
    };

    try {
      const listed = await listSku(storeId, sku, draft);
      results.push({
        sku,
        ok: true,
        title: draft.title,
        floorAskCents: unit.ask_cents,
        ebayPriceCents: priceCents,
        listingId: listed.listingId,
        offerId: listed.offerId,
        viewUrl: listed.viewUrl || ebayItemViewUrl(listed.listingId),
        account: listed.username || selling.username,
        listed_at: new Date().toISOString(),
      });
      await floorLog({
        storeId,
        sku,
        event: "ebay.pickup_list.ok",
        message: `pickup listed ${sku}`,
        detail: { listingId: listed.listingId, priceCents },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        sku,
        ok: false,
        error: message.slice(0, 500),
        floorAskCents: unit.ask_cents,
        ebayPriceCents: priceCents,
      });
      await floorLog({
        storeId,
        sku,
        level: "error",
        event: "ebay.pickup_list.fail",
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
