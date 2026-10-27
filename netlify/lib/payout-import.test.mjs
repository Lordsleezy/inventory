import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeEbayPayouts, normalizeSquarePayouts, importPayouts, dueForImport, IMPORT_EVERY_MS } from "./payout-import.mjs";

test("eBay payouts become withdrawals with id, date, amount and status", () => {
  const rows = normalizeEbayPayouts({ payouts: [
    { payoutId: "P1", payoutStatus: "SUCCEEDED", payoutDate: "2026-10-20T18:00:00.000Z", totalAmount: { value: "123.45", currency: "USD" }, payoutInstrument: { nickname: "Checking", accountLastFourDigits: "1234" } },
    { payoutId: "P2", payoutStatus: "FAILED", payoutDate: "2026-10-21T01:00:00.000Z", totalAmount: { value: "50.00" } },
    { payoutId: "P3", payoutStatus: "SUCCEEDED", payoutDate: "2026-10-22T10:00:00.000Z", totalAmount: { value: "0.00" } },
  ] });
  assert.equal(rows.length, 2, "zero-dollar payouts are ignored");
  assert.deepEqual([rows[0].external_id, rows[0].amount_cents, rows[0].on, rows[0].status], ["P1", 12345, "2026-10-20", "SUCCEEDED"]);
  assert.match(rows[0].note, /eBay payout P1 · Checking/);
  assert.equal(rows[1].on, "2026-10-20", "01:00 UTC is still the 20th in Los Angeles");
});

test("Square payouts use cents and arrival date", () => {
  const rows = normalizeSquarePayouts({ payouts: [{ id: "S1", status: "PAID", amount_money: { amount: 250000 }, arrival_date: "2026-10-19" }, { id: "S2", status: "SENT", amount_money: { amount: -500 }, created_at: "2026-10-19T00:00:00Z" }] });
  assert.deepEqual(rows.map((r) => [r.external_id, r.amount_cents, r.on, r.status]), [["S1", 250000, "2026-10-19", "PAID"]]);
});

function deps(over = {}) {
  const calls = { imported: [], state: null };
  return { calls, deps: { loadState: async () => over.state || {}, saveState: async (s) => { calls.state = s; },
    fetchEbay: over.fetchEbay || (async () => ({ payouts: [{ payoutId: "P1", payoutStatus: "SUCCEEDED", payoutDate: "2026-10-20T18:00:00Z", totalAmount: { value: "10.00" } }] })),
    fetchSquare: over.fetchSquare || (async () => { throw new Error("INSUFFICIENT_SCOPES"); }),
    importRows: async (platform, rows) => { calls.imported.push([platform, rows.length]); return { inserted: rows.length }; } } };
}

test("imports eBay, records why Square could not, and does not throw", async () => {
  const { deps: d, calls } = deps();
  const r = await importPayouts(d, { now: Date.parse("2026-10-27T00:00:00Z") });
  assert.deepEqual(calls.imported, [["ebay", 1]]);
  assert.match(r.square.error, /INSUFFICIENT_SCOPES/);
  assert.equal(calls.state.ebay_done, true);
  assert.match(calls.state.square_error, /INSUFFICIENT_SCOPES/);
});

test("runs at most every 6 hours and looks back only 120 days after the first full pull", async () => {
  const now = Date.parse("2026-10-27T12:00:00Z");
  assert.equal(dueForImport({ at: new Date(now - IMPORT_EVERY_MS + 60000).toISOString() }, now), false);
  const idle = deps({ state: { at: new Date(now - 60000).toISOString() } });
  assert.deepEqual(await importPayouts(idle.deps, { now }), { skipped: "not_due" });
  assert.equal(idle.calls.state, null, "a skipped run writes nothing");
  let since = "";
  const later = deps({ state: { at: "2026-10-01T00:00:00Z", ebay_done: true }, fetchEbay: async (s) => { since = s; return { payouts: [] }; } });
  await importPayouts(later.deps, { now });
  assert.equal(since.slice(0, 10), "2026-06-29");
});
