import test from "node:test";
import assert from "node:assert/strict";
import {
  applyReturnReserveCents,
  moneyToCents,
  parseAmazonReturnsTsv,
  shouldRefundNoReturn,
} from "./returns.mjs";
import { mapTikTokReturn } from "./tiktok-shop.mjs";

test("return reserve bakes into list price without shrinking", () => {
  assert.equal(applyReturnReserveCents(10000, 10), 11000);
  assert.equal(applyReturnReserveCents(10000, 0), 10000);
  assert.equal(applyReturnReserveCents(0, 10), 0);
});

test("refund-without-return threshold", () => {
  const settings = { refund_no_return_max_item_cents: 1500, refund_no_return_if_label_exceeds_item: true };
  assert.equal(shouldRefundNoReturn(settings, 1200, 800), true);
  assert.equal(shouldRefundNoReturn(settings, 5000, 6000), true);
  assert.equal(shouldRefundNoReturn(settings, 5000, 800), false);
});

test("parse Amazon MFN returns TSV", () => {
  const tsv = [
    "Order ID\tOrder date\tReturn request date\tReturn request status\tAmazon RMA ID\tLabel cost\tLabel to be paid by\tReturn carrier\tTracking ID\tMerchant SKU\tReturn Reason\tRefunded Amount\tOrder Amount\tResolution",
    "111-222\t2026-01-01\t2026-01-10\tPending approval\tRMA123\t7.50\tSeller\tUPS\t1Z\t11449\tUNWANTED_ITEM\t29.99\t29.99\tAwaiting seller",
  ].join("\n");
  const rows = parseAmazonReturnsTsv(tsv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].channel, "amazon");
  assert.equal(rows[0].sku, "11449");
  assert.equal(rows[0].external_return_id, "RMA123");
  assert.equal(rows[0].return_label_cents, 750);
  assert.equal(rows[0].refund_cents, 2999);
  assert.equal(rows[0].needs_decision, true);
  assert.equal(rows[0].status, "requested");
});

test("moneyToCents handles dollar strings", () => {
  assert.equal(moneyToCents("7.50"), 750);
  assert.equal(moneyToCents("$29.99"), 2999);
});

test("TikTok mapper marks requested as needs decision", () => {
  const row = mapTikTokReturn({
    return_id: "R1",
    order_id: "O1",
    seller_sku: "11500",
    return_status: "RETURN_OR_REFUND_REQUEST_PENDING",
    refund_amount: 19.5,
    return_reason: "DEFECTIVE",
  });
  assert.equal(row.channel, "tiktok");
  assert.equal(row.sku, "11500");
  assert.equal(row.needs_decision, true);
  assert.equal(row.refund_cents, 1950);
});

test("return reserve math matches Amazon bake-in helper", () => {
  const list = 12000;
  assert.equal(applyReturnReserveCents(list, 10), 13200);
});
