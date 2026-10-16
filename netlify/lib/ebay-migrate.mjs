/**
 * Move active eBay listings from an orders-only / personal seller account onto the store selling account.
 * Uses Trading API GetMyeBaySelling / GetItem / EndItem so Vendoo & Seller Hub listings are included.
 * Live mode: end on source → create on dest → confirm → update Floor. Never dual-live.
 */
import { requireEnv, serviceClient } from "./server.mjs";
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
  getSellerListActive,
  getSellerOrders,
  getTradingItem,
  tradingItemBlockedReason,
} from "./ebay-trading.mjs";
import { ebayItemViewUrl } from "./ebay-env.mjs";
import { publicPhotoUrl } from "./ebay-photos.mjs";
import { suggestCategories } from "./ebay-catalog.mjs";
import {
  clipMigrationTitle,
  describeMigrationPlan,
  emptyMigrationSummary,
  isEndAlreadyEndedError,
  isListingRemovedPolicyError,
  isSourceAlreadyEndedStatus,
  isVerificationHiddenListingError,
  itemFromActiveListSummary,
  MIGRATION_CREATE_BUILD,
  clampMigrationPackageDims,
  fillMissingAspects,
  migrationBannedReason,
  migrationConditionFallbacks,
  migrationConditionId,
  migrationPackageDims,
  migrationWeightLb,
  parseMissingAspectNames,
  replaceInvalidAspectValues,
  sanitizeMigrationAspects,
  tallyMigrationSummary,
} from "./ebay-migrate-rules.mjs";

export {
  clipMigrationTitle,
  describeMigrationPlan,
  emptyMigrationSummary,
  isEndAlreadyEndedError,
  isListingRemovedPolicyError,
  isSourceAlreadyEndedStatus,
  isVerificationHiddenListingError,
  itemFromActiveListSummary,
  MIGRATION_CREATE_BUILD,
  clampMigrationPackageDims,
  fillMissingAspects,
  migrationBannedReason,
  migrationConditionFallbacks,
  migrationConditionId,
  migrationPackageDims,
  migrationWeightLb,
  parseMissingAspectNames,
  replaceInvalidAspectValues,
  sanitizeMigrationAspects,
  tallyMigrationSummary,
};

// Live: ~250–300 listings must finish inside Netlify background (~15 min) → keep pace tight.
const DEFAULT_PACE_MS = { min: 2000, max: 4000 };

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
    .select(
      "sku,state,title,brand,model,category,ask_cents,condition,defect_notes,listed_on,test_status,package_length_in,package_width_in,package_height_in,package_weight_lb",
    )
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

/**
 * Floor eBay listing rows to migrate.
 * Includes `listed` on source/null account, plus `delisted` null-account rows that were
 * ended on source when create failed (stranded) so resume can recreate on dest.
 */
async function loadFloorEbayListingSummaries(storeId, { sourceAccountId = null, destAccountId = null } = {}) {
  const sb = serviceClient();
  const { data, error } = await sb
    .from("listings")
    .select("listing_id,sku,status,ebay_account_id")
    .eq("store_id", storeId)
    .eq("channel", "ebay")
    .in("status", ["listed", "delisted"]);
  if (error) throw new Error(error.message);
  const out = [];
  for (const row of data || []) {
    const itemId = String(row.listing_id || "").trim();
    if (!itemId) continue;
    // Skip rows already remapped onto the business selling account.
    if (destAccountId && row.ebay_account_id && String(row.ebay_account_id) === String(destAccountId)) continue;
    // Delisted rows only resume when they were never mapped to selling (stranded after EndItem).
    if (row.status === "delisted") {
      if (row.ebay_account_id && destAccountId && String(row.ebay_account_id) === String(destAccountId)) continue;
      if (row.ebay_account_id && sourceAccountId && String(row.ebay_account_id) !== String(sourceAccountId)) continue;
      // null account or source account delisted → include
    }
    if (
      sourceAccountId &&
      row.ebay_account_id &&
      String(row.ebay_account_id) !== String(sourceAccountId) &&
      destAccountId &&
      String(row.ebay_account_id) === String(destAccountId)
    ) {
      continue;
    }
    out.push({
      itemId,
      title: "",
      sku: row.sku || "",
      currentPrice: "",
      quantity: 1,
      quantitySold: 0,
      bidCount: 0,
      listingType: "FixedPriceItem",
      listingStatus: row.status === "delisted" ? "Completed" : "Active",
      categoryId: "",
      categoryName: "",
      imageUrls: [],
      viewItemUrl: "",
      fromFloor: true,
      strandedResume: row.status === "delisted",
    });
  }
  return out;
}

/** SKUs that failed live create and are not yet on the selling account. */
async function loadStrandedFailedMigrationSummaries(storeId, destAccountId = null) {
  const sb = serviceClient();
  const { data: failed, error } = await sb
    .from("ebay_migration_items")
    .select("sku,source_item_id,title,price_cents,created_at")
    .eq("store_id", storeId)
    .eq("outcome", "failed")
    .not("sku", "is", null)
    .order("created_at", { ascending: false })
    .limit(2000);
  if (error) throw new Error(error.message);
  const bySku = new Map();
  for (const row of failed || []) {
    const sku = String(row.sku || "").trim();
    if (!sku || bySku.has(sku)) continue;
    bySku.set(sku, row);
  }
  if (!bySku.size) return [];
  const skus = [...bySku.keys()];
  const { data: listings } = await sb
    .from("listings")
    .select("sku,listing_id,status,ebay_account_id")
    .eq("store_id", storeId)
    .eq("channel", "ebay")
    .in("sku", skus);
  const listingBySku = new Map((listings || []).map((r) => [String(r.sku), r]));
  const out = [];
  for (const [sku, row] of bySku) {
    const listing = listingBySku.get(sku);
    if (destAccountId && listing?.ebay_account_id && String(listing.ebay_account_id) === String(destAccountId) && listing.status === "listed") {
      continue; // already moved
    }
    const itemId = String(listing?.listing_id || row.source_item_id || "").trim();
    if (!itemId) continue;
    out.push({
      itemId,
      title: row.title || "",
      sku,
      currentPrice: row.price_cents != null ? (Number(row.price_cents) / 100).toFixed(2) : "",
      quantity: 1,
      quantitySold: 0,
      bidCount: 0,
      listingType: "FixedPriceItem",
      listingStatus: "Completed",
      categoryId: "",
      categoryName: "",
      imageUrls: [],
      viewItemUrl: "",
      fromFloor: true,
      strandedResume: true,
    });
  }
  return out;
}

function mergeListingSummaries(...lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const row of list || []) {
      const id = String(row?.itemId || "").trim();
      if (!id) continue;
      const prev = byId.get(id);
      if (!prev) {
        byId.set(id, { ...row, itemId: id });
        continue;
      }
      byId.set(id, {
        ...prev,
        ...row,
        itemId: id,
        title: row.title || prev.title,
        sku: row.sku || prev.sku,
        currentPrice: row.currentPrice || prev.currentPrice,
        categoryId: row.categoryId || prev.categoryId,
        categoryName: row.categoryName || prev.categoryName,
        imageUrls: row.imageUrls?.length ? row.imageUrls : prev.imageUrls,
        fromFloor: Boolean(prev.fromFloor || row.fromFloor),
      });
    }
  }
  return [...byId.values()];
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

async function suggestEbayCategory(title, unitCategory) {
  const query = [title, unitCategory].filter(Boolean).join(" ").trim();
  if (!query) return { categoryId: "", categoryName: "" };
  try {
    const suggestions = await suggestCategories(query);
    const pick = suggestions[0] || null;
    return {
      categoryId: pick?.categoryId || "",
      categoryName: pick?.categoryName || "",
    };
  } catch (err) {
    console.log("ebay_migrate_suggest_category", err instanceof Error ? err.message : String(err));
    return { categoryId: "", categoryName: "" };
  }
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
  const title = item.title || draft?.title || unit?.title || "";
  let categoryId = item.categoryId || draft?.category_id || "";
  let categoryName = item.categoryName || draft?.category_name || unit?.category || "";
  let categorySource = categoryId ? (item.categoryId ? "ebay" : "draft") : "";
  if (!categoryId) {
    const suggested = await suggestEbayCategory(title, unit?.category);
    categoryId = suggested.categoryId;
    categoryName = suggested.categoryName || categoryName;
    if (categoryId) categorySource = "taxonomy_suggest";
  }
  return {
    ...item,
    title,
    description: draft?.description || item.description || item.title || unit?.title || "",
    sku: sku || item.sku || "",
    categoryId,
    categoryName,
    conditionId: item.conditionId || draft?.condition_id || "3000",
    conditionDescription: item.conditionDescription || draft?.condition_notes || unit?.defect_notes || "",
    price,
    imageUrls,
    aspects: Object.keys(item.aspects || {}).length ? item.aspects : normalizeAspects(draft?.aspects),
    verificationHidden: true,
    floorMatched: Boolean(unit),
    categorySource,
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

function classifyItem(item, { openOrders, unit, mode = "dry_run" }) {
  const blocked = tradingItemBlockedReason(item, { openOrderItemIds: openOrders });
  if (blocked) {
    // Live resume: source may already be ended from a prior EndItem-before-create failure.
    if (mode === "live" && isSourceAlreadyEndedStatus(blocked)) {
      // fall through — still create on destination
    } else {
      return { outcome: "skipped", reason: blocked };
    }
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
  const reason = unit
    ? `Matched Floor SKU ${unit.sku}`
    : "No Floor SKU match — will still move listing";
  if (mode === "live" && blocked && isSourceAlreadyEndedStatus(blocked)) {
    return { outcome: "will_move", reason: `${reason} (source already ended — resume create on dest)` };
  }
  return { outcome: "will_move", reason };
}

async function alreadyOnDestAccount(storeId, sku, destAccountId) {
  if (!sku || !destAccountId) return false;
  const sb = serviceClient();
  const { data } = await sb
    .from("listings")
    .select("listing_id,status,ebay_account_id")
    .eq("store_id", storeId)
    .eq("sku", String(sku).trim())
    .eq("channel", "ebay")
    .maybeSingle();
  return (
    data?.status === "listed" &&
    data?.listing_id &&
    String(data.ebay_account_id || "") === String(destAccountId)
  );
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

async function createOnDestination(destAccount, item, policies, { storeId } = {}) {
  // Prefer Trading AddFixedPriceItem with seller profiles so price/photos/description carry over as-is.
  const token = await userTokenForAccount(destAccount);
  const unit = storeId ? await loadUnitBySku(storeId, item.sku) : null;
  const title = clipMigrationTitle(item.title);
  let aspects = sanitizeMigrationAspects(item.aspects, unit, item);
  const weightLb = migrationWeightLb(unit, item);
  let dims = clampMigrationPackageDims(migrationPackageDims(unit, item));
  const conditionIds = migrationConditionFallbacks(item.conditionId);
  let conditionIdx = 0;
  let lastErr = null;
  const filledAspectNames = [];

  for (let attempt = 0; attempt < 14; attempt += 1) {
    const conditionId = conditionIds[Math.min(conditionIdx, conditionIds.length - 1)];
    try {
      const created = await addFixedPriceItem(token, {
        title,
        description: item.description || title,
        categoryId: item.categoryId,
        price: item.price,
        conditionId,
        conditionDescription: conditionIdx === 0 ? item.conditionDescription : undefined,
        sku: item.sku || undefined,
        imageUrls: item.imageUrls,
        aspects,
        weightLb,
        lengthIn: dims.lengthIn,
        widthIn: dims.widthIn,
        heightIn: dims.heightIn,
        location: item.location,
        postalCode: item.postalCode || process.env.EBAY_LOCATION_POSTAL || "95663",
        city: item.location || "Penryn",
        dispatchTimeMax: item.dispatchTimeMax || 2,
        paymentPolicyId: policies.payment,
        returnPolicyId: policies.returnP,
        fulfillmentPolicyId: policies.fulfillment,
      });
      return created.listingId;
    } catch (err) {
      lastErr = err;
      const message = err instanceof Error ? err.message : String(err);
      const missing = parseMissingAspectNames(message);
      if (missing.length) {
        aspects = fillMissingAspects(aspects, missing, { unit, dims });
        filledAspectNames.push(...missing);
        continue;
      }
      const replaced = replaceInvalidAspectValues(aspects, message, { unit, dims });
      if (replaced.changed) {
        aspects = replaced.aspects;
        continue;
      }
      if (/girth|package.*(exceed|too\s+large|limit)/i.test(message)) {
        const next = clampMigrationPackageDims({
          lengthIn: Math.max(8, dims.lengthIn * 0.7),
          widthIn: Math.max(6, dims.widthIn * 0.7),
          heightIn: Math.max(2, dims.heightIn * 0.7),
        });
        if (next.lengthIn !== dims.lengthIn || next.widthIn !== dims.widthIn || next.heightIn !== dims.heightIn) {
          dims = next;
          continue;
        }
      }
      const conditionIssue =
        (/condition/i.test(message) && /invalid|not\s+valid|does\s+not\s+exist/i.test(message)) ||
        (/card\s+condition/i.test(message) && /required/i.test(message));
      if (conditionIssue && conditionIdx < conditionIds.length - 1) {
        conditionIdx += 1;
        // Trading card categories often want New (1000) + Card Condition aspect.
        if (/card\s+condition/i.test(message) && !aspects["Card Condition"]?.[0]) {
          aspects = { ...aspects, "Card Condition": ["Ungraded"] };
        }
        continue;
      }
      if (/card\s+condition/i.test(message) && /required/i.test(message) && !aspects["Card Condition"]?.[0]) {
        aspects = { ...aspects, "Card Condition": ["Ungraded"] };
        continue;
      }
      break;
    }
  }
  const err = lastErr || new Error("AddFixedPriceItem failed");
  err.createMeta = {
    createBuild: MIGRATION_CREATE_BUILD,
    weightLb,
    dims,
    aspectKeys: Object.keys(aspects),
    brand: aspects.Brand?.[0] || null,
    conditionTried: conditionIds.slice(0, conditionIdx + 1),
    filledAspectNames: [...new Set(filledAspectNames)],
  };
  throw err;
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
  console.log(
    "ebay_migrate_start",
    JSON.stringify({ runId: run.id, mode, createBuild: MIGRATION_CREATE_BUILD, storeId }),
  );

  try {
    const sourceToken = await userTokenForAccount(source);
    let activeList = [];
    let sellerList = [];
    let floorList = [];
    let strandedList = [];
    try {
      activeList = await getMyEbaySellingActive(sourceToken);
    } catch (err) {
      console.log("ebay_migrate_active_list", err instanceof Error ? err.message : String(err));
    }
    try {
      sellerList = await getSellerListActive(sourceToken);
    } catch (err) {
      console.log("ebay_migrate_seller_list", err instanceof Error ? err.message : String(err));
    }
    try {
      floorList = await loadFloorEbayListingSummaries(storeId, {
        sourceAccountId: source.id,
        destAccountId: dest?.id || null,
      });
    } catch (err) {
      console.log("ebay_migrate_floor_list", err instanceof Error ? err.message : String(err));
    }
    try {
      strandedList = await loadStrandedFailedMigrationSummaries(storeId, dest?.id || null);
    } catch (err) {
      console.log("ebay_migrate_stranded_list", err instanceof Error ? err.message : String(err));
    }
    const summaries = mergeListingSummaries(activeList, sellerList, floorList, strandedList);
    console.log(
      "ebay_migrate_sources",
      JSON.stringify({
        activeList: activeList.length,
        sellerList: sellerList.length,
        floorList: floorList.length,
        strandedList: strandedList.length,
        merged: summaries.length,
        createBuild: MIGRATION_CREATE_BUILD,
      }),
    );
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
        } else if (isListingRemovedPolicyError(message)) {
          const skip = {
            sourceItemId: row.itemId,
            sku: row.sku || null,
            title: row.title || null,
            priceCents: moneyToCents(row.currentPrice),
            outcome: "skipped",
            reason: "listing_removed_policy_violation",
            detail: { stage: "get_item", ebayMessage: message.slice(0, 300) },
          };
          results.push(skip);
          await saveItem(run.id, storeId, skip);
          continue;
        } else if (
          mode === "live" &&
          (row.fromFloor || row.sku) &&
          /not\s+found|invalid\s+item|cannot\s+be\s+accessed|ended|no\s+longer\s+available/i.test(message)
        ) {
          // Prior live attempt ended source but create failed — Floor still points at source ItemID.
          verificationHidden = true;
          item = await enrichVerificationHiddenItem(storeId, itemFromActiveListSummary(row));
          item.listingStatus = "Completed";
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
      const decision = classifyItem(item, { openOrders, unit: banUnit, mode });
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

      // LIVE: already remapped onto selling account — skip.
      if (dest && (await alreadyOnDestAccount(storeId, base.sku, dest.id))) {
        const skip = {
          ...base,
          outcome: "skipped",
          reason: "already_on_destination_account",
        };
        results.push(skip);
        await saveItem(run.id, storeId, skip);
        continue;
      }

      // LIVE: end on source first so the item is never dual-live.
      try {
        if (!policies || !dest) throw new Error("Destination selling account / policies missing");
        let sourceEnded = false;
        try {
          await endTradingItem(sourceToken, item.itemId, "NotAvailable");
          sourceEnded = true;
        } catch (endErr) {
          const endMsg = endErr instanceof Error ? endErr.message : String(endErr);
          if (isEndAlreadyEndedError(endMsg)) {
            sourceEnded = true;
          } else {
            throw endErr;
          }
        }
        // Brief pause so eBay search/index settles before create.
        await sleep(1500 + Math.floor(Math.random() * 1500));
        const destItemId = await createOnDestination(dest, item, policies, { storeId });
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
            : sourceEnded
              ? "ended_on_source_created_on_dest"
              : "created_on_dest",
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
          detail: {
            ...base.detail,
            stage: "end_or_create",
            createBuild: MIGRATION_CREATE_BUILD,
            ...(err && typeof err === "object" && err.createMeta ? err.createMeta : {}),
          },
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

const MIGRATION_REQUEST_KEY = "ebay_migration_request";

/**
 * Queue a dry-run or live migration via store_settings so ebay-sync (which has
 * SUPABASE_SERVICE_ROLE on Netlify) can kick ebay-migrate-background without an
 * agent-held secret.
 */
export async function queueMigrationRequest(storeId, { mode = "dry_run", requestedBy = "queue", limit = null } = {}) {
  if (mode !== "dry_run" && mode !== "live") throw new Error("mode must be dry_run or live");
  const sb = serviceClient();
  const value = {
    mode,
    status: "queued",
    requested_at: new Date().toISOString(),
    requested_by: requestedBy || "queue",
    limit: limit != null ? Number(limit) : null,
  };
  const { error } = await sb.from("store_settings").upsert(
    { store_id: storeId, key: MIGRATION_REQUEST_KEY, value },
    { onConflict: "store_id,key" },
  );
  if (error) throw new Error(error.message);
  return value;
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

/** Called from ebay-sync cron: dispatch any queued migration requests to the background worker. */
export async function dispatchQueuedMigrationRequests() {
  const sb = serviceClient();
  const { data: rows, error } = await sb
    .from("store_settings")
    .select("store_id,value")
    .eq("key", MIGRATION_REQUEST_KEY);
  if (error) throw new Error(error.message);
  const base = (process.env.URL || "https://inventoryobi.netlify.app").replace(/\/$/, "");
  const token = requireEnv("SUPABASE_SERVICE_ROLE");
  const results = [];
  for (const row of rows || []) {
    const val = parseSettingValue(row.value);
    if (val.status !== "queued") continue;
    const mode = val.mode === "live" ? "live" : "dry_run";
    const claimed = {
      ...val,
      status: "dispatched",
      dispatched_at: new Date().toISOString(),
    };
    await sb.from("store_settings").upsert(
      { store_id: row.store_id, key: MIGRATION_REQUEST_KEY, value: claimed },
      { onConflict: "store_id,key" },
    );
    try {
      const res = await fetch(`${base}/.netlify/functions/ebay-migrate-background`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          store_id: row.store_id,
          mode,
          created_by: val.requested_by || "ebay_migration_request",
          limit: val.limit != null ? Number(val.limit) : null,
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
        { store_id: row.store_id, key: MIGRATION_REQUEST_KEY, value: next },
        { onConflict: "store_id,key" },
      );
      results.push({ storeId: row.store_id, mode, ok, status: res.status });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await sb.from("store_settings").upsert(
        {
          store_id: row.store_id,
          key: MIGRATION_REQUEST_KEY,
          value: { ...claimed, status: "dispatch_failed", error: message.slice(0, 300) },
        },
        { onConflict: "store_id,key" },
      );
      results.push({ storeId: row.store_id, mode, ok: false, error: message });
    }
  }
  return results;
}

