/** Pull eBay return requests and send item-only or partial refunds. */
import { json, corsHeaders, serviceClient } from "../lib/server.mjs";
import { wrapHandler, asNetlifyFunction } from "../lib/floor-log.mjs";
import { portalAdminFromEvent } from "../lib/portal-auth.mjs";
import { loadEbayAccount } from "../lib/ebay-accounts.mjs";
import {
  deductionRefundCents,
  issueEbayItemRefund,
  offerEbayPartialRefund,
  syncEbayReturns,
  uploadEbayReturnFile,
} from "../lib/ebay-returns.mjs";

const SELLING = "ikonikdeals2026";

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: corsHeaders(), body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "post_only" });
  const body = JSON.parse(event.body || "{}");
  let ctx;
  try { ctx = await portalAdminFromEvent(event, body.store_id); }
  catch (err) { return json(err.status || 401, { error: err.message }); }

  const account = await loadEbayAccount(ctx.storeId, { username: SELLING });
  if (String(account.role) !== "selling") return json(400, { error: "selling_account_required" });

  if (body.action === "sync" || !body.action) {
    const result = await syncEbayReturns(ctx.storeId, account);
    return json(200, result);
  }

  const returnId = String(body.return_id || "");
  if (!returnId) return json(400, { error: "return_id_required" });
  const sb = serviceClient();
  const { data: row, error } = await sb.from("returns").select("id,external_return_id,refund_cents,raw,channel").eq("store_id", ctx.storeId).eq("id", returnId).maybeSingle();
  if (error) return json(500, { error: error.message });
  if (!row || row.channel !== "ebay") return json(404, { error: "ebay_return_not_found" });
  const ebayId = row.external_return_id;
  const itemCents = Math.max(0, Number(row.raw?.item_cents) || Number(row.refund_cents) || 0);

  if (body.action === "quote") {
    return json(200, {
      item_cents: itemCents,
      shipping_cents: Math.max(0, Number(row.raw?.shipping_cents) || 0),
      remorse: row.raw?.fault === "buyer" || row.raw?.reason === "buyer_remorse",
      max_deduction_percent: 50,
      suggested_refund_cents: itemCents,
    });
  }

  if (body.action === "refund_item") {
    const sent = await issueEbayItemRefund(account, ebayId, itemCents, body.note);
    await sb.from("returns").update({
      refund_cents: itemCents,
      status: "closed",
      refunded_at: new Date().toISOString(),
      closed_at: new Date().toISOString(),
      needs_decision: false,
      updated_at: new Date().toISOString(),
    }).eq("id", row.id);
    return json(200, { ok: true, refund_cents: itemCents, ebay: sent || null });
  }

  if (body.action === "deduct") {
    const note = String(body.note || "").trim();
    const photo = String(body.photo_base64 || "").trim();
    if (!note) return json(400, { error: "condition_note_required" });
    if (!photo) return json(400, { error: "condition_photo_required" });
    const bytes = Uint8Array.from(Buffer.from(photo, "base64"));
    if (bytes.length < 32) return json(400, { error: "condition_photo_required" });
    const contentType = String(body.photo_type || "image/jpeg");
    await uploadEbayReturnFile(account, ebayId, { filename: "condition.jpg", contentType, bytes });
    const money = deductionRefundCents(itemCents, body.percent);
    await offerEbayPartialRefund(account, ebayId, itemCents, money.percent, note);
    const photoPath = `${ctx.storeId}/returns/${row.id}/condition.jpg`;
    await sb.storage.from("unit-photos").upload(photoPath, bytes, { contentType, upsert: true }).catch(() => null);
    await sb.from("return_photos").insert({
      store_id: ctx.storeId, return_id: row.id, path: photoPath, kind: "damage", created_by: ctx.userId || null,
    });
    await sb.from("return_notes").insert({
      store_id: ctx.storeId, return_id: row.id, body: note, kind: "note", created_by: ctx.userId || null,
    });
    await sb.from("returns").update({
      refund_cents: money.refundCents,
      inspection_notes: note,
      needs_decision: false,
      updated_at: new Date().toISOString(),
    }).eq("id", row.id);
    return json(200, { ok: true, ...money });
  }

  return json(400, { error: "unknown_action" });
}

export const handler = asNetlifyFunction(handle);
export const invoke = wrapHandler("ebay-returns", handle);
