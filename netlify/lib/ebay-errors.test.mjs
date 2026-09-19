import assert from "node:assert/strict";
import test from "node:test";
import { formatEbayError, locationKey } from "./ebay-errors.mjs";

test("location keys are alphanumeric (eBay rejects hyphens)", () => {
  assert.equal(locationKey("a1b2-c3d4-e5f6"), "flra1b2c3d4e5f6");
  assert.match(locationKey("11111111-2222-3333-4444-555555555555"), /^flr[a-z0-9]+$/);
});

test("never surfaces a bare invalid", () => {
  const msg = formatEbayError({
    errors: [
      {
        errorId: 25002,
        message: "Invalid",
        longMessage: "A user error has occurred. Invalid data.",
        parameters: [{ name: "0", value: "condition" }],
      },
    ],
  });
  assert.doesNotMatch(msg, /^invalid$/i);
  assert.match(msg, /condition/i);
  assert.match(msg, /New, Open box/i);
});

test("photo errors tell you eBay could not download the files", () => {
  const msg = formatEbayError({
    errors: [{ message: "Invalid image URL", parameters: [{ name: "imageUrls", value: "https://x/sign" }] }],
  });
  assert.match(msg, /public HTTPS/i);
});

test("decodes HTML entities and does not repeat the same eBay sentence", () => {
  const msg = formatEbayError({
    errors: [
      {
        message: "Seller has opted into business policies. Please use the seller&apos;s policy IDs.",
        longMessage: "Seller has opted into business policies. Please use the seller&apos;s policy IDs.",
      },
      {
        message: "Seller has opted into business policies. Please use the seller&apos;s policy IDs.",
        longMessage: "Seller has opted into business policies. Please use the seller&apos;s policy IDs.",
      },
    ],
  });
  assert.match(msg, /seller's policy IDs/i);
  assert.doesNotMatch(msg, /&apos;/i);
  assert.doesNotMatch(msg, /ebay_raw=/);
  assert.equal((msg.match(/opted into business policies/gi) || []).length, 1);
});

test("keeps errorId, longMessage, parameters, and warnings for publish failures", () => {
  const msg = formatEbayError({
    errors: [
      {
        errorId: 25713,
        message: "This Offer is not available.",
        longMessage: "This Offer is not available.",
        parameters: [{ name: "additionalInfo", value: "Merchant location is disabled" }],
      },
    ],
    warnings: [
      {
        errorId: 25002,
        message: "Invalid",
        longMessage: "A user error has occurred. Invalid data.",
        parameters: [{ name: "0", value: "Brand" }],
      },
    ],
  });
  assert.match(msg, /25713/);
  assert.match(msg, /additionalInfo=Merchant location is disabled/);
  assert.match(msg, /Brand/);
  assert.match(msg, /warning/i);
  assert.doesNotMatch(msg, /ebay_raw=/);
});
