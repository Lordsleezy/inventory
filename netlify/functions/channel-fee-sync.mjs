import { serviceClient, json, corsHeaders } from "../lib/server.mjs";
import { getStoreSquareAccess, squareClient } from "../lib/square.mjs";
import { webSquareClient, webSquareEnv } from "../lib/web-square.mjs";
import { Environment } from "square/legacy";
import { wrapHandler, asNetlifyFunction } from "../lib/floor-log.mjs";
import { isNetlifyScheduleEvent } from "../lib/schedule.mjs";

// Reconciles the REAL Square card processing fee (register + website) onto recorded sales.
// eBay fees, ad fees and labels now come from the eBay Finances API inside the eBay order sync
// (netlify/lib/ebay-fees.mjs, called by ebay-sync). Never touches listings.
const LOOKBACK_DAYS = 90;

async function squareFee(client, paymentId) {
  const { result } = await client.paymentsApi.getPayment(paymentId);
  const fees = result.payment?.processingFee || [];
  const total = fees.reduce((n, f) => n + Number(f.amountMoney?.amount || 0), 0);
  return total > 0 ? total : null;
}

async function syncSquareFees(sb, storeId, log) {
  const { data: sales, error } = await sb.from("sales")
    .select("id,payment_id,channel")
    .eq("store_id", storeId)
    .in("payment_method", ["card", "split"])
    .is("processing_fee_cents", null)
    .not("payment_id", "is", null)
    .gte("sold_at", new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString())
    .limit(400);
  if (error) { log.push({ square: error.message }); return; }
  let register = null, web = null;
  const registerClient = async () => {
    if (register === null) {
      const access = await getStoreSquareAccess(storeId).catch(() => null);
      register = access ? squareClient(access.access_token, access.sandbox ? Environment.Sandbox : Environment.Production) : false;
    }
    return register || null;
  };
  const webClient = () => {
    if (web === null) {
      try { web = webSquareClient(storeId, webSquareEnv()); } catch { web = false; }
    }
    return web || null;
  };
  for (const s of sales || []) {
    const pid = String(s.payment_id || "");
    if (!pid || pid.includes(":")) continue; // manual:, marketplace:, ebay: — not Square ids
    try {
      const client = s.channel === "website" ? webClient() : await registerClient();
      if (!client) continue;
      const fee = await squareFee(client, pid);
      if (fee == null) continue;
      await sb.rpc("sale_set_processing_fee", { p_store: storeId, p_sale: s.id, p_fee_cents: fee, p_source: "actual" });
      log.push({ sale: s.id, fee });
    } catch (e) {
      log.push({ sale: s.id, payment: pid.slice(0, 8), error: e?.statusCode || e.message });
    }
  }
}

async function handle(event) {
  if (event?.httpMethod === "OPTIONS") return { statusCode: 200, headers: corsHeaders(), body: "" };
  // Schedule-only by default; allow manual invoke with webhook secret or schedule body.
  if (event?.httpMethod && event.httpMethod !== "POST" && event.httpMethod !== "GET") {
    return json(405, { error: "method_not_allowed" });
  }
  const sb = serviceClient();
  const { data: stores, error } = await sb.from("stores").select("id");
  if (error) throw error;
  const out = { schedule: isNetlifyScheduleEvent(event), stores: {} };
  for (const store of stores || []) {
    const log = [];
    out.stores[store.id] = log;
    try { await syncSquareFees(sb, store.id, log); } catch (e) { log.push({ square: String(e?.message || e) }); }
  }
  return json(200, out);
}

export const invoke = wrapHandler("channel-fee-sync", handle);

export default asNetlifyFunction(invoke);
