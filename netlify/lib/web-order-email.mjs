import { sendResend } from "./receipt.mjs";

const money = (n) => `$${(Number(n || 0) / 100).toFixed(2)}`;
const ZONE = "America/Los_Angeles";
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const STORE_ADDRESS = "3121 Penryn Rd Suite 320, Penryn, CA 95663";
export const STORE_PHONE = "(279) 977-0722";

function clock(t) {
  const [h, m] = String(t).split(":").map(Number);
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h >= 12 ? "pm" : "am"}`;
}
export function hoursText(hours) {
  return DAYS.map((d, i) => {
    const day = hours?.[String(i)];
    return `${d}: ${Array.isArray(day) ? `${clock(day[0])}–${clock(day[1])}` : "Closed"}`;
  }).join("\n");
}
export function when(ts) {
  return new Intl.DateTimeFormat("en-US", { timeZone: ZONE, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(ts));
}

export function orderEmail(kind, o, ctx = {}) {
  const item = `${o.title || "Item"} (SKU ${o.sku})`;
  const ref = o.order_no || o.id;
  const pickup = o.fulfillment === "pickup";
  const address = [o.buyer_name, o.ship_line1, o.ship_line2, [o.ship_city, o.ship_region, o.ship_postal].filter(Boolean).join(", "), o.ship_country].filter(Boolean).join("\n");
  const visit = [`Pick up at: Open Box Industries, ${STORE_ADDRESS}`, `Phone: ${STORE_PHONE}`, "", "Store hours:", hoursText(ctx.hours)].join("\n");
  if (kind === "tracking") return {
    subject: `Your Open Box Industries order ${ref} shipped`,
    text: [`Hi ${o.buyer_name || "there"},`, "", `${item} is on the way.`,
      o.carrier ? `Carrier: ${o.carrier}${o.service ? ` ${o.service}` : ""}` : "",
      `Tracking number: ${o.tracking_number}`, o.tracking_url ? `Track it: ${o.tracking_url}` : "", "", "Open Box Industries"].filter(l => l !== "").join("\n"),
  };
  if (kind === "pickup_reminder") return {
    subject: `Reminder: pick up order ${ref} by ${when(o.pickup_deadline)}`,
    text: [`Hi ${o.buyer_name || "there"},`, "",
      `${item} is paid for and waiting for you.`,
      `Please pick it up by ${when(o.pickup_deadline)}. After that the order is canceled and refunded in full, and the item goes back on sale.`,
      "", `Order number: ${ref}`, "Bring this order number and the name on the order.", "", visit, "", "Open Box Industries"].join("\n"),
  };
  if (kind === "canceled" || kind === "owner_canceled") {
    const why = o.cancel_source === "pickup_expired" ? "it was not picked up by the deadline" : (o.cancel_reason || "it was canceled by the store");
    return {
      subject: kind === "owner_canceled" ? `Online order ${ref} canceled and refunded — ${o.sku}` : `Order ${ref} canceled and refunded`,
      text: [kind === "owner_canceled" ? `Order ${ref} was canceled because ${why}. The unit is back on sale.` : `Hi ${o.buyer_name || "there"},\n\nYour order ${ref} was canceled because ${why}.`,
        "", item, `Refunded in full: ${money(o.total_cents)} to the card you paid with. Banks usually post refunds within 5–10 business days.`,
        kind === "canceled" ? `\nQuestions? Call ${STORE_PHONE}.` : `Buyer: ${o.buyer_name || ""} ${o.buyer_email || ""} ${o.buyer_phone || ""}`,
        "", "Open Box Industries"].join("\n"),
    };
  }
  const q = o.checkout_quote || {};
  const lines = [
    `Order number: ${ref}`, item, `Item: ${money(o.item_cents)}`,
    `Discount / credit: ${money(Number(q.discount_cents || 0) + Number(q.signup_discount_cents || 0) + Number(q.redeem_cents || 0))}`,
    pickup ? "Store pickup: free" : `Shipping${o.carrier ? ` (${o.carrier} ${o.service || ""})`.replace(/ \)$/, ")") : ""}: ${money(o.shipping_cents)}`,
    `Tax: ${money(o.tax_cents)}`, `Card fee: ${money(q.card_fee_cents)}`, `Total paid: ${money(o.total_cents)}`,
  ];
  if (kind === "owner") return {
    subject: `New online ${pickup ? "PICKUP" : "SHIPPING"} order ${ref} — ${item}`,
    text: [pickup ? `Paid store-pickup order. Customer must pick up by ${when(o.pickup_deadline)}.` : "Paid order ready to pack. Buy the label in Floor Admin → Orders.",
      "", ...lines, "", pickup ? "Customer:" : "Ship to:", pickup ? o.buyer_name : address,
      `Email: ${o.buyer_email || ""}`, `Phone: ${o.buyer_phone || ""}`, "", "Open Box Industries"].join("\n"),
  };
  return {
    subject: pickup ? `Order ${ref}: ready for pickup at Open Box Industries` : `Your Open Box Industries order ${ref}`,
    text: [`Hi ${o.buyer_name || "there"},`, "",
      pickup ? `Thank you! Your order is paid and set aside for you. Pick it up by ${when(o.pickup_deadline)}.` : "Thank you! Your order is paid. We will email tracking when it ships.",
      "", ...lines, "",
      ...(pickup ? ["Bring your order number and the name on the order. Large items: bring a vehicle that fits it; we can help load.",
        `If it is not picked up by ${when(o.pickup_deadline)}, the order is canceled and refunded in full.`, "", visit]
        : ["Ship to:", address]),
      "", `Email: ${o.buyer_email || ""}`, `Phone: ${o.buyer_phone || ""}`, "", "Open Box Industries"].join("\n"),
  };
}

export async function ownerEmails(sb, storeId) {
  const { data } = await sb.from("store_settings").select("value").eq("store_id", storeId).eq("key", "order_notify_emails").maybeSingle();
  const list = Array.isArray(data?.value) ? data.value.filter(x => typeof x === "string" && x.includes("@")) : [];
  if (list.length) return list;
  return (process.env.FLOOR_OWNER_EMAIL || "").split(",").map(s => s.trim()).filter(Boolean);
}

async function storeHours(sb, storeId, cache) {
  if (!storeId) return {};
  if (!cache.has(storeId)) {
    const { data } = await sb.from("store_settings").select("value").eq("store_id", storeId).eq("key", "store_hours").maybeSingle();
    cache.set(storeId, data?.value || {});
  }
  return cache.get(storeId);
}

export async function deliverOrderEmails(sb, orderId) {
  let query = sb.from("web_order_emails").select("*").is("sent_at", null).order("created_at").limit(30);
  if (orderId) query = query.eq("order_id", orderId);
  const { data: rows, error } = await query;
  if (error) throw error;
  const results = [];
  const hours = new Map();
  for (const row of rows || []) {
    try {
      const owner = row.kind === "owner" || row.kind === "owner_canceled";
      const to = owner ? await ownerEmails(sb, row.payload.store_id) : [row.payload.buyer_email].filter(Boolean);
      if (!to.length) throw new Error(owner ? "missing_owner_emails" : "missing_buyer_email");
      const message = orderEmail(row.kind, row.payload, { hours: await storeHours(sb, row.payload.store_id, hours) });
      for (const [i, addr] of to.entries()) {
        const result = await sendResend({ to: addr, ...message, idempotencyKey: `web-order-${row.id}${i ? `-${i}` : ""}` });
        if (!result.ok) throw new Error(result.reason || "email_not_sent");
      }
      const { error: updateError } = await sb.from("web_order_emails").update({ sent_at: new Date().toISOString(), last_error: null }).eq("id", row.id);
      if (updateError) throw updateError;
      results.push({ kind: row.kind, ok: true });
    } catch (err) {
      await sb.from("web_order_emails").update({ last_error: String(err.message || err).slice(0, 500) }).eq("id", row.id);
      results.push({ kind: row.kind, ok: false });
    }
  }
  return results;
}
