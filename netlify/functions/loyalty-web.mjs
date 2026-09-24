/**
 * Public website loyalty: lookup, signup, unsubscribe.
 * Auth: x-store-web-key (same as web-checkout). No SMS.
 */
import { serviceClient, json, corsHeaders } from "../lib/server.mjs";
import { wrapHandler } from "../lib/floor-log.mjs";
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
    headers["X-Connections-Key"] ||
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

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "post_only" }, cors);
  assertKey(event);
  const body = JSON.parse(event.body || "{}");
  const storeId = body.store_id;
  if (!storeId) return json(400, { error: "store_id_required" }, cors);
  const sb = serviceClient();
  const action = body.action;

  if (action === "lookup") {
    const phone = digitsOnly(body.phone);
    if (!phone) return json(400, { error: "phone_required" }, cors);
    const { data, error } = await sb.rpc("web_lookup_customer", { p_store: storeId, p_phone: phone });
    if (error) return json(400, { error: error.message }, cors);
    return json(200, { ok: true, customer: data }, cors);
  }

  if (action === "signup") {
    const phone = digitsOnly(body.phone);
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim();
    if (!phone || !name || !email.includes("@")) {
      return json(400, { error: "name_phone_email_required" }, cors);
    }
    const { data, error } = await sb.rpc("web_upsert_customer", {
      p_store: storeId,
      p_phone: phone,
      p_name: name,
      p_email: email,
      p_marketing_opt_in: Boolean(body.marketing_opt_in),
    });
    if (error) return json(400, { error: error.message }, cors);
    void drainLoyaltyEmail().catch(() => {});
    return json(200, { ok: true, customer: data }, cors);
  }

  if (action === "unsubscribe") {
    const token = String(body.token || "").trim();
    if (!token) return json(400, { error: "token_required" }, cors);
    const { data, error } = await sb.rpc("unsubscribe_loyalty", { p_token: token });
    if (error) return json(400, { error: error.message }, cors);
    return json(200, { ok: true, ...data }, cors);
  }

  return json(400, { error: "unknown_action" }, cors);
}

export const handler = wrapHandler("loyalty-web", async (event) => {
  try {
    return await handle(event);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg === "unauthorized" || msg === "rewards_key_unset" ? 401 : 500;
    return json(status, { error: msg }, cors);
  }
});
