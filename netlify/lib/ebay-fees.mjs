// Real eBay money, straight from the Sell Finances API (getTransactions). Floor never computes an eBay fee.
//   SALE              → every marketplace fee on the order, by fee type, and the sale's net
//   NON_SALE_CHARGE   → ad fees (AD_FEE / PREMIUM_AD_FEES) and other charges; attached to the order when eBay names one
//   SHIPPING_LABEL    → label debits/credits for the order
// Stored per fee type in ebay_order_fees; channel_orders.fee_cents is their sum (see ebay_record_order_fees).

// eBay clients are imported lazily so the parser and sync logic stay unit-testable without Netlify's runtime packages.
const liveFetcher = async (...args) => (await import("./ebay.mjs")).ebayFetch(...args);

export const AD_FEE_TYPES = new Set(["AD_FEE", "PREMIUM_AD_FEES"]);
const SWEEP_EVERY_MS = 6 * 3600e3;
const SWEEP_DAYS = 90;
const PENDING_MAX_DAYS = 45;

export function moneyToCents(amount) {
  if (amount == null) return null;
  const v = typeof amount === "object" ? amount.value : amount;
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

const isAdFeeType = (t) => AD_FEE_TYPES.has(String(t || "").toUpperCase()) || /AD_FEE/i.test(String(t || ""));
const signed = (cents, entry) => (String(entry || "").toUpperCase() === "CREDIT" ? -Math.abs(cents) : Math.abs(cents));

function orderIdOf(tx) {
  if (tx.orderId) return String(tx.orderId);
  const ref = (Array.isArray(tx.references) ? tx.references : []).find((r) => /ORDER_ID/i.test(String(r?.referenceType || "")));
  return ref?.referenceId ? String(ref.referenceId) : null;
}

/**
 * Group raw Finances transactions by eBay order.
 * Returns { orders: Map<orderId, {...}>, unattached: row[], orphanLabels: [] }.
 * Fee rows are { fee_type, amount_cents (+ charged / − credited), txn_id, txn_type, txn_date, line_item_id }.
 */
export function parseFinanceTransactions(transactions) {
  const orders = new Map();
  const unattached = [];
  const orphanLabels = [];
  const labelAgg = new Map(); // orderId -> { debits: [{cents,date}], creditCents }
  const get = (id) => {
    if (!orders.has(id)) orders.set(id, { rows: [], saleTxnAt: null, saleNetCents: null, taxCents: null, nonSaleCents: 0, labelCents: null, labelNote: null });
    return orders.get(id);
  };

  for (const tx of transactions || []) {
    const type = String(tx?.transactionType || "").toUpperCase();
    if (String(tx?.transactionStatus || "").toUpperCase() === "FAILED") continue;
    const txnId = String(tx.transactionId || "");
    if (!txnId) continue;
    const date = tx.transactionDate || null;

    if (type === "SALE") {
      const orderId = orderIdOf(tx);
      if (!orderId) continue;
      const o = get(orderId);
      o.saleTxnAt = date || o.saleTxnAt;
      const net = moneyToCents(tx.amount);
      // A SALE credit is money to us (+); a debit (reversal) is money out (−). Fee rows use the opposite sign.
      if (net != null) o.saleNetCents = String(tx.bookingEntry || "").toUpperCase() === "DEBIT" ? -Math.abs(net) : Math.abs(net);
      let itemized = 0;
      let tax = null;
      for (const item of tx.orderLineItems || []) {
        for (const f of item.marketplaceFees || []) {
          const cents = moneyToCents(f.amount);
          if (cents == null || !f.feeType) continue;
          itemized += cents;
          o.rows.push({ fee_type: String(f.feeType).toUpperCase(), amount_cents: cents, txn_id: txnId, txn_type: "SALE", txn_date: date, line_item_id: String(item.lineItemId || "") });
        }
        for (const t of item.taxes || []) {
          const c = moneyToCents(t.amount);
          if (c != null) tax = (tax ?? 0) + c;
        }
      }
      if (tax != null) o.taxCents = (o.taxCents ?? 0) + tax;
      // eBay's own total is the truth: anything the itemized list does not explain is kept as its own line.
      const total = moneyToCents(tx.totalFeeAmount);
      if (total != null && Math.abs(total) !== Math.abs(itemized)) {
        o.rows.push({ fee_type: "OTHER_FEES", amount_cents: Math.abs(total) - itemized, txn_id: txnId, txn_type: "SALE", txn_date: date, line_item_id: "" });
      }
      continue;
    }

    if (type === "SHIPPING_LABEL") {
      const cents = moneyToCents(tx.amount);
      const entry = String(tx.bookingEntry || "").toUpperCase();
      if (cents == null || cents === 0 || (entry !== "DEBIT" && entry !== "CREDIT")) continue;
      const orderId = orderIdOf(tx);
      const abs = Math.abs(cents);
      if (!orderId) {
        orphanLabels.push({ cents: entry === "CREDIT" ? -abs : abs, memo: tx.transactionMemo || null, date });
        continue;
      }
      get(orderId).rows.push({ fee_type: "SHIPPING_LABEL", amount_cents: entry === "CREDIT" ? -abs : abs, txn_id: txnId, txn_type: "SHIPPING_LABEL", txn_date: date, line_item_id: "" });
      const cur = labelAgg.get(orderId) || { debits: [], creditCents: 0 };
      if (entry === "CREDIT") cur.creditCents += abs;
      else cur.debits.push({ cents: abs, date: date || "" });
      labelAgg.set(orderId, cur);
      continue;
    }

    if (type === "NON_SALE_CHARGE" || isAdFeeType(type)) {
      const cents = moneyToCents(tx.amount);
      if (cents == null || cents === 0) continue;
      const feeType = String(tx.feeType || (isAdFeeType(type) ? type : "NON_SALE_CHARGE")).toUpperCase();
      const amount = signed(cents, tx.bookingEntry);
      const orderId = orderIdOf(tx);
      const row = { fee_type: feeType, amount_cents: amount, txn_id: txnId, txn_type: "NON_SALE_CHARGE", txn_date: date, line_item_id: "" };
      if (orderId) {
        const o = get(orderId);
        o.rows.push(row);
        o.nonSaleCents += amount;
      } else {
        unattached.push({ ...row, order_id: null, memo: tx.transactionMemo || null });
      }
    }
  }

  // Label: debits minus credits. Wrong label bought then replaced, credit not posted yet → keep the latest debit.
  for (const [orderId, agg] of labelAgg) {
    agg.debits.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const debitSum = agg.debits.reduce((n, d) => n + d.cents, 0);
    let label = Math.max(0, debitSum - agg.creditCents);
    const o = get(orderId);
    if (agg.creditCents === 0 && agg.debits.length >= 2) {
      label = agg.debits[agg.debits.length - 1].cents;
      o.labelNote = "latest_debit_pending_credit";
    }
    o.labelCents = label || null;
  }

  // Net after everything eBay attached to the order (what Seller Hub order earnings shows as net).
  for (const o of orders.values()) {
    if (o.saleNetCents != null) {
      const labelNet = o.rows.filter((r) => r.fee_type === "SHIPPING_LABEL").reduce((n, r) => n + r.amount_cents, 0);
      o.netCents = o.saleNetCents - o.nonSaleCents - labelNet;
    } else {
      o.netCents = null;
    }
  }
  return { orders, unattached, orphanLabels };
}

export async function fetchTransactions({ storeId, hint, since, budgetUntil, fetcher = liveFetcher }) {
  const out = [];
  let offset = 0;
  let complete = true;
  for (;;) {
    if (Date.now() > budgetUntil) { complete = false; break; }
    const filter = encodeURIComponent(`transactionDate:[${since}..]`);
    const res = await fetcher(storeId, "GET", `/sell/finances/v1/transaction?filter=${filter}&limit=200&offset=${offset}`, undefined, hint);
    const txns = res?.transactions || [];
    out.push(...txns);
    if (txns.length < 200) break;
    offset += txns.length;
  }
  return { transactions: out, complete };
}

async function pagedOrders(sb, storeId, since) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("channel_orders")
      .select("order_id,item_cents,created_at,fees_settled_at")
      .eq("store_id", storeId).eq("provider", "ebay").gte("created_at", since)
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if ((data || []).length < 1000) return rows;
  }
}

/**
 * Pull real eBay fees for one store and record them. Does nothing (no eBay calls) unless some order is still
 * waiting on fees or the 6-hourly reconcile sweep is due. Safe to run on every ebay-sync tick.
 *
 * deps (tests): { fetcher, now, budgetMs, accounts, force }
 */
export async function syncEbayFees(sb, storeId, deps = {}) {
  const now = deps.now ? new Date(deps.now) : new Date();
  const budgetUntil = Date.now() + (deps.budgetMs ?? 25000);
  const log = [];

  const { data: pending, error: pErr } = await sb.from("channel_orders")
    .select("order_id,created_at")
    .eq("store_id", storeId).eq("provider", "ebay").is("fees_settled_at", null)
    .gte("created_at", new Date(now.getTime() - PENDING_MAX_DAYS * 86400e3).toISOString())
    .order("created_at", { ascending: true }).limit(1000);
  if (pErr) throw new Error(pErr.message);

  const { data: sweepRow } = await sb.from("store_settings").select("value")
    .eq("store_id", storeId).eq("key", "ebay_fees_sweep_at").maybeSingle();
  const lastSweep = Date.parse(typeof sweepRow?.value === "string" ? sweepRow.value : "");
  const sweepDue = deps.force || !Number.isFinite(lastSweep) || now.getTime() - lastSweep >= SWEEP_EVERY_MS;
  if (!(pending || []).length && !sweepDue) return { skipped: "nothing_pending", settled: 0, log };

  const sinceMs = sweepDue
    ? now.getTime() - SWEEP_DAYS * 86400e3
    : Date.parse(pending[0].created_at) - 86400e3;
  const since = new Date(sinceMs).toISOString();
  const known = new Map((await pagedOrders(sb, storeId, new Date(sinceMs - 86400e3).toISOString())).map((r) => [String(r.order_id), r]));

  let accounts = deps.accounts;
  if (!accounts) {
    const { listEbayAccounts, resolveEbayAccount } = await import("./ebay-accounts.mjs");
    const all = await listEbayAccounts(storeId).catch(() => []);
    accounts = all.filter((a) => a.status === "connected");
    if (!accounts.length) {
      const legacy = await resolveEbayAccount(storeId).catch(() => null);
      if (legacy) accounts = [legacy];
    }
  }

  let recorded = 0;
  let complete = true;
  for (const account of accounts) {
    const scopes = Array.isArray(account.scopes) ? account.scopes : [];
    if (scopes.length && !scopes.some((s) => String(s).includes("sell.finances"))) {
      log.push({ ebay: "reconnect_required_for_finances_scope", username: account.username, accountId: account.id });
      continue;
    }
    const hint = account.id ? { accountId: account.id } : {};
    let page;
    try {
      page = await fetchTransactions({ storeId, hint, since, budgetUntil, fetcher: deps.fetcher });
    } catch (e) {
      log.push({ ebay: String(e?.message || e), username: account.username, accountId: account.id });
      complete = false;
      continue;
    }
    if (!page.complete) complete = false;
    const parsed = parseFinanceTransactions(page.transactions);
    if (parsed.orphanLabels.length) log.push({ orphanShippingLabels: parsed.orphanLabels.slice(0, 20) });

    for (const [orderId, o] of parsed.orders) {
      const co = known.get(orderId);
      if (!co) continue;
      let label = o.labelCents;
      if (label && label > 50000 && Number(co.item_cents) > 0 && label > Number(co.item_cents) * 3) {
        log.push({ orderId, labelSkipped: label, item: co.item_cents, reason: "label_absurd" });
        label = null;
      }
      const { error } = await sb.rpc("ebay_record_order_fees", {
        p_store: storeId, p_order_id: orderId, p_rows: o.rows,
        p_sale_txn_at: o.saleTxnAt, p_net_cents: o.netCents, p_tax_cents: o.taxCents, p_label_cents: label,
      });
      if (error) { log.push({ orderId, feeError: error.message }); continue; }
      recorded += 1;
      if (label) {
        // The packing row shows the label eBay charged.
        await sb.from("web_orders").update({ label_cost_cents: label, label_purchased_at: now.toISOString() })
          .eq("store_id", storeId).eq("payment_id", `ebay:${orderId}`);
      }
    }

    // Ad charges eBay did not tie to an order: stored, and debits booked once as eBay overhead (keyed by eBay's txn id).
    for (const u of parsed.unattached) {
      const { error } = await sb.from("ebay_order_fees").upsert({
        store_id: storeId, order_id: null, fee_type: u.fee_type, amount_cents: u.amount_cents,
        txn_id: u.txn_id, txn_type: u.txn_type, txn_date: u.txn_date, line_item_id: "",
      }, { onConflict: "store_id,txn_id,fee_type,line_item_id" });
      if (error) { log.push({ txn: u.txn_id, feeError: error.message }); continue; }
      if (u.amount_cents > 0 && isAdFeeType(u.fee_type)) {
        const day = String(u.txn_date || now.toISOString()).slice(0, 10);
        const { error: expErr } = await sb.rpc("portal_upsert_ebay_fee_expense", {
          p_store: storeId, p_external_id: u.txn_id, p_spent_on: day,
          p_description: `eBay ${u.fee_type === "PREMIUM_AD_FEES" ? "Promoted Listings Advanced" : "Promoted Listings"} charge${u.memo ? ` · ${u.memo}` : ""}`.slice(0, 250),
          p_category: "eBay ad fees", p_amount_cents: u.amount_cents,
        });
        if (expErr) log.push({ txn: u.txn_id, expenseError: expErr.message });
      }
    }
  }

  const { data: settled, error: sErr } = await sb.rpc("ebay_fee_settle_due", { p_store: storeId, p_now: now.toISOString() });
  if (sErr) log.push({ settleError: sErr.message });

  if (sweepDue && complete) {
    await sb.from("store_settings").upsert({ store_id: storeId, key: "ebay_fees_sweep_at", value: now.toISOString() }, { onConflict: "store_id,key" });
  }
  return { recorded, settled: settled ?? 0, sweep: Boolean(sweepDue), complete, log };
}
