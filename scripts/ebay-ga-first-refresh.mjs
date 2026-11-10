/**
 * Business-policy edits do not reach live listings until each listing is revised.
 * Re-attach the same fulfillment policy so Ground Advantage becomes service 1.
 * Does not send price, title, handling, returns, or package fields.
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

const CHANGED = new Set([
  "267755796017", "267792814017", "268528923017", "268528930017", "268528931017",
  "268528943017", "268528944017", "268528947017", "268528948017", "268528949017",
  "268528951017", "268528971017", "268528973017",
]);
const backupPath = path.join("ops", "shipping-audit-2026-11-09", "ga-first-backup.json");
const map = JSON.parse(readFileSync("ops/shipping-audit-2026-11-09/ga-first-policies.json", "utf8"));
const floor = JSON.parse(readFileSync("ops/shipping-audit-2026-11-09/floor-listings.json", "utf8"));
const byListing = new Map(floor.map((row) => [String(row.listing_id), row]));
const backup = JSON.parse(readFileSync(backupPath, "utf8"));
backup.refreshed = backup.refreshed || [];
const done = new Set(backup.refreshed.map((row) => row.listingId));

const account = await loadEbayAccount("5487ca47-6147-4fe8-bc6d-46b6472726ba", { username: "ikonikdeals2026" });
if (String(account.username).toLowerCase() !== "ikonikdeals2026") throw new Error(account.username);
const token = await userTokenForAccount(account);
const { api } = ebayHosts("production");

function tag(xml, name) {
  const match = String(xml).match(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`));
  return match ? match[1].trim() : "";
}
async function profiles(listingId) {
  const res = await fetch(`${api}/ws/api.dll`, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml",
      "X-EBAY-API-COMPATIBILITY-LEVEL": "1315",
      "X-EBAY-API-CALL-NAME": "GetItem",
      "X-EBAY-API-SITEID": "0",
      "X-EBAY-API-IAF-TOKEN": token,
    },
    body: `<?xml version="1.0" encoding="utf-8"?><GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ItemID>${listingId}</ItemID><OutputSelector>Item.SellerProfiles</OutputSelector></GetItemRequest>`,
  });
  const xml = await res.text();
  const block = (xml.match(/<SellerProfiles>([\s\S]*?)<\/SellerProfiles>/) || [])[1] || "";
  return {
    payment: tag(block, "PaymentProfileID"),
    returns: tag(block, "ReturnProfileID"),
    shipping: tag(block, "ShippingProfileID"),
    error: /success|warning/i.test(tag(xml, "Ack")) ? "" : tag(xml, "LongMessage"),
  };
}

const queue = map.items.filter((item) => CHANGED.has(item.policyId) && !done.has(item.id) && item.id !== "820272097961");
let ok = 0;
let failed = 0;
backup.errors = backup.errors || [];

async function offerFor(item, offerId) {
  if (offerId) {
    try {
      const body = await ebayFetchAccount(account, "GET", `/sell/inventory/v1/offer/${offerId}`);
      body.offerId = body.offerId || offerId;
      return body;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/not available|25713/i.test(message)) throw err;
    }
  }
  const listed = await ebayFetchAccount(account, "GET", `/sell/inventory/v1/offer?sku=${encodeURIComponent(item.sku)}`);
  const match = (listed.offers || []).find((row) => String(row.listing?.listingId || "") === item.id) || (listed.offers || [])[0];
  if (!match?.offerId) return null;
  const body = await ebayFetchAccount(account, "GET", `/sell/inventory/v1/offer/${match.offerId}`);
  body.offerId = body.offerId || match.offerId;
  return body;
}

async function putOffer(item, current) {
  const policyId = current.listingPolicies?.fulfillmentPolicyId || item.policyId;
  const body = { ...current, listingPolicies: { ...(current.listingPolicies || {}), fulfillmentPolicyId: policyId } };
  delete body.offerId;
  await ebayFetchAccount(account, "PUT", `/sell/inventory/v1/offer/${current.offerId}`, body);
  return { listingId: item.id, sku: item.sku, via: "inventory", offerId: current.offerId, policyId, payment: current.listingPolicies?.paymentPolicyId || "", returns: current.listingPolicies?.returnPolicyId || "" };
}

async function refresh(item) {
  const floorRow = byListing.get(item.id);
  const current = await offerFor(item, floorRow?.offer_id || "");
  if (current?.offerId) return putOffer(item, current);
  const found = await profiles(item.id);
  if (found.error) throw new Error(found.error);
  try {
    await reviseFixedPricePriceAndShipping(token, {
      itemId: item.id,
      fulfillmentPolicyId: found.shipping || item.policyId,
      paymentPolicyId: found.payment,
      returnPolicyId: found.returns,
    }, account);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/inventory-based/i.test(message)) throw err;
    const retry = await offerFor(item, "");
    if (!retry?.offerId) throw err;
    return putOffer(item, retry);
  }
  return { listingId: item.id, sku: item.sku, via: "trading", offerId: "", policyId: found.shipping || item.policyId, payment: found.payment, returns: found.returns };
}

for (let i = 0; i < queue.length; i += 1) {
  const slice = queue.slice(i, i + 1);
  const results = await Promise.all(slice.map(async (item) => {
    try {
      return { ok: true, row: await refresh(item) };
    } catch (err) {
      return { ok: false, listingId: item.id, sku: item.sku, error: err instanceof Error ? err.message : String(err) };
    }
  }));
  for (const result of results) {
    if (result.ok) {
      backup.refreshed.push(result.row);
      ok += 1;
    } else {
      backup.errors.push({ listingId: result.listingId, sku: result.sku, error: result.error });
      failed += 1;
      console.log(JSON.stringify({ failed: result.listingId, sku: result.sku, error: result.error.slice(0, 240) }));
    }
  }
  if ((ok + failed) % 30 === 0 || i + 3 >= queue.length) {
    writeFileSync(backupPath, JSON.stringify(backup));
    console.log(JSON.stringify({ ok, failed, left: queue.length - ok - failed }));
  }
}
writeFileSync(backupPath, JSON.stringify(backup, null, 2));
console.log(JSON.stringify({ done: true, ok, failed }));
