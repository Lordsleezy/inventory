import { serviceClient } from "../server.mjs";
import { enqueueDropshipAlert } from "./alerts.mjs";

/**
 * Per-supplier reliability from dropship_orders + return links.
 * Slipping suppliers get paused (meta flag) and Paul gets an alert.
 */
export async function recomputeSupplierReliability(storeId) {
  const sb = serviceClient();
  const { data: orders } = await sb
    .from("dropship_orders")
    .select("id, supplier, status, pause_reason, tracking_number, tracking_uploaded_at, handling_deadline_at")
    .eq("store_id", storeId)
    .order("created_at", { ascending: false })
    .limit(300);

  const by = new Map();
  for (const o of orders || []) {
    const s = o.supplier || "cj";
    const row = by.get(s) || {
      supplier: s,
      orders: 0,
      late: 0,
      missing_tracking: 0,
      out_of_stock: 0,
      defects: 0,
      returns: 0,
    };
    row.orders += 1;
    if (o.pause_reason === "out_of_stock") row.out_of_stock += 1;
    if (
      o.handling_deadline_at &&
      !o.tracking_uploaded_at &&
      new Date(o.handling_deadline_at).getTime() < Date.now()
    ) {
      row.late += 1;
    }
    if (["placed", "tracking", "shipped"].includes(o.status) && !o.tracking_number) {
      row.missing_tracking += 1;
    }
    by.set(s, row);
  }

  const { data: links } = await sb
    .from("dropship_return_links")
    .select("dropship_order_id")
    .eq("store_id", storeId);
  const orderIds = new Set((links || []).map((l) => l.dropship_order_id));
  if (orderIds.size) {
    const { data: retOrders } = await sb
      .from("dropship_orders")
      .select("id, supplier")
      .in("id", [...orderIds]);
    for (const o of retOrders || []) {
      const row = by.get(o.supplier || "cj");
      if (row) row.returns += 1;
    }
  }

  const scores = {};
  for (const [supplier, row] of by) {
    const n = Math.max(1, row.orders);
    const lateRate = row.late / n;
    const missRate = row.missing_tracking / n;
    const oosRate = row.out_of_stock / n;
    const returnRate = row.returns / n;
    // 100 = perfect; penalties stack.
    const score = Math.max(
      0,
      Math.round(100 - lateRate * 40 - missRate * 25 - oosRate * 20 - returnRate * 30),
    );
    scores[supplier] = { ...row, score, lateRate, missRate, oosRate, returnRate, paused: false };
  }

  const { data: settings } = await sb.from("dropship_settings").select("*").eq("store_id", storeId).maybeSingle();
  const minScore = Number(settings?.settings?.supplier_min_score ?? 60);
  for (const [supplier, row] of Object.entries(scores)) {
    if (row.orders >= 5 && row.score < minScore) {
      row.paused = true;
      await sb
        .from("dropship_supplier_credentials")
        .update({
          meta: { reliability_paused: true, reliability: row },
          last_error: `reliability_score_${row.score}`,
          updated_at: new Date().toISOString(),
        })
        .eq("store_id", storeId)
        .eq("supplier", supplier);
      await enqueueDropshipAlert(storeId, "DS-", `Supplier ${supplier} auto-paused (reliability ${row.score}).`, {
        kind_detail: "supplier_reliability_pause",
        supplier,
        score: row.score,
      });
    }
  }

  await sb.from("dropship_health").upsert(
    {
      store_id: storeId,
      supplier_reliability: scores,
      computed_at: new Date().toISOString(),
    },
    { onConflict: "store_id" },
  );

  return scores;
}

/** Flag products whose return rate exceeds threshold; optionally end all channels. */
export async function flagHighReturnProducts(storeId) {
  const sb = serviceClient();
  const { data: settings } = await sb.from("dropship_settings").select("settings").eq("store_id", storeId).maybeSingle();
  const threshold = Number(settings?.settings?.product_return_flag_pct ?? 12) / 100;

  const { data: products } = await sb
    .from("dropship_products")
    .select("id, sku, status")
    .eq("store_id", storeId)
    .eq("status", "listed");

  const flagged = [];
  for (const p of products || []) {
    const { count: orderCount } = await sb
      .from("dropship_orders")
      .select("id", { count: "exact", head: true })
      .eq("store_id", storeId)
      .eq("sku", p.sku);
    if ((orderCount || 0) < 5) continue;
    const { data: orderRows } = await sb.from("dropship_orders").select("id").eq("store_id", storeId).eq("sku", p.sku);
    const ids = (orderRows || []).map((o) => o.id);
    if (!ids.length) continue;
    const { count: retCount } = await sb
      .from("dropship_return_links")
      .select("id", { count: "exact", head: true })
      .eq("store_id", storeId)
      .in("dropship_order_id", ids);
    const rate = (retCount || 0) / (orderCount || 1);
    if (rate >= threshold) {
      flagged.push({ sku: p.sku, productId: p.id, rate, orders: orderCount, returns: retCount });
      await enqueueDropshipAlert(storeId, p.sku, `Dropship product flagged: return rate ${(rate * 100).toFixed(1)}%`, {
        kind_detail: "product_return_flag",
        rate,
      });
    }
  }
  return flagged;
}

export async function endDropshipProductAllChannels(storeId, productId) {
  const sb = serviceClient();
  const { data: product } = await sb
    .from("dropship_products")
    .select("*")
    .eq("id", productId)
    .eq("store_id", storeId)
    .maybeSingle();
  if (!product) throw new Error("product_not_found");

  const results = { ebay: null, tiktok: null, website: null };
  if (product.ebay_offer_id || product.channel === "ebay") {
    try {
      const { ebayFetch } = await import("../ebay.mjs");
      if (product.ebay_offer_id) {
        await ebayFetch(storeId, "POST", `/sell/inventory/v1/offer/${product.ebay_offer_id}/withdraw`, {});
      }
      results.ebay = { ok: true };
    } catch (err) {
      results.ebay = { ok: false, error: err.message };
    }
  }
  if (product.tiktok_product_id || product.channel === "tiktok") {
    try {
      const { delistTikTokSku } = await import("../tiktok-shop.mjs");
      await delistTikTokSku(storeId, product.sku);
      results.tiktok = { ok: true };
    } catch (err) {
      results.tiktok = { ok: false, error: err.message };
    }
  }
  results.website = { ok: true }; // status flip is enough

  await sb
    .from("dropship_products")
    .update({ status: "ended", ended_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", product.id);
  await sb
    .from("listings")
    .update({ status: "ended", delisted_at: new Date().toISOString() })
    .eq("store_id", storeId)
    .eq("sku", product.sku);

  await enqueueDropshipAlert(storeId, product.sku, `Ended DS- ${product.sku} on all dropship channels.`, {
    kind_detail: "end_product_all_channels",
    results,
  });
  return results;
}
