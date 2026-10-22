import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateChannelStats,
  buildNotListed,
  collectQuarters,
  currentQuarter,
  laMidnightIso,
  quarterBounds,
  shippingTag,
} from "./marketplace-board-math.mjs";

test("Q4 2026 starts at Los Angeles midnight on Oct 1", () => {
  const bounds = quarterBounds("2026-Q4");
  assert.equal(bounds.start, "2026-10-01");
  assert.equal(bounds.end, "2027-01-01");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(bounds.from));
  const got = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  assert.equal(got.year, "2026");
  assert.equal(got.month, "10");
  assert.equal(got.day, "01");
  assert.equal(got.hour, "00");
  assert.equal(got.minute, "00");
  assert.equal(laMidnightIso("2026-10-01"), bounds.from);
});

test("current quarter on Oct 21 2026 PT is Q4", () => {
  const q = currentQuarter(new Date("2026-10-22T05:00:00.000Z"));
  assert.equal(q.id, "2026-Q4");
  assert.match(q.label, /Oct–Dec/);
});

test("quarters include the current one and past quarters with data, newest first", () => {
  const list = collectQuarters(
    ["2026-05-02T18:00:00.000Z", "2025-01-15T20:00:00.000Z"],
    ["2026-08-01"],
    new Date("2026-10-22T05:00:00.000Z"),
  );
  assert.deepEqual(list.map((q) => q.id), ["2026-Q4", "2026-Q3", "2026-Q2", "2025-Q1"]);
});

test("stats match the channel report: voids leave gross, fees stay out, labels remain", () => {
  const stats = aggregateChannelStats(
    [
      {
        voided_at: null,
        price_cents: 2999,
        shipping_cents: 0,
        channel_fee_cents: 480,
        ship_cost_cents: 510,
        profit_cents: 1109,
      },
      {
        voided_at: "2026-10-02T00:00:00.000Z",
        price_cents: 5000,
        shipping_cents: 0,
        channel_fee_cents: 700,
        ship_cost_cents: 800,
        profit_cents: 1000,
      },
    ],
    { insertionCents: 2500 },
  );
  assert.equal(stats.orders, 1);
  assert.equal(stats.gross_cents, 2999);
  assert.equal(stats.fee_cents, 480);
  assert.equal(stats.ship_cents, 1310);
  assert.equal(stats.profit_cents, 1109);
  assert.equal(stats.voided_count, 1);
  assert.equal(stats.insertion_cents, 2500);
  assert.equal(stats.fee_pct, 16);
});

test("not listed keeps priced units with a real photo and greys Amazon blocks", () => {
  const rows = buildNotListed(
    [
      { sku: "1", title: "Ready", ask_cents: 1000, condition: "Open box", upc: "111" },
      { sku: "2", title: "Live", ask_cents: 1000 },
      { sku: "3", title: "No photo", ask_cents: 1000 },
      { sku: "4", title: "No price", ask_cents: 0 },
      { sku: "5", title: "Not on Amazon", ask_cents: 1500, upc: "555" },
    ],
    {
      liveSkus: ["2"],
      photoBySku: { 1: "https://photo/1", 3: null, 5: "https://photo/5" },
      blockedBySku: { 5: "No ASIN match — not on Amazon" },
    },
  );
  assert.deepEqual(rows.map((r) => r.sku), ["1", "5"]);
  assert.equal(rows[0].blocked, false);
  assert.equal(rows[1].blocked, true);
  assert.match(rows[1].blocked_reason, /not on Amazon/);
});

test("unknown shipping is buyer pays", () => {
  assert.equal(shippingTag("free"), "free");
  assert.equal(shippingTag(null), "buyer");
  assert.equal(shippingTag("calculated"), "buyer");
});
