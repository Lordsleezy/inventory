import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseMail,
  isMarketplaceNoise,
  looksLikeSaleNotice,
  marketplaceDkimPassed,
  mailAuthenticatedForMarketplace,
  extractDepopPhotoIds,
  extractSkuFirstLine,
} from "./marketplace-email-parse.mjs";

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


// DKIM / ARC trust gate — forged content without marketplace dkim=pass must fail.
const dkimRaw = [
  "From: sold@alerts.depop.com",
  "To: obitracking@gmail.com",
  "Subject: Your USPS shipping label and sale confirmation for @buyer",
  "Authentication-Results: mx.google.com;",
  "\tdkim=pass header.i=@alerts.depop.com header.s=selector header.b=abc;",
  "\tspf=pass smtp.mailfrom=depop.com;",
  "\tdmarc=pass header.from=alerts.depop.com",
  "Message-ID: <real@depop.com>",
  "",
  "You've made a sale!",
  "SKU: 11410",
  "Item price $22.00",
].join("\r\n");
assert.equal(marketplaceDkimPassed(dkimRaw, ["depop.com", "mercari.com"]), true);
assert.equal(mailAuthenticatedForMarketplace(dkimRaw), true);

const forgedRaw = [
  "From: sold@alerts.depop.com",
  "To: obitracking@gmail.com",
  "Subject: Your USPS shipping label and sale confirmation for @buyer",
  "Authentication-Results: mx.google.com;",
  "\tdkim=pass header.i=@gmail.com header.s=20240101 header.b=xyz;",
  "\tspf=fail smtp.mailfrom=evil.example;",
  "Message-ID: <fake@evil>",
  "",
  "You've made a sale!",
  "SKU: 11410",
  "Item price $22.00",
  "Sign in to Depop",
].join("\r\n");
assert.equal(marketplaceDkimPassed(forgedRaw, ["depop.com", "mercari.com"]), false);
assert.equal(mailAuthenticatedForMarketplace(forgedRaw), false);

const noAuthRaw = [
  "From: attacker@gmail.com",
  "Subject: You've made a sale: Fake Lamp",
  "",
  "You've made a sale! Sold for $99.00",
  "SKU: 11410",
  "Depop order",
].join("\r\n");
assert.equal(mailAuthenticatedForMarketplace(noAuthRaw), false);

const arcRaw = [
  "From: pgg124@gmail.com",
  "Subject: Fwd: Your USPS shipping label and sale confirmation",
  "ARC-Authentication-Results: i=1; mx.google.com;",
  "\tdkim=pass header.i=@alerts.depop.com header.s=selector header.b=abc;",
  "\tdmarc=pass header.from=alerts.depop.com",
  "",
  "You've made a sale!",
  "SKU: 11410",
  "Item price $22.00",
].join("\r\n");
assert.equal(marketplaceDkimPassed(arcRaw, ["depop.com"]), true);


const depopReal = parseMail({
  subject: "Your USPS shipping label and sale confirmation for @kwfastkat1988.",
  text: "You've made a sale!\nItem price $14.99\nShip to:\nJane Doe\n5017 Shade Tree Ln\nAustin, TX 78745\nSign in to Depop",
  from: { address: "sold@alerts.depop.com" },
});
assert.equal(depopReal.sale, true);
assert.equal(depopReal.marketplace, "depop");
assert.equal(depopReal.price, 1499);
assert.equal(depopReal.buyer.handle, "kwfastkat1988");
assert.equal(depopReal.order_number, null); // must not capture "details"
assert.match(depopReal.item_title, /@kwfastkat1988|Depop sale/i);

assert.equal(looksLikeSaleNotice("We've removed your listing", "This listing was sold then removed"), false);
assert.equal(looksLikeSaleNotice("You still need to ship", "Please ship your sold item"), false);

// Title cleanup for shipping-label subjects
assert.match(depopReal.item_title, /Depop sale for @kwfastkat1988/i);

// SKU on first description line (Depop truncated snippet).
assert.equal(extractSkuFirstLine("SKU 11449 · Pyrex glass mixing bowls See photos for...\nItem price $14.99"), "11449");
assert.equal(
  parseMail({
    subject: "Your USPS shipping label and sale confirmation for @buyer",
    text: "You've made a sale!\nSKU 99119 · 15in iron skillet\nItem price $24.99",
    from: { address: "sold@alerts.depop.com" },
  }).sku,
  "99119",
);

assert.deepEqual(
  extractDepopPhotoIds(
    "https://media-photos.depop.com/b1/481279620/4955799423_0680165964224f8d85ef55abae729c7c/P0.jpg",
  ),
  ["4955799423"],
);

// Real uploaded Depop sale .eml — photo id + truncated title, no SKU / product URL.
try {
  const emlPath =
    "/home/ubuntu/.cursor/projects/workspace/uploads/Your_USPS_shipping_label_and_sale_confirmation_for__kwfastkat1988._a948.eml";
  const raw = readFileSync(emlPath, "utf8");
  const subject = raw.match(/^Subject:\s*(.+)$/m)?.[1]?.trim();
  const html = raw.includes("Content-Type: text/html")
    ? raw.slice(raw.search(/Content-Type:\s*text\/html/i))
    : raw;
  const parsed = parseMail({
    subject,
    html,
    text: raw,
    from: { address: "sold@alerts.depop.com" },
  });
  assert.equal(parsed.sale, true);
  assert.equal(parsed.marketplace, "depop");
  assert.equal(parsed.price, 1499);
  assert.equal(parsed.sku, null);
  assert.deepEqual(parsed.photo_ids, ["4955799423"]);
  assert.match(parsed.item_title, /Pyrex glass mixing bowls/i);
} catch (err) {
  if (err && err.code === "ENOENT") {
    // Upload path absent in CI — photo unit test above still covers extraction.
  } else {
    throw err;
  }
}

console.log("marketplace-email-parse.test.mjs ok");


