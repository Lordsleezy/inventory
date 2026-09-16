import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RECEIPT_UPLOAD_MAX_BYTES,
  isSafeStoredReceiptName,
  parseReceiptFileRecord,
  parseReceiptUpload,
  receiptUploadError,
  storedReceiptName,
} from "./receipt-file.ts";

test("allows pdf jpg png webp heic", () => {
  assert.equal(parseReceiptUpload("scan.PDF")?.ext, "pdf");
  assert.equal(parseReceiptUpload("phone.JPEG")?.contentType, "image/jpeg");
  assert.equal(parseReceiptUpload("shot.png")?.ext, "png");
  assert.equal(parseReceiptUpload("shot.webp")?.ext, "webp");
  assert.equal(parseReceiptUpload("shot.heic")?.ext, "heic");
});

test("rejects path traversal and unknown types", () => {
  assert.equal(parseReceiptUpload("../etc/passwd.pdf"), null);
  assert.equal(parseReceiptUpload("..\\windows\\receipt.pdf"), null);
  assert.equal(parseReceiptUpload("receipt.exe"), null);
  assert.equal(parseReceiptUpload("receipt"), null);
  assert.equal(storedReceiptName("../../secret.pdf"), null);
  assert.equal(isSafeStoredReceiptName("../receipt-1.pdf"), false);
  assert.equal(isSafeStoredReceiptName("receipt-1.pdf"), true);
});

test("15 MB max matches photo limit", () => {
  assert.equal(RECEIPT_UPLOAD_MAX_BYTES, 15 * 1024 * 1024);
  assert.equal(receiptUploadError({ filename: "a.pdf", byteLength: RECEIPT_UPLOAD_MAX_BYTES + 1 }), "Receipt is too large (15 MB max)");
  assert.equal(receiptUploadError({ filename: "a.pdf", byteLength: 12 }), null);
  assert.match(receiptUploadError({ filename: "a.exe", byteLength: 12 }) ?? "", /PDF/);
});

test("ignores a malformed metadata pointer", () => {
  assert.equal(parseReceiptFileRecord({ filename: "a.pdf", storedName: "../x.pdf", contentType: "application/pdf", uploadedAt: "x" }), null);
  assert.ok(parseReceiptFileRecord({
    filename: "front.jpg",
    storedName: "receipt-1.jpg",
    contentType: "image/jpeg",
    uploadedAt: "2026-09-10T00:00:00.000Z",
  }));
});
