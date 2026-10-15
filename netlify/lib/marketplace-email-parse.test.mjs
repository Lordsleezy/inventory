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

// Real Depop/Mercari sale emails include Sign in / login / verify footers — must NOT be noise.
const depopBody = [
  "You've made a sale!",
  "SKU: 11410",
  "Item price $22.00",
  "Order number DEP-ABC123",
  "Ship by October 18, 2026",
  "Sign in to Depop to print your label",
  "Log in to your account",
  "Verify your email preferences",
  "https://www.depop.com/login",
].join("\n");
assert.equal(isMarketplaceNoise("Your USPS shipping label and sale confirmation for @coolbuyer", depopBody), false);
assert.equal(looksLikeSaleNotice("Your USPS shipping label and sale confirmation for @coolbuyer", depopBody), true);

const depop = parseMail({
  subject: "Your USPS shipping label and sale confirmation for @coolbuyer",
  text: depopBody,
  from: { address: "sold@alerts.depop.com" },
});
assert.equal(depop.sale, true);
assert.equal(depop.marketplace, "depop");
assert.equal(depop.sku, "11410");
assert.equal(depop.price, 2200);
assert.equal(depop.order_number, "DEP-ABC123");

const mercariBody = [
  "You've made a sale!",
  "SKU #11412",
  "Sold for $58.00",
  "Sign in to Mercari",
  "Confirm your email is up to date for shipping updates",
].join("\n");
assert.equal(isMarketplaceNoise("You've made a sale: Portable Blender", mercariBody), false);
const mercari = parseMail({
  subject: "You've made a sale: Portable Blender",
  text: mercariBody,
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

// Auth subjects still ignored even if body mentions sold.
assert.equal(looksLikeSaleNotice("Password reset", "Your item sold for $10"), false);
assert.equal(looksLikeSaleNotice("Verify your account", "Item sold"), false);

console.log("marketplace-email-parse.test.mjs ok");
