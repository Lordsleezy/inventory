/**
 * Website checkout — reserve → Square payment → finalize, with full refund
 * when the ticket cannot finalize after capture.
 *
 * Auth: header `x-store-web-key` must equal STORE_WEB_REWARDS_KEY (falls back
 * to CONNECTIONS_KEY), same contract as rewards-quote. Server-to-server only —
 * the storefront never sees the service key or Square tokens.
 *
 * POST JSON actions:
 *   { action: "config", store_id }
 *     → { application_id, location_id, sandbox, store_name }
 *   { action: "begin", store_id, sku, phone?, name?, email?, redeem_points? }
 *     → reserves the unit, upserts the rewards customer, returns quote +
 *       reservation_id + Square config. Fee/tax are server-computed.
 *   { action: "pay", store_id, reservation_id, source_id, email?, ... }
 *     → charges the card for the server-quoted amount, finalizes the ticket
 *       (channel "website"), emails the receipt, refunds on failure.
 *   { action: "release", store_id, reservation_id }
 *     → releases an abandoned hold early.
 */
import { serviceClient, json, corsHeaders } from "../lib/server.mjs";
import { wrapHandler } from "../lib/floor-log.mjs";
import { getStoreSquareAccess, squareClient, refundSquarePayment } from "../lib/square.mjs";
import { buildReceiptHtml, buildReceiptText, mergeBranding, sendResend } from "../lib/receipt.mjs";
import { drainLoyaltyEmail } from "./loyalty-email.mjs";

function rewardsKey() {
  return process.env.STORE_WEB_REWARDS_KEY || process.env.CONNECTIONS_KEY || "";
}

function assertKey(event) {
  const expected = rewardsKey();
  if (!expected) throw new Error("rewards_key_unset");
  const headers = event.headers || {};
  const got =
    headers["x-store-web-key"] ||
    headers["X-Store-Web-Key"] ||
    headers["x-connections-key"] ||
    "";
  if (!got || got !== expected) throw new Error("unauthorized");
}

const cors = {
  ...corsHeaders(),
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, x-store-web-key, x-connections-key",
};

function digitsOnly(phone) {
  return String(phone || "").replace(/\D/g, "");
}

async function loadBranding(sb, storeId) {
  const { data } = await sb
    .from("store_settings")
    .select("key, value")
    .eq("store_id", storeId)
    .in("key", ["receipt_branding", "display_name"]);
  let stored = null;
  let displayName = null;
  for (const row of data ?? []) {
    if (row.key === "receipt_branding") stored = row.value;
    if (row.key === "display_name") {
      displayName = typeof row.value === "string" ? row.value : String(row.value ?? "");
      displayName = displayName.replace(/^"|"$/g, "");
    }
  }
  return mergeBranding(stored, null, displayName);
}

async function squareConfig(sb, storeId) {
  const access = await getStoreSquareAccess(storeId);
  return {
    application_id: process.env.SQUARE_APPLICATION_ID || "",
    location_id: access.locationId || "",
    sandbox: access.sandbox !== false,
  };
}

async function handleConfig(sb, body) {
  const cfg = await squareConfig(sb, body.store_id);
  const branding = await loadBranding(sb, body.store_id);
  return json(200, { ...cfg, store_name: branding.storeName }, cors);
}

async function handleBegin(sb, body) {
  const storeId = body.store_id;
  const sku = String(body.sku || "").trim();
  if (!sku) return json(400, { error: "sku_required" }, cors);

  // Rewards customer: create on first checkout so points can be earned.
  let customer = null;
  const phone = digitsOnly(body.phone);
  if (phone) {
    const { data: cust, error: custErr } = await sb.rpc("web_upsert_customer", {
      p_store: storeId,
      p_phone: phone,
      p_name: body.name || null,
      p_email: body.email || null,
      p_marketing_opt_in: Boolean(body.marketing_opt_in),
    });
    if (custErr) return json(500, { error: custErr.message }, cors);
    customer = cust;
  }

  const redeem = Math.max(0, Math.trunc(Number(body.redeem_points) || 0));
  const { data: res, error } = await sb.rpc("web_reserve_unit", {
    p_store: storeId,
    p_sku: sku,
    p_customer_id: customer?.id ?? null,
    p_redeem_points: redeem,
  });
  if (error) {
    const msg = error.message || "reserve_failed";
    const status = /not_sellable|not_priced/.test(msg) ? 409 : 400;
    return json(status, { error: msg }, cors);
  }

  const cfg = await squareConfig(sb, storeId);
  const branding = await loadBranding(sb, storeId);
  const quote = res.quote || {};
  return json(
    200,
    {
      ok: true,
      reservation_id: res.reservation_id,
      expires_at: res.expires_at,
      price_cents: res.price_cents,
      customer,
      quote: {
        subtotal_cents: quote.subtotal_cents,
        discount_cents: (quote.discount_cents || 0) + (quote.signup_discount_cents || 0),
        signup_discount_cents: quote.signup_discount_cents || 0,
        redeem_cents: quote.redeem_cents || 0,
        tax_cents: quote.tax_cents,
        card_fee_cents: quote.card_fee_cents || 0,
        total_cents: quote.total_cents,
        earn_points_preview: Math.floor(Number(quote.subtotal_cents || 0) / 100),
      },
      square: cfg,
      store_name: branding.storeName,
    },
    cors,
  );
}

async function loadTicketReceipt(sb, storeId, ticketId) {
  const { data: sales } = await sb
    .from("sales")
    .select(
      "id, sku, receipt_no, ticket_id, sold_at, price_cents, tax_cents, card_fee_cents, list_price_cents, payment_method, card_brand, card_last4, actor_id, voided_at",
    )
    .eq("store_id", storeId)
    .eq("ticket_id", ticketId)
    .is("voided_at", null)
    .order("id", { ascending: true });
  if (!sales?.length) return null;
  const skus = [...new Set(sales.map((s) => s.sku))];
  const [{ data: units }, { data: extras }] = await Promise.all([
    sb.from("units").select("sku, title, brand, model, condition").eq("store_id", storeId).in("sku", skus),
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
  const enriched = sales.map((s) => {
    const u = unitBySku[s.sku];
    return {
      ...s,
      title: [u?.brand, u?.model].filter(Boolean).join(" ") || u?.title || "Item",
      condition: u?.condition ?? null,
    };
  });
  return { sales: enriched, extras };
}

async function handlePay(sb, body) {
  const storeId = body.store_id;
  const reservationId = body.reservation_id;
  const sourceId = String(body.source_id || "").trim();
  const sku = String(body.sku || "").trim();
  if (!reservationId || !sourceId || !sku) {
    return json(400, { error: "reservation_source_sku_required" }, cors);
  }

  // The reservation drives the ticket id so retries are idempotent.
  const { data: reservation } = await sb
    .from("reservations")
    .select("id, sku, store_id, released_at, finalized_at, expires_at")
    .eq("id", reservationId)
    .eq("store_id", storeId)
    .maybeSingle();
  if (!reservation || reservation.sku !== sku) {
    return json(404, { error: "reservation_not_found" }, cors);
  }
  if (reservation.finalized_at) {
    return json(409, { error: "already_finalized" }, cors);
  }
  if (reservation.released_at || new Date(reservation.expires_at) < new Date()) {
    return json(410, { error: "reservation_expired" }, cors);
  }

  // Rewards customer (buyer may have added a phone during payment).
  let customer = null;
  const phone = digitsOnly(body.phone);
  if (phone) {
    const { data: cust } = await sb.rpc("web_upsert_customer", {
      p_store: storeId,
      p_phone: phone,
      p_name: body.name || null,
      p_email: body.email || null,
      p_marketing_opt_in: Boolean(body.marketing_opt_in),
    });
    customer = cust;
  }
  const redeem = Math.min(
    Math.max(0, Math.trunc(Number(body.redeem_points) || 0)),
    Math.max(0, Number(customer?.points_balance) || 0),
  );

  const { data: unit } = await sb
    .from("units")
    .select("ask_cents")
    .eq("store_id", storeId)
    .eq("sku", sku)
    .maybeSingle();
  if (!unit?.ask_cents) return json(409, { error: "unit_not_priced" }, cors);

  const lines = [{ sku, price_cents: unit.ask_cents, qty: 1 }];
  const { data: quote, error: qErr } = await sb.rpc("web_quote", {
    p_store: storeId,
    p_lines: lines,
    p_customer_id: customer?.id ?? null,
    p_redeem_points: redeem,
  });
  if (qErr) return json(400, { error: qErr.message }, cors);
  const chargeCents = Number(quote?.card_charge_cents ?? quote?.total_cents);
  if (!Number.isFinite(chargeCents) || chargeCents <= 0) {
    return json(400, { error: "bad_quote" }, cors);
  }

  const { accessToken, locationId } = await getStoreSquareAccess(storeId);
  const client = squareClient(accessToken);

  // Square payment — idempotent on the reservation so a retried submit or a
  // double-tap cannot charge twice.
  const { result: payResult } = await client.paymentsApi.createPayment({
    sourceId: sourceId,
    idempotencyKey: `web_${reservationId}`,
    amountMoney: { amount: BigInt(chargeCents), currency: "USD" },
    locationId: locationId || undefined,
    note: `openboxindustries.com ${sku}`,
    buyerEmailAddress: body.email || undefined,
  });
  const payment = payResult?.payment;
  if (!payment?.id) return json(502, { error: "payment_not_created" }, cors);

  const ticketId = reservationId;
  const { data: summary, error: finErr } = await sb.rpc("web_finalize_ticket", {
    p_store: storeId,
    p_ticket_id: ticketId,
    p_lines: lines,
    p_payment_id: payment.id,
    p_customer_id: customer?.id ?? null,
    p_redeem_points: redeem,
    p_note: body.note || null,
  });

  if (finErr) {
    // Card captured but the sale could not record — refund the full amount.
    try {
      await refundSquarePayment(storeId, payment.id, chargeCents, "web_finalize_failed");
      return json(409, {
        error: finErr.message || "finalize_failed",
        refunded: true,
      }, cors);
    } catch (refundErr) {
      return json(409, {
        error: finErr.message || "finalize_failed",
        refunded: false,
        payment_id: payment.id,
        refund_error: refundErr instanceof Error ? refundErr.message : String(refundErr),
      }, cors);
    }
  }

  // Mark the reservation finalized (finalize_ticket releases open holds on the
  // sku; the explicit reservation row gets its sale pointer here).
  const saleId = summary?.lines?.[0]?.sale_id ?? null;
  await sb
    .from("reservations")
    .update({ finalized_at: new Date().toISOString(), sale_id: saleId, payment_id: payment.id })
    .eq("id", reservationId)
    .eq("store_id", storeId);

  // Receipt email (best-effort — the sale is already final).
  let emailed = false;
  const toEmail = String(body.email || customer?.email || "").trim();
  if (toEmail.includes("@")) {
    try {
      const receipt = await loadTicketReceipt(sb, storeId, ticketId);
      if (receipt) {
        const branding = await loadBranding(sb, storeId);
        const result = await sendResend({
          to: toEmail,
          subject: `Your receipt from ${branding.storeName} (${receipt.sales[0]?.receipt_no || "order"})`,
          text: buildReceiptText(receipt.sales, receipt.extras, branding, "Online"),
          html: buildReceiptHtml(receipt.sales, receipt.extras, branding, "Online"),
        });
        emailed = result.ok === true;
      }
    } catch {
      /* receipt email is best-effort */
    }
  }
  void drainLoyaltyEmail().catch(() => {});

  return json(200, { ok: true, summary, emailed }, cors);
}

async function handleRelease(sb, body) {
  const { error } = await sb.rpc("web_release_reservation", {
    p_store: body.store_id,
    p_reservation_id: body.reservation_id,
  });
  if (error) return json(400, { error: error.message }, cors);
  return json(200, { ok: true }, cors);
}

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "post_only" }, cors);
  assertKey(event);
  const body = JSON.parse(event.body || "{}");
  if (!body.store_id) return json(400, { error: "store_id_required" }, cors);
  const sb = serviceClient();
  switch (body.action) {
    case "config":
      return await handleConfig(sb, body);
    case "begin":
      return await handleBegin(sb, body);
    case "pay":
      return await handlePay(sb, body);
    case "release":
      return await handleRelease(sb, body);
    default:
      return json(400, { error: "unknown_action" }, cors);
  }
}

export const handler = wrapHandler("web-checkout", async (event) => {
  try {
    return await handle(event);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg === "unauthorized" || msg === "rewards_key_unset" ? 401 : 500;
    return json(status, { error: msg }, cors);
  }
});
