import { serviceClient } from "../lib/server.mjs";
import { ebayFetch, loadEbayConnection } from "../lib/ebay.mjs";
import { getStoreSquareAccess, squareClient } from "../lib/square.mjs";
import { webSquareClient, webSquareEnv } from "../lib/web-square.mjs";
import { Environment } from "square/legacy";

// Reconciles REAL fees + eBay-bought shipping labels onto recorded sales.
//  - eBay Finances SALE → marketplace fee (actual)
//  - eBay Finances SHIPPING_LABEL → label cost the seller paid on eBay
//  - Square Payments → card processing fee (register + website)
// Never touches listings.
const LOOKBACK_DAYS = 90;

function moneyToCents(amount) {
  if (amount == null) return null;
  const v = typeof amount === "object" ? amount.value : amount;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

async function* ebayTransactions(storeId, type, since) {
  // Finances uses apiz host + filter=transactionType:{…} (not a top-level query param).
  let offset = 0;
  for (;;) {
    const filter = encodeURIComponent(`transactionType:{${type}},transactionDate:[${since}..]`);
    const res = await ebayFetch(storeId, "GET",
      `/sell/finances/v1/transaction?filter=${filter}&limit=200&offset=${offset}`);
    const txns = res?.transactions || [];
    for (const tx of txns) yield tx;
    if (txns.length < 200) break;
    offset += txns.length;
  }
}

async function syncEbayFees(sb, storeId, log) {
  const conn = await loadEbayConnection(storeId).catch(() => null);
  if (!conn) return;
  const scopes = Array.isArray(conn.scopes) ? conn.scopes : [];
  if (scopes.length && !scopes.some((s) => String(s).includes("sell.finances"))) {
    log.push({ ebay: "reconnect_required_for_finances_scope" });
    return;
  }
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();

  for await (const tx of ebayTransactions(storeId, "SALE", since)) {
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
    if (error) log.push({ orderId, feeError: error.message });
    else log.push({ orderId, fee });
  }

  // Aggregate label debits/credits per order.
  // eBay sometimes omits orderId — fall back to references.
  // Wrong-label-then-replace: multiple DEBITs with no CREDIT yet → keep the latest debit only
  // (e.g. Ninja $110.21 canceled, then $43.51 kept; credit may lag in Finances).
  const labels = new Map(); // orderId -> { debits: [{cents,date}], creditCents }
  const orphanLabels = [];
  for await (const tx of ebayTransactions(storeId, "SHIPPING_LABEL", since)) {
    if (String(tx.transactionType || "").toUpperCase() !== "SHIPPING_LABEL") continue;
    const refs = Array.isArray(tx.references) ? tx.references : [];
    const orderRef = refs.find((r) => /ORDER_ID/i.test(String(r.referenceType || "")));
    const orderId = tx.orderId || orderRef?.referenceId || null;
    const entry = String(tx.bookingEntry || "").toUpperCase();
    if (entry !== "DEBIT" && entry !== "CREDIT") continue;
    const cents = moneyToCents(tx.amount);
    if (cents == null || cents === 0) continue;
    const abs = Math.abs(cents);
    if (!orderId) {
      orphanLabels.push({
        cents: entry === "CREDIT" ? -abs : abs,
        memo: tx.transactionMemo || null,
        date: tx.transactionDate || null,
        refs: refs.map((r) => `${r.referenceType}:${r.referenceId}`).slice(0, 6),
      });
      continue;
    }
    const cur = labels.get(orderId) || { debits: [], creditCents: 0 };
    if (entry === "CREDIT") cur.creditCents += abs;
    else cur.debits.push({ cents: abs, date: tx.transactionDate || "" });
    labels.set(orderId, cur);
  }
  if (orphanLabels.length) log.push({ orphanShippingLabels: orphanLabels });
  for (const [orderId, agg] of labels) {
    agg.debits.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const debitSum = agg.debits.reduce((n, d) => n + d.cents, 0);
    const net = debitSum - agg.creditCents;
    let labelCents = Math.max(0, net);
    let note = null;
    // Pending cancel: 2+ purchases, no refund posted yet → keep the replacement (latest).
    if (agg.creditCents === 0 && agg.debits.length >= 2) {
      labelCents = agg.debits[agg.debits.length - 1].cents;
      note = "latest_debit_pending_credit";
    }
    if (!labelCents) continue;
    const { data: co } = await sb.from("channel_orders")
      .select("item_cents,sale_id").eq("store_id", storeId).eq("provider", "ebay").eq("order_id", orderId).maybeSingle();
    let item = Number(co?.item_cents || 0);
    if (!item && co?.sale_id) {
      const { data: sale } = await sb.from("sales").select("price_cents").eq("id", co.sale_id).maybeSingle();
      item = Number(sale?.price_cents || 0);
      if (item > 0) {
        await sb.from("channel_orders").update({ item_cents: item })
          .eq("store_id", storeId).eq("provider", "ebay").eq("order_id", orderId);
      }
    }
    if (labelCents > 50000 && item > 0 && labelCents > item * 3) {
      log.push({ orderId, labelSkipped: labelCents, item, reason: "label_absurd" });
      continue;
    }
    const { error } = await sb.rpc("channel_order_update", {
      p_store: storeId, p_provider: "ebay", p_order_id: orderId,
      p_ship_label_cents: labelCents, p_ship_label_source: "ebay",
    });
    if (error) log.push({ orderId, labelError: error.message });
    else {
      await sb.from("web_orders").update({
        label_cost_cents: labelCents,
        label_purchased_at: new Date().toISOString(),
      }).eq("store_id", storeId).eq("payment_id", `ebay:${orderId}`);
      log.push({ orderId, label: labelCents, ...(note ? { note, debitSum, creditCents: agg.creditCents } : {}) });
    }
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
