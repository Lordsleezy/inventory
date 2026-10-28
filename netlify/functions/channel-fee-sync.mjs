import { serviceClient, json, corsHeaders } from "../lib/server.mjs";
import { ebayFetch } from "../lib/ebay.mjs";
import { listEbayAccounts, resolveEbayAccount } from "../lib/ebay-accounts.mjs";
import { getStoreSquareAccess, squareClient } from "../lib/square.mjs";
import { webSquareClient, webSquareEnv, webSquareAccess } from "../lib/web-square.mjs";
import { Environment } from "square/legacy";
import { wrapHandler, asNetlifyFunction } from "../lib/floor-log.mjs";
import { isNetlifyScheduleEvent } from "../lib/schedule.mjs";
import { normalizeBooksPayout, saveBooksPayout } from "../lib/books-payout-import.mjs";
import { matchSquarePaymentsToTickets } from "../lib/square-books-match.mjs";

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

async function* ebayTransactions(storeId, type, since, hint = {}) {
  // Finances uses apiz host + filter=transactionType:{…} (not a top-level query param).
  let offset = 0;
  for (;;) {
    const filter = encodeURIComponent(`transactionType:{${type}},transactionDate:[${since}..]`);
    const res = await ebayFetch(storeId, "GET",
      `/sell/finances/v1/transaction?filter=${filter}&limit=200&offset=${offset}`, undefined, hint);
    const txns = res?.transactions || [];
    for (const tx of txns) yield tx;
    if (txns.length < 200) break;
    offset += txns.length;
  }
}

async function* ebayAllTransactions(storeId, since, hint = {}) {
  let offset = 0;
  for (;;) {
    const filter = encodeURIComponent(`transactionDate:[${since}..]`);
    const res = await ebayFetch(storeId, "GET", `/sell/finances/v1/transaction?filter=${filter}&limit=200&offset=${offset}`, undefined, hint);
    const txns = res?.transactions || [];
    for (const tx of txns) yield tx;
    if (txns.length < 200) break;
    offset += txns.length;
  }
}

async function saveEbayTransactionLedger(sb, storeId, account, since, hint) {
  const rows = [];
  for await (const tx of ebayAllTransactions(storeId, since, hint)) {
    if (!tx?.transactionId || !tx?.transactionDate) continue;
    const marketplaceFees = (tx.orderLineItems || []).flatMap((item) => item.marketplaceFees || []).flat().map((fee) => ({ type: fee.feeType || null, amount_cents: moneyToCents(fee.amount) }));
    rows.push({ store_id: storeId, account_id: String(account.id || account.username), account_username: account.username,
      transaction_id: String(tx.transactionId), transaction_type: String(tx.transactionType || "UNKNOWN").toUpperCase(),
      booking_entry: tx.bookingEntry || null, transaction_date: tx.transactionDate, order_id: tx.orderId || null,
      amount_cents: moneyToCents(tx.amount), total_fee_cents: moneyToCents(tx.totalFeeAmount), marketplace_fees: marketplaceFees,
      transaction_memo: tx.transactionMemo || null, refs: tx.references || [], updated_at: new Date().toISOString() });
    if (rows.length >= 200) {
      const { error } = await sb.from("books_ebay_transactions").upsert(rows.splice(0), { onConflict: "store_id,account_id,transaction_id" });
      if (error) throw error;
    }
  }
  if (rows.length) { const { error } = await sb.from("books_ebay_transactions").upsert(rows, { onConflict: "store_id,account_id,transaction_id" }); if (error) throw error; }
}

async function syncEbayFeesForAccount(sb, storeId, account, log) {
  const scopes = Array.isArray(account.scopes) ? account.scopes : [];
  if (scopes.length && !scopes.some((s) => String(s).includes("sell.finances"))) {
    log.push({ ebay: "reconnect_required_for_finances_scope", username: account.username, accountId: account.id });
    return;
  }
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  const hint = account.id ? { accountId: account.id } : {};

  await saveEbayTransactionLedger(sb, storeId, account, since, hint);

  for await (const tx of ebayTransactions(storeId, "SALE", since, hint)) {
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

  // Pull completed eBay bank payouts inside this existing 15-minute fee-sync schedule.
  let payoutOffset = 0;
  for (;;) {
    const filter = encodeURIComponent(`payoutDate:[${since}..]`);
    const result = await ebayFetch(storeId, "GET", `/sell/finances/v1/payout?filter=${filter}&limit=200&offset=${payoutOffset}`, undefined, hint);
    const payouts = result?.payouts || [];
    for (const payout of payouts) {
      const normalized = normalizeBooksPayout("ebay", payout);
      if (!normalized) continue;
      try { log.push(await saveBooksPayout(sb, storeId, normalized)); }
      catch (e) { log.push({ ebayPayoutId: normalized.external_payout_id, payoutError: e?.message || String(e) }); }
    }
    if (payouts.length < 200) break;
    payoutOffset += payouts.length;
  }

  // Aggregate label debits/credits per order.
  // eBay sometimes omits orderId — fall back to references.
  // Wrong-label-then-replace: multiple DEBITs with no CREDIT yet → keep the latest debit only
  // (e.g. Ninja $110.21 canceled, then $43.51 kept; credit may lag in Finances).
  const labels = new Map(); // orderId -> { debits: [{cents,date}], creditCents }
  const orphanLabels = [];
  for await (const tx of ebayTransactions(storeId, "SHIPPING_LABEL", since, hint)) {
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
      log.push({
        orderId,
        label: labelCents,
        username: account.username,
        ...(note ? { note, debitSum, creditCents: agg.creditCents } : {}),
      });
    }
  }
}

async function syncEbayFees(sb, storeId, log) {
  const accounts = await listEbayAccounts(storeId).catch(() => []);
  const connected = accounts.filter((a) => a.status === "connected");
  if (connected.length) {
    for (const account of connected) {
      try {
        await syncEbayFeesForAccount(sb, storeId, account, log);
      } catch (e) {
        log.push({ ebay: String(e?.message || e), username: account.username, accountId: account.id });
      }
    }
    return;
  }
  // Legacy single connection fallback.
  const legacy = await resolveEbayAccount(storeId).catch(() => null);
  if (!legacy) return;
  await syncEbayFeesForAccount(sb, storeId, legacy, log);
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

async function syncSquarePayouts(sb, storeId, log) {
  let access;
  try { access = webSquareAccess(storeId, webSquareEnv()); }
  catch (e) { log.push({ squarePayouts: "Square key not working" }); return; }
  const base = access.sandbox ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";
  const begin = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  const end = new Date().toISOString();
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const url = new URL("/v2/payouts", base);
    url.searchParams.set("begin_time", begin); url.searchParams.set("end_time", end); url.searchParams.set("limit", "100");
    if (access.locationId) url.searchParams.set("location_id", access.locationId);
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${access.accessToken}`, "Square-Version": "2024-01-18", "Content-Type": "application/json" } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { log.push({ squarePayouts: res.status === 401 || res.status === 403 ? "Square key not working" : `Square payouts request failed (HTTP ${res.status})` }); return; }
    for (const payout of body.payouts || []) {
      const normalized = normalizeBooksPayout("square", payout);
      if (!normalized) continue;
      try { log.push(await saveBooksPayout(sb, storeId, normalized)); }
      catch (e) { log.push({ squarePayoutId: normalized.external_payout_id, payoutError: e?.message || String(e) }); }
    }
    if (!body.cursor) break;
    cursor = body.cursor;
  }
}

async function syncSquarePaymentMatches(sb, storeId, log) {
  const { error: ledgerError } = await sb.from("books_square_payments").select("payment_id").eq("store_id", storeId).limit(1);
  if (ledgerError) {
    log.push({ squareMatches: ledgerError.code === "PGRST205" || ledgerError.code === "42P01" ? "Books Square ledger is not available yet" : "Could not read the Books Square ledger" });
    return;
  }
  let access;
  try { access = webSquareAccess(storeId, webSquareEnv()); }
  catch (e) { log.push({ squareMatches: "Square key not working" }); return; }
  const base = access.sandbox ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";
  const payments = []; let cursor = "";
  for (let page = 0; page < 200; page++) {
    const url = new URL("/v2/payments", base);
    for (const [k,v] of Object.entries({ begin_time: "2013-01-01T00:00:00Z", end_time: new Date().toISOString(), location_id: access.locationId || access.location_id || "", limit: "100", ...(cursor ? { cursor } : {}) })) if (v) url.searchParams.set(k,v);
    const res = await fetch(url,{headers:{Authorization:`Bearer ${access.accessToken || access.access_token}`,"Square-Version":"2024-01-18","Content-Type":"application/json"}});
    const body = await res.json().catch(()=>({}));
    if (!res.ok) { log.push({ squareMatches: res.status === 401 || res.status === 403 ? "Square key not working" : `Square payments request failed (HTTP ${res.status})` }); return; }
    payments.push(...(body.payments||[])); cursor=body.cursor||""; if(!cursor)break;
  }
  const [saleRes, extraRes] = await Promise.all([
    sb.from("sales").select("id,ticket_id,sku,sold_at,price_cents,tax_cents,channel,payment_method,voided_at").eq("store_id",storeId).is("voided_at",null).in("payment_method",["card","split"]).limit(10000),
    sb.from("ticket_extras").select("ticket_id,card_cents").eq("store_id",storeId).limit(10000),
  ]);
  if(saleRes.error)throw saleRes.error;if(extraRes.error)throw extraRes.error;
  const extras=new Map((extraRes.data||[]).map(x=>[String(x.ticket_id),Number(x.card_cents||0)]));
  const grouped=new Map();for(const s of saleRes.data||[]){if(!s.ticket_id||!['floor','in_store','instore','store'].includes(String(s.channel||'').toLowerCase()))continue;const key=String(s.ticket_id);grouped.set(key,[...(grouped.get(key)||[]),s]);}
  const tickets=[...grouped.entries()].map(([ticket_id,rows])=>({ticket_id,sold_at:rows.map(s=>s.sold_at).sort()[0],card_cents:extras.get(ticket_id)||0,sale_ids:rows.map(s=>s.id),weights:rows.map(s=>Math.max(0,Number(s.price_cents||0)+Number(s.tax_cents||0)))})).filter(t=>t.card_cents>0);
  const matched=matchSquarePaymentsToTickets(payments,tickets);
  for(let i=0;i<matched.length;i+=200){const batch=matched.slice(i,i+200).map(x=>({store_id:storeId,payment_id:x.payment_id,created_at:x.created_at,amount_cents:x.amount_cents,fee_cents:x.fee_cents,refund_cents:x.refund_cents,status:'COMPLETED',source_type:'CARD',match_status:x.status,ticket_id:x.ticket_id,sale_ids:x.sale_ids,candidate_ticket_ids:x.candidates,updated_at:new Date().toISOString()}));const {error}=await sb.from('books_square_payments').upsert(batch,{onConflict:'store_id,payment_id'});if(error)throw error;}
  log.push({squareMatches:{payments:matched.length,matched:matched.filter(x=>x.status==='matched').length,unmatched:matched.filter(x=>x.status==='unmatched').length,ambiguous:matched.filter(x=>x.status==='ambiguous').length,tickets:tickets.length}});
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
    try { await syncEbayFees(sb, store.id, log); } catch (e) { log.push({ ebay: String(e?.message || e) }); }
    try { await syncSquareFees(sb, store.id, log); } catch (e) { log.push({ square: String(e?.message || e) }); }
    try { await syncSquarePaymentMatches(sb, store.id, log); } catch (e) { log.push({ squareMatches: String(e?.message || e) }); }
    try { await syncSquarePayouts(sb, store.id, log); } catch (e) { log.push({ squarePayouts: String(e?.message || e) }); }
    // Real eBay / Square balances for the Money tab: self-throttled to once per 6 hours (most runs only read one setting).
    try { log.push({ money: await (await import("../lib/money-sync.mjs")).runMoneySync(sb, store.id) }); } catch (e) { log.push({ money: String(e?.message || e) }); }
  }
  return json(200, out);
}

export const invoke = wrapHandler("channel-fee-sync", handle);

export default asNetlifyFunction(invoke);
