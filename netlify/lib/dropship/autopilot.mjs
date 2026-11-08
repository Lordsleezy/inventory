import { serviceClient } from "../server.mjs";
import { openAdapter } from "./adapters/index.mjs";
import { enqueueDropshipAlert, checkKeepAlive } from "./alerts.mjs";
import { isDropshipSku } from "./types.mjs";

/**
 * Order autopilot for DS- sales.
 * First 10 orders: require manual Place order.
 * Never auto-cancel or refund. Fail closed on missing blind-shipping / address / stock / balance.
 */
export async function syncDropshipSale(storeId, sale) {
  const sku = String(sale?.sku || "");
  if (!isDropshipSku(sku)) return { skipped: true, reason: "not_ds" };

  const sb = serviceClient();
  const { data: settings } = await sb.from("dropship_settings").select("*").eq("store_id", storeId).maybeSingle();
  if (!settings?.enabled) return { skipped: true, reason: "off" };

  const existing = await sb
    .from("dropship_orders")
    .select("id")
    .eq("store_id", storeId)
    .eq("channel_order_id", String(sale.channel_order_id || sale.order_id || ""))
    .eq("sku", sku)
    .maybeSingle();
  if (existing.data) return { skipped: true, reason: "already_tracked" };

  const { data: product } = await sb
    .from("dropship_products")
    .select("*, catalog:supplier_catalog_items(*)")
    .eq("store_id", storeId)
    .eq("sku", sku)
    .maybeSingle();

  const handlingDays = Number(product?.handling_days || 5);
  const deadline = new Date(Date.now() + handlingDays * 86400_000);

  const { data: order, error } = await sb
    .from("dropship_orders")
    .insert({
      store_id: storeId,
      dropship_product_id: product?.id || null,
      sku,
      channel: sale.channel || "ebay",
      channel_order_id: String(sale.channel_order_id || sale.order_id || ""),
      sale_id: sale.sale_id || null,
      status: "awaiting_place",
      supplier: product?.catalog?.supplier || "cj",
      buyer_name: sale.buyer_name || null,
      ship_address: sale.ship_address || null,
      handling_deadline_at: deadline.toISOString(),
      raw: sale,
    })
    .select("*")
    .single();
  if (error) throw error;

  await enqueueDropshipAlert(storeId, sku, `New dropship order ${order.id} — awaiting place.`, {
    kind_detail: "new_order",
    order_id: order.id,
  });

  if ((settings.manual_place_remaining ?? 0) <= 0 && !settings.settings?.force_manual_place) {
    return placeSupplierOrder(storeId, order.id, { autopilot: true });
  }
  return { ok: true, orderId: order.id, needsManualPlace: true };
}

export async function placeSupplierOrder(storeId, orderId, opts = {}) {
  const sb = serviceClient();
  const { data: settings } = await sb.from("dropship_settings").select("*").eq("store_id", storeId).maybeSingle();
  if (!settings?.enabled) throw new Error("dropship_off");
  if (settings.paused) throw new Error(`dropship_paused:${settings.pause_reason || ""}`);

  const { data: order } = await sb
    .from("dropship_orders")
    .select("*")
    .eq("id", orderId)
    .eq("store_id", storeId)
    .maybeSingle();
  if (!order) throw new Error("order_not_found");
  if (!["awaiting_place", "paused", "failed"].includes(order.status)) {
    throw new Error(`bad_status:${order.status}`);
  }

  const rules = settings.settings || {};
  if (rules.cj_blind_shipping_verified !== true) {
    return pauseOrder(order, "blind_shipping_unverified");
  }

  const addr = order.ship_address || {};
  if (!addr.line1 || !addr.city || !addr.region || !addr.postal || !addr.name) {
    return pauseOrder(order, "bad_address");
  }

  const { data: product } = await sb
    .from("dropship_products")
    .select("*, catalog:supplier_catalog_items(*)")
    .eq("id", order.dropship_product_id)
    .maybeSingle();
  const cat = product?.catalog;
  if (!cat?.ships_from_us) return pauseOrder(order, "not_us_warehouse");

  const supplier = order.supplier || cat.supplier || "cj";
  const { adapter, ctx } = await openAdapter(storeId, supplier);

  // Live stock + balance checks
  const stock = await adapter.liveStock(ctx, cat.supplier_product_id, cat.supplier_variant_id);
  if (!stock.inStock || stock.stockQty < 1) return pauseOrder(order, "out_of_stock");

  const bal = await adapter.getBalance(ctx);
  if (bal.balanceCents != null && bal.balanceCents < (product.cost_cents || 0) + (product.shipping_cents || 0)) {
    return pauseOrder(order, "balance_too_low");
  }

  await sb.from("dropship_orders").update({ status: "placing", updated_at: new Date().toISOString() }).eq("id", order.id);

  try {
    const placed = await adapter.placeOrder(ctx, {
      externalOrderId: order.channel_order_id || order.id,
      supplierProductId: cat.supplier_product_id,
      supplierVariantId: cat.supplier_variant_id,
      sku: cat.raw?.variant?.sku || cat.raw?.sku || undefined,
      quantity: 1,
      warehouseId: cat.warehouse_id,
      address: {
        name: addr.name,
        phone: addr.phone || null,
        line1: addr.line1,
        line2: addr.line2 || null,
        city: addr.city,
        region: addr.region,
        postal: addr.postal,
        country: addr.country || "US",
      },
      storeName: rules.cj_store_name || undefined,
      remark: "Blind ship. Packing slip and invoice: Open Box Industries only. No supplier branding. Fulfil this order only; no marketing use of buyer data.",
    });

    const patch = {
      status: "placed",
      supplier_order_id: placed.supplierOrderId,
      placed_at: new Date().toISOString(),
      cost_cents: placed.chargedCents,
      pause_reason: null,
      updated_at: new Date().toISOString(),
      raw: { ...(order.raw || {}), place: placed.raw },
    };
    if (opts.userId) patch.placed_by = opts.userId;
    await sb.from("dropship_orders").update(patch).eq("id", order.id);

    if ((settings.manual_place_remaining ?? 0) > 0) {
      await sb
        .from("dropship_settings")
        .update({
          manual_place_remaining: settings.manual_place_remaining - 1,
          last_supplier_order_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("store_id", storeId);
    } else {
      await sb
        .from("dropship_settings")
        .update({ last_supplier_order_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("store_id", storeId);
    }

    return { ok: true, supplierOrderId: placed.supplierOrderId };
  } catch (err) {
    return pauseOrder(order, err.message || "place_failed");
  }
}

async function pauseOrder(order, reason) {
  const sb = serviceClient();
  await sb
    .from("dropship_orders")
    .update({
      status: "paused",
      pause_reason: String(reason).slice(0, 500),
      updated_at: new Date().toISOString(),
    })
    .eq("id", order.id);
  await enqueueDropshipAlert(order.store_id, order.sku, `Dropship order paused: ${reason}`, {
    kind_detail: "order_paused",
    order_id: order.id,
    reason,
  });
  return { ok: false, paused: true, reason };
}

export async function pullTrackingAndUpload(storeId, orderId) {
  const sb = serviceClient();
  const { data: order } = await sb.from("dropship_orders").select("*").eq("id", orderId).eq("store_id", storeId).maybeSingle();
  if (!order?.supplier_order_id) return { skipped: true };
  const { adapter, ctx } = await openAdapter(storeId, order.supplier || "cj");
  const track = await adapter.getTracking(ctx, order.supplier_order_id);
  if (!track.trackingNumber) {
    // Late watch
    if (order.handling_deadline_at && new Date(order.handling_deadline_at).getTime() < Date.now()) {
      await enqueueDropshipAlert(storeId, order.sku, `Tracking missing past handling deadline for ${order.supplier_order_id}`, {
        kind_detail: "late_tracking",
        order_id: order.id,
      });
    }
    return { ok: true, tracking: null };
  }

  await sb
    .from("dropship_orders")
    .update({
      tracking_number: track.trackingNumber,
      tracking_carrier: track.carrier,
      status: "tracking",
      updated_at: new Date().toISOString(),
    })
    .eq("id", order.id);

  if (order.channel === "ebay" && order.channel_order_id && !order.tracking_uploaded_at) {
    try {
      // Minimal fulfillment upload — rely on existing ebay order helpers when available.
      await ebayUploadTracking(storeId, order, track);
      await sb
        .from("dropship_orders")
        .update({
          tracking_uploaded_at: new Date().toISOString(),
          status: "shipped",
          updated_at: new Date().toISOString(),
        })
        .eq("id", order.id);
    } catch (err) {
      await enqueueDropshipAlert(storeId, order.sku, `Failed to upload tracking to eBay: ${err.message}`, {
        kind_detail: "tracking_upload_failed",
        order_id: order.id,
      });
    }
  }
  return { ok: true, tracking: track.trackingNumber };
}

async function ebayUploadTracking(storeId, order, track) {
  const { ebayFetch } = await import("../ebay.mjs");
  // Fulfillment API: createShippingFulfillment
  await ebayFetch(
    storeId,
    "POST",
    `/sell/fulfillment/v1/order/${encodeURIComponent(order.channel_order_id)}/shipping_fulfillment`,
    {
      lineItems: [{ lineItemId: order.raw?.line_item_id || undefined, quantity: 1 }],
      shippedDate: new Date().toISOString(),
      shippingCarrierCode: track.carrier || "OTHER",
      trackingNumber: track.trackingNumber,
    },
  );
}

export async function recomputeHealth(storeId) {
  const sb = serviceClient();
  const { data: orders } = await sb
    .from("dropship_orders")
    .select("status, tracking_number, tracking_uploaded_at, handling_deadline_at, created_at")
    .eq("store_id", storeId)
    .order("created_at", { ascending: false })
    .limit(200);
  const sample = orders || [];
  const n = sample.length || 1;
  let late = 0;
  let tracked = 0;
  let defects = 0; // reserved — filled when returns mark DS- defects
  for (const o of sample) {
    if (o.tracking_number) tracked += 1;
    if (
      o.handling_deadline_at &&
      !o.tracking_uploaded_at &&
      new Date(o.handling_deadline_at).getTime() < Date.now()
    ) {
      late += 1;
    }
  }
  const latePct = (late / n) * 100;
  const trackingPct = (tracked / n) * 100;
  const defectPct = (defects / n) * 100;

  await sb.from("dropship_health").upsert({
    store_id: storeId,
    late_pct: latePct,
    tracking_pct: trackingPct,
    defect_pct: defectPct,
    orders_sample: sample.length,
    computed_at: new Date().toISOString(),
  });

  const { data: settings } = await sb.from("dropship_settings").select("*").eq("store_id", storeId).maybeSingle();
  const ap = settings?.settings?.auto_pause || { late_pct: 3, tracking_pct_min: 96, defect_pct: 0.8 };
  if (settings?.enabled && sample.length >= 10) {
    let reason = null;
    if (latePct >= Number(ap.late_pct ?? 3)) reason = `late_pct ${latePct.toFixed(2)}%`;
    if (trackingPct < Number(ap.tracking_pct_min ?? 96)) reason = `tracking_pct ${trackingPct.toFixed(2)}%`;
    if (defectPct >= Number(ap.defect_pct ?? 0.8)) reason = `defect_pct ${defectPct.toFixed(2)}%`;
    if (reason && !settings.paused) {
      await sb
        .from("dropship_settings")
        .update({ paused: true, pause_reason: reason, updated_at: new Date().toISOString() })
        .eq("store_id", storeId);
      await enqueueDropshipAlert(storeId, "DS-", `Dropship auto-paused: ${reason}`, { kind_detail: "auto_pause" });
    }
  }
  if (settings) await checkKeepAlive(storeId, settings);
  return { latePct, trackingPct, defectPct, sample: sample.length };
}

/** Hard-block: Depop / Mercari must never list DS- SKUs. */
export function assertChannelAllowsDropship(channel, sku) {
  if (!isDropshipSku(sku)) return;
  const ch = String(channel || "").toLowerCase();
  if (ch === "depop" || ch === "mercari") {
    const err = new Error(`dropship_blocked_on_${ch}`);
    err.code = "dropship_channel_blocked";
    throw err;
  }
}
