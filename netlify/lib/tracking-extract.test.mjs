import test from "node:test";
import assert from "node:assert/strict";
import { extractPdfText, extractTrackingFromFile, parseTracking } from "./tracking-extract.mjs";

const DEPOP = "9400111899001234567891";

function pdfWith(text) {
  const safe = String(text).replace(/[()\\]/g, "");
  const stream = `BT /F1 12 Tf (${safe}) Tj ET`;
  return Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\ntrailer\n<<>>\n%%EOF\n`);
}

test("Depop-style spaced USPS tracking is one confident number", () => {
  const text = `DEPOP\nUSPS GROUND ADVANTAGE\nUSPS TRACKING #\n9400 1118 9900 1234 5678 91\nShip to Jane`;
  const r = parseTracking(text);
  assert.equal(r.confident, true);
  assert.equal(r.number, DEPOP);
  assert.equal(r.carrier, "USPS");
});

test("a 420 barcode prefix does not create a second number", () => {
  const r = parseTracking(`42095834${DEPOP}`);
  assert.equal(r.confident, true);
  assert.equal(r.number, DEPOP);
});

test("two different USPS numbers are not a guess", () => {
  const r = parseTracking(`${DEPOP}\n9400111899000000000099`);
  assert.equal(r.confident, false);
  assert.equal(r.reason, "multiple");
});

test("UPS 1Z is confident", () => {
  const r = parseTracking("UPS 1Z999AA10123456784");
  assert.equal(r.confident, true);
  assert.equal(r.carrier, "UPS");
  assert.equal(r.number, "1Z999AA10123456784");
});

test("a price and a zip are not a tracking number", () => {
  const r = parseTracking("Sale $11.90\nPenryn CA 95663\nOrder 99899");
  assert.equal(r.confident, false);
});

test("PDF text extraction reads the tracking line", async () => {
  const buf = pdfWith(`USPS TRACKING 9400 1118 9900 1234 5678 91`);
  assert.match(extractPdfText(buf), /9400 1118 9900 1234 5678 91/);
  const r = await extractTrackingFromFile(buf, "application/pdf");
  assert.equal(r.engine, "pdf");
  assert.equal(r.confident, true);
  assert.equal(r.number, DEPOP);
});
