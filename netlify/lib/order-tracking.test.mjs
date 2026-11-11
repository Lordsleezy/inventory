import test from "node:test";
import assert from "node:assert/strict";
import { patchFromShippoStatus, registerOrderTracking } from "./order-tracking.mjs";
import { attachUploadedLabel, resolveUploadedTracking } from "./order-label.mjs";

const order = { id: "o1", shipped_at: null, delivered_at: null, packaged_at: "2026-11-07T18:00:00Z", carrier: "USPS" };

test("label created does not move the order to Shipped", () => {
  const patch = patchFromShippoStatus(order, { status: "PRE_TRANSIT", statusDate: "2026-11-07T19:00:00Z", statusDetails: "Label created" });
  assert.equal(patch.shipped_at, undefined);
  assert.equal(patch.delivered_at, undefined);
  assert.equal(patch.tracking_status, "pre_transit");
});

test("first carrier scan sets shipped and clears an old exception", () => {
  const patch = patchFromShippoStatus(
    { ...order, tracking_exception: "old" },
    { status: "TRANSIT", statusDate: "2026-11-08T00:31:00Z", statusDetails: "Accepted at USPS" },
  );
  assert.equal(patch.shipped_at, "2026-11-08T00:31:00Z");
  assert.equal(patch.tracking_exception, null);
  assert.equal(patch.delivered_at, undefined);
});

test("delivered sets both timestamps once", () => {
  const patch = patchFromShippoStatus(order, { status: "DELIVERED", statusDate: "2026-11-10T15:00:00Z", statusDetails: "Delivered" });
  assert.equal(patch.delivered_at, "2026-11-10T15:00:00Z");
  assert.ok(patch.shipped_at);
});

test("Shippo tracking registration stays off until the store setting is on", async () => {
  const calls = [];
  const off = {
    from() {
      const chain = {
        select() { return chain; },
        eq() { return chain; },
        limit: async () => ({ data: [{ value: false }], error: null }),
      };
      return chain;
    },
  };
  const skipped = await registerOrderTracking(off, { id: "o1", tracking_number: "9400111899223344556677" }, {
    registerTrack: async () => { calls.push("register"); return { object_id: "trk" }; },
  });
  assert.equal(skipped.skipped, "tracking_off");
  assert.equal(calls.length, 0);

  const on = {
    from(table) {
      const chain = {
        select() { return chain; },
        eq() { return chain; },
        update() { return chain; },
        limit: async () => ({ data: [{ value: true }], error: null }),
      };
      if (table === "web_orders") chain.limit = undefined;
      return chain;
    },
  };
  const registered = await registerOrderTracking(on, { id: "o1", tracking_number: "9400111899223344556677" }, {
    registerTrack: async () => { calls.push("register"); return { object_id: "trk" }; },
  });
  assert.equal(registered.ok, true);
  assert.deepEqual(calls, ["register"]);
});

test("return to sender flags the order and does not mark it delivered", () => {
  const patch = patchFromShippoStatus(order, { status: "RETURNED", statusDate: "2026-11-09T12:00:00Z", statusDetails: "Return to sender" });
  assert.equal(patch.tracking_exception, "Return to sender");
  assert.equal(patch.delivered_at, undefined);
  assert.ok(patch.shipped_at);
});

test("an uploaded Depop label stores tracking and posts no expense", async () => {
  const updates = [];
  const inserts = [];
  const sb = {
    storage: undefined,
    from(table) {
      const api = {
        update(vals) { updates.push([table, vals]); return api; },
        insert(vals) { inserts.push([table, vals]); return api; },
        eq() { return api; },
        select() { return api; },
        async single() { return { data: { id: "o1", tracking_number: updates.at(-1)?.[1]?.tracking_number, store_id: "s" }, error: null }; },
      };
      return api;
    },
  };
  const pdf = Buffer.from("%PDF-1.4\n(USPS TRACKING 9300 1107 9340 0248 3678 94) Tj\n%%EOF\n");
  const r = await attachUploadedLabel(sb, "s", { id: "o1", store_id: "s", status: "paid", fulfillment: "ship", channel: "depop", weight_verified_at: "2026-11-07T12:00:00Z" }, {
    bytes: pdf, name: "depop-label-00162.pdf", mime: "application/pdf",
  }, { allowMissingStorage: true, registerTrack: async () => ({ ok: true, skipped: "test" }) });
  assert.equal(r.ok, true);
  assert.equal(r.expense_posted, false);
  assert.equal(r.needs_tracking, false);
  assert.equal(r.tracking_number, "9300110793400248367894");
  assert.equal(inserts.length, 0);
  assert.equal(updates[0][1].label_origin, "upload");
  assert.equal(updates[0][1].label_cost_cents, null);
});

test("an eBay PDF that disagrees with eBay tracking is a mismatch", () => {
  const r = resolveUploadedTracking(
    { channel: "ebay", marketplace_tracking_number: "9400111899001234567891" },
    { confident: true, number: "9400111899001234567800", carrier: "USPS" },
  );
  assert.equal(r.mismatch, true);
  assert.match(r.exception, /^label_mismatch\|/);
});

test("a truncated USPS body matches eBay tracking", () => {
  const r = resolveUploadedTracking(
    { channel: "ebay", marketplace_tracking_number: "9434608106244728542207" },
    { confident: true, number: "34608106244728542207", carrier: "FedEx" },
  );
  assert.equal(r.mismatch, false);
  assert.equal(r.tracking, "9434608106244728542207");
});

test("an unreadable eBay PDF keeps eBay's tracking number", () => {
  const r = resolveUploadedTracking(
    { channel: "ebay", marketplace_tracking_number: "9400111899001234567891", carrier: "USPS" },
    { confident: false },
  );
  assert.equal(r.mismatch, false);
  assert.equal(r.tracking, "9400111899001234567891");
  assert.equal(r.usedEbay, true);
});
