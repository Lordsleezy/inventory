import { json, corsHeaders, staffFromEvent, serviceClient } from "../lib/server.mjs";
import { refundSquarePayment } from "../lib/square.mjs";
import { wrapHandler } from "../lib/floor-log.mjs";

/**
 * Refund a Square payment when finalize_ticket cannot complete after capture
 * (unit sold elsewhere, etc.). Marks the charge canceled.
 */
async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "method_not_allowed" });
  const ctx = await staffFromEvent(event);
  const body = JSON.parse(event.body || "{}");
  const chargeId = body.chargeId;
  const paymentId = body.paymentId;
  const amountCents = body.amountCents != null ? Number(body.amountCents) : null;
  const reason = body.reason || "finalize_failed";
  if (!paymentId && !chargeId) return json(400, { error: "payment_or_charge_required" });

  const sb = serviceClient();
  let payId = paymentId;
  let amt = amountCents;
  let rowId = chargeId;

  if (chargeId) {
    const { data: charge } = await sb
      .from("card_charges")
      .select("id, payment_id, amount_cents, status, store_id")
      .eq("id", chargeId)
      .eq("store_id", ctx.staff.store_id)
      .maybeSingle();
    if (!charge) return json(404, { error: "charge_not_found" });
    payId = charge.payment_id || payId;
    amt = amt ?? charge.amount_cents;
    rowId = charge.id;
  }

  if (!payId) return json(400, { error: "no_payment_id" });

  const result = await refundSquarePayment(ctx.staff.store_id, payId, amt, reason);

  if (rowId) {
    await sb
      .from("card_charges")
      .update({
        status: "canceled",
        error: `refunded:${reason}`,
        updated_at: new Date().toISOString(),
      })
      .eq("id", rowId)
      .eq("store_id", ctx.staff.store_id);
  }

  return json(200, {
    ok: true,
    refund_id: result.refund?.id || null,
    status: result.refund?.status || null,
  });
}

export const handler = wrapHandler("square-refund-payment", async (event) => {
  try {
    return await handle(event);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json(500, { error: msg });
  }
});
