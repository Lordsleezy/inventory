import { parseFinanceTransactions, fetchTransactions } from "./ebay-fees.mjs";

// One-time history pass: re-pull eBay's real fees for every past eBay sale and show what changes.
//   dry run (default): writes nothing; commission change is a rolled-back preview.
//   apply:             records real fees on every sale (ledger/reports become exact) and re-bases the commission of
//                      UNPAID sales. A sale with any commission already paid out is never re-based; it is listed.
// The database refuses to rewrite paid-out commission (payout_refresh_ebay_fees); this runner also never asks it to.

const PAGE = 1000;

async function paged(make) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await make().range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if ((data || []).length < PAGE) return out;
  }
}

const orderIdOf = (paymentId) => String(paymentId || "").replace(/^ebay:/, "");
const sumFees = (rows) => rows.filter((r) => r.fee_type !== "SHIPPING_LABEL").reduce((n, r) => n + r.amount_cents, 0);
const sumAd = (rows) => rows.filter((r) => /AD_FEE/.test(r.fee_type)).reduce((n, r) => n + r.amount_cents, 0);

/**
 * @returns {{ rows: object[], paidOut: object[], summary: object }}
 * deps: { fetcher, now, accounts, budgetMs }
 */
export async function runEbayFeeHistory(sb, storeId, { apply = false, ...deps } = {}) {
  const ledger = (await paged(() => sb.from("sale_ledger")
    .select("id,sku,sold_at,payment_id,channel,voided_at,channel_fee_cents,fee_source,profit_cents")
    .eq("store_id", storeId).eq("channel", "ebay").order("id")))
    .filter((r) => !r.voided_at && String(r.payment_id || "").startsWith("ebay:"));
  if (!ledger.length) return { rows: [], paidOut: [], summary: { sales: 0 } };

  const commissions = await paged(() => sb.from("sale_commissions").select("sale_id,employee_id,amount_cents").eq("store_id", storeId).order("sale_id"));
  const staff = await paged(() => sb.from("staff").select("user_id,display_name").eq("store_id", storeId).order("user_id"));
  const names = new Map(staff.map((s) => [s.user_id, s.display_name]));
  const { data: paidRows, error: paidErr } = await sb.rpc("ebay_commission_paid_status", { p_store: storeId });
  if (paidErr) throw new Error(paidErr.message);
  const paidBySale = new Map();
  for (const p of paidRows || []) paidBySale.set(p.sale_id, (paidBySale.get(p.sale_id) || 0) + (p.paid_cents || 0));
  const commBySale = new Map();
  for (const c of commissions) {
    if (!commBySale.has(c.sale_id)) commBySale.set(c.sale_id, {});
    commBySale.get(c.sale_id)[c.employee_id] = c.amount_cents;
  }

  // Real money from eBay, back to the oldest eBay sale.
  const now = deps.now ? new Date(deps.now) : new Date();
  const oldest = ledger.reduce((m, r) => (r.sold_at < m ? r.sold_at : m), ledger[0].sold_at);
  const since = new Date(Date.parse(oldest) - 2 * 86400e3).toISOString();
  let accounts = deps.accounts;
  if (!accounts) {
    const { listEbayAccounts } = await import("./ebay-accounts.mjs");
    accounts = (await listEbayAccounts(storeId)).filter((a) => a.status === "connected");
  }
  const orders = new Map();
  const warnings = [];
  for (const account of accounts) {
    const scopes = Array.isArray(account.scopes) ? account.scopes : [];
    if (scopes.length && !scopes.some((s) => String(s).includes("sell.finances"))) {
      warnings.push(`${account.username || account.id}: missing sell.finances scope (reconnect eBay)`);
      continue;
    }
    const hint = account.id ? { accountId: account.id } : {};
    const page = await fetchTransactions({ storeId, hint, since, budgetUntil: Date.now() + (deps.budgetMs ?? 600000), fetcher: deps.fetcher });
    if (!page.complete) warnings.push(`${account.username || account.id}: transaction pull stopped early (time budget); rerun`);
    for (const [id, o] of parseFinanceTransactions(page.transactions).orders) orders.set(id, o);
  }

  const rows = [];
  for (const sale of ledger) {
    const orderId = orderIdOf(sale.payment_id);
    const o = orders.get(orderId);
    const row = {
      sale_id: sale.id, sku: sale.sku, order_id: orderId, sold_at: sale.sold_at,
      old_fee_cents: sale.channel_fee_cents, old_fee_source: sale.fee_source, old_profit_cents: sale.profit_cents,
      real_fee_cents: null, ad_fee_cents: null, new_profit_cents: null, status: "", commission: [],
      paid_cents: paidBySale.get(sale.id) || 0,
    };
    if (!o || o.saleTxnAt == null) {
      row.status = "no_finances_data";
      rows.push(row);
      continue;
    }
    row.real_fee_cents = sumFees(o.rows);
    row.ad_fee_cents = sumAd(o.rows);
    row.new_profit_cents = sale.profit_cents == null ? null : sale.profit_cents + sale.channel_fee_cents - row.real_fee_cents;
    const paid = row.paid_cents > 0;

    if (apply) {
      const { error } = await sb.rpc("ebay_record_order_fees", {
        p_store: storeId, p_order_id: orderId, p_rows: o.rows, p_sale_txn_at: o.saleTxnAt,
        p_net_cents: o.netCents, p_tax_cents: o.taxCents, p_label_cents: o.labelCents,
      });
      if (error) { row.status = `error: ${error.message}`; rows.push(row); continue; }
    }
    // Paid-out sales are only ever previewed (dry), even in apply mode.
    const { data: refresh, error: rErr } = await sb.rpc("payout_refresh_ebay_fees", {
      p_sale: sale.id, p_dry: !apply || paid, p_fee: apply ? null : row.real_fee_cents, p_label: null,
    });
    if (rErr) { row.status = `error: ${rErr.message}`; rows.push(row); continue; }
    row.status = paid ? "paid_out_not_changed" : !apply ? "would_update" : refresh?.status === "not_frozen" ? "fees_recorded_not_frozen_yet" : "updated";
    const before = refresh?.before || commBySale.get(sale.id) || {};
    const after = refresh?.after || before;
    for (const emp of new Set([...Object.keys(before), ...Object.keys(after)])) {
      row.commission.push({
        employee_id: emp, name: names.get(emp) || emp,
        old_cents: before[emp] ?? null, new_cents: after[emp] ?? null,
        delta_cents: before[emp] == null || after[emp] == null ? null : after[emp] - before[emp],
      });
    }
    rows.push(row);
  }

  if (apply) {
    const done = rows.filter((r) => ["updated", "paid_out_not_changed", "fees_recorded_not_frozen_yet"].includes(r.status));
    for (let i = 0; i < done.length; i += 200) {
      const ids = done.slice(i, i + 200).map((r) => r.sale_id);
      const { data } = await sb.from("sale_ledger").select("id,channel_fee_cents,profit_cents").in("id", ids);
      const byId = new Map((data || []).map((d) => [d.id, d]));
      for (const r of done.slice(i, i + 200)) {
        const d = byId.get(r.sale_id);
        if (d) { r.real_fee_cents = d.channel_fee_cents; r.new_profit_cents = d.profit_cents; }
      }
    }
    await sb.rpc("ebay_fee_settle_due", { p_store: storeId, p_now: now.toISOString() });
  }

  const paidOut = rows.filter((r) => r.status === "paid_out_not_changed");
  const count = (s) => rows.filter((r) => r.status === s).length;
  const summary = {
    mode: apply ? "apply" : "dry_run",
    sales: rows.length,
    updated: count("updated") + count("would_update"),
    paid_out_not_changed: paidOut.length,
    no_finances_data: count("no_finances_data"),
    with_ad_fee: rows.filter((r) => r.ad_fee_cents).length,
    ad_fee_total_cents: rows.reduce((n, r) => n + (r.ad_fee_cents || 0), 0),
    fee_change_total_cents: rows.reduce((n, r) => n + (r.real_fee_cents == null ? 0 : r.real_fee_cents - r.old_fee_cents), 0),
    unpaid_commission_change_cents: rows.filter((r) => r.status === "updated" || r.status === "would_update")
      .reduce((n, r) => n + r.commission.reduce((m, c) => m + (c.delta_cents || 0), 0), 0),
    paid_out_commission_would_change_cents: paidOut.reduce((n, r) => n + r.commission.reduce((m, c) => m + (c.delta_cents || 0), 0), 0),
    warnings,
  };
  return { rows, paidOut, summary };
}

const q = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const dollars = (c) => (c == null ? "" : (c / 100).toFixed(2));

export function historyCsv(rows) {
  const head = ["sale_id", "sku", "order_id", "sold_at", "status", "old_fee", "old_fee_source", "real_fee", "fee_change", "ad_fee",
    "old_profit", "new_profit", "profit_change", "commission_paid_so_far", "commission_old_new_delta_by_person"];
  const lines = [head.join(",")];
  for (const r of rows) {
    lines.push([
      r.sale_id, r.sku, r.order_id, r.sold_at, r.status, dollars(r.old_fee_cents), r.old_fee_source, dollars(r.real_fee_cents),
      r.real_fee_cents == null ? "" : dollars(r.real_fee_cents - r.old_fee_cents), dollars(r.ad_fee_cents),
      dollars(r.old_profit_cents), dollars(r.new_profit_cents),
      r.new_profit_cents == null || r.old_profit_cents == null ? "" : dollars(r.new_profit_cents - r.old_profit_cents),
      dollars(r.paid_cents),
      r.commission.map((c) => `${c.name}: ${dollars(c.old_cents)} -> ${dollars(c.new_cents)} (${c.delta_cents == null ? "?" : dollars(c.delta_cents)})`).join(" | "),
    ].map(q).join(","));
  }
  return lines.join("\n") + "\n";
}

export function paidOutText(paidOut) {
  if (!paidOut.length) return "No paid-out sales are affected.\n";
  const out = ["Paid-out sales: commission NOT changed. Dollar change that real fees would make (decide per sale):"];
  for (const r of paidOut) {
    out.push(`  sale ${r.sale_id} · SKU ${r.sku} · eBay ${r.order_id} · ${String(r.sold_at).slice(0, 10)} · paid so far $${dollars(r.paid_cents)} · fee $${dollars(r.old_fee_cents)} -> $${dollars(r.real_fee_cents)} (ad fee $${dollars(r.ad_fee_cents) || "0.00"})`);
    for (const c of r.commission) out.push(`      ${c.name}: $${dollars(c.old_cents)} -> $${dollars(c.new_cents)} (${c.delta_cents == null ? "n/a" : (c.delta_cents < 0 ? "-" : "+") + "$" + dollars(Math.abs(c.delta_cents))})`);
  }
  return out.join("\n") + "\n";
}
