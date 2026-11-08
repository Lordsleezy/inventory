/**
 * One digest when orders are waiting on a label PDF.
 * Owner alerts go through Gmail SMTP (sendInternalAlert), to pgg124@gmail.com.
 */
import { sendInternalAlert } from "./mail.mjs";

const TO = "pgg124@gmail.com";

export function orderStillNeedsLabel(order) {
  if (!order) return false;
  const ch = String(order.channel || "").toLowerCase();
  if (ch !== "ebay" && ch !== "depop") return false;
  if (order.status !== "paid" || order.fulfillment !== "ship") return false;
  if (order.packaged_at || order.shipped_at || order.delivered_at) return false;
  if (String(order.ebay_seller_username || "").toLowerCase() === "pgg124-5") return false;
  if (order.label_tracking_mismatch) return true;
  if (order.label_storage_path) return false;
  if (order.label_origin === "upload" || order.label_origin === "bought") return false;
  if (order.label_url) return false;
  return true;
}

export async function sendLabelNeededDigest(sb, deps = {}) {
  const { data: notes, error } = await sb
    .from("label_needed_notices")
    .select("id,store_id,order_id")
    .is("sent_at", null)
    .order("created_at", { ascending: true })
    .limit(40);
  if (error) return { ok: false, error: error.message };
  if (!notes?.length) return { ok: true, sent: 0 };

  const { data: orders, error: orderError } = await sb
    .from("web_orders")
    .select("id,store_id,sku,marketplace_title,channel,item_cents,order_no,label_storage_path,label_origin,label_url,label_tracking_mismatch,packaged_at,shipped_at,delivered_at,status,fulfillment,ebay_seller_username")
    .in("id", notes.map((n) => n.order_id));
  if (orderError) return { ok: false, error: orderError.message };

  const byId = new Map((orders || []).map((o) => [o.id, o]));
  const clear = [];
  const waiting = [];
  for (const note of notes) {
    const order = byId.get(note.order_id);
    if (!orderStillNeedsLabel(order)) clear.push(note.id);
    else waiting.push({ note, order });
  }
  const now = new Date().toISOString();
  if (clear.length) {
    await sb.from("label_needed_notices").update({ sent_at: now }).in("id", clear);
  }
  if (!waiting.length) return { ok: true, sent: 0, cleared: clear.length };

  const storeId = waiting[0].order.store_id;
  const skus = [...new Set(waiting.map((row) => row.order.sku).filter(Boolean))];
  const { data: locs } = await sb
    .from("unit_pick_locations")
    .select("sku,location_code")
    .eq("store_id", storeId)
    .in("sku", skus);
  const bay = new Map((locs || []).map((row) => [row.sku, row.location_code]));
  const lines = waiting.map(({ order }) => {
    const price = (Number(order.item_cents || 0) / 100).toFixed(2);
    const title = order.marketplace_title || "Item";
    return `${title} · SKU ${order.sku} · ${order.channel} · $${price} · ${bay.get(order.sku) || "no bay"} · ${order.order_no || ""}`;
  });
  const subject = waiting.length === 1
    ? `Needs label · SKU ${waiting[0].order.sku}`
    : `Needs label · ${waiting.length} orders`;
  const text = [
    "These orders need a label PDF before the warehouse can ship them.",
    "",
    ...lines,
  ].join("\n");
  const send = deps.send || sendInternalAlert;
  const result = await send({ to: TO, subject, text });
  if (result?.skipped) return { ok: true, sent: 0, skipped: result.reason, waiting: waiting.length };
  await sb.from("label_needed_notices").update({ sent_at: now }).in("id", waiting.map((row) => row.note.id));
  return { ok: true, sent: waiting.length };
}
