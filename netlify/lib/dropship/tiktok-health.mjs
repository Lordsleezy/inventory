import { serviceClient } from "../server.mjs";
import { enqueueDropshipAlert } from "./alerts.mjs";

/**
 * Pull TikTok shop performance if the API exposes it; otherwise leave nulls.
 * Pause only the TikTok channel (not the whole master switch) when thresholds trip.
 */
export async function refreshTikTokShopHealth(storeId) {
  const sb = serviceClient();
  let late = null;
  let cancel = null;
  let refund = null;
  let source = "unavailable";

  try {
    const { tiktokApiFetch } = await import("../tiktok-shop.mjs");
    // Best-effort: performance endpoints vary by shop API version.
    const res = await tiktokApiFetch(storeId, "GET", "/analytics/202405/shop/performance", {}).catch(() => null);
    const data = res?.data || res;
    if (data) {
      late = num(data.late_dispatch_rate ?? data.lateDispatchRate ?? data.fulfillment_late_rate);
      cancel = num(data.cancellation_rate ?? data.cancelRate);
      refund = num(data.refund_rate ?? data.refundRate);
      source = "tiktok_api";
    }
  } catch {
    source = "unavailable";
  }

  await sb.from("dropship_health").upsert(
    {
      store_id: storeId,
      tiktok_late_dispatch_pct: late,
      tiktok_cancel_pct: cancel,
      tiktok_refund_pct: refund,
      computed_at: new Date().toISOString(),
    },
    { onConflict: "store_id" },
  );

  const { data: settings } = await sb.from("dropship_settings").select("*").eq("store_id", storeId).maybeSingle();
  const th = settings?.settings?.tiktok_health_pause || {
    late_dispatch_pct: 5,
    cancel_pct: 5,
    refund_pct: 8,
  };
  if (settings?.tiktok_channel_on && source === "tiktok_api") {
    let reason = null;
    if (late != null && late >= Number(th.late_dispatch_pct ?? 5)) reason = `tiktok_late_dispatch ${late}%`;
    if (cancel != null && cancel >= Number(th.cancel_pct ?? 5)) reason = `tiktok_cancel ${cancel}%`;
    if (refund != null && refund >= Number(th.refund_pct ?? 8)) reason = `tiktok_refund ${refund}%`;
    if (reason) {
      await sb
        .from("dropship_settings")
        .update({ tiktok_channel_on: false, updated_at: new Date().toISOString() })
        .eq("store_id", storeId);
      await enqueueDropshipAlert(storeId, "DS-", `TikTok dropship channel paused: ${reason}`, {
        kind_detail: "tiktok_health_pause",
        reason,
      });
    }
  }

  return { late, cancel, refund, source };
}

function num(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
