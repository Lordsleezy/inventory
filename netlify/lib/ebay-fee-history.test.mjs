import test from "node:test";
import assert from "node:assert/strict";
import { runEbayFeeHistory, historyCsv, paidOutText } from "./ebay-fee-history.mjs";

const money = (v) => ({ value: String(v), currency: "USD" });
const sale = (orderId, ad = 0) => ({
  transactionId: `S-${orderId}`, transactionType: "SALE", orderId, transactionDate: "2026-10-01T12:00:00.000Z", bookingEntry: "CREDIT",
  amount: money("80.00"), totalFeeAmount: money((13.3 + ad).toFixed(2)),
  orderLineItems: [{ lineItemId: "L", marketplaceFees: [
    { feeType: "FINAL_VALUE_FEE", amount: money("13.30") }, ...(ad ? [{ feeType: "AD_FEE", amount: money(ad.toFixed(2)) }] : [])] }],
});
const OWNER = "owner-1";

function fakeSb() {
  const tables = {
    sale_ledger: [
      { id: 1, sku: "A1", sold_at: "2026-09-01T00:00:00Z", payment_id: "ebay:O-PAID", channel: "ebay", voided_at: null, channel_fee_cents: 1322, fee_source: "estimated", profit_cents: 4678 },
      { id: 2, sku: "A2", sold_at: "2026-10-01T00:00:00Z", payment_id: "ebay:O-OPEN", channel: "ebay", voided_at: null, channel_fee_cents: 1322, fee_source: "estimated", profit_cents: 4678 },
      { id: 3, sku: "A3", sold_at: "2026-10-02T00:00:00Z", payment_id: "ebay:O-GONE", channel: "ebay", voided_at: null, channel_fee_cents: 1322, fee_source: "estimated", profit_cents: 4678 },
    ],
    sale_commissions: [
      { sale_id: 1, employee_id: OWNER, amount_cents: 936 }, { sale_id: 2, employee_id: OWNER, amount_cents: 936 },
    ],
    staff: [{ user_id: OWNER, display_name: "Paul" }],
  };
  const calls = [];
  const from = (t) => {
    const api = { select: () => api, eq: () => api, order: () => api, in: () => api,
      range: (a, b) => Promise.resolve({ data: (tables[t] || []).slice(a, b + 1), error: null }) };
    return api;
  };
  const rpc = (name, args) => {
    calls.push({ name, args });
    if (name === "ebay_commission_paid_status") return Promise.resolve({ data: [{ sale_id: 1, employee_id: OWNER, commission_cents: 936, paid_cents: 936 }, { sale_id: 2, employee_id: OWNER, commission_cents: 936, paid_cents: 0 }], error: null });
    if (name === "payout_refresh_ebay_fees") {
      // the real function previews paid sales and refuses to write them
      return Promise.resolve({ data: { status: "ok", before: { [OWNER]: 936 }, after: { [OWNER]: args.p_sale === 1 ? 700 : 760 } }, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  };
  return { from, rpc, calls };
}

const deps = {
  now: "2026-10-26T00:00:00Z",
  accounts: [{ id: "a", username: "ikonikdeals2026", scopes: ["https://api.ebay.com/oauth/api_scope/sell.finances"] }],
  fetcher: async () => ({ transactions: [sale("O-PAID", 8), sale("O-OPEN", 8)] }),
};

test("dry run writes nothing and reports the per-sale diff, ad fee and commission change", async () => {
  const sb = fakeSb();
  const { rows, paidOut, summary } = await runEbayFeeHistory(sb, "store", { ...deps, apply: false });
  assert.equal(summary.mode, "dry_run");
  assert.equal(sb.calls.filter((c) => c.name === "ebay_record_order_fees").length, 0, "no fees written");
  assert.ok(sb.calls.filter((c) => c.name === "payout_refresh_ebay_fees").every((c) => c.args.p_dry === true), "every refresh is a dry run");
  const open = rows.find((r) => r.sale_id === 2);
  assert.equal(open.real_fee_cents, 2130); assert.equal(open.ad_fee_cents, 800);
  assert.equal(open.new_profit_cents, 4678 + 1322 - 2130);
  assert.equal(open.status, "would_update");
  assert.deepEqual(open.commission[0], { employee_id: OWNER, name: "Paul", old_cents: 936, new_cents: 760, delta_cents: -176 });
  assert.equal(rows.find((r) => r.sale_id === 3).status, "no_finances_data");
  assert.equal(paidOut.length, 1);
  assert.match(historyCsv(rows), /A2,.*would_update/);
});

test("apply never asks the database to rewrite a paid-out sale, and lists it with dollars", async () => {
  const sb = fakeSb();
  const { rows, paidOut, summary } = await runEbayFeeHistory(sb, "store", { ...deps, apply: true });
  const refreshes = sb.calls.filter((c) => c.name === "payout_refresh_ebay_fees");
  const paidCall = refreshes.find((c) => c.args.p_sale === 1);
  const openCall = refreshes.find((c) => c.args.p_sale === 2);
  assert.equal(paidCall.args.p_dry, true, "paid-out sale is only previewed");
  assert.equal(openCall.args.p_dry, false, "unpaid sale is re-based");
  assert.equal(rows.find((r) => r.sale_id === 1).status, "paid_out_not_changed");
  assert.equal(rows.find((r) => r.sale_id === 2).status, "updated");
  assert.equal(summary.paid_out_not_changed, 1);
  assert.equal(summary.paid_out_commission_would_change_cents, 700 - 936);
  const text = paidOutText(paidOut);
  assert.match(text, /sale 1 · SKU A1/); assert.match(text, /paid so far \$9\.36/); assert.match(text, /\$9\.36 -> \$7\.00 \(-\$2\.36\)/);
  assert.ok(sb.calls.some((c) => c.name === "ebay_fee_settle_due"));
});
