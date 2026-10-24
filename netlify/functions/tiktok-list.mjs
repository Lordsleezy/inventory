/**
 * Admin TikTok Shop queue: status / prepare / list_one / sync_orders.
 */
import { json, corsHeaders, serviceClient } from "../lib/server.mjs";
import { portalAdminFromEvent } from "../lib/portal-auth.mjs";
import { wrapHandler, asNetlifyFunction } from "../lib/floor-log.mjs";
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
