/**
 * Migrate Trading/Vendoo-era eBay listings into the Inventory API via bulk_migrate_listing
 * so they become editable from Floor. Does not end or recreate the live listing.
 */
import { serviceClient } from "./server.mjs";
import { ebayFetch, resolveEbayAccount } from "./ebay.mjs";

const MIGRATE_KEY = "ebay_inventory_migrate_request";

async function setSetting(sb, storeId, value) {
  const { error } = await sb.from("store_settings").upsert(
    { store_id: storeId, key: MIGRATE_KEY, value },
    { onConflict: "store_id,key" },
  );
  if (error) throw new Error(error.message);
}

export async function getEbayInventoryMigrateStatus(storeId) {
  const sb = serviceClient();
  const { data } = await sb
    .from("store_settings")
    .select("value")
    .eq("store_id", storeId)
    .eq("key", MIGRATE_KEY)
    .maybeSingle();
  return data?.value && typeof data.value === "object" ? data.value : null;
}

/**
 * Find Floor eBay listings that look legacy (have listing_id, not in Inventory API).
 */
export async function listLegacyEbayCandidates(storeId, { limit = 50 } = {}) {
  const sb = serviceClient();
  const selling = await resolveEbayAccount(storeId, { role: "selling" }).catch(() => null);
  const { data: floorOnly } = await sb
    .from("listings")
    .select("sku, listing_id, status, listed_at")
    .eq("store_id", storeId)
    .eq("channel", "ebay")
    .eq("status", "listed")
    .not("listing_id", "is", null)
    .limit(200);

  const candidates = [];
  for (const row of floorOnly || []) {
    if (candidates.length >= limit) break;
    const listingId = String(row.listing_id || "").replace(/\D/g, "");
    if (!listingId) continue;
    // Probe Inventory by sku — if offer exists, already migrated
    let hasInventory = false;
    if (selling) {
      try {
        const offers = await ebayFetch(
          storeId,
          "GET",
          `/sell/inventory/v1/offer?sku=${encodeURIComponent(row.sku)}&limit=5`,
          undefined,
          { accountId: selling.id },
        );
        hasInventory = (offers?.offers || []).some((o) => o.status === "PUBLISHED" || o.offerId);
      } catch {
        hasInventory = false;
      }
    }
    if (hasInventory) continue;
    const { data: unit } = await sb
      .from("units")
      .select("sku, title, ask_cents, state")
      .eq("store_id", storeId)
      .eq("sku", row.sku)
      .maybeSingle();
    candidates.push({
      sku: row.sku,
      listing_id: listingId,
      title: unit?.title || row.sku,
      ask_cents: unit?.ask_cents ?? null,
      state: unit?.state || null,
      status: row.status,
    });
  }
  return { ok: true, items: candidates, selling: selling ? { id: selling.id, username: selling.username } : null };
}

/**
 * Migrate one or more listing IDs into Inventory API.
 * @see https://developer.ebay.com/api-docs/sell/inventory/resources/listing/methods/bulkMigrateListing
 */
export async function migrateEbayListingsToInventory(
  storeId,
  { listingIds = [], dryRun = false } = {},
) {
  const ids = [...new Set((listingIds || []).map((x) => String(x).replace(/\D/g, "")).filter(Boolean))];
  if (!ids.length) return { ok: false, error: "listing_ids_required" };
  if (ids.length > 5) return { ok: false, error: "max_5_listing_ids_per_call — pace batches" };

  const selling = await resolveEbayAccount(storeId, { role: "selling" });
  const hint = { accountId: selling.id };
  const sb = serviceClient();

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      listingIds: ids,
      message: "Would call bulk_migrate_listing — no changes made.",
    };
  }

  const body = {
    requests: ids.map((listingId) => ({ listingId })),
  };

  let json;
  try {
    json = await ebayFetch(storeId, "POST", "/sell/inventory/v1/bulk_migrate_listing", body, hint);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      httpStatus: e?.status || null,
      body: e?.body || null,
    };
  }

  const responses = json?.responses || json?.migrateListingResponses || [];
  const results = [];
  for (let i = 0; i < ids.length; i++) {
    const listingId = ids[i];
    const resp = responses[i] || responses.find((r) => String(r.listingId || r.listing_id) === listingId) || {};
    const statusCode = Number(resp.statusCode || resp.status || 0);
    const errors = resp.errors || resp.warnings || [];
    const inventoryItemGroupKey = resp.inventoryItemGroupKey || null;
    const marketplaceId = resp.marketplaceId || null;
    const ok = statusCode >= 200 && statusCode < 300 && !errors.some((e) => String(e.severity || "").toUpperCase() === "ERROR");
    results.push({
      listing_id: listingId,
      ok,
      statusCode: statusCode || null,
      inventoryItemGroupKey,
      marketplaceId,
      errors: (errors || []).map((e) => e.message || e.longMessage || JSON.stringify(e)).slice(0, 5),
      raw: resp,
    });
  }

  await setSetting(sb, storeId, {
    status: "completed",
    finished_at: new Date().toISOString(),
    username: selling.username,
    results,
    summary: {
      requested: ids.length,
      ok: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    },
  });

  return {
    ok: results.every((r) => r.ok),
    results,
    summary: {
      requested: ids.length,
      ok: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    },
    raw: json,
  };
}
