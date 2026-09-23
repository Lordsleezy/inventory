import { staffFromEvent, serviceClient, json, corsHeaders } from "../lib/server.mjs";
import { wrapHandler } from "../lib/floor-log.mjs";
import {
  buildReceiptHtml,
  buildReceiptText,
  mergeBranding,
  sendResend,
} from "../lib/receipt.mjs";

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "method_not_allowed" });

  let ctx;
  try {
    ctx = await staffFromEvent(event);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json(msg === "not_staff" ? 403 : 401, { error: msg });
  }

  const body = JSON.parse(event.body || "{}");
  const ticketId = body.ticketId;
  const toEmail = String(body.toEmail || body.email || "").trim();
  if (!ticketId) return json(400, { error: "ticketId_required" });
  if (!toEmail || !toEmail.includes("@")) return json(400, { error: "toEmail_required" });

  const sb = serviceClient();
  const storeId = ctx.staff.store_id;

  const { data: sales, error: salesErr } = await sb
    .from("sales")
    .select(
      "id, sku, receipt_no, ticket_id, sold_at, price_cents, tax_cents, card_fee_cents, list_price_cents, payment_method, card_brand, card_last4, actor_id, voided_at",
    )
    .eq("store_id", storeId)
    .eq("ticket_id", ticketId)
    .is("voided_at", null)
    .order("id", { ascending: true });

  if (salesErr) return json(500, { error: salesErr.message });
  if (!sales?.length) return json(404, { error: "ticket_not_found" });

  const skus = [...new Set(sales.map((s) => s.sku))];
  const actorIds = [...new Set(sales.map((s) => s.actor_id).filter(Boolean))];
  const [{ data: units }, { data: staffRows }, { data: extras }] = await Promise.all([
    sb.from("units").select("sku, title, brand, model, condition").eq("store_id", storeId).in("sku", skus),
    actorIds.length
      ? sb.from("staff").select("user_id, display_name").eq("store_id", storeId).in("user_id", actorIds)
      : Promise.resolve({ data: [] }),
    sb
      .from("ticket_extras")
      .select(
        "discount_cents, signup_discount_cents, points_earned, points_redeemed, cash_cents, card_cents, amount_tendered_cents, card_fee_cents",
      )
      .eq("store_id", storeId)
      .eq("ticket_id", ticketId)
      .maybeSingle(),
  ]);
  const unitBySku = Object.fromEntries((units ?? []).map((u) => [u.sku, u]));
  const staffById = Object.fromEntries((staffRows ?? []).map((s) => [s.user_id, s]));

  const enriched = sales.map((s) => {
    const u = unitBySku[s.sku];
    const title = [u?.brand, u?.model].filter(Boolean).join(" ") || u?.title || "Item";
    return {
      ...s,
      title,
      condition: u?.condition ?? null,
      actor_name: staffById[s.actor_id]?.display_name ?? null,
      total_cents: (s.price_cents || 0) + (s.tax_cents || 0) + (s.card_fee_cents || 0),
    };
  });

  const { data: settingsRows } = await sb
    .from("store_settings")
    .select("key, value")
    .eq("store_id", storeId)
    .in("key", ["receipt_branding", "display_name"]);

  let brandingStored = null;
  let displayName = null;
  for (const row of settingsRows ?? []) {
    if (row.key === "receipt_branding") brandingStored = row.value;
    if (row.key === "display_name") {
      displayName = typeof row.value === "string" ? row.value : row.value;
      if (typeof displayName === "object" && displayName != null) displayName = String(displayName);
    }
  }

  const branding = mergeBranding(brandingStored, body.branding, displayName);
  const text = buildReceiptText(enriched, extras, branding, ctx.staff.display_name);
  const html = buildReceiptHtml(enriched, extras, branding, ctx.staff.display_name);
  const receiptNo = enriched[0]?.receipt_no || ticketId.slice(0, 8);

  const result = await sendResend({
    to: toEmail,
    subject: `Your receipt from ${branding.storeName} (${receiptNo})`,
    text,
    html,
  });

  if (result.skipped) {
    return json(503, { error: result.reason || "email_unavailable", detail: "RESEND_API_KEY / RESEND_FROM not configured" });
  }

  return json(200, { ok: true, to: toEmail, receiptNo });
}

export const handler = wrapHandler("email-receipt", async (event) => {
  try {
    return await handle(event);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json(500, { error: msg });
  }
});
