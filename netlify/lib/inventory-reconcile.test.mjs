import assert from "node:assert/strict";
import { reconcileAlertText, reconcileFindings } from "./inventory-reconcile.mjs";

const findings = reconcileFindings({
  units: [
    { sku: "11352", title: "bagsmart travel backpack", state: "available" },
    { sku: "11442", title: "Artic Zone Titan", state: "sold" },
    { sku: "99999", title: "Still for sale", state: "available" },
  ],
  sales: [{ sku: "11352", channel: "depop", price_cents: 2200, sold_at: "2026-10-21T18:00:00Z", voided_at: null }],
  orders: [],
  listings: [
    { sku: "11442", channel: "depop", status: "listed", listing_id: "945694376" },
    { sku: "99999", channel: "ebay", status: "listed", listing_id: "1" },
    { sku: "11442", channel: "ebay", status: "delisted", listing_id: "2" },
  ],
});

assert.equal(findings.soldButAvailable.length, 1);
assert.equal(findings.soldButAvailable[0].sku, "11352");
assert.equal(findings.soldStillListed.length, 1);
assert.equal(findings.soldStillListed[0].channel, "depop");
assert.match(reconcileAlertText(findings), /11352/);
assert.match(reconcileAlertText(findings), /11442/);

const quiet = reconcileFindings({
  units: [{ sku: "1", state: "available", title: "Ok" }],
  sales: [],
  orders: [{ sku: "UNMATCHED", channel: "depop", status: "paid" }],
  listings: [],
});
assert.equal(quiet.soldButAvailable.length, 0);

console.log("inventory-reconcile.test.mjs ok");
