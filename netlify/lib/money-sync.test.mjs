import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEbayFundsSummary, computeSquareBalance, syncMoneyBalances, dueForMoneySync, MONEY_SYNC_EVERY_MS } from "./money-sync.mjs";

test("eBay funds summary splits Available / Processing / On hold and totals them", () => {
  const r = parseEbayFundsSummary({ availableFunds: { value: "410.25" }, processingFunds: { value: "300.00" }, fundsOnHold: { value: "123.10" } });
  assert.deepEqual(r.detail, { available_cents: 41025, processing_cents: 30000, on_hold_cents: 12310 });
  assert.equal(r.balance_cents, 83335);
});

test("Square balance = card payments less fees and refunds, minus payouts; cash, failed payments and failed payouts are ignored", () => {
  const r = computeSquareBalance({
    payments: [
      { status: "COMPLETED", source_type: "CARD", total_money: { amount: 10000 }, processing_fee: [{ amount_money: { amount: 320 } }], refunded_money: { amount: 1000 } },
      { status: "COMPLETED", source_type: "CASH", total_money: { amount: 5000 } },
      { status: "FAILED", source_type: "CARD", total_money: { amount: 9999 } },
      { status: "COMPLETED", source_type: "CARD", total_money: { amount: 2000 }, processing_fee: [{ amount_money: { amount: 88 } }] },
    ],
    payouts: [{ status: "PAID", amount_money: { amount: 6000 } }, { status: "FAILED", amount_money: { amount: 3000 } }, { status: "SENT", amount_money: { amount: -400 } }],
  });
  assert.equal(r.balance_cents, 10000 - 320 - 1000 + 2000 - 88 - 6000);
  assert.equal(r.detail.payments, 2);
  assert.equal(r.detail.payouts, 1);
});

function deps(over = {}) {
  const saved = {}; let state = over.state || {};
  return { saved, get state() { return state; }, d: { loadState: async () => state, saveState: async (s) => { state = s; }, save: async (a, row) => { saved[a] = row; },
    fetchEbayFunds: over.fetchEbayFunds || (async () => ({ availableFunds: { value: "10.00" } })),
    fetchEbayPersonalFunds: over.fetchEbayPersonalFunds || (async () => ({ availableFunds: { value: "496.00" } })),
    fetchSquare: over.fetchSquare || (async () => { throw new Error("square_not_connected"); }) } };
}

test("saves the real eBay balance, and says Square is not connected without throwing", async () => {
  const x = deps();
  const r = await syncMoneyBalances(x.d, { now: Date.parse("2026-10-28T00:00:00Z") });
  assert.equal(x.saved.ebay.balance_cents, 1000);
  assert.equal(x.saved.ebay.status, "ok");
  assert.equal(x.saved.ebay_pgg124_5.balance_cents, 49600);
  assert.equal(x.saved.ebay_pgg124_5.status, "ok");
  assert.equal(x.saved.square.status, "not_connected");
  assert.equal(r.square.status, "not_connected");
});

test("a missing permission becomes a Reconnect status", async () => {
  const x = deps({ fetchEbayFunds: async () => { throw new Error("ebay 403 Insufficient permissions"); } });
  await syncMoneyBalances(x.d);
  assert.equal(x.saved.ebay.status, "reconnect");
  assert.match(x.saved.ebay.message, /Reconnect eBay/);
});

test("a Square key failure is saved as a plain message without throwing", async () => {
  const x = deps({ fetchSquare: async () => { throw new Error("square_401:UNAUTHORIZED"); } });
  const result = await syncMoneyBalances(x.d);
  assert.equal(result.square.status, "reconnect");
  assert.equal(x.saved.square.message, "Square key not working");
});

test("runs at most every 6 hours; a skipped run writes nothing", async () => {
  const now = Date.parse("2026-10-28T12:00:00Z");
  assert.equal(dueForMoneySync({ at: new Date(now - MONEY_SYNC_EVERY_MS + 60000).toISOString() }, now), false);
  const x = deps({ state: { at: new Date(now - 60000).toISOString() } });
  assert.deepEqual(await syncMoneyBalances(x.d, { now }), { skipped: "not_due" });
  assert.deepEqual(x.saved, {});
});
