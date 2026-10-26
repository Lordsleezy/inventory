import test from "node:test";
import assert from "node:assert/strict";
import { parseFinanceTransactions, syncEbayFees, moneyToCents } from "./ebay-fees.mjs";

const money = (v) => ({ value: String(v), currency: "USD" });

// A promoted sale as Finances reports it: final value fee + fixed fee + promoted-listing ad fee on the SALE.
const promotedSale = {
  transactionId: "SALE-1", transactionType: "SALE", orderId: "27-11111-22222", transactionDate: "2026-10-20T15:00:00.000Z",
  bookingEntry: "CREDIT", amount: money("86.70"), totalFeeAmount: money("21.30"),
  orderLineItems: [{
    lineItemId: "L1",
    marketplaceFees: [
      { feeType: "FINAL_VALUE_FEE", amount: money("13.00") },
      { feeType: "FINAL_VALUE_FEE_FIXED_PER_ORDER", amount: money("0.30") },
      { feeType: "AD_FEE", amount: money("8.00") },
    ],
  }],
};

test("moneyToCents handles objects, strings and junk", () => {
  assert.equal(moneyToCents(money("13.30")), 1330);
  assert.equal(moneyToCents("0.30"), 30);
  assert.equal(moneyToCents(null), null);
  assert.equal(moneyToCents({ value: "x" }), null);
});

test("SALE: every fee type kept separately, sale date and net recorded", () => {
  const { orders } = parseFinanceTransactions([promotedSale]);
  const o = orders.get("27-11111-22222");
  assert.deepEqual(o.rows.map((r) => [r.fee_type, r.amount_cents]), [
    ["FINAL_VALUE_FEE", 1300], ["FINAL_VALUE_FEE_FIXED_PER_ORDER", 30], ["AD_FEE", 800],
  ]);
  assert.equal(o.saleTxnAt, "2026-10-20T15:00:00.000Z");
  assert.equal(o.saleNetCents, 8670);
  assert.equal(o.netCents, 8670);
});

test("fees eBay's total explains but the itemized list does not become their own line", () => {
  const tx = { ...promotedSale, totalFeeAmount: money("22.00") };
  const o = parseFinanceTransactions([tx]).orders.get("27-11111-22222");
  const other = o.rows.find((r) => r.fee_type === "OTHER_FEES");
  assert.equal(other.amount_cents, 70);
  assert.equal(o.rows.reduce((n, r) => n + r.amount_cents, 0), 2200);
});

test("NON_SALE_CHARGE ad fee with an order id attaches to that order and lowers its net", () => {
  const late = {
    transactionId: "AD-9", transactionType: "NON_SALE_CHARGE", feeType: "AD_FEE", orderId: "27-11111-22222",
    transactionDate: "2026-10-21T08:00:00.000Z", bookingEntry: "DEBIT", amount: money("2.50"),
  };
  const { orders, unattached } = parseFinanceTransactions([promotedSale, late]);
  const o = orders.get("27-11111-22222");
  assert.equal(unattached.length, 0);
  assert.equal(o.rows.filter((r) => r.fee_type === "AD_FEE").reduce((n, r) => n + r.amount_cents, 0), 1050);
  assert.equal(o.netCents, 8670 - 250);
});

test("NON_SALE_CHARGE matched through an ORDER_ID reference; PREMIUM_AD_FEES with no order stays unattached", () => {
  const viaRef = {
    transactionId: "AD-10", transactionType: "NON_SALE_CHARGE", feeType: "AD_FEE", transactionDate: "2026-10-21T08:00:00.000Z",
    bookingEntry: "DEBIT", amount: money("1.00"), references: [{ referenceType: "ORDER_ID", referenceId: "27-AAA" }],
  };
  const campaign = { transactionId: "CAMP-1", transactionType: "NON_SALE_CHARGE", feeType: "PREMIUM_AD_FEES", transactionDate: "2026-10-21T00:00:00.000Z", bookingEntry: "DEBIT", amount: money("15.00") };
  const credit = { ...campaign, transactionId: "CAMP-2", bookingEntry: "CREDIT", amount: money("3.00") };
  const { orders, unattached } = parseFinanceTransactions([viaRef, campaign, credit]);
  assert.equal(orders.get("27-AAA").rows[0].amount_cents, 100);
  assert.deepEqual(unattached.map((u) => [u.fee_type, u.amount_cents]), [["PREMIUM_AD_FEES", 1500], ["PREMIUM_AD_FEES", -300]]);
});

test("SHIPPING_LABEL: debit minus credit; replacement label with no credit yet keeps the latest", () => {
  const label = (id, entry, amount, date, orderId = "27-LBL") => ({ transactionId: id, transactionType: "SHIPPING_LABEL", orderId, bookingEntry: entry, amount: money(amount), transactionDate: date });
  let o = parseFinanceTransactions([label("a", "DEBIT", "11.00", "2026-10-01T00:00:00Z"), label("b", "CREDIT", "11.00", "2026-10-02T00:00:00Z"), label("c", "DEBIT", "4.35", "2026-10-02T01:00:00Z")]).orders.get("27-LBL");
  assert.equal(o.labelCents, 435);
  o = parseFinanceTransactions([label("a", "DEBIT", "11.02", "2026-10-01T00:00:00Z"), label("c", "DEBIT", "4.35", "2026-10-02T01:00:00Z")]).orders.get("27-LBL");
  assert.equal(o.labelCents, 435);
  assert.equal(o.labelNote, "latest_debit_pending_credit");
  const orphan = parseFinanceTransactions([{ ...label("z", "DEBIT", "5.00", "2026-10-01T00:00:00Z"), orderId: undefined }]);
  assert.equal(orphan.orphanLabels.length, 1);
});

// ── orchestrator ────────────────────────────────────────────────────────────────────────────────

function fakeSb({ pending = [], known = [], settings = {} } = {}) {
  const calls = { rpc: [], upserts: [], updates: [] };
  const from = (table) => {
    const api = {
      select: () => api, eq: () => api, is: () => api, gte: () => api, order: () => api,
      limit: () => Promise.resolve({ data: pending, error: null }),
      range: () => Promise.resolve({ data: known, error: null }),
      maybeSingle: () => Promise.resolve({ data: settings[table] ?? null, error: null }),
      upsert: (row) => { calls.upserts.push({ table, row }); return Promise.resolve({ error: null }); },
      update: (row) => { calls.updates.push({ table, row }); return api; },
      then: undefined,
    };
    return api;
  };
  const rpc = (name, args) => { calls.rpc.push({ name, args }); return Promise.resolve({ data: name === "ebay_fee_settle_due" ? 0 : { found: true }, error: null }); };
  return { from, rpc, calls };
}

test("sync makes no eBay calls when nothing is waiting and the sweep is not due", async () => {
  let fetches = 0;
  const sb = fakeSb({ settings: { store_settings: { value: new Date().toISOString() } } });
  const out = await syncEbayFees(sb, "store", { fetcher: async () => { fetches += 1; return { transactions: [] }; }, accounts: [{ id: "a1", scopes: ["https://api.ebay.com/oauth/api_scope/sell.finances"] }] });
  assert.equal(out.skipped, "nothing_pending");
  assert.equal(fetches, 0);
});

test("sync records the late ad fee against the right order and then asks the database to settle", async () => {
  const sb = fakeSb({
    pending: [{ order_id: "27-11111-22222", created_at: "2026-10-20T14:00:00Z" }],
    known: [{ order_id: "27-11111-22222", item_cents: 10000, created_at: "2026-10-20T14:00:00Z" }, { order_id: "27-OTHER", item_cents: 5000, created_at: "2026-10-20T14:00:00Z" }],
    settings: { store_settings: { value: new Date().toISOString() } },
  });
  const late = { transactionId: "AD-9", transactionType: "NON_SALE_CHARGE", feeType: "AD_FEE", orderId: "27-11111-22222", transactionDate: "2026-10-21T08:00:00.000Z", bookingEntry: "DEBIT", amount: money("2.50") };
  const unknownOrder = { ...late, transactionId: "AD-X", orderId: "27-NOT-OURS" };
  const out = await syncEbayFees(sb, "store", {
    now: "2026-10-22T00:00:00Z",
    fetcher: async () => ({ transactions: [promotedSale, late, unknownOrder] }),
    accounts: [{ id: "a1", username: "ikonikdeals2026", scopes: ["https://api.ebay.com/oauth/api_scope/sell.finances"] }],
  });
  const recs = sb.calls.rpc.filter((c) => c.name === "ebay_record_order_fees");
  assert.equal(recs.length, 1, "only orders Floor knows are recorded");
  assert.equal(recs[0].args.p_order_id, "27-11111-22222");
  assert.equal(recs[0].args.p_rows.filter((r) => r.fee_type === "AD_FEE").reduce((n, r) => n + r.amount_cents, 0), 1050);
  assert.equal(recs[0].args.p_sale_txn_at, "2026-10-20T15:00:00.000Z");
  assert.ok(sb.calls.rpc.some((c) => c.name === "ebay_fee_settle_due"));
  assert.equal(out.recorded, 1);
});

test("an account without the finances scope is reported, not guessed around", async () => {
  const sb = fakeSb({ pending: [{ order_id: "o", created_at: "2026-10-20T14:00:00Z" }] });
  const out = await syncEbayFees(sb, "store", {
    fetcher: async () => { throw new Error("must not call eBay"); },
    accounts: [{ id: "a1", username: "ikonikdeals2026", scopes: ["https://api.ebay.com/oauth/api_scope/sell.fulfillment"] }],
  });
  assert.ok(out.log.some((l) => l.ebay === "reconnect_required_for_finances_scope"));
  assert.equal(sb.calls.rpc.filter((c) => c.name === "ebay_record_order_fees").length, 0);
});

test("unattached ad campaign charges are stored and booked once as overhead", async () => {
  const sb = fakeSb({ pending: [{ order_id: "o", created_at: "2026-10-20T14:00:00Z" }] });
  const campaign = { transactionId: "CAMP-1", transactionType: "NON_SALE_CHARGE", feeType: "PREMIUM_AD_FEES", transactionDate: "2026-10-21T00:00:00.000Z", bookingEntry: "DEBIT", amount: money("15.00") };
  await syncEbayFees(sb, "store", {
    fetcher: async () => ({ transactions: [campaign] }),
    accounts: [{ id: "a1", scopes: ["https://api.ebay.com/oauth/api_scope/sell.finances"] }],
  });
  assert.equal(sb.calls.upserts.filter((u) => u.table === "ebay_order_fees").length, 1);
  const exp = sb.calls.rpc.find((c) => c.name === "portal_upsert_ebay_fee_expense");
  assert.equal(exp.args.p_external_id, "CAMP-1");
  assert.equal(exp.args.p_amount_cents, 1500);
});
