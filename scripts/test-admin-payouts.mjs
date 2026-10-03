// node --experimental-strip-types --test scripts/test-admin-payouts.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { payout, remainingProfit, isOnline } from "../apps/admin/src/payouts.ts";

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
  assert.equal(remainingProfit(t, rules, cfg), 10000 - 1800);
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
test("in-store payouts are exactly as before (percent of sale, cost irrelevant)", () => {
  const t = store(10000, 4000);
  assert.equal(payout(t, rules[0], cfg), 3000);
  assert.equal(payout(t, rules[1], cfg), 2000);
  assert.equal(payout(store(10000, null), rules[0], cfg), 3000);
  assert.equal(remainingProfit(t, rules, cfg), 10000 - 5000);
});
test("in-store flat and percent-of-profit rules unchanged", () => {
  assert.equal(payout(store(10000, 4000), { employee_id: PAUL, method: "flat_ticket", rate: 5 }, cfg), 500);
  assert.equal(payout(store(10000, 4000), { employee_id: PAUL, method: "percent_profit", rate: 50 }, cfg), 3000);
  assert.equal(payout(store(10000, null), { employee_id: PAUL, method: "percent_profit", rate: 50 }, cfg), null);
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
});
