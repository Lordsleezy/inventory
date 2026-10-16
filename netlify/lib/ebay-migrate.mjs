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
import { publicPhotoUrl } from "./ebay-photos.mjs";
import {
  describeMigrationPlan,
  emptyMigrationSummary,
  isVerificationHiddenListingError,
  itemFromActiveListSummary,
  migrationBannedReason,
  tallyMigrationSummary,
} from "./ebay-migrate-rules.mjs";

export {
  describeMigrationPlan,
  emptyMigrationSummary,
  isVerificationHiddenListingError,
  itemFromActiveListSummary,
  migrationBannedReason,
  tallyMigrationSummary,
};

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
    .select("sku,state,title,brand,model,category,ask_cents,condition,defect_notes,listed_on,test_status")
    .eq("store_id", storeId)
    .eq("sku", String(sku).trim())
    .maybeSingle();
  return data || null;
}

function normalizeAspects(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [name, value] of Object.entries(raw)) {
    if (Array.isArray(value)) {
      const vals = value.map((v) => String(v ?? "").trim()).filter(Boolean);
      if (vals.length) out[name] = vals;
    } else if (value != null && String(value).trim()) {
      out[name] = [String(value).trim()];
    }
  }
  return out;
}

async function floorPhotoUrls(storeId, sku) {
  if (!sku) return [];
  const sb = serviceClient();
  const { data } = await sb
    .from("photos")
    .select("path, is_primary")
    .eq("store_id", storeId)
    .eq("sku", String(sku).trim())
    .order("is_primary", { ascending: false });
  return (data || [])
    .map((row) => row.path)
    .filter((path) => path && !String(path).includes("/official-"))
    .slice(0, 12)
    .map((path) => publicPhotoUrl(path));
}

async function loadEbayDraft(storeId, sku) {
  if (!sku) return null;
  const sb = serviceClient();
  const { data } = await sb
    .from("ebay_drafts")
    .select(
      "sku,title,description,category_id,category_name,condition_id,condition_notes,aspects,price_cents,photo_paths",
    )
    .eq("store_id", storeId)
    .eq("sku", String(sku).trim())
    .maybeSingle();
  return data || null;
}

/** Floor unit + draft fields used for skip rules (prefer Floor/draft over a bogus eBay category). */
async function loadBanContext(storeId, sku) {
  const unit = await loadUnitBySku(storeId, sku);
  const draft = await loadEbayDraft(storeId, sku);
  if (!unit && !draft) return null;
  return {
    sku: unit?.sku || draft?.sku || sku,
    title: unit?.title || draft?.title || "",
    category: unit?.category && !/^uncategorized$/i.test(unit.category) ? unit.category : draft?.category_name || unit?.category || "",
    condition: unit?.condition || "",
    brand: unit?.brand || null,
    model: unit?.model || null,
    defect_notes: unit?.defect_notes || draft?.condition_notes || null,
  };
}

/**
 * When GetItem fails because pgg124-5 is under eBay verification, fill listing fields from
 * ActiveList + Floor (draft / photos / unit) so the listing can still move.
 */
export async function enrichVerificationHiddenItem(storeId, item) {
  const sku = String(item.sku || "").trim();
  const unit = await loadUnitBySku(storeId, sku);
  const draft = await loadEbayDraft(storeId, sku);
  const photos = await floorPhotoUrls(storeId, sku);
  const draftPhotos = Array.isArray(draft?.photo_paths)
    ? draft.photo_paths.filter(Boolean).slice(0, 12).map((path) =>
        String(path).startsWith("http") ? path : publicPhotoUrl(path),
      )
    : [];
  const imageUrls = item.imageUrls?.length
    ? item.imageUrls
    : photos.length
      ? photos
      : draftPhotos;
  const price =
    item.price && Number(item.price) > 0
      ? item.price
      : draft?.price_cents
        ? (draft.price_cents / 100).toFixed(2)
        : unit?.ask_cents
          ? (unit.ask_cents / 100).toFixed(2)
          : item.price;
  return {
    ...item,
    title: item.title || draft?.title || unit?.title || "",
    description: draft?.description || item.description || item.title || unit?.title || "",
    sku: sku || item.sku || "",
    categoryId: item.categoryId || draft?.category_id || "",
    categoryName: item.categoryName || draft?.category_name || unit?.category || "",
    conditionId: item.conditionId || draft?.condition_id || "3000",
    conditionDescription: item.conditionDescription || draft?.condition_notes || unit?.defect_notes || "",
    price,
    imageUrls,
    aspects: Object.keys(item.aspects || {}).length ? item.aspects : normalizeAspects(draft?.aspects),
    verificationHidden: true,
    floorMatched: Boolean(unit),
  };
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

/** Recompute summary from persisted item rows (fixes stuck runs left by sync timeouts). */
export async function recomputeMigrationRunSummary(runId) {
  const sb = serviceClient();
  const { data: items } = await sb
    .from("ebay_migration_items")
    .select("outcome")
    .eq("run_id", runId);
  const summary = tallyMigrationSummary(items || []);
  const { data: run } = await sb
    .from("ebay_migration_runs")
    .select("status")
    .eq("id", runId)
    .maybeSingle();
  const patch = {
    summary,
    updated_at: new Date().toISOString(),
  };
  if (run?.status === "running") {
    patch.status = "completed";
    patch.finished_at = new Date().toISOString();
    patch.error = "Run finalized from item rows (worker did not finish writing summary).";
  }
  await sb.from("ebay_migration_runs").update(patch).eq("id", runId);
  return summary;
}

async function finalizeStuckRuns(storeId) {
  const sb = serviceClient();
  const { data: stuck } = await sb
    .from("ebay_migration_runs")
    .select("id,summary,status")
    .eq("store_id", storeId)
    .eq("status", "running");
  for (const run of stuck || []) {
    const summary = run.summary && typeof run.summary === "object" ? run.summary : {};
    const hasCounts =
      Number(summary.total || 0) > 0 ||
      Number(summary.will_move || 0) +
        Number(summary.skipped || 0) +
        Number(summary.failed || 0) +
        Number(summary.moved || 0) >
        0;
    if (!hasCounts) await recomputeMigrationRunSummary(run.id);
  }
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
      summary: emptyMigrationSummary(),
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
      summary: emptyMigrationSummary(),
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
      summary: emptyMigrationSummary(),
    };
  }

  await finalizeStuckRuns(storeId);

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

  try {
    const sourceToken = await userTokenForAccount(source);
    const summaries = await getMyEbaySellingActive(sourceToken);
    const openOrders = await openOrderItemIds(sourceToken);
    const capped = limit != null ? summaries.slice(0, Number(limit)) : summaries;

    for (const row of capped) {
      let item;
      let verificationHidden = false;
      try {
        item = await getTradingItem(sourceToken, row.itemId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isVerificationHiddenListingError(message)) {
          // Account under eBay verification — listing is hidden, not a real policy violation.
          // Treat as movable: use ActiveList + Floor enrichment, then end/create as normal.
          verificationHidden = true;
          item = await enrichVerificationHiddenItem(storeId, itemFromActiveListSummary(row));
        } else {
          const fail = {
            sourceItemId: row.itemId,
            sku: row.sku || null,
            title: row.title || null,
            priceCents: moneyToCents(row.currentPrice),
            outcome: "failed",
            reason: message,
            detail: { stage: "get_item" },
          };
          results.push(fail);
          await saveItem(run.id, storeId, fail);
          continue;
        }
      }

      const banUnit = await loadBanContext(storeId, item.sku || row.sku);
      const decision = classifyItem(item, { openOrders, unit: banUnit });
      const base = {
        sourceItemId: item.itemId,
        sku: item.sku || row.sku || banUnit?.sku || null,
        title: item.title || banUnit?.title || null,
        priceCents: moneyToCents(item.price),
        sourceUrl: ebayItemViewUrl(item.itemId),
        detail: {
          categoryId: item.categoryId,
          categoryName: item.categoryName,
          photoCount: item.imageUrls?.length || 0,
          bidCount: item.bidCount,
          bestOfferCount: item.bestOfferCount,
          quantitySold: item.quantitySold,
          floorMatched: Boolean(banUnit),
          verificationHidden: Boolean(verificationHidden || item.verificationHidden),
        },
      };

      if (decision.outcome === "skipped") {
        const skip = { ...base, outcome: "skipped", reason: decision.reason };
        results.push(skip);
        await saveItem(run.id, storeId, skip);
        continue;
      }

      if (mode === "dry_run") {
        const reason = verificationHidden
          ? `${decision.reason} (source listing hidden by account verification — will end on pgg124-5 and recreate on selling account)`
          : decision.reason;
        const planned = { ...base, outcome: "will_move", reason };
        results.push(planned);
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
          reason: verificationHidden
            ? "ended_on_source_created_on_dest (was verification-hidden)"
            : "ended_on_source_created_on_dest",
          destItemId,
          destUrl: ebayItemViewUrl(destItemId),
          detail: { ...base.detail, mapping, destStatus: live.listingStatus },
        };
        results.push(moved);
        await saveItem(run.id, storeId, moved);
      } catch (err) {
        const fail = {
          ...base,
          outcome: "failed",
          reason: err instanceof Error ? err.message : String(err),
          detail: { ...base.detail, stage: "end_or_create" },
        };
        results.push(fail);
        await saveItem(run.id, storeId, fail);
      }

      await sleep(paceDelay(pace));
    }

    const summary = tallyMigrationSummary(results);
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
    const summary = tallyMigrationSummary(results);
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
  const rows = items || [];
  const stored = run.summary && typeof run.summary === "object" ? run.summary : {};
  const storedTotal =
    Number(stored.total || 0) ||
    Number(stored.will_move || 0) +
      Number(stored.skipped || 0) +
      Number(stored.failed || 0) +
      Number(stored.moved || 0);
  if (run.status === "running" || storedTotal === 0) {
    const summary = await recomputeMigrationRunSummary(run.id);
    const { data: refreshed } = await sb.from("ebay_migration_runs").select("*").eq("id", run.id).maybeSingle();
    return { run: { ...(refreshed || run), summary }, items: rows };
  }
  if (Number(stored.total || 0) === 0 && rows.length) {
    const summary = tallyMigrationSummary(rows);
    return { run: { ...run, summary }, items: rows };
  }
  return { run, items: rows };
}

