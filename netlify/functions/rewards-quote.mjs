/**
 * Website rewards quote — lookup customer balance + discount preview.
 *
 * Auth: header `x-store-web-key` (or `x-connections-key`) must match
 * STORE_WEB_REWARDS_KEY, falling back to CONNECTIONS_KEY.
 *
 * POST JSON:
 *   { store_id, phone, redeem_points?, lines?: [{ price_cents, qty? }],
 *     discount_bps?, subtotal_cents? }
 *
 * When `lines` is omitted, pass `subtotal_cents` for a rough redeem/signup preview.
 */
import { serviceClient, json, corsHeaders, requireEnv } from "../lib/server.mjs";

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
    headers["X-Connections-Key"] ||
    "";
  if (!got || got !== expected) throw new Error("unauthorized");
}

function digitsOnly(phone) {
  return String(phone || "").replace(/\D/g, "");
}

function settingInt(rows, key, fallback) {
  const row = rows.find((r) => r.key === key);
  if (!row || row.value == null) return fallback;
  const n = Number(row.value);
  return Number.isFinite(n) ? n : fallback;
}

function settingBool(rows, key, fallback) {
  const row = rows.find((r) => r.key === key);
  if (!row || row.value == null) return fallback;
  if (typeof row.value === "boolean") return row.value;
  return String(row.value) === "true";
}

export async function handler(event) {
  const cors = {
    ...corsHeaders(),
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type, x-store-web-key, x-connections-key",
  };
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: "post_only" }) };
  }

  try {
    assertKey(event);
    const body = JSON.parse(event.body || "{}");
    const storeId = body.store_id;
    const phone = digitsOnly(body.phone);
    if (!storeId || !phone) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "store_id_and_phone_required" }) };
    }

    const sb = serviceClient();
    const { data: settings, error: setErr } = await sb
      .from("store_settings")
      .select("key, value")
      .eq("store_id", storeId)
      .in("key", [
        "rewards_enabled",
        "rewards_points_per_dollar",
        "rewards_point_value_cents",
        "rewards_signup_discount_bps",
        "taxRateBps",
        "clerk_max_discount_bps",
      ]);
    if (setErr) throw new Error(setErr.message);

    const rows = settings || [];
    const enabled = settingBool(rows, "rewards_enabled", true);
    if (!enabled) {
      return {
        statusCode: 200,
        headers: cors,
        body: JSON.stringify({ ok: true, enabled: false, customer: null }),
      };
    }

    const { data: customer, error: custErr } = await sb
      .from("customers")
      .select(
        "id, store_id, phone, name, email, marketing_opt_in, first_purchase_discount_used, created_at",
      )
      .eq("store_id", storeId)
      .eq("phone", phone)
      .maybeSingle();
    if (custErr) throw new Error(custErr.message);

    let balance = 0;
    if (customer?.id) {
      const { data: ledger } = await sb
        .from("customer_points_ledger")
        .select("balance_after")
        .eq("store_id", storeId)
        .eq("customer_id", customer.id)
        .order("id", { ascending: false })
        .limit(1)
        .maybeSingle();
      balance = Number(ledger?.balance_after ?? 0);
    }

    const pointValue = settingInt(rows, "rewards_point_value_cents", 1);
    const signupBps = settingInt(rows, "rewards_signup_discount_bps", 500);
    const pointsPerDollar = settingInt(rows, "rewards_points_per_dollar", 1);
    const taxBps = settingInt(rows, "taxRateBps", 0);
    const discountBps = Math.max(0, Math.min(10000, Number(body.discount_bps) || 0));
    const redeemWanted = Math.max(0, Math.round((Number(body.redeem_points) || 0) * 10));

    let rawSub = 0;
    if (Array.isArray(body.lines) && body.lines.length) {
      for (const line of body.lines) {
        const unit = Number(line.price_cents);
        const qty = Math.max(1, Math.trunc(Number(line.qty) || 1));
        if (!Number.isFinite(unit) || unit < 0) {
          return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "invalid_line" }) };
        }
        rawSub += unit * qty;
      }
    } else {
      rawSub = Math.max(0, Math.trunc(Number(body.subtotal_cents) || 0));
    }

    const ticketDiscount = Math.round((rawSub * discountBps) / 10000);
    let remaining = rawSub - ticketDiscount;

    let signupCents = 0;
    if (customer && !customer.first_purchase_discount_used) {
      signupCents = Math.round((remaining * signupBps) / 10000);
      remaining -= signupCents;
    }

    const maxRedeemByBalance = balance;
    const maxRedeemBySubtotal = pointValue > 0 ? Math.floor(remaining / pointValue) : 0;
    const maxRedeemPoints = Math.min(maxRedeemByBalance, maxRedeemBySubtotal);
    const redeemPoints = Math.min(redeemWanted, maxRedeemPoints);
    const redeemCents = redeemPoints * pointValue;
    remaining -= redeemCents;

    const subtotal = remaining;
    const tax = taxBps > 0 ? Math.round((subtotal * taxBps) / 10000) : 0;
    const earnPreview = Math.floor((subtotal * pointsPerDollar) / 100) / 10;

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        ok: true,
        enabled: true,
        customer: customer
          ? {
              id: customer.id,
              phone: customer.phone,
              name: customer.name,
              email: customer.email,
              first_purchase_discount_used: customer.first_purchase_discount_used,
              balance: balance / 10,
              credit_cents: balance * pointValue,
            }
          : null,
        quote: {
          raw_subtotal_cents: rawSub,
          discount_bps: discountBps,
          discount_cents: ticketDiscount,
          signup_discount_cents: signupCents,
          redeem_points: redeemPoints / 10,
          redeem_cents: redeemCents,
          max_redeem_points: maxRedeemPoints / 10,
          subtotal_cents: subtotal,
          tax_cents: tax,
          total_cents: subtotal + tax,
          earn_points_preview: earnPreview,
          point_value_cents: pointValue * 10,
          points_per_100_dollars: pointsPerDollar * 10,
        },
      }),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code =
      message === "unauthorized" || message === "rewards_key_unset"
        ? 401
        : message.startsWith("Missing env")
          ? 500
          : 400;
    return {
      statusCode: code,
      headers: cors,
      body: JSON.stringify({ error: "rewards_quote_failed", message }),
    };
  }
}
