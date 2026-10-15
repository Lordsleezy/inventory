import assert from "node:assert/strict";
import { parseMail, isMarketplaceNoise, looksLikeSaleNotice } from "./marketplace-email-parse.mjs";

assert.equal(looksLikeSaleNotice("You've made a sale: Lasko Fan", "You've made a sale! $25.00"), true);
assert.equal(
  looksLikeSaleNotice(
    "Your USPS shipping label and sale confirmation for @buyer",
    "You've made a sale! Item sold for $18.00",
  ),
  true,
);
assert.equal(looksLikeSaleNotice("You've made a sale: Blender", "Ship your item soon"), true);
assert.equal(isMarketplaceNoise("New offer on your item", "You received an offer"), true);
assert.equal(looksLikeSaleNotice("New offer on your item", "You received an offer"), false);
assert.equal(looksLikeSaleNotice("Time to ship", "Please ship your sold item"), false);
assert.equal(looksLikeSaleNotice("Security alert", "New login"), false);

const depop = parseMail({
  subject: "Your USPS shipping label and sale confirmation for @coolbuyer",
  text: "You've made a sale!\nSKU: 11410\nItem price $22.00\nOrder number DEP-ABC123",
  from: { address: "noreply@depop.com" },
});
assert.equal(depop.sale, true);
assert.equal(depop.marketplace, "depop");
assert.equal(depop.sku, "11410");
assert.equal(depop.price, 2200);

const mercari = parseMail({
  subject: "You've made a sale: Portable Blender",
  text: "You've made a sale!\nSKU #11412\nSold for $58.00",
  from: { address: "no-reply@mercari.com" },
});
assert.equal(mercari.sale, true);
assert.equal(mercari.marketplace, "mercari");
assert.equal(mercari.sku, "11412");
assert.equal(mercari.price, 5800);

const subjectSku = parseMail({
  subject: "SOLD on Mercari – $58 (11412)",
  text: "You've made a sale!",
  from: { address: "obitracking@gmail.com" },
});
assert.equal(subjectSku.sale, true);
assert.equal(subjectSku.sku, "11412");
assert.equal(subjectSku.price, 5800);

console.log("marketplace-email-parse.test.mjs ok");
