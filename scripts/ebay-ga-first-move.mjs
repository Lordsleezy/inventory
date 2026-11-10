/**
 * The $30-named policy cannot be reordered: eBay treats that service list as a
 * duplicate of OBI Calculated Shipping – Buyer Pays. Move its one listing onto
 * that policy, which already has Ground Advantage first. Price and title stay.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadEbayAccount, userTokenForAccount, ebayFetchAccount } from "../netlify/lib/ebay-accounts.mjs";
import { ebayHosts } from "../netlify/lib/ebay-env.mjs";
import { reviseFixedPricePriceAndShipping } from "../netlify/lib/ebay-trading.mjs";

const cached = JSON.parse(readFileSync(path.join(process.env.TEMP, "netlify-env-inventoryobi.json"), "utf8"));
for (const row of cached) {
  if (!process.env[row.key] && row.values?.[0]?.value) process.env[row.key] = row.values[0].value;
}
process.env.EBAY_ENV = "production";

const STORE = "5487ca47-6147-4fe8-bc6d-46b6472726ba";
const ITEM = "820272097961";
const FROM = "267969883017";
const TO = "267755796017";
const backupPath = path.join("ops", "shipping-audit-2026-11-09", "ga-first-backup.json");

const account = await loadEbayAccount(STORE, { username: "ikonikdeals2026" });
const token = await userTokenForAccount(account);
const { api } = ebayHosts("production");

function tag(xml, name) {
  const match = String(xml).match(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`));
  return match ? match[1].trim() : "";
}
async function trading(callName, inner) {
  const res = await fetch(`${api}/ws/api.dll`, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml",
      "X-EBAY-API-COMPATIBILITY-LEVEL": "1315",
      "X-EBAY-API-CALL-NAME": callName,
      "X-EBAY-API-SITEID": "0",
      "X-EBAY-API-IAF-TOKEN": token,
    },
    body: `<?xml version="1.0" encoding="utf-8"?><${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents"><ErrorLanguage>en_US</ErrorLanguage>${inner}</${callName}Request>`,
  });
  const xml = await res.text();
  return { ack: tag(xml, "Ack"), xml, error: /success|warning/i.test(tag(xml, "Ack")) ? "" : tag(xml, "LongMessage") };
}
async function readItem() {
  const { xml, error } = await trading("GetItem", `<ItemID>${ITEM}</ItemID><OutputSelector>Item.Title</OutputSelector><OutputSelector>Item.SellingStatus</OutputSelector><OutputSelector>Item.SellerProfiles</OutputSelector>`);
  const profiles = (xml.match(/<SellerProfiles>([\s\S]*?)<\/SellerProfiles>/) || [])[1] || "";
  return {
    error,
    title: tag(xml, "Title"),
    price: tag(xml, "CurrentPrice"),
    payment: tag(profiles, "PaymentProfileID"),
    returns: tag(profiles, "ReturnProfileID"),
    shipping: tag(profiles, "ShippingProfileID"),
  };
}

const before = await readItem();
if (before.error) throw new Error(before.error);
if (before.shipping === TO) {
  console.log(JSON.stringify({ already: true, ...before }));
  process.exit(0);
}
const backup = JSON.parse(readFileSync(backupPath, "utf8"));
backup.listingMoves = backup.listingMoves || [];
if (!backup.listingMoves.some((row) => row.listingId === ITEM)) {
  backup.listingMoves.push({ listingId: ITEM, sku: "99795", fromPolicyId: before.shipping, toPolicyId: TO, price: before.price, title: before.title, payment: before.payment, returns: before.returns, applied: false });
}
writeFileSync(backupPath, JSON.stringify(backup, null, 2));

let via = "trading";
try {
  await reviseFixedPricePriceAndShipping(token, {
    itemId: ITEM,
    fulfillmentPolicyId: TO,
    paymentPolicyId: before.payment,
    returnPolicyId: before.returns,
  }, account);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (!/inventory-based/i.test(message)) throw err;
  via = "inventory";
  const offers = await ebayFetchAccount(account, "GET", `/sell/inventory/v1/offer?sku=${encodeURIComponent("99795")}`);
  const offer = (offers.offers || []).find((row) => String(row.offerId || row.listing?.listingId || "") && (row.listing?.listingId === ITEM || row.sku === "99795"));
  if (!offer?.offerId) throw new Error(`no offer for 99795: ${message}`);
  const current = await ebayFetchAccount(account, "GET", `/sell/inventory/v1/offer/${offer.offerId}`);
  const body = {
    ...current,
    listingPolicies: { ...(current.listingPolicies || {}), fulfillmentPolicyId: TO },
  };
  delete body.offerId;
  await ebayFetchAccount(account, "PUT", `/sell/inventory/v1/offer/${offer.offerId}`, body);
  backup.listingMoves.find((row) => row.listingId === ITEM).offerId = offer.offerId;
}

const after = await readItem();
const move = backup.listingMoves.find((row) => row.listingId === ITEM);
move.via = via;
move.applied = after.shipping === TO && after.price === before.price && after.title === before.title;
move.after = after;
if (!move.applied) {
  writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  throw new Error(`move failed ${JSON.stringify(after)} expected from ${FROM}`);
}
writeFileSync(backupPath, JSON.stringify(backup, null, 2));
console.log(JSON.stringify({ via, before, after }, null, 2));
