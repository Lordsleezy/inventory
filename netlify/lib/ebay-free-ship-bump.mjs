/**
 * For ikonikdeals2026 ACTIVE listings whose Shippo estimate is ≤ $10:
 * raise eBay price by $10 and switch the listing to free shipping.
 *
 * Uses the prior ebay_listing_audit_result CSV for ship estimates.
 * Inventory API offer update when possible; Trading ReviseFixedPriceItem otherwise.
 */
import { serviceClient, requireEnv } from "./server.mjs";
import { loadEbayAccount, userTokenForAccount, ebayFetchAccount } from "./ebay-accounts.mjs";
import { marketplaceIdFromEnv } from "./ebay-env.mjs";
import { reviseFixedPricePriceAndShipping } from "./ebay-trading.mjs";

export const BUMP_REQUEST_KEY = "ebay_free_ship_bump_request";
export const BUMP_RESULT_KEY = "ebay_free_ship_bump_result";
export const REVERT_REQUEST_KEY = "ebay_free_ship_bump_revert_request";
export const REVERT_RESULT_KEY = "ebay_free_ship_bump_revert_result";
export const SELLING_USERNAME = "ikonikdeals2026";
export const STORE_DEFAULT = "5487ca47-6147-4fe8-bc6d-46b6472726ba";
export const SHIP_CUTOFF_CENTS = 1000;
export const PRICE_BUMP_CENTS = 1000;
export const FREE_POLICY_NAME = "OBI Free Shipping";

/** Toys, cards, vinyl, comics — not lunchboxes / household. */
export function isCollectible({ title = "", categoryName = "" } = {}) {
  const blob = `${title} ${categoryName}`.toLowerCase();
  if (
    /collectible|trading card|ccg\b|action figure|vinyl|comics?|graphic novel|star wars|pokemon|poke.?trivia|power ranger|gundam|hot wheels|transformers|indiana jones|indiani jones|panini|topps|bowman|\bscore\b|burger king|naboo|y.?wing|tie fighter|assault walker|assult walker|jedha|moroff|tusken|conlon|sporting news/.test(
      blob,
    )
  ) {
    return true;
  }
  return false;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function money(cents) {
  return Number.isFinite(cents) ? `$${(cents / 100).toFixed(2)}` : "";
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

function parseCsv(csvText) {
  const lines = String(csvText || "").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cols = splitCsvLine(line);
    const row = {};
    headers.forEach((h, i) => {
      row[h] = cols[i] ?? "";
    });
    return row;
  });
}

function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export function selectEligibleFromAuditRows(rows, { cutoffCents = SHIP_CUTOFF_CENTS } = {}) {
  const eligible = [];
  const skipped = [];
  for (const r of rows || []) {
    const sku = String(r.floor_sku || r.sku || "").trim();
    const itemId = String(r.ebay_item_id || r.item_id || "").trim();
    const mode = String(r.shipping_mode || "").toLowerCase();
    const shipCents = Number(r.shippo_estimate_cents);
    const ebayCents = Number(r.ebay_price_cents);
    const retailCents = Number(r.retail_high_cents);
    const display = String(r.shipping_display || "").toLowerCase();
    if (!sku || !itemId) {
      skipped.push({ sku, itemId, reason: "missing_sku_or_item" });
      continue;
    }
    if (mode === "free" || display.startsWith("free")) {
      skipped.push({ sku, itemId, reason: "already_free", ship_cents: shipCents || 0 });
      continue;
    }
    if (r.dims_missing === "yes" || r.dims_missing === true) {
      skipped.push({ sku, itemId, reason: "missing_dims" });
      continue;
    }
    if (!Number.isFinite(shipCents) || shipCents < 0) {
      skipped.push({ sku, itemId, reason: "no_ship_estimate" });
      continue;
    }
    if (shipCents > cutoffCents) {
      skipped.push({ sku, itemId, reason: "ship_over_cutoff", ship_cents: shipCents });
      continue;
    }
    if (!Number.isFinite(ebayCents) || ebayCents <= 0) {
      skipped.push({ sku, itemId, reason: "bad_ebay_price" });
      continue;
    }
    const newCents = ebayCents + PRICE_BUMP_CENTS;
    eligible.push({
      sku,
      item_id: itemId,
      title: r.product_name || r.title || "",
      ship_cents: shipCents,
      old_ebay_cents: ebayCents,
      new_ebay_cents: newCents,
      retail_high_cents: Number.isFinite(retailCents) && retailCents > 0 ? retailCents : null,
      over_retail_after: Number.isFinite(retailCents) && retailCents > 0 && newCents > retailCents,
    });
  }
  return { eligible, skipped };
}

function policyMode(policy) {
  const options = policy?.shippingOptions || [];
  const services = options.flatMap((opt) => opt?.shippingServices || []);
  const calculated = options.some((opt) => String(opt.costType || "").toUpperCase() === "CALCULATED");
  const free =
    services.some((svc) => svc.freeShipping) ||
    (services.length > 0 && services.every((svc) => Number(svc.shippingCost?.value || 0) === 0) && !calculated);
  if (calculated) return "calculated";
  if (free) return "free";
  return null;
}

function policyId(row, kind) {
  return row?.[`${kind}PolicyId`] || row?.policyId || row?.id || null;
}

async function ensureFreeShippingPolicy(account) {
  const market = marketplaceIdFromEnv();
  const json = await ebayFetchAccount(
    account,
    "GET",
    `/sell/account/v1/fulfillment_policy?marketplace_id=${market}`,
  );
  const rows = json?.fulfillmentPolicies || [];
  const named = rows.find((r) => String(r?.name || "").trim() === FREE_POLICY_NAME);
  const free = named || rows.find((r) => policyMode(r) === "free");
  if (free) {
    return {
      fulfillmentPolicyId: String(policyId(free, "fulfillment")),
      paymentPolicyId: account.payment_policy_id || null,
      returnPolicyId: account.return_policy_id || null,
      reused: true,
      name: free.name || FREE_POLICY_NAME,
    };
  }
  const body = {
    name: FREE_POLICY_NAME,
    marketplaceId: market,
    categoryTypes: [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES", default: true }],
    handlingTime: { value: 2, unit: "DAY" },
    localPickup: false,
    freightShipping: false,
    shippingOptions: [
      {
        optionType: "DOMESTIC",
        costType: "FLAT_RATE",
        shippingServices: [
          {
            sortOrder: 1,
            shippingCarrierCode: "USPS",
            shippingServiceCode: "USPSPriority",
            freeShipping: true,
            shippingCost: { value: "0.0", currency: "USD" },
            buyerResponsibleForShipping: false,
          },
        ],
      },
    ],
  };
  const created = await ebayFetchAccount(account, "POST", "/sell/account/v1/fulfillment_policy", body);
  return {
    fulfillmentPolicyId: String(created.fulfillmentPolicyId || created.id),
    paymentPolicyId: account.payment_policy_id || null,
    returnPolicyId: account.return_policy_id || null,
    reused: false,
    name: FREE_POLICY_NAME,
  };
}

function offerUpdateBody(existing, { priceDollars, fulfillmentPolicyId, paymentPolicyId, returnPolicyId }) {
  const listingPolicies = {
    ...(existing.listingPolicies || {}),
    fulfillmentPolicyId,
  };
  if (paymentPolicyId) listingPolicies.paymentPolicyId = paymentPolicyId;
  if (returnPolicyId) listingPolicies.returnPolicyId = returnPolicyId;
  return {
    sku: existing.sku,
    marketplaceId: existing.marketplaceId || marketplaceIdFromEnv(),
    format: existing.format || "FIXED_PRICE",
    availableQuantity: existing.availableQuantity ?? 1,
    categoryId: existing.categoryId,
    listingDescription: existing.listingDescription,
    listingPolicies,
    merchantLocationKey: existing.merchantLocationKey,
    listingDuration: existing.listingDuration || "GTC",
    pricingSummary: {
      price: { value: Number(priceDollars).toFixed(2), currency: "USD" },
    },
    ...(existing.storeCategoryNames ? { storeCategoryNames: existing.storeCategoryNames } : {}),
    ...(existing.bestOfferTerms ? { bestOfferTerms: existing.bestOfferTerms } : {}),
  };
}

async function updateViaInventory(account, { sku, newCents, policies }) {
  const market = marketplaceIdFromEnv();
  const listed = await ebayFetchAccount(
    account,
    "GET",
    `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${market}&limit=50`,
  );
  const offers = listed?.offers || [];
  const published = offers.find((o) => String(o.status || "").toUpperCase() === "PUBLISHED") || offers[0];
  if (!published?.offerId) return { ok: false, reason: "no_inventory_offer" };
  const full = await ebayFetchAccount(account, "GET", `/sell/inventory/v1/offer/${published.offerId}`);
  const body = offerUpdateBody(full, {
    priceDollars: newCents / 100,
    fulfillmentPolicyId: policies.fulfillmentPolicyId,
    paymentPolicyId: policies.paymentPolicyId || full.listingPolicies?.paymentPolicyId,
    returnPolicyId: policies.returnPolicyId || full.listingPolicies?.returnPolicyId,
  });
  await ebayFetchAccount(account, "PUT", `/sell/inventory/v1/offer/${published.offerId}`, body);
  return { ok: true, path: "inventory", offerId: published.offerId, listingId: published.listing?.listingId || published.listingId || null };
}

async function updateViaTrading(account, token, { itemId, newCents, policies }) {
  await reviseFixedPricePriceAndShipping(token, {
    itemId,
    price: newCents / 100,
    fulfillmentPolicyId: policies.fulfillmentPolicyId,
    paymentPolicyId: policies.paymentPolicyId,
    returnPolicyId: policies.returnPolicyId,
  });
  return { ok: true, path: "trading", listingId: itemId };
}

export async function queueFreeShipBump(storeId = STORE_DEFAULT, { requestedBy = "queue" } = {}) {
  const sb = serviceClient();
  const value = {
    status: "queued",
    requested_at: new Date().toISOString(),
    requested_by: requestedBy,
    account: SELLING_USERNAME,
    cutoff_cents: SHIP_CUTOFF_CENTS,
    bump_cents: PRICE_BUMP_CENTS,
  };
  await setSetting(sb, storeId, BUMP_REQUEST_KEY, value);
  return value;
}

async function dispatchQueuedByKey(requestKey, action) {
  const sb = serviceClient();
  const { data: rows, error } = await sb.from("store_settings").select("store_id,value").eq("key", requestKey);
  if (error) throw new Error(error.message);
  const base = (process.env.URL || "https://inventoryobi.netlify.app").replace(/\/$/, "");
  const token = requireEnv("SUPABASE_SERVICE_ROLE");
  const results = [];
  for (const row of rows || []) {
    const val = row.value && typeof row.value === "object" ? row.value : {};
    if (val.status !== "queued") continue;
    const claimed = { ...val, status: "dispatched", dispatched_at: new Date().toISOString() };
    await setSetting(sb, row.store_id, requestKey, claimed);
    try {
      const res = await fetch(`${base}/.netlify/functions/ebay-free-ship-bump-background`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          store_id: row.store_id,
          action,
          requested_by: val.requested_by || "dispatch",
        }),
      });
      const ok = res.ok || res.status === 202;
      await setSetting(sb, row.store_id, requestKey, {
        ...claimed,
        status: ok ? "started" : "dispatch_failed",
        http_status: res.status,
        started_at: ok ? new Date().toISOString() : claimed.dispatched_at,
        error: ok ? null : (await res.text()).slice(0, 300),
      });
      results.push({ storeId: row.store_id, ok, status: res.status, action });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await setSetting(sb, row.store_id, requestKey, {
        ...claimed,
        status: "dispatch_failed",
        error: message.slice(0, 300),
      });
      results.push({ storeId: row.store_id, ok: false, error: message, action });
    }
  }
  return results;
}

export async function dispatchQueuedFreeShipBumps() {
  const bumps = await dispatchQueuedByKey(BUMP_REQUEST_KEY, "bump");
  const reverts = await dispatchQueuedByKey(REVERT_REQUEST_KEY, "revert_collectibles");
  return { bumps, reverts };
}

export function selectCollectiblesToRevert(bumpRows, { categoryBySku = {} } = {}) {
  const out = [];
  for (const r of bumpRows || []) {
    if (String(r.ok || "").toLowerCase() !== "yes" && r.ok !== true) continue;
    const sku = String(r.sku || "").trim();
    const title = r.title || "";
    const categoryName = categoryBySku[sku] || r.category_name || r.category || "";
    if (!isCollectible({ title, categoryName })) continue;
    const oldCents = Number(r.old_ebay_cents);
    const newCents = Number(r.new_ebay_cents);
    const itemId = String(r.item_id || "").trim();
    if (!sku || !itemId || !Number.isFinite(oldCents) || oldCents <= 0) continue;
    out.push({
      sku,
      item_id: itemId,
      title: title || categoryName,
      restore_cents: oldCents,
      bumped_cents: Number.isFinite(newCents) ? newCents : oldCents + PRICE_BUMP_CENTS,
      prior_path: r.path || null,
    });
  }
  return out;
}

export async function runCollectibleBumpRevert(storeId = STORE_DEFAULT) {
  const startedAt = new Date().toISOString();
  const sb = serviceClient();
  const progress = async (patch) => {
    const cur = (await getSetting(sb, storeId, REVERT_REQUEST_KEY)) || {};
    await setSetting(sb, storeId, REVERT_REQUEST_KEY, {
      ...cur,
      status: "running",
      ...patch,
      updated_at: new Date().toISOString(),
    });
  };

  await progress({ phase: "load_bump_result" });
  const bump = await getSetting(sb, storeId, BUMP_RESULT_KEY);
  if (!bump?.csv) throw new Error("ebay_free_ship_bump_result missing — nothing to revert");
  const targets = selectCollectiblesToRevert(parseCsv(bump.csv));
  await progress({ phase: "targets", total: targets.length });

  const account = await loadEbayAccount(storeId, { username: SELLING_USERNAME });
  if (String(account.role) !== "selling") throw new Error("expected selling account ikonikdeals2026");
  const token = await userTokenForAccount(account);
  const calculatedId = account.fulfillment_policy_id;
  if (!calculatedId) throw new Error("selling account missing calculated fulfillment_policy_id");
  const policies = {
    fulfillmentPolicyId: String(calculatedId),
    paymentPolicyId: account.payment_policy_id || null,
    returnPolicyId: account.return_policy_id || null,
  };

  const results = [];
  let done = 0;
  for (const row of targets) {
    done += 1;
    if (done % 5 === 0 || done === targets.length) {
      await progress({ phase: "reverting", done, total: targets.length });
    }
    await sleep(350);
    try {
      let updated = null;
      let inventoryError = null;
      try {
        updated = await updateViaInventory(account, {
          sku: row.sku,
          newCents: row.restore_cents,
          policies,
        });
        if (!updated.ok) inventoryError = updated.reason || "no_inventory_offer";
      } catch (err) {
        inventoryError = String(err?.message || err).slice(0, 200);
        updated = { ok: false };
      }
      if (!updated?.ok) {
        updated = await updateViaTrading(account, token, {
          itemId: row.item_id,
          newCents: row.restore_cents,
          policies,
        });
        if (inventoryError) updated.via = `trading_after_${inventoryError}`;
      }
      await sb
        .from("ebay_drafts")
        .update({
          price_cents: row.restore_cents,
          shipping_mode: "calculated",
          updated_at: new Date().toISOString(),
        })
        .eq("store_id", storeId)
        .eq("sku", row.sku);
      results.push({ ...row, ok: true, path: updated.path, error: null });
    } catch (err) {
      results.push({
        ...row,
        ok: false,
        path: null,
        error: String(err?.message || err).slice(0, 400),
      });
    }
  }

  const okRows = results.filter((r) => r.ok);
  const failRows = results.filter((r) => !r.ok);
  const finishedAt = new Date().toISOString();
  const summary = {
    account: SELLING_USERNAME,
    started_at: startedAt,
    finished_at: finishedAt,
    targets: targets.length,
    reverted: okRows.length,
    failed: failRows.length,
    calculated_policy_id: policies.fulfillmentPolicyId,
  };
  const txt = [
    `Collectible free-ship bump REVERT — ${SELLING_USERNAME}`,
    `Started:  ${startedAt}`,
    `Finished: ${finishedAt}`,
    "",
    `Collectibles targeted: ${targets.length}`,
    `Reverted OK:           ${okRows.length}`,
    `Failed:                ${failRows.length}`,
    "",
    "Restored original eBay price and Calculated Shipping – Buyer Pays.",
    "",
    "--- FAILURES ---",
    ...(failRows.length ? failRows.map((r) => `${r.sku} | ${r.item_id} | ${r.error}`) : ["(none)"]),
    "",
  ].join("\n");

  const result = { status: "done", summary, txt, results, failures: failRows };
  await setSetting(sb, storeId, REVERT_RESULT_KEY, result);
  await setSetting(sb, storeId, REVERT_REQUEST_KEY, {
    status: "done",
    finished_at: finishedAt,
    summary,
  });
  return result;
}

export async function runFreeShipBump(storeId = STORE_DEFAULT) {
  const startedAt = new Date().toISOString();
  const sb = serviceClient();
  const progress = async (patch) => {
    const cur = (await getSetting(sb, storeId, BUMP_REQUEST_KEY)) || {};
    await setSetting(sb, storeId, BUMP_REQUEST_KEY, {
      ...cur,
      status: "running",
      ...patch,
      updated_at: new Date().toISOString(),
    });
  };

  await progress({ phase: "load_audit" });
  const audit = await getSetting(sb, storeId, "ebay_listing_audit_result");
  if (!audit?.csv) throw new Error("ebay_listing_audit_result missing — run the listing audit first");
  const { eligible, skipped } = selectEligibleFromAuditRows(parseCsv(audit.csv));
  await progress({ phase: "eligible", eligible: eligible.length, skipped: skipped.length });

  const account = await loadEbayAccount(storeId, { username: SELLING_USERNAME });
  if (String(account.role) !== "selling") throw new Error("expected selling account ikonikdeals2026");
  const token = await userTokenForAccount(account);
  const policies = await ensureFreeShippingPolicy(account);
  if (!policies.fulfillmentPolicyId) throw new Error("free shipping policy id missing");
  // Prefer account payment/return IDs; fall back already set above.
  if (!policies.paymentPolicyId || !policies.returnPolicyId) {
    // Try to read from ebay_policy_status / account again after reload
    const refreshed = await loadEbayAccount(storeId, { id: account.id });
    policies.paymentPolicyId = policies.paymentPolicyId || refreshed.payment_policy_id;
    policies.returnPolicyId = policies.returnPolicyId || refreshed.return_policy_id;
  }

  const results = [];
  let done = 0;
  for (const row of eligible) {
    done += 1;
    if (done % 5 === 0 || done === eligible.length) {
      await progress({ phase: "updating", done, total: eligible.length });
    }
    await sleep(350);
    try {
      let updated = null;
      let inventoryError = null;
      try {
        updated = await updateViaInventory(account, {
          sku: row.sku,
          newCents: row.new_ebay_cents,
          policies,
        });
        if (!updated.ok) inventoryError = updated.reason || "no_inventory_offer";
      } catch (err) {
        inventoryError = String(err?.message || err).slice(0, 200);
        updated = { ok: false };
      }
      if (!updated?.ok) {
        updated = await updateViaTrading(account, token, {
          itemId: row.item_id,
          newCents: row.new_ebay_cents,
          policies,
        });
        if (inventoryError) updated.via = `trading_after_${inventoryError}`;
      }
      // Keep ebay_drafts in sync when present
      await sb
        .from("ebay_drafts")
        .update({
          price_cents: row.new_ebay_cents,
          shipping_mode: "free",
          updated_at: new Date().toISOString(),
        })
        .eq("store_id", storeId)
        .eq("sku", row.sku);
      results.push({
        ...row,
        ok: true,
        path: updated.path,
        offer_id: updated.offerId || null,
        error: null,
      });
    } catch (err) {
      results.push({
        ...row,
        ok: false,
        path: null,
        error: String(err?.message || err).slice(0, 400),
      });
    }
  }

  const okRows = results.filter((r) => r.ok);
  const failRows = results.filter((r) => !r.ok);
  const overRetail = okRows.filter((r) => r.over_retail_after);
  const finishedAt = new Date().toISOString();
  const summary = {
    account: SELLING_USERNAME,
    started_at: startedAt,
    finished_at: finishedAt,
    eligible: eligible.length,
    updated: okRows.length,
    failed: failRows.length,
    skipped: skipped.length,
    over_retail_after: overRetail.length,
    free_policy_id: policies.fulfillmentPolicyId,
    free_policy_name: policies.name,
    free_policy_reused: policies.reused,
    cutoff_cents: SHIP_CUTOFF_CENTS,
    bump_cents: PRICE_BUMP_CENTS,
  };

  const csvHeaders = [
    "sku",
    "item_id",
    "title",
    "ship_cents",
    "old_ebay_cents",
    "new_ebay_cents",
    "retail_high_cents",
    "over_retail_after",
    "ok",
    "path",
    "error",
  ];
  const csvLines = [csvHeaders.join(",")];
  for (const r of results) {
    csvLines.push(
      [
        r.sku,
        r.item_id,
        `"${String(r.title || "").replace(/"/g, '""')}"`,
        r.ship_cents,
        r.old_ebay_cents,
        r.new_ebay_cents,
        r.retail_high_cents ?? "",
        r.over_retail_after ? "yes" : "no",
        r.ok ? "yes" : "no",
        r.path || "",
        `"${String(r.error || "").replace(/"/g, '""')}"`,
      ].join(","),
    );
  }

  const overLines = overRetail.map(
    (r) =>
      `${r.sku} | ${r.item_id} | was ${money(r.old_ebay_cents)} → now ${money(r.new_ebay_cents)} vs retail ${money(r.retail_high_cents)} | ${r.title}`,
  );
  const txt = [
    `Free-ship price bump — ${SELLING_USERNAME}`,
    `Started:  ${startedAt}`,
    `Finished: ${finishedAt}`,
    "",
    `Eligible (ship ≤ $10): ${eligible.length}`,
    `Updated OK:            ${okRows.length}`,
    `Failed:                ${failRows.length}`,
    `Skipped:               ${skipped.length}`,
    `Now over retail:       ${overRetail.length}`,
    "",
    "--- NOW OVER RETAIL (after +$10 + free ship) ---",
    ...(overLines.length ? overLines : ["(none)"]),
    "",
    "--- FAILURES ---",
    ...(failRows.length
      ? failRows.map((r) => `${r.sku} | ${r.item_id} | ${r.error}`)
      : ["(none)"]),
    "",
  ].join("\n");

  const result = {
    status: "done",
    summary,
    csv: `${csvLines.join("\n")}\n`,
    txt,
    over_retail: overRetail,
    failures: failRows,
    skipped_sample: skipped.slice(0, 40),
  };
  await setSetting(sb, storeId, BUMP_RESULT_KEY, result);
  await setSetting(sb, storeId, BUMP_REQUEST_KEY, {
    status: "done",
    finished_at: finishedAt,
    summary,
  });
  return result;
}
