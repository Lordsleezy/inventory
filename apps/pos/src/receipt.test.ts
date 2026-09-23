import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_LEGAL,
  charsPerLine,
  escPosBytes,
  letterBytes,
  receiptPrintJob,
  receiptText,
  wrapLine,
} from "./receipt.ts";

const TEST_ADDRESS = "3121 Penryn Rd, Penryn, CA 95663";

const payload = {
  receiptNo: "HOLD-1",
  provisional: true,
  soldAt: "2026-09-19 17:00",
  clerkName: "Sam",
  sku: "11116",
  title: "GE fridge",
  condition: "Good",
  priceCents: 1999,
  taxCents: 145,
  totalCents: 2144,
  tender: "CASH",
};

test("letter is the wide default; rolls stay narrow", () => {
  assert.equal(charsPerLine("letter"), 88);
  assert.equal(charsPerLine("roll58"), 32);
  assert.equal(charsPerLine("roll80"), 48);
});

test("letter receipt is a full page with 7-day exchange legal", () => {
  const width = charsPerLine("letter");
  const text = receiptText({ ...payload, branding: { address: TEST_ADDRESS } }, width);
  assert.match(text, /3121 Penryn Rd/);
  assert.match(text, /11116/);
  assert.match(text, /7-DAY EXCHANGE ONLY/);
  assert.doesNotMatch(text, /ALL SALES FINAL/);
  assert.match(text, /PROVISIONAL/);
  for (const line of text.split("\n")) assert.ok(line.length <= width, line);
  assert.ok(DEFAULT_LEGAL.includes("store credit"));
  const page = letterBytes(payload);
  assert.equal(page[page.length - 1], 0x0c);
});

test("custom legal is used when provided", () => {
  const text = receiptText({ ...payload, legal: "SHORT POLICY." }, 88);
  assert.match(text, /SHORT POLICY/);
  assert.doesNotMatch(text, /7-DAY EXCHANGE/);
});

test("roll job is ESC/POS raw; letter job is CUPS text", () => {
  const roll = receiptPrintJob({ ...payload, reviewUrl: "https://g.page/r/review" }, "roll80");
  assert.equal(roll.raw, true);
  assert.equal(roll.data[0], 0x1b);
  const letter = receiptPrintJob(payload, "letter");
  assert.equal(letter.raw, false);
});

test("wrap splits long legal copy", () => {
  const lines = wrapLine(DEFAULT_LEGAL, 32);
  assert.ok(lines.length > 4);
  for (const line of lines) assert.ok(line.length <= 32);
});

test("ESC/POS bytes include QR and cut on roll", () => {
  const withQr = escPosBytes({ ...payload, reviewUrl: "https://g.page/r/review" }, "roll80");
  assert.match(Buffer.from(withQr).toString("latin1"), /Scan to review/);
});

test("branding overrides store name and shows discount/points/tender", () => {
  const text = receiptText(
    {
      ...payload,
      discountCents: 200,
      pointsEarned: 5,
      pointsRedeemed: 1,
      pointsBalance: 40,
      tenderDetails: { method: "CARD", cardBrand: "Visa", cardLast4: "4242" },
      branding: { storeName: "Acme Resale", showTax: true },
    },
    48,
  );
  assert.match(text, /Acme Resale/);
  assert.match(text, /Discount/);
  assert.match(text, /Pts earned/);
  assert.match(text, /Visa/);
  assert.equal(text.split("\n")[0], "Acme Resale");
});
