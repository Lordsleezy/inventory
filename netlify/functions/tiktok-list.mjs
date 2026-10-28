/**
 * Admin TikTok Shop queue: status / prepare / list_one / sync_orders.
 */
import { json, corsHeaders, serviceClient } from "../lib/server.mjs";
import { portalAdminFromEvent } from "../lib/portal-auth.mjs";
import { wrapHandler, asNetlifyFunction } from "../lib/floor-log.mjs";
import { evaluateTikTokReadiness, suggestedTikTokPriceCents } from "../lib/tiktok-readiness.mjs";
import { syncChannelTaxonomy } from "../lib/category-taxonomy.mjs";
import { syncTikTokPrepData, syncTikTokFinance } from "../lib/tiktok-prep-sync.mjs";
import {
  tiktokConnectionStatus,
  tiktokListingEnabled,
  prepareTikTokQueueItem,
  listTikTokProduct,
  runTikTokOrdersSyncJob,
  ensureTikTokTokenFresh,
  STORE_DEFAULT,
} from "../lib/tiktok-shop.mjs";

const STORE = STORE_DEFAULT;

async function handleStaff(event) {
  const body = typeof event.body === "string" ? JSON.parse(event.body || "{}") : event.body || {};
  const action = String(body.action || "").trim();
  const { storeId } = await portalAdminFromEvent(event, body.store_id || STORE);
  const sb = serviceClient();
  const sku = body.sku != null ? String(body.sku).trim() : "";

  if (action === "readiness") {
    const { data: units, error } = await sb.from("units")
      .select("sku,title,brand,model,upc,category,internal_category,condition,test_status,ask_cents,state,listing_body,listing_specs,has_ai_images,has_stock_photos,has_manufacturer_photos")
      .eq("store_id", storeId).eq("state", "available").order("sku").limit(10000);
    if (error) throw new Error(error.message);
    const skus = (units || []).map((u) => u.sku);
    const photoSkus = new Set();
    for (let i = 0; i < skus.length; i += 500) {
      const { data: photos, error: photoError } = await sb.from("photos").select("sku")
        .eq("store_id", storeId).in("sku", skus.slice(i, i + 500));
      if (photoError) throw new Error(photoError.message);
      for (const row of photos || []) photoSkus.add(row.sku);
    }
    const { data: mappings, error: mappingError } = await sb.from("unit_channel_categories")
      .select("sku,category_id,attributes,enabled").eq("store_id", storeId).eq("channel", "tiktok");
    if (mappingError) throw new Error(mappingError.message);
    const mappingBySku = new Map((mappings || []).map((row) => [row.sku, row]));
    const categoryIds = [...new Set((mappings || []).filter((row) => row.enabled && row.category_id).map((row) => row.category_id))];
    const taxonomyById = new Map();
    for (let i = 0; i < categoryIds.length; i += 500) {
      const { data: taxonomy, error: taxonomyError } = await sb.from("channel_taxonomy")
        .select("category_id,active,leaf,permissions,required_fields,fields_fetched_at")
        .eq("channel", "tiktok").in("category_id", categoryIds.slice(i, i + 500));
      if (taxonomyError) throw new Error(taxonomyError.message);
      for (const row of taxonomy || []) taxonomyById.set(row.category_id, row);
    }
    const brandSnapshots = [];
    for (const categoryId of categoryIds) {
      for (let offset = 0; ; offset += 500) {
        const { data: snapshots, error: brandError } = await sb.from("tiktok_shop_snapshots")
          .select("payload").eq("store_id", storeId).eq("snapshot_type", "brands")
          .contains("payload", { category_id: categoryId }).range(offset, offset + 499);
        if (brandError) throw new Error(brandError.message);
        brandSnapshots.push(...(snapshots || []).map((row) => row.payload));
        if (!snapshots || snapshots.length < 500) break;
      }
    }
    const connected = await tiktokConnectionStatus(storeId).then((s) => s.healthy);
    const rows = (units || []).map((unit) => {
      const mapping = mappingBySku.get(unit.sku);
      const category = mapping?.category_id ? taxonomyById.get(mapping.category_id) : null;
      const brandName = String(unit.brand || "").trim().toLocaleLowerCase();
      const brandVerified = !brandName || brandSnapshots.some((brand) => brand.category_id === mapping?.category_id &&
        String(brand.name || "").trim().toLocaleLowerCase() === brandName &&
        brand.authorized_status === "AUTHORIZED" && brand.brand_status === "AVAILABLE");
      const result = evaluateTikTokReadiness(unit, { photoCount: photoSkus.has(unit.sku) ? 1 : 0,
        taxonomyAvailable: Boolean(category?.active && category?.leaf && category?.fields_fetched_at),
        categoryMapped: Boolean(mapping?.enabled && mapping?.category_id),
        categoryAllowed: Boolean(category?.active && category?.leaf && Array.isArray(category.permissions) &&
          category.permissions.includes("AVAILABLE")),
        requiredFields: category?.fields_fetched_at ? category.required_fields : null,
        attributes: mapping?.attributes && typeof mapping.attributes === "object" ? mapping.attributes : {},
        brandVerified, connected });
      return { sku: unit.sku, title: unit.title || `SKU ${unit.sku}`, floor_price_cents: unit.ask_cents,
        tiktok_price_cents: suggestedTikTokPriceCents(unit.ask_cents), suggested_category: unit.internal_category || unit.category || "Needs mapping",
        status: result.status, reasons: result.reasons };
    });
    const byReason = {};
    for (const row of rows) for (const reason of row.reasons) byReason[reason] = (byReason[reason] || 0) + 1;
    return json(200, { ok: true, rows, totals: { units: rows.length, ready: rows.filter((r) => r.status === "ready").length,
      blocked: rows.filter((r) => r.status === "blocked").length, byReason } });
  }

  if (action === "sync_taxonomy") {
    const result = await syncChannelTaxonomy("tiktok", storeId);
    return json(200, { ok: true, ...result });
  }

  if (action === "sync_readonly") {
    const result = await syncTikTokPrepData(storeId);
    return json(200, result);
  }
  if (action === "sync_finance") {
    const result = await syncTikTokFinance(storeId);
    return json(200, { ok: true, ...result });
  }

  if (action === "status" || !action) {
    await ensureTikTokTokenFresh(storeId).catch(() => undefined);
    const status = await tiktokConnectionStatus(storeId);
    return json(200, { ok: true, ...status, listingEnabled: tiktokListingEnabled() });
  }

  if (action === "prepare" || action === "retry") {
    if (!sku) return json(400, { ok: false, error: "sku_required" });
    const result = await prepareTikTokQueueItem(storeId, sku);
    if (!result.ok) {
      await sb
        .from("tiktok_list_items")
        .upsert(
          {
            store_id: storeId,
            sku,
            status: result.status || "error",
            last_error: result.last_error || result.status || "prepare_failed",
            updated_at: new Date().toISOString(),
          },
          { onConflict: "store_id,sku" },
        );
    }
    return json(result.ok ? 200 : 400, { ok: result.ok, ...result });
  }

  if (action === "set_price") {
    if (!sku) return json(400, { ok: false, error: "sku_required" });
    const cents = Math.round(Number(body.price_cents));
    if (!Number.isFinite(cents) || cents < 500) return json(400, { ok: false, error: "price_too_low" });
    await sb
      .from("tiktok_list_items")
      .update({ tiktok_price_cents: cents, updated_at: new Date().toISOString() })
      .eq("store_id", storeId)
      .eq("sku", sku);
    return json(200, { ok: true, sku, tiktok_price_cents: cents });
  }

  if (action === "list_one") {
    if (!sku) return json(400, { ok: false, error: "sku_required" });
    const { data: row } = await sb.from("tiktok_list_items").select("*").eq("store_id", storeId).eq("sku", sku).maybeSingle();
    const { data: unit } = await sb.from("units").select("*").eq("store_id", storeId).eq("sku", sku).maybeSingle();
    if (!unit) return json(404, { ok: false, error: "unknown_sku" });
    await sb
      .from("tiktok_list_items")
      .upsert(
        { store_id: storeId, sku, status: "listing", updated_at: new Date().toISOString() },
        { onConflict: "store_id,sku" },
      );
    const result = await listTikTokProduct(storeId, {
      unit,
      sku,
      priceCents: row?.tiktok_price_cents || body.price_cents || null,
    });
    if (!result.ok) {
      await sb
        .from("tiktok_list_items")
        .update({
          status: "error",
          last_error: result.message || result.reason || "list_failed",
          updated_at: new Date().toISOString(),
        })
        .eq("store_id", storeId)
        .eq("sku", sku);
    }
    return json(result.ok ? 200 : 400, result);
  }

  if (action === "sync_orders") {
    const result = await runTikTokOrdersSyncJob(storeId);
    return json(200, { ok: true, ...result });
  }

  if (action === "remove") {
    if (!sku) return json(400, { ok: false, error: "sku_required" });
    await sb.from("tiktok_list_items").delete().eq("store_id", storeId).eq("sku", sku);
    return json(200, { ok: true, sku });
  }

  return json(400, { ok: false, error: "unknown_action", action });
}

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: corsHeaders(), body: "" };
  if (event.httpMethod && event.httpMethod !== "POST") {
    return json(405, { error: "method_not_allowed" });
  }
  try {
    return await handleStaff(event);
  } catch (err) {
    const status = err?.status || 500;
    const message = err instanceof Error ? err.message : String(err);
    return json(status, { ok: false, error: message });
  }
}

export const invoke = wrapHandler("tiktok-list", handle);
export default asNetlifyFunction(invoke);
