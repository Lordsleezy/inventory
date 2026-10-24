import assert from "node:assert/strict";
import {
  parseMail,
  isMarketplaceNoise,
  isMarketplacePromo,
  looksLikeSaleNotice,
  marketplaceDkimPassed,
  mailAuthenticatedForMarketplace,
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

const depopLabel = parseMail({
  subject: "Your USPS shipping label and sale confirmation for @kay_lucha.",
  text: "You've made a sale!\nOrder details\nimage Bagsmart travel backpack. Open box; see the...\n$19.99\nPayment details\nItem price\n$19.99\nPayment processing fee (?)\n( https://example.com/very-long-information-link-about-the-fee )\n−$1.36\nBuyer paid for shipping\nWhat you’ll receive   $18.63",
  from: { address: "sold@alerts.depop.com" },
});
assert.equal(depopLabel.item_title, "Bagsmart travel backpack. Open box; see the...");
assert.equal(depopLabel.price, 1999);
assert.equal(depopLabel.fee, 136);
assert.equal(depopLabel.payout, 1863);

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

// Mercari marketing tip that previously created a false $0 Live Sales row.
const mercariPromo =
  "It’s time to turn “just browsing” into “just sold” 💰";
assert.equal(isMarketplacePromo(mercariPromo, "Tips to sell faster on Mercari"), true);
assert.equal(looksLikeSaleNotice(mercariPromo, "Tips to sell faster on Mercari"), false);
assert.equal(isMarketplaceNoise(mercariPromo, "Tips to sell faster on Mercari"), true);
assert.equal(
  parseMail({
    subject: mercariPromo,
    text: "Just browsing tips. Sign in to Mercari.",
    from: { address: "no-reply@mercari.com" },
  }).sale,
  false,
);
// Real Mercari sold subject still works.
assert.equal(looksLikeSaleNotice("SOLD on Mercari – $58 (11412)", "You've made a sale!\nSold for $58.00"), true);

// Title cleanup for shipping-label subjects
assert.match(depopReal.item_title, /Depop sale for @kwfastkat1988/i);

console.log("marketplace-email-parse.test.mjs ok");


