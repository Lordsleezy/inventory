import { randomUUID } from "node:crypto";
import { json } from "./server.mjs";
import { webSquareClient, webSquareConfig } from "./web-square.mjs";
import { deliverOrderEmails } from "./web-order-email.mjs";
import { refundLabel } from "./shippo.mjs";

export async function settleShippingOrder(sb, order, deps = {}) {
  const cfg = deps.config || webSquareConfig(order.store_id, order.payment_env || undefined);
  const client = deps.client || webSquareClient(order.store_id, order.payment_env || undefined);
  let paymentId = order.payment_id;
  if (order.status !== "paid") {
    let result;
    try {
      ({ result } = await client.paymentsApi.createPayment({
      sourceId: order.payment_source_id, idempotencyKey: `web_${order.payment_attempt_id}`,
      amountMoney: { amount: BigInt(order.total_cents), currency: "USD" },
      locationId: cfg.location_id, buyerEmailAddress: order.buyer_email,
      referenceId: order.id, note: `Open Box Industries SKU ${order.sku} (${order.fulfillment === "pickup" ? "store pickup" : "ship"})`,
      }));
    } catch (err) {
      // Explicit card rejection is safe to retry with a new card and a new attempt key.
      // Transport/auth/server errors retain the original attempt for reconciliation.
      const errors = err.errors || err.result?.errors || err.body?.errors || [];
      if (Array.isArray(errors) && errors.some(e => e.category === "PAYMENT_METHOD_ERROR")) {
        const { error } = await sb.from("web_orders").update({ payment_source_id: null, payment_started_at: null, payment_attempt_id: randomUUID() })
          .eq("id", order.id).eq("status", "claimed").eq("payment_attempt_id", order.payment_attempt_id);
        if (error) throw error;
        return json(400, { error: "Card declined. Check your card details or use another card." });
      }
      throw err;
    }
    if (result.payment?.status !== "COMPLETED" || !result.payment?.id) return json(502, { error: "payment_not_completed" });
    paymentId = result.payment.id;
  }
  const { data: summary, error: finError } = await sb.rpc("complete_shipping_checkout", {
    p_store: order.store_id, p_order: order.id, p_payment: paymentId,
  });
  if (finError) {
    // Only an explicit PostgreSQL business rejection proves the transaction rolled back.
    // Network/5xx ambiguity must be retried with the same order, never blindly refunded.
    if (finError.code !== "P0001") return json(503, { error: "Payment received; order confirmation is pending. Retry this payment to check the same order.", payment_id: paymentId });
    const { result } = await client.refundsApi.refundPayment({
      idempotencyKey: `wr_${order.id}`, paymentId,
      amountMoney: { amount: BigInt(order.total_cents), currency: "USD" }, reason: "Online order could not finalize",
    });
    const refunded = ["PENDING", "COMPLETED"].includes(result.refund?.status);
    if (refunded) {
      const { error: refundError } = await sb.from("web_orders").update({ status: "refunded", refund_id: result.refund.id, payment_id: paymentId, payment_source_id: null }).eq("id", order.id).neq("status", "paid");
      if (refundError) throw refundError;
    }
    return json(409, { error: finError.message, refunded, payment_id: paymentId });
  }
  // The transaction already queued both emails. Temporary delivery failures retry on the schedule.
  await (deps.deliver || deliverOrderEmails)(sb, order.id).catch(() => []);
  return json(200, { ok: true, summary, order_id: order.id });
}

/**
 * Cancel a paid order with a full refund. Safe to retry: the DB lock step is idempotent, the Square
 * refund uses a stable idempotency key, and the final step voids the sale exactly once.
 */
export async function cancelAndRefund(sb, storeId, orderId, source, reason, deps = {}) {
  const { data: order, error } = await sb.rpc("request_web_order_refund", {
    p_store: storeId, p_order: orderId, p_source: source, p_reason: reason || null,
  });
  if (error) return { ok: false, status: error.code === "P0001" ? 409 : 500, error: error.message };
  const client = deps.client || webSquareClient(order.store_id, order.payment_env || undefined);
  let refundId = null;
  try {
    const { result } = await client.refundsApi.refundPayment({
      idempotencyKey: `cancel_${order.id}`, paymentId: order.payment_id,
      amountMoney: { amount: BigInt(order.total_cents), currency: "USD" },
      reason: source === "pickup_expired" ? "Store pickup not collected by deadline" : (reason || "Order canceled by store").slice(0, 190),
    });
    if (!["PENDING", "COMPLETED"].includes(result.refund?.status)) {
      return { ok: false, status: 502, error: `refund_${String(result.refund?.status || "failed").toLowerCase()}` };
    }
    refundId = result.refund.id;
  } catch {
    // The order stays locked (refund_requested_at) and the pickup sweep retries the same key.
    return { ok: false, status: 502, error: "Square refund failed; it will be retried automatically." };
  }
  const { data: done, error: finError } = await sb.rpc("finish_web_order_refund", { p_store: storeId, p_order: orderId, p_refund: refundId });
  if (finError) return { ok: false, status: 500, error: finError.message, refund_id: refundId };
  let label = null;
  if (order.label_transaction_id && !order.shipped_at) {
    label = await (deps.refundLabel || refundLabel)(order.label_transaction_id).then(r => r.status || "requested").catch(() => "label_refund_failed");
  }
  await (deps.deliver || deliverOrderEmails)(sb, orderId).catch(() => []);
  return { ok: true, status: 200, order: done, refund_id: refundId, label_refund: label };
}
