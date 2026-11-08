import { serviceClient } from "../server.mjs";

/** Queue a dropship alert through the existing alert_outbox → dispatch-alerts path. */
export async function enqueueDropshipAlert(storeId, sku, message, extra = {}) {
  const sb = serviceClient();
  const { error } = await sb.from("alert_outbox").insert({
    store_id: storeId,
    kind: "dropship",
    sku: sku || "DS-",
    payload: {
      message: String(message || "").slice(0, 2000),
      ...extra,
      at: new Date().toISOString(),
    },
  });
  if (error) throw error;
}

export async function checkKeepAlive(storeId, settingsRow) {
  const last = settingsRow?.last_supplier_order_at
    ? new Date(settingsRow.last_supplier_order_at).getTime()
    : null;
  if (!last) {
    // No orders yet — warn once the feature is enabled that API suspends after 30 days idle.
    if (settingsRow?.enabled) {
      await enqueueDropshipAlert(
        storeId,
        "DS-",
        "Dropship is ON but no supplier order has been placed yet. CJ suspends API access after 30 days with zero orders — place a small real order before then. Bot will never auto-spend to keep-alive.",
        { kind_detail: "keepalive_never_ordered" },
      );
    }
    return;
  }
  const days = (Date.now() - last) / (86400_000);
  if (days >= 23) {
    const left = Math.max(0, Math.ceil(30 - days));
    await enqueueDropshipAlert(
      storeId,
      "DS-",
      `CJ API keep-alive: last supplier order was ${Math.floor(days)} days ago. About ${left} day(s) until possible API suspension. Place a small real order — the bot will not auto-spend.`,
      { kind_detail: "keepalive_warning", days_since_order: Math.floor(days) },
    );
  }
}
