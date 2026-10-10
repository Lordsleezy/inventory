// node --experimental-strip-types --test scripts/test-admin-payouts.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { payout, remainingProfit, isOnline, profit } from "../apps/admin/src/payouts.ts";

const PAUL = "paul", JACOB = "jacob";
const rules = [{ employee_id: PAUL, method: "percent_sale", rate: 30 }, { employee_id: JACOB, method: "percent_sale", rate: 20 }];
const cfg = { channels: ["website"], pct: 30, employeeId: PAUL };
// Ticket subtotal is merchandise only: sales tax, card fee, shipping charged and label cost are never in it.
const online = (subtotal, cost) => ({ subtotal, cost, channel: "website" });
const store = (subtotal, cost) => ({ subtotal, cost, channel: "floor" });

test("online sale with cost: Paul gets 30% of profit, Jacob nothing", () => {
  const t = online(10000, 4000); // $100.00 sale, $40.00 cost -> $60.00 profit
  assert.equal(payout(t, rules[0], cfg), 1800);
  assert.equal(payout(t, rules[1], cfg), 0);
  assert.equal(profit(t), 6000);
  assert.equal(remainingProfit(t, rules, cfg), 6000 - 1800);
});
test("online sale missing cost is flagged, not guessed, and pays once cost is filled in", () => {
  const t = online(10000, null);
  assert.equal(payout(t, rules[0], cfg), null);
  assert.equal(payout(t, rules[1], cfg), 0);
  assert.equal(remainingProfit(t, rules, cfg), null);
  assert.equal(payout({ ...t, cost: 2500 }, rules[0], cfg), 2250);
});
test("online: zero cost is a real cost; selling below cost pays nothing", () => {
  assert.equal(payout(online(5000, 0), rules[0], cfg), 1500);
  assert.equal(payout(online(2000, 3000), rules[0], cfg), 0);
});
test("online rounding and a different percent", () => {
  assert.equal(payout(online(999, 100), rules[0], cfg), Math.round(899 * 0.3));
  assert.equal(payout(online(10000, 4000), rules[0], { ...cfg, pct: 25 }), 1500);
});
test("profit subtracts channel fees, label cost, and card processing on every channel", () => {
  // Depop sale: $80 item, real $2.64+0.45 fee, $9.99 prepaid label, $9 default cost
  const t = { subtotal: 8000, cost: 900, channel: "depop", feeCents: 309, shipCostCents: 999, processingFeeCents: 0 };
  assert.equal(profit(t), 5792);
  const withCfg = { ...cfg, channels: ["depop"], pct: 30 };
  assert.equal(payout(t, rules[0], withCfg), Math.round(5792 * 0.3));
});
test("buyer-paid shipping is revenue (matches sale_ledger / Reports)", () => {
  const t = { subtotal: 8000, cost: 2000, channel: "website", shippingCents: 1200, shipCostCents: 1399, processingFeeCents: 313 };
  assert.equal(profit(t), 8000 + 1200 - 1399 - 313 - 2000);
  // Ledger profit_cents wins when present.
  assert.equal(profit({ ...t, profitCents: 9999 }), 9999);
});
test("losses are not floored in profit(); commissions still floor at zero", () => {
  const t = { subtotal: 1000, cost: 5000, channel: "floor", feeCents: 0, shipCostCents: 0, processingFeeCents: 0 };
  assert.equal(profit(t), -4000);
  assert.equal(payout(t, { employee_id: PAUL, method: "percent_profit", rate: 20 }, cfg), 0);
});
test("in-store card sale: Square processing fee lowers profit for percent_profit rules", () => {
  // $100 sale, $40 cost, $2.75 Square fee → $57.25 profit
  const t = { subtotal: 10000, cost: 4000, channel: "floor", processingFeeCents: 275 };
  const r20 = { employee_id: PAUL, method: "percent_profit", rate: 20 };
  const r10 = { employee_id: JACOB, method: "percent_profit", rate: 10 };
  assert.equal(payout(t, r20, cfg), Math.round(5725 * 0.2)); // $11.45
  assert.equal(payout(t, r10, cfg), Math.round(5725 * 0.1)); // $5.73
  assert.equal(remainingProfit(t, [r20, r10], cfg), 5725 - 1145 - 573);
});
test("in-store percent_of_sale and flat rules are unchanged (cost irrelevant)", () => {
  const t = store(10000, 4000);
  assert.equal(payout(t, rules[0], cfg), 3000);
  assert.equal(payout(t, rules[1], cfg), 2000);
  assert.equal(payout(store(10000, null), rules[0], cfg), 3000);
  assert.equal(payout(store(10000, 4000), { employee_id: PAUL, method: "flat_ticket", rate: 5 }, cfg), 500);
  assert.equal(remainingProfit(t, rules, cfg), 6000 - 5000);
});
test("negative fees/shipping can never inflate profit", () => {
  const t = { subtotal: 10000, cost: 4000, channel: "ebay", feeCents: -500, shipCostCents: -100, processingFeeCents: -1 };
  assert.equal(profit(t), 6000);
});
test("percent_profit applies to all sales regardless of sold date (no cutover)", () => {
  const rule = { employee_id: PAUL, method: "percent_profit", rate: 20 };
  const old = { subtotal: 10000, cost: 4000, channel: "floor", at: "2025-06-01T12:00:00Z" };
  const recent = { ...old, at: "2026-06-01T12:00:00Z" };
  assert.equal(payout(old, rule, cfg), Math.round(6000 * 0.2));
  assert.equal(payout(recent, rule, cfg), Math.round(6000 * 0.2));
});
test("channel matching is case-insensitive and eBay plugs in by adding the channel", () => {
  assert.equal(isOnline({ subtotal: 1, cost: 1, channel: "Website" }, cfg), true);
  assert.equal(isOnline({ subtotal: 1, cost: 1, channel: "ebay" }, cfg), false);
  const withEbay = { ...cfg, channels: ["website", "ebay"] };
  assert.equal(payout({ subtotal: 10000, cost: 4000, channel: "ebay" }, rules[0], withEbay), 1800);
  assert.equal(payout({ subtotal: 10000, cost: 4000, channel: "ebay" }, rules[1], withEbay), 0);
  // $129.99 item, $17.22 fee, $12.00 baked label, $40.00 cost → $60.77 profit, 30% = $18.23
  const ebay = { subtotal: 12999, cost: 4000, channel: "ebay", ebayFeeCents: 1722, bakedShipCents: 1200 };
  assert.equal(payout(ebay, rules[0], withEbay), Math.round((12999 - 1722 - 1200 - 4000) * 0.3));
  assert.equal(payout({ ...ebay, cost: null }, rules[0], withEbay), null);
  // Generic fee fields (new ledger columns) take precedence over the eBay aliases.
  const depop = { subtotal: 12999, cost: 4000, channel: "depop", feeCents: 474, shipCostCents: 800 };
  assert.equal(payout(depop, rules[0], { ...cfg, channels: ["depop"] }), Math.round((12999 - 474 - 800 - 4000) * 0.3));
});
