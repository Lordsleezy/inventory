import { cancelAndRefund } from "./web-payment.mjs";
import { deliverOrderEmails } from "./web-order-email.mjs";

const DAY = 24 * 60 * 60 * 1000;

/** Day-2 reminders, auto-cancel + full refund after the pickup deadline, and refund retries. */
export async function pickupSweep(sb, { now = new Date(), cancel = cancelAndRefund, deliver = deliverOrderEmails } = {}) {
  const out = { reminded: [], expired: [], retried: [], errors: [] };
  const iso = now.toISOString();

  const { data: due, error: dueError } = await sb.from("web_orders").select("*")
    .eq("fulfillment", "pickup").eq("status", "paid").is("picked_up_at", null).is("refund_requested_at", null)
    .is("pickup_reminder_sent_at", null).gt("pickup_deadline", iso).lte("pickup_deadline", new Date(now.getTime() + DAY).toISOString());
  if (dueError) throw dueError;
  for (const o of due || []) {
    const { data: u } = await sb.from("units").select("title,brand,model").eq("store_id", o.store_id).eq("sku", o.sku).maybeSingle();
    const title = u?.title?.trim() || [u?.brand, u?.model].filter(Boolean).join(" ") || o.sku;
    const { payment_source_id: _drop, ...payload } = o;
    const { error } = await sb.from("web_order_emails").upsert({ order_id: o.id, kind: "pickup_reminder", payload: { ...payload, title } },
      { onConflict: "order_id,kind", ignoreDuplicates: true });
    if (error) { out.errors.push({ id: o.id, step: "reminder", error: error.message }); continue; }
    await sb.from("web_orders").update({ pickup_reminder_sent_at: iso }).eq("id", o.id);
    out.reminded.push(o.order_no || o.id);
  }

  const { data: late, error: lateError } = await sb.from("web_orders").select("id,store_id,order_no")
    .eq("fulfillment", "pickup").eq("status", "paid").is("picked_up_at", null).is("refund_requested_at", null).lt("pickup_deadline", iso);
  if (lateError) throw lateError;
  for (const o of late || []) {
    const r = await cancel(sb, o.store_id, o.id, "pickup_expired", "Not picked up by the deadline");
    (r.ok ? out.expired : out.errors).push(r.ok ? (o.order_no || o.id) : { id: o.id, step: "expire", error: r.error });
  }

  const { data: stuck, error: stuckError } = await sb.from("web_orders").select("id,store_id,order_no,cancel_source,cancel_reason")
    .eq("status", "paid").not("refund_requested_at", "is", null).lt("refund_requested_at", new Date(now.getTime() - 2 * 60 * 1000).toISOString());
  if (stuckError) throw stuckError;
  for (const o of stuck || []) {
    const r = await cancel(sb, o.store_id, o.id, o.cancel_source || "admin", o.cancel_reason);
    (r.ok ? out.retried : out.errors).push(r.ok ? (o.order_no || o.id) : { id: o.id, step: "retry", error: r.error });
  }

  await deliver(sb).catch(() => []);
  return out;
}
