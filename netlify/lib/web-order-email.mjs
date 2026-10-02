import { sendResend } from "./receipt.mjs";

const money = (n) => `$${(Number(n || 0) / 100).toFixed(2)}`;
export function orderEmail(kind, o) {
  const item = `${o.title || "Item"} (SKU ${o.sku})`;
  const address = [o.buyer_name, o.ship_line1, o.ship_line2, [o.ship_city, o.ship_region, o.ship_postal].filter(Boolean).join(", "), o.ship_country].filter(Boolean).join("\n");
  if (kind === "tracking") return {
    subject: `Your Open Box Industries order shipped — ${o.sku}`,
    text: `Hi ${o.buyer_name || "there"},\n\n${item} is on the way.\nTracking number: ${o.tracking_number}\n\nOpen Box Industries`,
  };
  const q = o.checkout_quote || {};
  return {
    subject: kind === "owner" ? `New online order — ${item}` : `Your Open Box Industries order — ${o.sku}`,
    text: [kind === "owner" ? "Paid order ready to pack." : "Thank you! Your order is paid. We will email tracking when it ships.",
      `Order: ${o.id}`, item, `Item: ${money(o.item_cents)}`,
      `Discount / credit: ${money(Number(q.discount_cents || 0) + Number(q.signup_discount_cents || 0) + Number(q.redeem_cents || 0))}`,
      `Shipping: ${money(o.shipping_cents)}`, `Tax: ${money(o.tax_cents)}`,
      `Card fee: ${money(q.card_fee_cents)}`, `Total paid: ${money(o.total_cents)}`,
      "", "Ship to:", address, `Email: ${o.buyer_email || ""}`, `Phone: ${o.buyer_phone || ""}`, "", "Open Box Industries"].join("\n"),
  };
}

export async function deliverOrderEmails(sb, orderId) {
  let query = sb.from("web_order_emails").select("*").is("sent_at", null).order("created_at").limit(30);
  if (orderId) query = query.eq("order_id", orderId);
  const { data: rows, error } = await query;
  if (error) throw error;
  const results = [];
  for (const row of rows || []) {
    try {
      const to = row.kind === "owner" ? process.env.FLOOR_OWNER_EMAIL : row.payload.buyer_email;
      if (!to) throw new Error(row.kind === "owner" ? "missing_FLOOR_OWNER_EMAIL" : "missing_buyer_email");
      const result = await sendResend({ to, ...orderEmail(row.kind, row.payload), idempotencyKey: `web-order-${row.id}` });
      if (!result.ok) throw new Error(result.reason || "email_not_sent");
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
