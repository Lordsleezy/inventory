// node --experimental-strip-types --test scripts/test-admin-payouts.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { payout, remainingProfit, isOnline, profit, commissionProfit, reportProfitCents, PAYOUT_JACOB_ID, PAYOUT_PAUL_ID } from "../apps/admin/src/payouts.ts";

const PAUL = "paul", JACOB = "jacob";
const rules = [{ employee_id: PAUL, method: "percent_sale", rate: 30 }, { employee_id: JACOB, method: "percent_sale", rate: 20 }];
const cfg = { channels: ["website"], pct: 30, employeeId: PAUL };
// Ticket subtotal is merchandise only: sales tax, card fee, shipping charged and label cost are never in it.
const online = (subtotal, cost) => ({ subtotal, cost, channel: "website" });
const store = (subtotal, cost) => ({ subtotal, cost, channel: "floor" });

test("online sale with cost: Paul gets 30% of sale − cost, Jacob nothing", () => {
  const t = online(10000, 4000); // $100.00 sale, $40.00 cost -> $60.00 commission base
  assert.equal(payout(t, rules[0], cfg), 1800);
  assert.equal(payout(t, rules[1], cfg), 0);
  assert.equal(commissionProfit(t), 6000);
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
test("Payouts profit matches Reports after eBay insertion and subscription fees", () => {
  assert.equal(reportProfitCents(280546, 6834), 273712);
  assert.equal(reportProfitCents(null, 6834), null);
  assert.equal(reportProfitCents(100, 0), 100);
  assert.equal(reportProfitCents(-50, 10), -60);
});
test("Reports profit subtracts fees; commissions ignore fees", () => {
  // Depop sale: $80 item, real fee, prepaid label, $9 default cost
  const t = { subtotal: 8000, cost: 900, channel: "depop", feeCents: 309, shipCostCents: 999, processingFeeCents: 0 };
  assert.equal(profit(t), 5792);
  assert.equal(commissionProfit(t), 8000 - 900);
  const withCfg = { ...cfg, channels: ["depop"], pct: 30 };
  assert.equal(payout(t, rules[0], withCfg), Math.round(7100 * 0.3));
});
test("buyer-paid shipping is revenue for both Reports profit and commissions", () => {
  const t = { subtotal: 8000, cost: 2000, channel: "website", shippingCents: 1200, shipCostCents: 1399, processingFeeCents: 313 };
  assert.equal(profit(t), 8000 + 1200 - 1399 - 313 - 2000);
  assert.equal(commissionProfit(t), 8000 + 1200 - 2000);
  // Ledger profit_cents wins for Reports profit only — commissions still use sale − cost.
  assert.equal(profit({ ...t, profitCents: 9999 }), 9999);
  assert.equal(commissionProfit({ ...t, profitCents: 9999 }), 7200);
});
test("losses are not floored in profit(); commissions still floor at zero", () => {
  const t = { subtotal: 1000, cost: 5000, channel: "floor", feeCents: 0, shipCostCents: 0, processingFeeCents: 0 };
  assert.equal(profit(t), -4000);
  assert.equal(payout(t, { employee_id: PAUL, method: "percent_profit", rate: 20 }, cfg), 0);
});
test("in-store card sale: Square fee lowers Reports profit, not commission base", () => {
  // $100 sale, $40 cost, $2.75 Square fee → Reports $57.25; commission on $60.00
  const t = { subtotal: 10000, cost: 4000, channel: "floor", processingFeeCents: 275 };
  const r20 = { employee_id: PAUL, method: "percent_profit", rate: 20 };
  const r10 = { employee_id: JACOB, method: "percent_profit", rate: 10 };
  assert.equal(payout(t, r20, cfg), Math.round(6000 * 0.2)); // $12.00
  assert.equal(payout(t, r10, cfg), Math.round(6000 * 0.1)); // $6.00
  assert.equal(remainingProfit(t, [r20, r10], cfg), 5725 - 1200 - 600);
});
test("in-store percent_of_sale and flat rules are unchanged (cost irrelevant)", () => {
  const t = store(10000, 4000);
  assert.equal(payout(t, rules[0], cfg), 3000);
  assert.equal(payout(t, rules[1], cfg), 2000);
  assert.equal(payout(store(10000, null), rules[0], cfg), 3000);
  assert.equal(payout(store(10000, 4000), { employee_id: PAUL, method: "flat_ticket", rate: 5 }, cfg), 500);
  assert.equal(remainingProfit(t, rules, cfg), 6000 - 5000);
});
test("negative fees/shipping can never inflate Reports profit", () => {
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
test("in-store SKU overrides: Jacob 25% / Paul 5% on 11314, 11522; 20/10 on 11386, 11415", () => {
  const rPaul = { employee_id: PAYOUT_PAUL_ID, method: "percent_profit", rate: 20 };
  const rJacob = { employee_id: PAYOUT_JACOB_ID, method: "percent_profit", rate: 10 };
  for (const line of [
    { sku: "11314", price_cents: 5252, cost_cents: 1000 },
    { sku: "11522", price_cents: 1399, cost_cents: 1000 },
  ]) {
    const base = line.price_cents - line.cost_cents;
    const t = { subtotal: line.price_cents, cost: line.cost_cents, channel: "floor", lines: [line] };
    assert.equal(payout(t, rJacob, cfg), Math.round(base * 0.25));
    assert.equal(payout(t, rPaul, cfg), Math.round(base * 0.05));
  }
  for (const line of [
    { sku: "11386", price_cents: 3000, cost_cents: 1000 },
    { sku: "11415", price_cents: 2099, cost_cents: 1000 },
  ]) {
    const base = line.price_cents - line.cost_cents;
    const t = { subtotal: line.price_cents, cost: line.cost_cents, channel: "floor", lines: [line] };
    assert.equal(payout(t, rJacob, cfg), Math.round(base * 0.2));
    assert.equal(payout(t, rPaul, cfg), Math.round(base * 0.1));
  }
  // Other floor SKUs keep the global 20/10 rules on sale − cost.
  const other = { subtotal: 10000, cost: 4000, channel: "floor", lines: [{ sku: "99999", price_cents: 10000, cost_cents: 4000 }] };
  assert.equal(payout(other, rPaul, cfg), 1200);
  assert.equal(payout(other, rJacob, cfg), 600);
});
test("jersey ticket: Paul 30% of $500; Paul 10% / Jacob 20% on other lines (sale − cost)", () => {
  const rPaul = { employee_id: PAYOUT_PAUL_ID, method: "percent_profit", rate: 20 };
  const rJacob = { employee_id: PAYOUT_JACOB_ID, method: "percent_profit", rate: 10 };
  const lines = [
    { sku: "99694", price_cents: 70000, cost_cents: 20000 },
    { sku: "11629", price_cents: 1000, cost_cents: 900 },
    { sku: "99695", price_cents: 3000, cost_cents: 900 },
  ];
  const t = {
    subtotal: 74000,
    cost: 21800,
    channel: "floor",
    processingFeeCents: 2161,
    profitCents: 50039,
    lines,
  };
  // Jersey $700 − $200 = $500 → Paul $150; others ($10−$9)+($30−$9) → Paul $2.20, Jacob $4.40
  assert.equal(payout(t, rPaul, cfg), 15000 + 10 + 210);
  assert.equal(payout(t, rJacob, cfg), 0 + 20 + 420);
});
test("channel matching is case-insensitive and eBay plugs in by adding the channel", () => {
  assert.equal(isOnline({ subtotal: 1, cost: 1, channel: "Website" }, cfg), true);
  assert.equal(isOnline({ subtotal: 1, cost: 1, channel: "ebay" }, cfg), false);
  const withEbay = { ...cfg, channels: ["website", "ebay"] };
  assert.equal(payout({ subtotal: 10000, cost: 4000, channel: "ebay" }, rules[0], withEbay), 1800);
  assert.equal(payout({ subtotal: 10000, cost: 4000, channel: "ebay" }, rules[1], withEbay), 0);
  // $129.99 item − $40 cost = $89.99 commission base (fees/label excluded)
  const ebay = { subtotal: 12999, cost: 4000, channel: "ebay", ebayFeeCents: 1722, bakedShipCents: 1200 };
  assert.equal(payout(ebay, rules[0], withEbay), Math.round((12999 - 4000) * 0.3));
  assert.equal(payout({ ...ebay, cost: null }, rules[0], withEbay), null);
  const depop = { subtotal: 12999, cost: 4000, channel: "depop", feeCents: 474, shipCostCents: 800 };
  assert.equal(payout(depop, rules[0], { ...cfg, channels: ["depop"] }), Math.round((12999 - 4000) * 0.3));
});

test("per-sale override replaces defaults for Paul and Jacob", () => {
  const rPaul = { employee_id: PAYOUT_PAUL_ID, method: "percent_profit", rate: 20 };
  const rJacob = { employee_id: PAYOUT_JACOB_ID, method: "percent_profit", rate: 10 };
  const t = {
    subtotal: 10000, cost: 4000, channel: "floor",
    commissionOverride: { paulPct: 10, jacobPct: 20 },
  };
  // Commission base $60 → Paul $6, Jacob $12 (flipped from default 20/10)
  assert.equal(payout(t, rPaul, cfg), 600);
  assert.equal(payout(t, rJacob, cfg), 1200);
  assert.equal(remainingProfit(t, [rPaul, rJacob], cfg), 6000 - 600 - 1200);
});

test("custom override on online sale can pay Jacob (defaults only pay Paul)", () => {
  const rPaul = { employee_id: PAYOUT_PAUL_ID, method: "percent_profit", rate: 20 };
  const rJacob = { employee_id: PAYOUT_JACOB_ID, method: "percent_profit", rate: 10 };
  const onlineCfg = { channels: ["website"], pct: 30, employeeId: PAYOUT_PAUL_ID };
  const base = { subtotal: 10000, cost: 4000, channel: "website" };
  assert.equal(payout(base, rPaul, onlineCfg), 1800);
  assert.equal(payout(base, rJacob, onlineCfg), 0);
  const flipped = { ...base, commissionOverride: { paulPct: 0, jacobPct: 30 } };
  assert.equal(payout(flipped, rPaul, onlineCfg), 0);
  assert.equal(payout(flipped, rJacob, onlineCfg), 1800);
});

test("ticket override wins over per-SKU in-store rates", () => {
  const rPaul = { employee_id: PAYOUT_PAUL_ID, method: "percent_profit", rate: 20 };
  const rJacob = { employee_id: PAYOUT_JACOB_ID, method: "percent_profit", rate: 10 };
  const line = { sku: "11314", price_cents: 5252, cost_cents: 1000 }; // SKU would be 25/5
  const t = {
    subtotal: 5252, cost: 1000, channel: "floor", lines: [line],
    commissionOverride: { paulPct: 15, jacobPct: 15 },
  };
  const base = 4252;
  assert.equal(payout(t, rPaul, cfg), Math.round(base * 0.15));
  assert.equal(payout(t, rJacob, cfg), Math.round(base * 0.15));
});

test("override on already-paid sale only changes commission cents (payments untouched)", () => {
  const rPaul = { employee_id: PAYOUT_PAUL_ID, method: "percent_profit", rate: 20 };
  const rJacob = { employee_id: PAYOUT_JACOB_ID, method: "percent_profit", rate: 10 };
  const t = { subtotal: 10000, cost: 4000, channel: "floor" };
  const beforePaul = payout(t, rPaul, cfg); // 1200
  const beforeJacob = payout(t, rJacob, cfg); // 600
  const paidPaul = 1200; // fully paid Paul's commission for this sale conceptually
  const paidJacob = 600;
  const after = { ...t, commissionOverride: { paulPct: 10, jacobPct: 20 } };
  const afterPaul = payout(after, rPaul, cfg); // 600
  const afterJacob = payout(after, rJacob, cfg); // 1200
  // Running balances move by delta; payment records stay
  assert.equal(beforePaul - paidPaul, 0);
  assert.equal(beforeJacob - paidJacob, 0);
  assert.equal(afterPaul - paidPaul, -600); // Paul owes $6 back / balance down
  assert.equal(afterJacob - paidJacob, 600); // Jacob owed $6 more
});

test("sum over 100% is allowed in math (UI warns)", () => {
  const rPaul = { employee_id: PAYOUT_PAUL_ID, method: "percent_profit", rate: 20 };
  const rJacob = { employee_id: PAYOUT_JACOB_ID, method: "percent_profit", rate: 10 };
  const t = {
    subtotal: 10000, cost: 4000, channel: "floor",
    commissionOverride: { paulPct: 60, jacobPct: 50 },
  };
  assert.equal(payout(t, rPaul, cfg), 3600);
  assert.equal(payout(t, rJacob, cfg), 3000);
  assert.equal(remainingProfit(t, [rPaul, rJacob], cfg), 6000 - 3600 - 3000);
});
