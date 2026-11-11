import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  compactTracking,
  extractPdfText,
  extractTrackingFromFile,
  parseTracking,
} from "./tracking-extract.mjs";
import { attachUploadedLabel, resolveUploadedTracking } from "./order-label.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures", "labels");

const EBAY_4798 = "9400108106244728534798";
const EBAY_2207 = "9434608106244728542207";
const DEPOP_7894 = "9300110793400248367894";

function pdfWithText(text) {
  const safe = String(text).replace(/[()\\]/g, " ");
  const stream = `BT /F1 10 Tf 24 700 Td (${safe}) Tj ET`;
  return Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\ntrailer\n<<>>\n%%EOF\n`,
  );
}

function ebayTextPdf({ trackingSpaced, orderRef = "25-15374-99562", permit = "028W0002311111" }) {
  const text = [
    "eBay.com shipping label",
    "USPS GROUND ADVANTAGE",
    "USPS TRACKING #",
    trackingSpaced,
    `Postage Paid ${permit}`,
    `Order ${orderRef}`,
    "Ship to Sample Buyer",
    "Sample City CA 95663",
  ].join("\n");
  return pdfWithText(text);
}

function wrapJpegInPdf(jpegBuf) {
  const len = jpegBuf.length;
  const head = Buffer.from(
    `%PDF-1.4
1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj
2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj
3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 600] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>endobj
4 0 obj<< /Type /XObject /Subtype /Image /Width 400 /Height 600 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${len} >>
stream
`,
  );
  const tail = Buffer.from(`
endstream
endobj
5 0 obj<< /Length 44 >>stream
q 400 0 0 600 0 0 cm /Im0 Do Q
endstream
endobj
trailer<< /Size 6 /Root 1 0 R >>
%%EOF`);
  return Buffer.concat([head, jpegBuf, tail]);
}

/** Shippo-style flattened label: no PDF text, printed number on the bitmap (OCR / barcode). */
async function depopImageLabelPdf(tracking) {
  const spaced = tracking.replace(/(\d{4})(?=\d)/g, "$1 ").trim();
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1200">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="48" y="880" font-family="Arial, sans-serif" font-size="36" fill="#000">USPS TRACKING #</text>
  <text x="48" y="940" font-family="Arial, sans-serif" font-size="36" fill="#000">${spaced}</text>
  <text x="48" y="1000" font-family="Arial, sans-serif" font-size="28" fill="#666">SKU: 11443</text>
</svg>`;
  const jpeg = await sharp(Buffer.from(svg)).jpeg({ quality: 95 }).toBuffer();
  return wrapJpegInPdf(jpeg);
}

mkdirSync(FIX, { recursive: true });

test("Paul eBay sample layout reads spaced USPS (ends 4798)", async () => {
  const buf = ebayTextPdf({ trackingSpaced: "9400 1081 0624 4728 5347 98" });
  const r = await extractTrackingFromFile(buf, "application/pdf", { filename: "eBay_label_25-15374-99562.pdf" });
  assert.equal(r.confident, true, r.reason);
  assert.equal(r.number, EBAY_4798);
  assert.equal(r.carrier, "USPS");
});

test("second eBay sample (ends 2207) ignores postage permit", async () => {
  const buf = ebayTextPdf({ trackingSpaced: "9434 6081 0624 4728 5422 07", orderRef: "16-15389-95042", permit: "028W0002311459" });
  const r = await extractTrackingFromFile(buf, "application/pdf", { filename: "eBay_label_16-15389-95042.pdf" });
  assert.equal(r.number, EBAY_2207);
});

test("flattened Shippo-style PDF reads printed tracking, not SKU decoy", { skip: process.env.CI ? "OCR is slow in CI; covered locally with bundled traineddata" : false }, async () => {
  const buf = await depopImageLabelPdf(DEPOP_7894);
  const r = await extractTrackingFromFile(buf, "application/pdf", { filename: "Label.pdf" });
  assert.equal(r.confident, true, JSON.stringify(r));
  assert.equal(r.number, DEPOP_7894);
  assert.match(r.layer, /^(ocr|barcode|pdf-text)$/);
});

test("attach_label does not ask for manual entry when barcode succeeded (Depop state bug)", { skip: process.env.CI ? "OCR is slow in CI" : false }, async () => {
  const buf = await depopImageLabelPdf(DEPOP_7894);
  const updates = [];
  const sb = {
    storage: undefined,
    from() {
      const api = {
        update(vals) { updates.push(vals); return api; },
        eq() { return api; },
        select() { return api; },
        async single() {
          return {
            data: { id: "o1", tracking_number: updates.at(-1)?.tracking_number, store_id: "s" },
            error: null,
          };
        },
      };
      return api;
    },
  };
  const r = await attachUploadedLabel(
    sb,
    "s",
    { id: "o1", store_id: "s", status: "paid", fulfillment: "ship", channel: "depop", weight_verified_at: "2026-11-07T12:00:00Z" },
    { bytes: buf, name: "Label.pdf", mime: "application/pdf" },
    { allowMissingStorage: true, registerTrack: async () => ({ ok: true, skipped: "test" }) },
  );
  assert.equal(r.tracking_number, DEPOP_7894);
  assert.equal(r.needs_tracking, false);
  assert.equal(r.ok, true);
});

test("bad check digit is rejected", () => {
  const r = parseTracking("USPS TRACKING 9400 1081 0624 4728 5347 99");
  assert.equal(r.confident, false);
});

test("Depop-style spaced USPS is one confident number", async () => {
  const text = `DEPOP\nUSPS GROUND ADVANTAGE\nUSPS TRACKING #\n9300 1107 9340 0248 3678 94\nShip to Jane`;
  const r = parseTracking(text);
  assert.equal(r.confident, true);
  assert.equal(r.number, DEPOP_7894);
});

test("a 420 barcode prefix does not create a second number", () => {
  const r = parseTracking(`42095639${DEPOP_7894}`);
  assert.equal(r.confident, true);
  assert.equal(r.number, DEPOP_7894);
});

test("two different valid USPS numbers need a picker", () => {
  const r = parseTracking(`${EBAY_4798}\n${EBAY_2207}`);
  assert.equal(r.confident, false);
  assert.equal(r.needsPicker, true);
});

test("UPS 1Z is confident near a tracking label", () => {
  const r = parseTracking("UPS TRACKING #\n1Z999AA10123456784");
  assert.equal(r.confident, true);
  assert.equal(r.carrier, "UPS");
  assert.equal(r.number, "1Z999AA10123456784");
});

test("a price and a zip are not a tracking number", () => {
  const r = parseTracking("Sale $11.90\nPenryn CA 95663\nOrder 99899");
  assert.equal(r.confident, false);
});

test("a 420 ZIP wrapper is the same USPS number", () => {
  assert.equal(compactTracking(`42095663${DEPOP_7894}`), DEPOP_7894);
  assert.equal(compactTracking(DEPOP_7894), DEPOP_7894);
  assert.equal(compactTracking("(420)442362125(94)34608106244728542207"), EBAY_2207);
  assert.equal(compactTracking("4204423621259434608106244728542207"), EBAY_2207);
  assert.equal(compactTracking(`42044236${EBAY_2207}`), EBAY_2207);
  assert.equal(compactTracking("962208043(0000000000)000384592279027"), "384592279027");
});

test("filename order digits are not chosen as tracking", async () => {
  const buf = ebayTextPdf({ trackingSpaced: "9400 1081 0624 4728 5347 98", orderRef: "25-15374-99562" });
  const r = await extractTrackingFromFile(buf, "application/pdf", { filename: "eBay_label_25-15374-99562.pdf" });
  assert.notEqual(r.number, "251537499562");
  assert.equal(r.number, EBAY_4798);
});

test("eBay PDF that disagrees with eBay tracking is a mismatch", () => {
  const r = resolveUploadedTracking(
    { channel: "ebay", marketplace_tracking_number: DEPOP_7894 },
    { confident: true, number: EBAY_4798, carrier: "USPS" },
  );
  assert.equal(r.mismatch, true);
});

test("20-digit IMpb body from barcode completes to 9434…2207 (Paul SKU 99860)", () => {
  const r = parseTracking("USPS TRACKING #\n34608106244728542207");
  assert.equal(r.confident, true);
  assert.equal(r.number, EBAY_2207);
});

test("resolveUploadedTracking treats truncated body as same as eBay", () => {
  const r = resolveUploadedTracking(
    { channel: "ebay", marketplace_tracking_number: EBAY_2207 },
    { confident: true, number: "34608106244728542207", carrier: "USPS" },
  );
  assert.equal(r.mismatch, false);
  assert.equal(r.tracking, EBAY_2207);
});

test("unreadable eBay PDF keeps eBay tracking", () => {
  const r = resolveUploadedTracking(
    { channel: "ebay", marketplace_tracking_number: DEPOP_7894, carrier: "USPS" },
    { confident: false },
  );
  assert.equal(r.tracking, DEPOP_7894);
});

test("write redacted fixtures for manual inspection", async () => {
  if (process.env.CI) return;
  if (!existsSync(FIX)) mkdirSync(FIX, { recursive: true });
  writeFileSync(join(FIX, "ebay-label-4798.pdf"), ebayTextPdf({ trackingSpaced: "9400 1081 0624 4728 5347 98" }));
  writeFileSync(join(FIX, "ebay-label-2207.pdf"), ebayTextPdf({ trackingSpaced: "9434 6081 0624 4728 5422 07", orderRef: "16-15389-95042" }));
  writeFileSync(join(FIX, "depop-shippo-image.pdf"), await depopImageLabelPdf(DEPOP_7894));
  const text = await extractPdfText(ebayTextPdf({ trackingSpaced: "9400 1081 0624 4728 5347 98" }));
  assert.match(text, /USPS TRACKING/);
});
