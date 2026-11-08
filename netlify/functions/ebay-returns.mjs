/** Pull eBay return requests. Refunds go out only when an admin confirms. */
import { json, corsHeaders, serviceClient } from "../lib/server.mjs";
import { wrapHandler, asNetlifyFunction } from "../lib/floor-log.mjs";
import { portalAdminFromEvent } from "../lib/portal-auth.mjs";
import { assertEbaySellerWrite, loadEbayAccount } from "../lib/ebay-accounts.mjs";
import {
  deductionRefundCents,
  ebayRefundPlan,
  issueEbayReturnRefund,
  offerEbayPartialRefund,
  syncEbayReturns,
  uploadEbayReturnFile,
} from "../lib/ebay-returns.mjs";

const SELLING = "ikonikdeals2026";

function planFallbackItem(row) {
  const refund = Math.max(0, Number(row.refund_cents) || 0);
  const shipping = Math.max(0, Number(row.raw?.shipping_cents) || 0);
  const stored = Math.max(0, Number(row.raw?.item_cents) || 0);
  if (stored > 0) return stored;
  const snad = row.fault === "seller" || /not_as_described|defective|wrong_item|damaged/.test(String(row.reason || ""));
  if (snad && shipping > 0 && refund > shipping) return refund - shipping;
  return refund;
}

async function finishEbayRefund(sb, storeId, row, refundCents) {
  void storeId;
  const now = new Date().toISOString();
  await sb.from("returns").update({
    refund_cents: refundCents,
    status: "closed",
    refunded_at: now,
    closed_at: now,
    needs_decision: false,
    updated_at: now,
  }).eq("id", row.id);
  // Owner profit drops via buyer_keep_refund_cents. Worker commissions stay.
  // Do not void the sale or claw back payouts — garage still uses Back in stock / Defective.
  const { error: profitErr } = await sb.rpc("return_apply_owner_profit_refund", { p_return_id: row.id });
  if (profitErr) throw new Error(profitErr.message);
  await sb.rpc("return_sync_label_expense", { p_return_id: row.id });
  await sb.rpc("return_post_ledger", { p_return_id: row.id });
}

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: corsHeaders(), body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "post_only" });
  const body = JSON.parse(event.body || "{}");
  let ctx;
  try { ctx = await portalAdminFromEvent(event, body.store_id); }
  catch (err) { return json(err.status || 401, { error: err.message }); }

  const account = await loadEbayAccount(ctx.storeId, { username: SELLING });
  try { assertEbaySellerWrite(account); }
  catch (err) { return json(400, { error: err.message, code: err.code || "ebay_write_refused" }); }

  if (body.action === "sync" || !body.action) {
    const result = await syncEbayReturns(ctx.storeId, account);
    return json(200, result);
  }

  const returnId = String(body.return_id || "");
  if (!returnId) return json(400, { error: "return_id_required" });
  const sb = serviceClient();
  const { data: row, error } = await sb.from("returns").select("id,external_return_id,refund_cents,raw,channel,reason,fault,sale_id,refunded_at,sku,return_label_cents,label_paid_by").eq("store_id", ctx.storeId).eq("id", returnId).maybeSingle();
  if (error) return json(500, { error: error.message });
  if (!row || row.channel !== "ebay") return json(404, { error: "ebay_return_not_found" });
  const ebayId = row.external_return_id;
  const itemCents = Math.max(0, Number(row.raw?.item_cents) || 0);
  const shippingCents = Math.max(0, Number(row.raw?.shipping_cents) || 0);
  const plan = ebayRefundPlan({
    reason: row.reason || row.raw?.reason,
    fault: row.fault || row.raw?.fault,
    itemCents: itemCents || (planFallbackItem(row)),
    shippingCents,
  });

  if (body.action === "quote") {
    return json(200, {
      ...plan,
      max_deduction_percent: plan.deductionAllowed ? 50 : 0,
      suggested_refund_cents: plan.refundCents,
    });
  }

  if (row.refunded_at) return json(409, { error: "already_refunded" });

  if (body.action === "refund_item") {
    // Prefer an admin-edited refund on the return row; otherwise the policy plan.
    const refundCents = Math.max(0, Number(row.refund_cents) || 0) > 0
      ? Math.max(0, Number(row.refund_cents) || 0)
      : plan.refundCents;
    const sendPlan = {
      ...plan,
      refundCents,
      itemCents: plan.includeOriginalShipping && plan.originalShippingCents > 0
        ? Math.max(0, refundCents - plan.originalShippingCents)
        : refundCents,
    };
    if (sendPlan.includeOriginalShipping && sendPlan.itemCents <= 0) {
      sendPlan.itemCents = plan.itemCents;
      sendPlan.refundCents = plan.refundCents;
    }
    const sent = await issueEbayReturnRefund(account, ebayId, sendPlan, body.note);
    await finishEbayRefund(sb, ctx.storeId, row, sendPlan.refundCents);
    return json(200, { ok: true, refund_cents: sendPlan.refundCents, ebay: sent || null });
  }

  if (body.action === "deduct") {
    if (!plan.deductionAllowed) return json(400, { error: "deduction_not_allowed", message: "Not-as-described returns are a full refund. No deduction." });
    const note = String(body.note || "").trim();
    const photo = String(body.photo_base64 || "").trim();
    if (!note) return json(400, { error: "condition_note_required" });
    if (!photo) return json(400, { error: "condition_photo_required" });
    const bytes = Uint8Array.from(Buffer.from(photo, "base64"));
    if (bytes.length < 32) return json(400, { error: "condition_photo_required" });
    const contentType = String(body.photo_type || "image/jpeg");
    await uploadEbayReturnFile(account, ebayId, { filename: "condition.jpg", contentType, bytes });
    const money = deductionRefundCents(plan.itemCents, body.percent);
    await offerEbayPartialRefund(account, ebayId, plan.itemCents, money.percent, note);
    const photoPath = `${ctx.storeId}/returns/${row.id}/condition.jpg`;
    await sb.storage.from("unit-photos").upload(photoPath, bytes, { contentType, upsert: true }).catch(() => null);
    await sb.from("return_photos").insert({
      store_id: ctx.storeId, return_id: row.id, path: photoPath, kind: "damage", created_by: ctx.userId || null,
    });
    await sb.from("return_notes").insert({
      store_id: ctx.storeId, return_id: row.id, body: note, kind: "note", created_by: ctx.userId || null,
    });
    await finishEbayRefund(sb, ctx.storeId, row, money.refundCents);
    return json(200, { ok: true, ...money });
  }

  return json(400, { error: "unknown_action" });
}

export default asNetlifyFunction(handle);
export const invoke = wrapHandler("ebay-returns", handle);
