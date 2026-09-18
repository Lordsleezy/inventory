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
