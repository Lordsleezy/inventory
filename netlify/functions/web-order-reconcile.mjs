import { serviceClient, json, corsHeaders } from "../lib/server.mjs";
import { settleShippingOrder } from "../lib/web-payment.mjs";
import { wrapHandler, asNetlifyFunction } from "../lib/floor-log.mjs";
import { isNetlifyScheduleEvent } from "../lib/schedule.mjs";

async function handle(event) {
  if (event?.httpMethod === "OPTIONS") return { statusCode: 200, headers: corsHeaders(), body: "" };
  const sb = serviceClient();
  const { data, error } = await sb
    .from("web_orders")
    .select("*")
    .eq("status", "claimed")
    .not("payment_started_at", "is", null)
    .lt("payment_started_at", new Date(Date.now() - 60000).toISOString())
    .order("payment_started_at")
    .limit(20);
  if (error) throw error;
  const results = [];
  for (const order of data || []) {
    try {
      const result = await settleShippingOrder(sb, order);
      results.push({ id: order.id, status: result.statusCode });
    } catch {
      results.push({ id: order.id, status: 503 });
    }
  }
  return json(200, { results, schedule: isNetlifyScheduleEvent(event) });
}

export const invoke = wrapHandler("web-order-reconcile", handle);

export default asNetlifyFunction(invoke);
