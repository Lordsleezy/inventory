/**
 * TikTok Shop Partner API connector stub.
 *
 * TikTok Shop is not connected yet. This module documents the integration surface
 * and provides a safe no-op sync that becomes live once credentials exist.
 *
 * Required env (Netlify) once approved:
 *   TIKTOK_SHOP_APP_KEY
 *   TIKTOK_SHOP_APP_SECRET
 *   TIKTOK_SHOP_ACCESS_TOKEN   (or store encrypted in connections.provider = 'tiktok')
 *   TIKTOK_SHOP_SHOP_ID
 *   TIKTOK_SHOP_API_BASE       (optional; default US shop API host)
 *
 * Partner docs (verify current URLs in TikTok Shop Partner Center):
 *   - Auth / shops: Partner Center → authorize shop → access token
 *   - Orders: GET /order/202309/orders/search (or current versioned path)
 *   - Returns/refunds: GET /return_refund/202309/returns/search
 *
 * When credentials are present, poll returns/refunds and call ingest_channel_return
 * with channel='tiktok', needs_decision=true, decision window 48h (settings).
 */

import { serviceClient } from "./server.mjs";
import { ingestReturnRow } from "./returns.mjs";

export const STORE_DEFAULT = "5487ca47-6147-4fe8-bc6d-46b6472726ba";

export function tiktokConfigured() {
  return Boolean(
    (process.env.TIKTOK_SHOP_APP_KEY || "").trim() &&
      (process.env.TIKTOK_SHOP_APP_SECRET || "").trim() &&
      (process.env.TIKTOK_SHOP_ACCESS_TOKEN || "").trim() &&
      (process.env.TIKTOK_SHOP_SHOP_ID || "").trim(),
  );
}

export function tiktokSetupChecklist() {
  return [
    "Create a TikTok Shop Partner account at partner.tiktokshop.com (or regional equivalent).",
    "Register an app for Open Box Industries / Floor; request Orders + Return/Refund scopes.",
    "Complete app review / seller authorization for the US shop.",
    "Copy App Key, App Secret, Shop ID, and Access Token (or refresh-token flow).",
    "Set Netlify env: TIKTOK_SHOP_APP_KEY, TIKTOK_SHOP_APP_SECRET, TIKTOK_SHOP_ACCESS_TOKEN, TIKTOK_SHOP_SHOP_ID.",
    "Optionally store the access token encrypted in connections (provider=tiktok) like Amazon.",
    "Redeploy inventoryobi Netlify site so returns-sync / tiktok-returns-sync pick up env.",
    "Smoke-test: POST /.netlify/functions/tiktok-returns-sync with {\"action\":\"status\"}.",
    "Confirm return_decision alerts hit obitracking@gmail.com within minutes of a test RMA.",
  ];
}

/**
 * Normalize a TikTok return/refund payload into ingest_channel_return shape.
 * Field names vary by API version — keep this adapter thin and update when live.
 */
export function mapTikTokReturn(row = {}) {
  const id = String(row.return_id || row.returnId || row.id || "").trim();
  const orderId = String(row.order_id || row.orderId || row.order_sn || "").trim();
  const sku = String(
    row.seller_sku || row.sellerSku || row.sku || row.product_sku || "",
  ).trim();
  const statusRaw = String(row.return_status || row.status || "").toLowerCase();
  let status = "requested";
  if (/approved|agree/.test(statusRaw)) status = "approved";
  else if (/ship|transit/.test(statusRaw)) status = "in_transit";
  else if (/receiv|complete|success/.test(statusRaw)) status = "received";
  else if (/reject|deny|cancel/.test(statusRaw)) status = "denied";
  else if (/refund.?only|returnless/.test(statusRaw)) status = "refunded_no_return";

  const refund =
    Number(row.refund_amount?.amount || row.refund_amount || row.refundAmount || 0) || 0;
  // Assume major currency units unless value looks like already-cents.
  const refundCents = refund > 0 && refund < 1000 && !Number.isInteger(refund)
    ? Math.round(refund * 100)
    : refund < 50 && Number.isInteger(refund)
      ? refund * 100
      : Math.round(refund);

  return {
    channel: "tiktok",
    external_return_id: id || (orderId ? `tiktok:${orderId}:${sku || "item"}` : null),
    external_order_id: orderId || null,
    sku: sku || null,
    reason: row.return_reason || row.reason || row.buyer_reason || "other",
    status,
    needs_decision: status === "requested",
    refund_cents: refundCents,
    return_label_cents: 0,
    label_paid_by: "unknown",
    raw: row,
  };
}

export async function syncTikTokReturns(storeId = STORE_DEFAULT) {
  if (!tiktokConfigured()) {
    return {
      ok: false,
      skipped: true,
      reason: "tiktok_not_configured",
      checklist: tiktokSetupChecklist(),
    };
  }

  // Live HTTP calls intentionally omitted until Partner API paths are confirmed
  // for this shop's region/version. Wire fetch here, then:
  //   for (const row of apiRows) await ingestReturnRow(storeId, mapTikTokReturn(row));
  const sb = serviceClient();
  await sb.from("connections").upsert(
    {
      store_id: storeId,
      provider: "tiktok",
      status: "connected",
      account_label: process.env.TIKTOK_SHOP_SHOP_ID || null,
      updated_at: new Date().toISOString(),
      last_error: "connector_ready_waiting_for_api_paths",
    },
    { onConflict: "store_id,provider" },
  );

  return {
    ok: true,
    stub: true,
    note: "Credentials present; implement versioned returns search when Partner API paths are confirmed.",
    ingested: 0,
  };
}

/** Manual test helper: ingest a synthetic TikTok return (dev / admin only). */
export async function ingestTikTokFixture(storeId, fixture) {
  return ingestReturnRow(storeId, mapTikTokReturn(fixture));
}
