import { createHmac, timingSafeEqual } from "node:crypto";

/** Square signs notificationUrl + raw body with HMAC-SHA256, then base64. */
export function squareSignature(key, notificationUrl, rawBody) {
  return createHmac("sha256", key).update(`${notificationUrl}${rawBody}`, "utf8").digest("base64");
}

export function verifySquareSignature(key, notificationUrl, rawBody, provided) {
  if (!key || !notificationUrl || !provided) return false;
  const expected = Buffer.from(squareSignature(key, notificationUrl, rawBody));
  const actual = Buffer.from(String(provided).trim());
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export function squareSignatureHeader(headers) {
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === "x-square-hmacsha256-signature" && value) return String(value).trim();
  }
  return "";
}

function cents(money) {
  if (!money || money.amount == null || money.amount === "") return null;
  const amount = Number(money.amount);
  if (!Number.isFinite(amount)) return null;
  return Math.round(amount);
}

/**
 * Refunds and disputes only. Other Square events are acknowledged and ignored.
 * A missing payment id is still returned so the caller can record it.
 */
export function parseSquareNotification(payload) {
  const type = String(payload?.type || "").toLowerCase();
  const eventId = String(payload?.event_id || "").trim();
  if (!eventId || eventId.length > 200) return null;
  const data = payload?.data || {};
  const object = data.object || {};
  const merchantId = String(payload?.merchant_id || "").slice(0, 80);
  if (type.startsWith("refund.")) {
    const refund = object.refund || object;
    return {
      kind: "refund",
      eventId,
      eventType: type.slice(0, 80),
      merchantId,
      paymentId: String(refund.payment_id || "").trim().slice(0, 200),
      resourceId: String(refund.id || data.id || "").trim().slice(0, 80),
      status: String(refund.status || "").trim().toUpperCase().slice(0, 40),
      amountCents: cents(refund.amount_money),
    };
  }
  if (type.startsWith("dispute.")) {
    const dispute = object.dispute || object;
    const paymentId = dispute.payment_id || dispute.disputed_payment?.payment_id || "";
    return {
      kind: "dispute",
      eventId,
      eventType: type.slice(0, 80),
      merchantId,
      paymentId: String(paymentId || "").trim().slice(0, 200),
      resourceId: String(dispute.id || data.id || dispute.dispute_id || "").trim().slice(0, 80),
      status: String(dispute.state || dispute.status || "").trim().toUpperCase().slice(0, 40),
      amountCents: cents(dispute.amount_money),
      reason: String(dispute.reason || "").slice(0, 120),
    };
  }
  return null;
}
