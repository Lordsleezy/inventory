import { serviceClient } from "../lib/server.mjs";
import { settleShippingOrder } from "../lib/web-payment.mjs";
export const handler = async () => {
  const sb = serviceClient();
  const { data, error } = await sb.from("web_orders").select("*").eq("status", "claimed")
    .not("payment_started_at", "is", null).lt("payment_started_at", new Date(Date.now() - 60000).toISOString())
    .order("payment_started_at").limit(20);
  if (error) throw error;
  const results = [];
  for (const order of data || []) {
    try { const result = await settleShippingOrder(sb, order); results.push({ id: order.id, status: result.statusCode }); }
    catch { results.push({ id: order.id, status: 503 }); }
  }
  return { statusCode: 200, body: JSON.stringify(results) };
};
