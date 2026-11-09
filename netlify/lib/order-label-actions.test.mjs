import test from "node:test";
import assert from "node:assert/strict";
import { acceptMarketplaceTracking, resolveUploadedTracking } from "./order-label.mjs";

test("accept_marketplace_tracking saves eBay number and clears mismatch", async () => {
  const updates = [];
  const sb = {
    from() {
      const api = {
        update(vals) { updates.push(vals); return api; },
        eq() { return api; },
        select() { return api; },
        async single() {
          return { data: { id: "o1", tracking_number: updates.at(-1)?.tracking_number, store_id: "s" }, error: null };
        },
      };
      return api;
    },
  };
  const order = {
    id: "o1",
    store_id: "s",
    channel: "ebay",
    marketplace_tracking_number: "9434608106244728542207",
    label_tracking_mismatch: true,
    tracking_exception: "label_mismatch|34608106244728542207|9434608106244728542207",
  };
  const r = await acceptMarketplaceTracking(sb, "s", order, {
    registerTrack: async () => ({ ok: true, skipped: "test" }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.order.tracking_number, "9434608106244728542207");
  assert.equal(updates[0].label_tracking_mismatch, false);
  assert.equal(updates[0].tracking_exception, null);
});
