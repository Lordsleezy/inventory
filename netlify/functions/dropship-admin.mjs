import { staffFromEvent, serviceClient, json, corsHeaders } from "../lib/server.mjs";
import { netlifyHandler } from "../lib/floor-log.mjs";
import { saveApiKey } from "../lib/dropship/credentials.mjs";
import { openAdapter, listAdapters } from "../lib/dropship/adapters/index.mjs";
import { importCatalogChunk } from "../lib/dropship/catalog-import.mjs";
import { runHunter, decidePick } from "../lib/dropship/picks.mjs";
import { placeSupplierOrder, pullTrackingAndUpload, recomputeHealth, assertChannelAllowsDropship } from "../lib/dropship/autopilot.mjs";
import { publishDropshipToEbay, endAllDropshipEbayListings, getEbayPrivileges } from "../lib/dropship/publish-ebay.mjs";
import { publishDropshipToTikTok, endAllDropshipTikTokListings } from "../lib/dropship/publish-tiktok.mjs";
import { getAmazonReadiness, updateAmazonReadiness } from "../lib/dropship/amazon-readiness.mjs";
import { openDropshipReturnTask, receiveReturnedDropshipAsUnit } from "../lib/dropship/returns.mjs";
import { orderSample, markSampleVerified } from "../lib/dropship/picks.mjs";
import { DEFAULT_HUNTER } from "../lib/dropship/hunter.mjs";
import { isDropshipSku } from "../lib/dropship/types.mjs";

async function requireAdmin(event) {
  const { user, staff } = await staffFromEvent(event);
  if (!staff || (staff.role !== "owner" && staff.role !== "admin" && staff.role !== "manager")) {
    // Floor uses owner/admin; managers with portal_is_admin also ok via RPC. Be strict here.
    if (staff?.role !== "owner" && staff?.role !== "admin") {
      const err = new Error("admin_required");
      err.status = 403;
      throw err;
    }
  }
  return { user, staff, storeId: staff.store_id };
}

async function handler(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(event), body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "method" });

  const body = JSON.parse(event.body || "{}");
  const action = String(body.action || "");
  const { user, staff, storeId } = await requireAdmin(event);
  const sb = serviceClient();

  if (action === "desk") {
    const { data, error } = await sb.rpc("portal_dropship_desk");
    // RPC uses JWT store; service role may need to set claim — fall back to assembled desk.
    if (error) {
      const assembled = await assembleDesk(storeId);
      return json(200, assembled);
    }
    return json(200, data);
  }

  if (action === "set_enabled") {
    const enabled = Boolean(body.enabled);
    await sb
      .from("dropship_settings")
      .upsert(
        {
          store_id: storeId,
          enabled,
          paused: enabled ? false : undefined,
          pause_reason: enabled ? null : undefined,
          updated_at: new Date().toISOString(),
          updated_by: user.id,
        },
        { onConflict: "store_id" },
      );
    return json(200, { ok: true, enabled });
  }

  if (action === "set_paused") {
    await sb
      .from("dropship_settings")
      .update({
        paused: Boolean(body.paused),
        pause_reason: body.paused ? String(body.reason || "manual") : null,
        updated_at: new Date().toISOString(),
        updated_by: user.id,
      })
      .eq("store_id", storeId);
    return json(200, { ok: true });
  }

  if (action === "save_settings") {
    const { data: cur } = await sb.from("dropship_settings").select("settings").eq("store_id", storeId).maybeSingle();
    const next = { ...DEFAULT_HUNTER, ...(cur?.settings || {}), ...(body.settings || {}) };
    const patch = {
      settings: next,
      updated_at: new Date().toISOString(),
      updated_by: user.id,
    };
    for (const k of [
      "ebay_channel_on",
      "website_channel_on",
      "tiktok_channel_on",
      "amazon_channel_on",
      "daily_publish_cap",
      "manual_place_remaining",
      "sample_gate_required",
    ]) {
      if (body[k] != null) patch[k] = body[k];
    }
    // Amazon channel cannot turn on unless readiness unlocked.
    if (patch.amazon_channel_on) {
      const ready = await getAmazonReadiness(storeId);
      if (!ready.unlocked) {
        return json(400, {
          error: "amazon_locked",
          missing: ready.missing,
          message: "Amazon switch is disabled until the readiness checklist is all green.",
        });
      }
    }
    // Hard-block: never allow depop/mercari flags even if someone sends them.
    await sb.from("dropship_settings").update(patch).eq("store_id", storeId);
    return json(200, { ok: true, settings: next });
  }

  if (action === "save_api_key") {
    const supplier = String(body.supplier || "");
    if (!["cj", "eprolo", "printify"].includes(supplier)) return json(400, { error: "bad_supplier" });
    if (supplier === "doba") return json(400, { error: "doba_disabled" });
    const saved = await saveApiKey(storeId, supplier, body.api_key);
    return json(200, { ok: true, supplier: saved.supplier, status: saved.status });
  }

  if (action === "test_connection") {
    const supplier = String(body.supplier || "cj");
    const { adapter, ctx } = await openAdapter(storeId, supplier);
    const result = await adapter.testConnection(ctx);
    return json(200, result);
  }

  if (action === "import_chunk") {
    const result = await importCatalogChunk(storeId, body.supplier || "cj", {
      maxPages: body.maxPages || 10,
      pageSize: body.pageSize || 50,
      runId: body.runId || null,
    });
    return json(200, result);
  }

  if (action === "pause_import") {
    await sb
      .from("supplier_catalog_runs")
      .update({ status: "paused", updated_at: new Date().toISOString() })
      .eq("store_id", storeId)
      .eq("supplier", body.supplier || "cj")
      .eq("status", "running");
    return json(200, { ok: true });
  }

  if (action === "run_hunter") {
    const result = await runHunter(storeId, body);
    return json(200, result);
  }

  if (action === "list_picks") {
    const status = body.status || "pending";
    const { data } = await sb
      .from("dropship_picks")
      .select("*, catalog:supplier_catalog_items(title, image_url, cost_cents, shipping_cents, ships_from_us, processing_days, stock_qty, supplier)")
      .eq("store_id", storeId)
      .eq("status", status)
      .order("rank_score", { ascending: false })
      .limit(Math.min(100, Number(body.limit) || 40));
    return json(200, { picks: data || [] });
  }

  if (action === "decide_pick") {
    const result = await decidePick(storeId, body.pick_id, body.decision, user.id);
    return json(200, result);
  }

  if (action === "publish_ebay") {
    try {
      const result = await publishDropshipToEbay(storeId, body.product_id, body);
      return json(200, result);
    } catch (err) {
      return json(400, { error: err.message, code: err.code });
    }
  }

  if (action === "end_all_ebay") {
    if (body.confirm !== "END_ALL_DROPSHIP") return json(400, { error: "confirm_required" });
    const results = await endAllDropshipEbayListings(storeId);
    return json(200, { results });
  }

  if (action === "publish_tiktok") {
    try {
      const result = await publishDropshipToTikTok(storeId, body.product_id);
      return json(200, result);
    } catch (err) {
      return json(400, { error: err.message, code: err.code });
    }
  }

  if (action === "end_all_tiktok") {
    if (body.confirm !== "END_ALL_DROPSHIP_TIKTOK") return json(400, { error: "confirm_required" });
    const results = await endAllDropshipTikTokListings(storeId);
    return json(200, { results });
  }

  if (action === "amazon_readiness") {
    return json(200, await getAmazonReadiness(storeId));
  }

  if (action === "amazon_readiness_update") {
    return json(200, await updateAmazonReadiness(storeId, body.patch || body));
  }

  if (action === "order_sample") {
    return json(200, await orderSample(storeId, body.catalog_item_id, body.address, user.id));
  }

  if (action === "mark_sample_verified") {
    return json(200, await markSampleVerified(storeId, body.product_id, body.verified !== false));
  }

  if (action === "open_return_task") {
    return json(200, await openDropshipReturnTask(storeId, body));
  }

  if (action === "receive_returned") {
    return json(200, await receiveReturnedDropshipAsUnit(storeId, { ...body, userId: user.id }));
  }

  if (action === "list_orders") {
    const { data } = await sb
      .from("dropship_orders")
      .select("*")
      .eq("store_id", storeId)
      .order("created_at", { ascending: false })
      .limit(80);
    return json(200, { orders: data || [] });
  }

  if (action === "place_order") {
    const result = await placeSupplierOrder(storeId, body.order_id, { userId: user.id });
    return json(200, result);
  }

  if (action === "pull_tracking") {
    const result = await pullTrackingAndUpload(storeId, body.order_id);
    return json(200, result);
  }

  if (action === "health") {
    const health = await recomputeHealth(storeId);
    const privileges = await getEbayPrivileges(storeId);
    return json(200, { health, ebay: privileges, adapters: listAdapters() });
  }

  if (action === "assert_channel") {
    try {
      assertChannelAllowsDropship(body.channel, body.sku);
      return json(200, { ok: true, is_dropship: isDropshipSku(body.sku) });
    } catch (err) {
      return json(400, { error: err.message, code: err.code });
    }
  }

  void staff;
  return json(400, { error: "unknown_action", action });
}

async function assembleDesk(storeId) {
  const sb = serviceClient();
  const { data: settings } = await sb.from("dropship_settings").select("*").eq("store_id", storeId).maybeSingle();
  const { data: suppliers } = await sb
    .from("dropship_supplier_credentials")
    .select(
      "supplier, status, points_remaining, points_checked_at, balance_cents, balance_checked_at, last_error, token_expires_at, api_key_ciphertext",
    )
    .eq("store_id", storeId);
  const { count: total } = await sb
    .from("supplier_catalog_items")
    .select("id", { count: "exact", head: true })
    .eq("store_id", storeId);
  const { count: us } = await sb
    .from("supplier_catalog_items")
    .select("id", { count: "exact", head: true })
    .eq("store_id", storeId)
    .eq("ships_from_us", true);
  const { data: runs } = await sb
    .from("supplier_catalog_runs")
    .select("id, supplier, status, cursor_page, imported_count, matched_us_count, points_spent, last_error, updated_at")
    .eq("store_id", storeId)
    .order("updated_at", { ascending: false })
    .limit(8);
  const { count: pending } = await sb
    .from("dropship_picks")
    .select("id", { count: "exact", head: true })
    .eq("store_id", storeId)
    .eq("status", "pending");
  const { count: approved } = await sb
    .from("dropship_picks")
    .select("id", { count: "exact", head: true })
    .eq("store_id", storeId)
    .eq("status", "approved");
  const { count: listed } = await sb
    .from("dropship_products")
    .select("id", { count: "exact", head: true })
    .eq("store_id", storeId)
    .eq("status", "listed");
  const { count: openOrders } = await sb
    .from("dropship_orders")
    .select("id", { count: "exact", head: true })
    .eq("store_id", storeId)
    .in("status", ["awaiting_place", "placing", "placed", "tracking", "paused", "failed"]);
  const { data: health } = await sb.from("dropship_health").select("*").eq("store_id", storeId).maybeSingle();

  return {
    enabled: settings?.enabled ?? false,
    paused: settings?.paused ?? false,
    pause_reason: settings?.pause_reason ?? null,
    settings: settings?.settings || DEFAULT_HUNTER,
    ebay_channel_on: settings?.ebay_channel_on ?? false,
    website_channel_on: settings?.website_channel_on ?? false,
    tiktok_channel_on: settings?.tiktok_channel_on ?? false,
    amazon_channel_on: settings?.amazon_channel_on ?? false,
    sample_gate_required: settings?.sample_gate_required ?? true,
    daily_publish_cap: settings?.daily_publish_cap ?? 5,
    manual_place_remaining: settings?.manual_place_remaining ?? 10,
    last_supplier_order_at: settings?.last_supplier_order_at ?? null,
    suppliers: (suppliers || []).map((c) => ({
      supplier: c.supplier,
      status: c.status,
      has_api_key: Boolean(c.api_key_ciphertext),
      points_remaining: c.points_remaining,
      points_checked_at: c.points_checked_at,
      balance_cents: c.balance_cents,
      balance_checked_at: c.balance_checked_at,
      last_error: c.last_error,
      token_expires_at: c.token_expires_at,
    })),
    catalog: { total: total || 0, us: us || 0, runs: runs || [] },
    picks: { pending: pending || 0, approved: approved || 0, listed: listed || 0 },
    orders: { open: openOrders || 0 },
    health: health || null,
  };
}

export const handler = netlifyHandler("dropship-admin", handler);
