import { serviceClient } from "../lib/server.mjs";
import { ebayFetch, loadEbayConnection } from "../lib/ebay.mjs";
import { getStoreSquareAccess, squareClient } from "../lib/square.mjs";
import { webSquareClient, webSquareEnv } from "../lib/web-square.mjs";
import { Environment } from "square/legacy";

// Reconciles REAL fees onto recorded sales so the ledger stops estimating.
//  - eBay: Finances API gives the exact marketplace fee per order (read-only).
//  - Square: Payments API gives the processing fee per card payment (register + website).
// Only writes to channel_orders / sales.processing_fee_cents. Never touches listings.
const LOOKBACK_DAYS = 14;

function moneyToCents(amount) {
  if (amount == null) return null;
  const v = typeof amount === "object" ? amount.value : amount;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

async function syncEbayFees(sb, storeId, log) {
  const conn = await loadEbayConnection(storeId).catch(() => null);
  if (!conn) return;
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  // SALE transactions carry orderLineItems[].marketplaceFees — the actual FVF etc.
  let offset = 0;
  for (;;) {
    const res = await ebayFetch(storeId, "GET",
      `/sell/finances/v1/transaction?transactionType=SALE&filter=transactionDate:[${since}..]&limit=200&offset=${offset}`);
    const txns = res?.transactions || [];
    for (const tx of txns) {
      const orderId = tx.orderId;
      if (!orderId) continue;
      let fee = 0;
      for (const item of tx.orderLineItems || []) {
        for (const f of item.marketplaceFees || []) fee += moneyToCents(f.amount) || 0;
      }
      const total = moneyToCents(tx.totalFeeAmount);
      if (total != null && Math.abs(total) > fee) fee = Math.abs(total);
      if (!fee) continue;
      const { error } = await sb.rpc("channel_order_update", {
        p_store: storeId, p_provider: "ebay", p_order_id: orderId,
        p_fee_cents: fee, p_fee_source: "actual",
      });
      if (error) log.push({ orderId, error: error.message });
      else log.push({ orderId, fee });
    }
    if (txns.length < 200) break;
    offset += txns.length;
  }
}

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

export const handler = async () => {
  const sb = serviceClient();
  const { data: stores, error } = await sb.from("stores").select("id");
  if (error) throw error;
  const out = {};
  for (const store of stores || []) {
    const log = [];
    out[store.id] = log;
    try { await syncEbayFees(sb, store.id, log); } catch (e) { log.push({ ebay: String(e?.message || e) }); }
    try { await syncSquareFees(sb, store.id, log); } catch (e) { log.push({ square: String(e?.message || e) }); }
  }
  return { statusCode: 200, body: JSON.stringify(out) };
};
