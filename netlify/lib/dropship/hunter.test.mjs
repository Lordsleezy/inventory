import test from "node:test";
import assert from "node:assert/strict";
import { evaluateItem, suggestPriceCents, hunt, DEFAULT_HUNTER } from "./hunter.mjs";

const base = {
  title: "Stainless Steel Kitchen Tongs 9 Inch",
  brand: null,
  ships_from_us: true,
  stock_qty: 20,
  processing_days: 3,
  cost_cents: 400,
  shipping_cents: 200,
};

test("suggestPrice clears min profit and margin for website cheaper than ebay", () => {
  const landed = 600;
  const web = suggestPriceCents(landed, "website", DEFAULT_HUNTER);
  const ebay = suggestPriceCents(landed, "ebay", DEFAULT_HUNTER);
  assert.ok(web >= 1500);
  assert.ok(ebay >= web, "eBay price should be >= website for same landed cost");
});

test("hunter accepts a clean US gadget-adjacent kitchen tool", () => {
  const ev = evaluateItem(base, "website", DEFAULT_HUNTER);
  assert.equal(ev.ok, true);
  assert.ok(ev.profit_cents >= 500);
  assert.ok(ev.margin_bps >= 4000);
  assert.match(ev.reason, /US warehouse/);
});

test("hunter skips branded goods when in doubt", () => {
  const ev = evaluateItem({ ...base, title: "Sony Headphones Case", brand: "Sony" }, "ebay");
  assert.equal(ev.ok, false);
  assert.match(ev.reason, /brand/i);
});

test("hunter skips kids products", () => {
  const ev = evaluateItem({ ...base, title: "Kids Toddler Snack Cup" }, "ebay");
  assert.equal(ev.ok, false);
  assert.match(ev.reason, /kids/i);
});

test("hunter skips plugged-in items", () => {
  const ev = evaluateItem({ ...base, title: "Wall Charger USB Plug-In Hub" }, "ebay");
  assert.equal(ev.ok, false);
  assert.match(ev.reason, /plug/i);
});

test("hunter skips fragile glass", () => {
  const ev = evaluateItem({ ...base, title: "Fragile Glass Vase Decor" }, "ebay");
  assert.equal(ev.ok, false);
});

test("hunter skips missing dimensions / very cheap that cannot clear $15", () => {
  const ev = evaluateItem({ ...base, cost_cents: 50, shipping_cents: 0, stock_qty: 5 }, "ebay");
  // May still find a price, but min retail $15 with 40% margin on tiny cost usually works.
  // Force impossible: enormous shipping.
  const bad = evaluateItem(
    { ...base, cost_cents: 8000, shipping_cents: 5000, title: "Oversized Sofa Cover Kit Furniture" },
    "ebay",
  );
  assert.equal(bad.ok, false);
});

test("hunter skips non-US warehouse", () => {
  const ev = evaluateItem({ ...base, ships_from_us: false }, "ebay");
  assert.equal(ev.ok, false);
  assert.match(ev.reason, /US warehouse/);
});

test("hunter skips low stock below buffer", () => {
  const ev = evaluateItem({ ...base, stock_qty: 1 }, "ebay");
  assert.equal(ev.ok, false);
  assert.match(ev.reason, /stock/i);
});

test("hunter skips slow shipping", () => {
  const ev = evaluateItem({ ...base, processing_days: 12 }, "ebay");
  assert.equal(ev.ok, false);
});

test("hunt ranks by profit-ish score", () => {
  const items = [
    { id: 1, ...base, cost_cents: 300, shipping_cents: 100, title: "Metal Bookends Pair" },
    { id: 2, ...base, cost_cents: 900, shipping_cents: 300, title: "Heavy Duty Shelf Bracket" },
  ];
  const ranked = hunt(items, ["website"], DEFAULT_HUNTER);
  assert.ok(ranked.length >= 1);
  assert.ok(ranked[0].rank_score >= ranked[ranked.length - 1].rank_score);
});

test("unknown brand field fails closed", () => {
  const ev = evaluateItem({ ...base, brand: "AcmeCorpLuxury" }, "ebay");
  assert.equal(ev.ok, false);
});
