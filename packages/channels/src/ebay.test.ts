import assert from "node:assert/strict";
import test from "node:test";
import { ebayCondition, ebayHosts, ebayItemViewUrl, ebayRuName } from "./ebay.ts";

test("sandbox is the default eBay host until EBAY_ENV is production", () => {
  assert.equal(ebayHosts(undefined).api, "https://api.sandbox.ebay.com");
  assert.equal(ebayHosts("sandbox").auth, "https://auth.sandbox.ebay.com");
  assert.equal(ebayHosts("production").api, "https://api.ebay.com");
  assert.equal(ebayItemViewUrl("110590742623"), "https://www.sandbox.ebay.com/itm/110590742623");
  assert.equal(
    ebayItemViewUrl("110590742623", "production"),
    "https://www.ebay.com/itm/110590742623",
  );
});

test("eBay OAuth uses the RuName, not the https callback", () => {
  assert.equal(ebayRuName("Paul_Green-PaulGree-Sentine-xxxxx"), "Paul_Green-PaulGree-Sentine-xxxxx");
  assert.throws(() => ebayRuName("https://example.com/oauth-callback"));
  assert.throws(() => ebayRuName(""));
});

test("Floor conditions map onto eBay condition enums", () => {
  assert.equal(ebayCondition("New"), "NEW");
  assert.equal(ebayCondition("Open box"), "LIKE_NEW");
  assert.equal(ebayCondition("Excellent"), "USED_EXCELLENT");
  assert.equal(ebayCondition("Good"), "USED_GOOD");
  assert.equal(ebayCondition("Fair"), "USED_ACCEPTABLE");
  assert.equal(ebayCondition("For parts"), "FOR_PARTS_OR_NOT_WORKING");
});
