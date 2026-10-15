/**
 * Move active eBay listings from an orders-only / personal seller account onto the store selling account.
 * Uses Trading API GetMyeBaySelling / GetItem / EndItem so Vendoo & Seller Hub listings are included.
 * Live mode: end on source → create on dest → confirm → update Floor. Never dual-live.
 */
import { serviceClient } from "./server.mjs";
import {
  listEbayAccounts,
  loadEbayAccount,
  userTokenForAccount,
  ebayFetchAccount,
} from "./ebay-accounts.mjs";
import { ensureBusinessPolicies } from "./ebay-policies.mjs";
import {
  addFixedPriceItem,
  endTradingItem,
  getMyEbaySellingActive,
  getSellerOrders,
  getTradingItem,
  tradingItemBlockedReason,
} from "./ebay-trading.mjs";
import { ebayItemViewUrl } from "./ebay-env.mjs";
import { describeMigrationPlan, migrationBannedReason } from "./ebay-migrate-rules.mjs";

export { describeMigrationPlan, migrationBannedReason };

const DEFAULT_PACE_MS = { min: 4000, max: 9000 };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function paceDelay(pace = DEFAULT_PACE_MS) {
  const min = Math.max(1000, Number(pace.min) || DEFAULT_PACE_MS.min);
  const max = Math.max(min, Number(pace.max) || DEFAULT_PACE_MS.max);
  return min + Math.floor(Math.random() * (max - min + 1));
}

function moneyToCents(value) {
  const n = Number(String(value || "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

async function openOrderItemIds(token) {
  const ids = new Set();
  try {
    const orders = await getSellerOrders(token, 30);
    for (const order of orders || []) {
      const cancel = String(order.cancelStatus || "").replace(/_/g, "").toLowerCase();
      if (/cancel/.test(cancel) && !/notapplicable|none/.test(cancel)) continue;
      const status = String(order.orderStatus || "").toLowerCase();
      if (/completed|cancelled|canceled|shipped/.test(status) && Number(order.amountPaid) <= 0) continue;
      // Any recent order with a purchased qty still ties the ItemID to fulfillment on source.
      if (order.itemId && Number(order.quantityPurchased) >= 1) {
        const paid =
          Number(order.amountPaid) > 0 ||
          Boolean(order.paidTime) ||
          /^complete$/i.test(String(order.checkoutStatus || ""));
        const active = /active|completed|inprocess|in_process|shipped/i.test(status) || paid;
        if (active) ids.add(String(order.itemId));
      }
    }
  } catch (err) {
    console.log("ebay_migrate_open_orders", err instanceof Error ? err.message : String(err));
  }
  return ids;
}

async function loadUnitBySku(storeId, sku) {
  if (!sku) return null;
  const sb = serviceClient();
  const { data } = await sb
    .from("units")
    .select("sku,state,title,brand,model,category,ask_cents,condition,defect_notes,listed_on")
    .eq("store_id", storeId)
    .eq("sku", String(sku).trim())
    .maybeSingle();
  return data || null;
}

export async function migrationPrerequisites(storeId) {
  const accounts = await listEbayAccounts(storeId);
  const selling = accounts.find((a) => a.role === "selling" && a.status === "connected") || null;
  const source =
    accounts.find((a) => a.role === "orders_only" && a.status === "connected") ||
    accounts.find((a) => a.status === "connected" && a.id !== selling?.id) ||
    null;
  const ready = Boolean(
    selling &&
      source &&
      selling.id !== source.id &&
      selling.policiesReady,
  );
  return {
    accounts,
    selling,
    source,
    ready,
    blockers: [
      !selling ? "Connect the business eBay account as the selling account." : null,
      selling && !selling.policiesReady
        ? "Create business policies on the selling account (Calculated shipping / No returns / Payment)."
        : null,
      !source ? "Keep pgg124-5 connected in orders-only mode as the migration source." : null,
      selling && source && selling.id === source.id
        ? "Source and destination must be different eBay accounts."
        : null,
    ].filter(Boolean),
  };
}

function classifyItem(item, { openOrders, unit }) {
  const blocked = tradingItemBlockedReason(item, { openOrderItemIds: openOrders });
  if (blocked) {
    return { outcome: "skipped", reason: blocked };
  }
  const banned = migrationBannedReason(item, unit);
  if (banned) {
    return { outcome: "skipped", reason: banned };
  }
  if (!item.imageUrls?.length) {
    return { outcome: "skipped", reason: "no_photos" };
  }
  if (!item.title || !item.categoryId || !(moneyToCents(item.price) > 0)) {
    return { outcome: "skipped", reason: "incomplete_listing_data" };
  }
  return {
    outcome: "will_move",
    reason: unit ? `Matched Floor SKU ${unit.sku}` : "No Floor SKU match — will still move listing",
  };
}

async function persistRun(storeId, { mode, sourceId, destId, createdBy, status = "running" }) {
  const sb = serviceClient();
  const { data, error } = await sb
    .from("ebay_migration_runs")
    .insert({
      store_id: storeId,
      mode,
      status,
      source_account_id: sourceId,
      dest_account_id: destId,
      started_at: new Date().toISOString(),
      created_by: createdBy || null,
      updated_at: new Date().toISOString(),
    })
    .select("*")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function saveItem(runId, storeId, row) {
  const sb = serviceClient();
  const { error } = await sb.from("ebay_migration_items").insert({
    run_id: runId,
    store_id: storeId,
    source_item_id: row.sourceItemId,
    sku: row.sku || null,
    title: row.title || null,
    price_cents: row.priceCents ?? null,
    outcome: row.outcome,
    reason: row.reason || null,
    dest_item_id: row.destItemId || null,
    detail: row.detail || {},
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
}

async function finishRun(runId, summary, status = "completed", error = null) {
  const sb = serviceClient();
  await sb
    .from("ebay_migration_runs")
    .update({
      status,
      summary,
      error,
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", runId);
}

async function createOnDestination(destAccount, item, policies) {
  // Prefer Trading AddFixedPriceItem with seller profiles so price/photos/description carry over as-is.
  const token = await userTokenForAccount(destAccount);
  const created = await addFixedPriceItem(token, {
    title: item.title,
    description: item.description || item.title,
    categoryId: item.categoryId,
    price: item.price,
    conditionId: item.conditionId || "3000",
    conditionDescription: item.conditionDescription,
    sku: item.sku || undefined,
    imageUrls: item.imageUrls,
    aspects: item.aspects,
    location: item.location,
    postalCode: item.postalCode || process.env.EBAY_LOCATION_POSTAL || "95663",
    city: item.location || "Penryn",
    dispatchTimeMax: item.dispatchTimeMax || 2,
    paymentPolicyId: policies.payment,
    returnPolicyId: policies.returnP,
    fulfillmentPolicyId: policies.fulfillment,
  });
  return created.listingId;
}

async function confirmDestLive(destAccount, listingId) {
  // Lightweight confirmation: GetItem on dest should return Active.
  const token = await userTokenForAccount(destAccount);
  const live = await getTradingItem(token, listingId);
  const status = String(live.listingStatus || "").toLowerCase();
  if (status && status !== "active") {
    throw new Error(`Destination listing ${listingId} status is ${live.listingStatus}, not Active`);
  }
  return live;
}

async function updateFloorMapping(storeId, { sku, sourceItemId, destItemId, destAccountId }) {
  if (!sku) return { updated: false, reason: "no_sku" };
  const sb = serviceClient();
  const { data: existing } = await sb
    .from("listings")
    .select("listing_id,offer_id,status")
    .eq("store_id", storeId)
    .eq("sku", sku)
    .eq("channel", "ebay")
    .maybeSingle();
  await sb.from("listings").upsert(
    {
      store_id: storeId,
      sku,
      channel: "ebay",
      status: "listed",
      listing_id: destItemId,
      offer_id: null,
      ebay_account_id: destAccountId,
      listed_at: new Date().toISOString(),
      delisted_at: null,
    },
    { onConflict: "store_id,sku,channel" },
  );
  const { data: unit } = await sb
    .from("units")
    .select("listed_on")
    .eq("store_id", storeId)
    .eq("sku", sku)
    .maybeSingle();
  if (unit) {
    const listed = new Set([...(unit.listed_on || []), "ebay"]);
    await sb.from("units").update({ listed_on: [...listed] }).eq("store_id", storeId).eq("sku", sku);
  }
  return {
    updated: true,
    previousListingId: existing?.listing_id || sourceItemId,
  };
}

/**
 * @param {'dry_run'|'live'} mode
 */
export async function runEbayMigration(storeId, { mode = "dry_run", createdBy = null, pace = DEFAULT_PACE_MS, limit = null } = {}) {
  if (mode !== "dry_run" && mode !== "live") throw new Error("mode must be dry_run or live");
  const pre = await migrationPrerequisites(storeId);
  if (mode === "live" && !pre.ready) {
    return {
      ok: false,
      mode,
      ready: false,
      blockers: pre.blockers,
      accounts: pre.accounts,
      items: [],
      summary: { moved: 0, skipped: 0, failed: 0, will_move: 0 },
    };
  }
  if (!pre.source && !pre.selling) {
    return {
      ok: false,
      mode,
      ready: false,
      blockers: pre.blockers.length
        ? pre.blockers
        : ["Connect at least the source (pgg124-5) account to preview listings."],
      accounts: pre.accounts,
      items: [],
      summary: { moved: 0, skipped: 0, failed: 0, will_move: 0 },
      note:
        "Dry-run without accounts: connect the business selling account + keep pgg124-5 as orders-only, create policies, then re-run dry-run to see every ItemID.",
    };
  }
  if (!pre.source) {
    return {
      ok: false,
      mode,
      ready: false,
      blockers: pre.blockers,
      accounts: pre.accounts,
      items: [],
      summary: { moved: 0, skipped: 0, failed: 0, will_move: 0 },
    };
  }

  const source = await loadEbayAccount(storeId, { id: pre.source.id });
  let dest = null;
  let policies = null;
  if (pre.selling) {
    dest = await loadEbayAccount(storeId, { id: pre.selling.id });
    if (dest.payment_policy_id && dest.return_policy_id && dest.fulfillment_policy_id) {
      policies = {
        payment: dest.payment_policy_id,
        returnP: dest.return_policy_id,
        fulfillment: dest.fulfillment_policy_id,
      };
    } else if (mode === "live") {
      policies = await ensureBusinessPolicies(dest);
      dest = await loadEbayAccount(storeId, { id: dest.id });
    }
  }

  const run = await persistRun(storeId, {
    mode,
    sourceId: source.id,
    destId: dest?.id || null,
    createdBy,
  });

  const results = [];
  const summary = { moved: 0, skipped: 0, failed: 0, will_move: 0, total: 0 };

  try {
    const sourceToken = await userTokenForAccount(source);
    const summaries = await getMyEbaySellingActive(sourceToken);
    const openOrders = await openOrderItemIds(sourceToken);
    const capped = limit != null ? summaries.slice(0, Number(limit)) : summaries;
    summary.total = capped.length;

    for (const row of capped) {
      let item;
      try {
        item = await getTradingItem(sourceToken, row.itemId);
      } catch (err) {
        const fail = {
          sourceItemId: row.itemId,
          sku: row.sku || null,
          title: row.title || null,
          priceCents: moneyToCents(row.currentPrice),
          outcome: "failed",
          reason: err instanceof Error ? err.message : String(err),
          detail: { stage: "get_item" },
        };
        results.push(fail);
        summary.failed += 1;
        await saveItem(run.id, storeId, fail);
        continue;
      }

      const unit = await loadUnitBySku(storeId, item.sku || row.sku);
      const decision = classifyItem(item, { openOrders, unit });
      const base = {
        sourceItemId: item.itemId,
        sku: item.sku || row.sku || unit?.sku || null,
        title: item.title,
        priceCents: moneyToCents(item.price),
        sourceUrl: ebayItemViewUrl(item.itemId),
        detail: {
          categoryId: item.categoryId,
          categoryName: item.categoryName,
          photoCount: item.imageUrls?.length || 0,
          bidCount: item.bidCount,
          bestOfferCount: item.bestOfferCount,
          quantitySold: item.quantitySold,
          floorMatched: Boolean(unit),
        },
      };

      if (decision.outcome === "skipped") {
        const skip = { ...base, outcome: "skipped", reason: decision.reason };
        results.push(skip);
        summary.skipped += 1;
        await saveItem(run.id, storeId, skip);
        continue;
      }

      if (mode === "dry_run") {
        const planned = { ...base, outcome: "will_move", reason: decision.reason };
        results.push(planned);
        summary.will_move += 1;
        await saveItem(run.id, storeId, planned);
        continue;
      }

      // LIVE: end on source first so the item is never dual-live.
      try {
        if (!policies || !dest) throw new Error("Destination selling account / policies missing");
        await endTradingItem(sourceToken, item.itemId, "NotAvailable");
        // Brief pause so eBay search/index settles before create.
        await sleep(1500 + Math.floor(Math.random() * 1500));
        const destItemId = await createOnDestination(dest, item, policies);
        const live = await confirmDestLive(dest, destItemId);
        const mapping = await updateFloorMapping(storeId, {
          sku: base.sku,
          sourceItemId: item.itemId,
          destItemId,
          destAccountId: dest.id,
        });
        const moved = {
          ...base,
          outcome: "moved",
          reason: "ended_on_source_created_on_dest",
          destItemId,
          destUrl: ebayItemViewUrl(destItemId),
          detail: { ...base.detail, mapping, destStatus: live.listingStatus },
        };
        results.push(moved);
        summary.moved += 1;
        await saveItem(run.id, storeId, moved);
      } catch (err) {
        const fail = {
          ...base,
          outcome: "failed",
          reason: err instanceof Error ? err.message : String(err),
          detail: { ...base.detail, stage: "end_or_create" },
        };
        results.push(fail);
        summary.failed += 1;
        await saveItem(run.id, storeId, fail);
      }

      await sleep(paceDelay(pace));
    }

    await finishRun(run.id, summary, "completed");
    return {
      ok: true,
      mode,
      ready: pre.ready,
      blockers: pre.blockers,
      runId: run.id,
      source: { id: source.id, username: source.username },
      destination: dest ? { id: dest.id, username: dest.username } : null,
      summary,
      items: results,
      accounts: pre.accounts,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishRun(run.id, summary, "failed", message);
    return {
      ok: false,
      mode,
      ready: pre.ready,
      blockers: pre.blockers,
      runId: run.id,
      error: message,
      summary,
      items: results,
      accounts: pre.accounts,
    };
  }
}

export async function latestMigrationRun(storeId) {
  const sb = serviceClient();
  const { data: run } = await sb
    .from("ebay_migration_runs")
    .select("*")
    .eq("store_id", storeId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!run) return null;
  const { data: items } = await sb
    .from("ebay_migration_items")
    .select("source_item_id,sku,title,price_cents,outcome,reason,dest_item_id,detail,created_at")
    .eq("run_id", run.id)
    .order("created_at", { ascending: true });
  return { run, items: items || [] };
}

