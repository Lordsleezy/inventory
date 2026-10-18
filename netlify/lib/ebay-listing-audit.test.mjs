import assert from "node:assert/strict";
import {
  shippingFromTradingItem,
  rowsToCsv,
  buildSummaryText,
  MID_COUNTRY_ZIP,
} from "./ebay-listing-audit.mjs";

const calc = shippingFromTradingItem({
  shippingType: "Calculated",
  shippingProfile: "Calculated Shipping – Buyer Pays",
  shippingServices: [],
  localPickup: true,
});
assert.equal(calc.shipping_mode, "calculated");
assert.equal(calc.local_pickup, true);

const free = shippingFromTradingItem({
  shippingType: "Flat",
  shippingProfile: "Free Shipping",
  shippingServices: [{ service: "USPSPriority", cost: "0.0", free: true, priority: 1 }],
});
assert.equal(free.shipping_mode, "free");
assert.equal(free.flat_shipping_cents, 0);

const flat = shippingFromTradingItem({
  shippingType: "Flat",
  shippingServices: [{ service: "USPSPriority", cost: "9.95", free: false, priority: 1 }],
});
assert.equal(flat.shipping_mode, "flat");
assert.equal(flat.flat_shipping_cents, 995);

const csv = rowsToCsv([
  {
    ebay_item_id: "123",
    ebay_url: "https://www.ebay.com/itm/123",
    floor_sku: "11400",
    floor_match: "matched",
    product_name: 'Skillet, 12"',
    brand: "Lodge",
    model: "",
    upc: "",
    ebay_price_cents: 1200,
    ebay_price: "$12.00",
    shipping_mode: "calculated",
    shipping_profile: "Calculated Shipping – Buyer Pays",
    shipping_display: `Calculated est. $8.00 (${MID_COUNTRY_ZIP})`,
    shippo_estimate_cents: 800,
    shippo_estimate: "$8.00",
    shippo_detail: "USPS Ground Advantage",
    local_pickup: "yes",
    package_dims: "12x12x4 in / 8 lb",
    dims_missing: "no",
    retail_outlets: "Amazon $40.00",
    retail_high_cents: 4000,
    retail_high: "$40.00",
    retail_low_cents: 4000,
    retail_low: "$40.00",
    retail_links: "https://www.amazon.com/dp/B00",
    match_confidence: "exact",
    pct_of_high_retail: 30,
    price_flag: "SUSPICIOUSLY_LOW",
    unit_state: "available",
    floor_ask_cents: 1200,
    notes: "",
  },
]);
assert.match(csv, /ebay_item_id/);
assert.match(csv, /Skillet, 12""/);

const txt = buildSummaryText({
  account: "ikonikdeals2026",
  liveCount: 1,
  rows: [
    {
      floor_sku: "11400",
      ebay_item_id: "123",
      ebay_price: "$12.00",
      ebay_price_cents: 1200,
      retail_high: "$40.00",
      retail_high_cents: 4000,
      pct_of_high_retail: 30,
      price_flag: "SUSPICIOUSLY_LOW",
      product_name: "Skillet",
      floor_match: "matched",
      dims_missing: "no",
    },
  ],
  mismatches: { floor_not_live: [] },
  startedAt: "2026-01-01T00:00:00Z",
  finishedAt: "2026-01-01T00:10:00Z",
  notes: ["test note"],
});
assert.match(txt, /Live ACTIVE listings:\s+1/);
assert.match(txt, /SUSPICIOUSLY/);
assert.match(txt, /test note/);

console.log("ebay-listing-audit.test.mjs ok");
