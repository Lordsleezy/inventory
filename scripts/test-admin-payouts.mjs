// node --experimental-strip-types --test scripts/test-admin-payouts.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { payout, payoutCardIncludesSale, remainingProfit, isOnline, profit, commissionProfit, commissionBreakdown, reportProfitCents } from "../apps/admin/src/payouts.ts";

// Per-store payout people and SKU rates now come from store_payout_people / store_payout_sku_rates.
const PAYOUT_PAUL_ID = "f17e6163-b10a-4fe1-a373-75c0094e5363";
const PAYOUT_JACOB_ID = "c851c8ee-2cc2-490f-935f-1e2d7e093d88";
const slots = { paul: PAYOUT_PAUL_ID, jacob: PAYOUT_JACOB_ID };
const skuRates = Object.fromEntries(Object.entries({ "11314": [25, 5], "11386": [20, 10], "11415": [20, 10], "11522": [25, 5],
  "99694": [0, 30], "11629": [20, 10], "99695": [20, 10] }).map(([sku, [j, p]]) => [sku, { [PAYOUT_JACOB_ID]: j, [PAYOUT_PAUL_ID]: p }]));

const PAUL = "paul", JACOB = "jacob";
const rules = [{ employee_id: PAUL, method: "percent_sale", rate: 30 }, { employee_id: JACOB, method: "percent_sale", rate: 20 }];
const cfg = { channels: ["website"], pct: 30, employeeId: PAUL, slots, skuRates };
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
  assert.equal(payout(t, rules[1], cfg), null);
  assert.equal(remainingProfit(t, rules, cfg), null);
  assert.equal(payout({ ...t, cost: 2500 }, rules[0], cfg), 2250);
});
test("eBay sale of a sold unit stays on the Payouts card, including when cost is missing", () => {
  const ebay = { channels: ["ebay"], pct: 30, employeeId: PAUL, absorbFees: true, slots };
  const rule = { employee_id: PAUL, method: "percent_profit", rate: 20 };
  const missing = { subtotal: 1452, cost: null, channel: "ebay", shippingCents: 922, feeCents: 373, shipCostCents: 0, processingFeeCents: 0 };
  assert.equal(payout(missing, rule, ebay), null);
  assert.equal(payoutCardIncludesSale(payout(missing, rule, ebay)), true);
  const sold = { ...missing, cost: 400 };
  assert.equal(commissionProfit(sold, true), 1452 + 922 - 400);
  const owed = payout(sold, rule, ebay);
  assert.equal(owed, Math.round((1452 + 922 - 400) * 0.3));
  assert.equal(payoutCardIncludesSale(owed), true);
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
test("Reports profit and commissions use pre-tax merchandise plus buyer shipping", () => {
  // Depop sale: $80 item, real fee, prepaid label, $9 default cost
  const t = { subtotal: 8000, cost: 900, channel: "depop", feeCents: 309, shipCostCents: 999, processingFeeCents: 0 };
  assert.equal(profit(t), 5792);
  assert.equal(commissionProfit(t), 5792);
  const withCfg = { ...cfg, channels: ["depop"], pct: 30 };
  assert.equal(payout(t, rules[0], withCfg), Math.round(5792 * 0.3));
  assert.equal(profit({ ...t, taxOwedCents: 500 }), 5792);
  assert.equal(commissionProfit({ ...t, taxOwedCents: 500 }), 5792);
  assert.equal(profit({ ...t, taxCollectedCents: 500, taxOwedCents: 500 }), 5792);
  assert.equal(commissionProfit({ ...t, taxCollectedCents: 500, taxOwedCents: 500 }), 5792);
});
test("buyer-paid shipping is revenue for both Reports profit and commissions", () => {
  const t = { subtotal: 8000, cost: 2000, channel: "website", shippingCents: 1200, shipCostCents: 1399, processingFeeCents: 313 };
  assert.equal(profit(t), 8000 + 1200 - 1399 - 313 - 2000);
  assert.equal(commissionProfit(t), 8000 + 1200 - 1399 - 313 - 2000);
  assert.equal(profit({ ...t, profitCents: 9999 }), 5488);
  assert.equal(commissionProfit({ ...t, profitCents: 9999 }), 5488);
});
test("losses are not floored in profit(); commissions still floor at zero", () => {
  const t = { subtotal: 1000, cost: 5000, channel: "floor", feeCents: 0, shipCostCents: 0, processingFeeCents: 0 };
  assert.equal(profit(t), -4000);
  assert.equal(payout(t, { employee_id: PAUL, method: "percent_profit", rate: 20 }, cfg), 0);
});
test("in-store card sale: Square fee lowers profit and commission base", () => {
  // $100 sale, $40 cost, $2.75 Square fee → $57.25 profit and commission base.
  const t = { subtotal: 10000, cost: 4000, channel: "floor", processingFeeCents: 275 };
  const r20 = { employee_id: PAUL, method: "percent_profit", rate: 20 };
  const r10 = { employee_id: JACOB, method: "percent_profit", rate: 10 };
  assert.equal(payout(t, r20, cfg), Math.round(5725 * 0.2)); // $11.45
  assert.equal(payout(t, r10, cfg), Math.round(5725 * 0.1)); // $5.73
  assert.equal(remainingProfit(t, [r20, r10], cfg), 5725 - 1145 - 573);
});
test("in-store percent_of_sale and flat rules still require a real cost", () => {
  const t = store(10000, 4000);
  assert.equal(payout(t, rules[0], cfg), 3000);
  assert.equal(payout(t, rules[1], cfg), 2000);
  assert.equal(payout(store(10000, null), rules[0], cfg), null);
  assert.equal(payout(store(10000, 4000), { employee_id: PAUL, method: "flat_ticket", rate: 5 }, cfg), 500);
  assert.equal(payout(store(10000, null), { employee_id: PAUL, method: "flat_ticket", rate: 5 }, cfg), null);
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
  // Fees and label costs are deducted from the $129.99 item amount.
  const ebay = { subtotal: 12999, cost: 4000, channel: "ebay", ebayFeeCents: 1722, bakedShipCents: 1200 };
  assert.equal(payout(ebay, rules[0], withEbay), Math.round((12999 - 1722 - 1200 - 4000) * 0.3));
  assert.equal(payout({ ...ebay, cost: null }, rules[0], withEbay), null);
  const depop = { subtotal: 12999, cost: 4000, channel: "depop", feeCents: 474, shipCostCents: 800 };
  assert.equal(payout(depop, rules[0], { ...cfg, channels: ["depop"] }), Math.round((12999 - 474 - 800 - 4000) * 0.3));
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
  const onlineCfg = { channels: ["website"], pct: 30, employeeId: PAYOUT_PAUL_ID, slots, skuRates };
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

// ---- Store absorbs fees ----
const ebay = { subtotal: 10000, cost: 4000, channel: "ebay", shippingCents: 1000, feeCents: 1500, shipCostCents: 800, processingFeeCents: 0 };
const cfgEbay = { ...cfg, channels: ["ebay"] };
test("fees ON: channel and card fees are not subtracted; label subtracts and buyer shipping adds", () => {
  // 100.00 + 10.00 ship - 8.00 label - 40.00 cost = 62.00 (the 15.00 channel fee is eaten by the store)
  assert.equal(commissionProfit(ebay, true), 6200);
  assert.equal(payout(ebay, rules[0], { ...cfgEbay, absorbFees: true }), 1860);
});
test("fees OFF keeps the current rule exactly", () => {
  assert.equal(commissionProfit(ebay), 4700);
  assert.equal(commissionProfit(ebay, false), 4700);
  assert.equal(payout(ebay, rules[0], cfgEbay), 1410);
  assert.equal(payout(ebay, rules[0], { ...cfgEbay, absorbFees: false }), 1410);
});
test("store profit still shows every fee when commissions ignore them", () => {
  assert.equal(profit(ebay), 4700);
});
test("card fee leftover only: in-store card sale with a net card fee", () => {
  const card = { subtotal: 20000, cost: 5000, channel: "floor", processingFeeCents: 168 }; // 1.68 left after the surcharge
  assert.equal(commissionProfit(card), 14832);
  assert.equal(commissionProfit(card, true), 15000);
});
test("breakdown lists every fee, marks absorbed ones, and adds up to the commission profit", () => {
  const on = commissionBreakdown(ebay, true);
  assert.equal(on.base, 6200);
  assert.equal(on.absorbedCents, 1500);
  assert.equal(on.rows.find(r => r.label.includes("Channel")).note, "absorbed by the store");
  const sumOn = on.rows.reduce((n, r) => n + (r.note?.startsWith("absorbed") ? 0 : r.cents), 0);
  assert.equal(sumOn, on.base);
  const off = commissionBreakdown(ebay, false);
  assert.equal(off.base, 4700);
  assert.equal(off.rows.reduce((n, r) => n + r.cents, 0), off.base);
  assert.equal(commissionBreakdown({ ...ebay, cost: null }, true).base, null);
});
