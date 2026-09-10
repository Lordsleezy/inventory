import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFloorConfig } from "./config.ts";
import {
  buildCustomerReceipt,
  formatTaxRateBps,
  receiptCustomer,
  receiptPdfFilename,
  taxLineLabel,
  MISSING_CONDITION,
} from "./receipt.ts";
import type { SaleReceipt } from "./sale.ts";

const config = parseFloorConfig({
  storeName: "Open Box Industries",
  storeAddress: "3121 Penryn Rd, Penryn, CA 95663",
  storeEmail: "hello@example.com",
  taxRateBps: 725,
});

function receipt(overrides: Partial<SaleReceipt> = {}): SaleReceipt {
  return {
    saleId: 2,
    reference: "SO-0002",
    soldOn: "2026-09-10T15:30:00.000Z",
    channel: "floor",
    customer: { name: "Jane Doe", phone: "9165550100", email: "jane@example.com" },
    lines: [
      {
        sku: "11126",
        title: "Bosch b36cl80ens/47",
        brand: "Bosch",
        model: "b36cl80ens/47",
        description: "Bosch 20 cu ft counter depth 4 door fridge",
        condition: "Good",
        priceCents: 99900,
        channel: "floor",
      },
    ],
    saleDiscountCents: 0,
    taxRateBps: 725,
    subtotalCents: 99900,
    taxCents: 7243,
    totalCents: 107143,
    payments: [{ method: "card", cents: 107143, at: "2026-09-10T15:30:00.000Z" }],
    ...overrides,
  };
}

test("receipt PDF filename uses receipt number and date", () => {
  assert.equal(receiptPdfFilename("SO-0002", "2026-09-10T15:30:00.000Z"), "receipt-SO-0002-2026-09-10.pdf");
  assert.equal(receiptPdfFilename("SO/0002", "2026-09-10T15:30:00.000Z"), "receipt-SO-0002-2026-09-10.pdf");
});

test("tax line shows the rate", () => {
  assert.equal(formatTaxRateBps(725), "7.25%");
  assert.equal(formatTaxRateBps(0), "0%");
  assert.equal(taxLineLabel(725), "Tax (7.25%)");
  const doc = buildCustomerReceipt(receipt(), config);
  assert.equal(doc.taxLineLabel, "Tax (7.25%)");
  assert.equal(doc.taxRateLabel, "7.25%");
  assert.equal(doc.taxAmountLabel, "$72.43");
});

test("empty customer block is omitted; phone is never on the receipt", () => {
  assert.equal(receiptCustomer({ name: null, phone: "9165550100", email: null }), null);
  assert.equal(receiptCustomer(null), null);
  const named = receiptCustomer({ name: "Jane", phone: "9165550100", email: null });
  assert.deepEqual(named, { name: "Jane", email: null });
  const doc = buildCustomerReceipt(
    receipt({ customer: { name: null, phone: "9165550100", email: null } }),
    config,
  );
  assert.equal(doc.customer, null);
  const blob = JSON.stringify(doc);
  assert.equal(blob.includes("9165550100"), false);
  assert.equal(blob.includes("phone"), false);
  assert.equal(blob.includes("Penryn"), true);
});

test("each line includes condition in writing", () => {
  const doc = buildCustomerReceipt(receipt(), config);
  assert.equal(doc.lines[0]?.condition, "Good");
  const missing = buildCustomerReceipt(
    receipt({
      lines: [{ sku: "11126", title: "Fridge", priceCents: 100, channel: "floor" }],
    }),
    config,
  );
  assert.equal(missing.lines[0]?.condition, MISSING_CONDITION);
});

test("store identity comes from config and never includes a phone field", () => {
  const doc = buildCustomerReceipt(receipt(), config);
  assert.equal(doc.storeName, "Open Box Industries");
  assert.equal(doc.storeAddress, "3121 Penryn Rd, Penryn, CA 95663");
  assert.equal(doc.storeEmail, "hello@example.com");
  assert.equal("storePhone" in doc, false);
  assert.equal(doc.paymentMethod, "Card");
  assert.equal(doc.channel, "In-store");
  assert.match(doc.returnPolicy, /as-is/i);
});

test("parseFloorConfig defaults Open Box identity and a return policy", () => {
  const parsed = parseFloorConfig({});
  assert.equal(parsed.storeName, "Open Box Industries");
  assert.equal(parsed.storeAddress, "3121 Penryn Rd, Penryn, CA 95663");
  assert.equal(parsed.storeEmail, "");
  assert.match(parsed.returnPolicy, /as-is/i);
});
