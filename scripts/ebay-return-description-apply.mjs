/**
 * Replace the no-returns footer on active eBay listings.
 * Sends listingDescription only. Price and business policies are left off the request
 * because a sale blocks price revisions, and omitting them leaves price and shipping in place.
 */
import fs from "node:fs";
import path from "node:path";

for (const key of Object.keys(process.env)) {
  if (/^EBAY_/.test(key)) delete process.env[key];
}
const rows = JSON.parse(fs.readFileSync(path.join(process.env.TEMP, "netlify-env-inventoryobi.json"), "utf8"));
for (const row of rows) {
  if (!row?.key) continue;
  const values = Array.isArray(row.values) ? row.values : [];
  const picked = values.find((v) => v?.context === "production") || values[0];
  if (picked?.value != null && picked.value !== "") process.env[row.key] = String(picked.value);
}

const { listEbayAccounts, loadEbayAccount, userTokenForAccount } = await import("../netlify/lib/ebay-accounts.mjs");
const { ebayHosts, marketplaceIdFromEnv } = await import("../netlify/lib/ebay-env.mjs");
const { descriptionWithReturns, reviseReturnPolicyXml } = await import("../netlify/lib/ebay-listing-standards.mjs");

const STORE = "5487ca47-6147-4fe8-bc6d-46b6472726ba";
const OUT = path.join(process.env.TEMP || ".", "ebay-return-description-apply.json");
const progress = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : { accounts: {} };

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}
function xmlTag(xml, tag) {
  const m = String(xml).match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? m[1].trim() : "";
}
function xmlBlocks(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  let m;
  while ((m = re.exec(String(xml)))) out.push(m[1]);
  return out;
}

async function tradingCall(token, callName, innerXml) {
  const { api } = ebayHosts(process.env.EBAY_ENV);
  const body = `<?xml version="1.0" encoding="utf-8"?>
<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">
  <ErrorLanguage>en_US</ErrorLanguage><WarningLevel>High</WarningLevel>
  ${innerXml}
</${callName}Request>`;
  let last = "";
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(`${api}/ws/api.dll`, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml",
        "X-EBAY-API-COMPATIBILITY-LEVEL": "1315",
        "X-EBAY-API-CALL-NAME": callName,
        "X-EBAY-API-SITEID": "0",
        "X-EBAY-API-IAF-TOKEN": token,
      },
      body,
    });
    const xml = await res.text();
    const ack = xmlTag(xml, "Ack");
    if (/success|warning/i.test(ack)) return xml;
    last = xmlTag(xml, "LongMessage") || xmlTag(xml, "ShortMessage") || xml.slice(0, 240);
    if (!/limit|rate|temporarily|10007|16110/i.test(last) || attempt === 5) throw new Error(`${callName}: ${last}`);
    await sleep(1500 * attempt);
  }
  throw new Error(`${callName}: ${last}`);
}

async function activeListings(token) {
  const items = [];
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages && page <= 40) {
    const xml = await tradingCall(token, "GetMyeBaySelling", `<ActiveList>
      <Include>true</Include>
      <Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination>
    </ActiveList>`);
    const active = xmlBlocks(xml, "ActiveList")[0] || xml;
    for (const block of xmlBlocks(active, "Item")) {
      const itemId = xmlTag(block, "ItemID");
      const selling = xmlBlocks(block, "SellingStatus")[0] || "";
      if (!itemId) continue;
      items.push({
        itemId,
        sku: xmlTag(block, "SKU"),
        price: xmlTag(selling, "CurrentPrice"),
        listingType: xmlTag(block, "ListingType"),
      });
    }
    const pagination = xmlBlocks(active, "PaginationResult")[0] || "";
    const pages = Number(xmlTag(pagination, "TotalNumberOfPages") || 0);
    const total = Number(xmlTag(pagination, "TotalNumberOfEntries") || 0);
    totalPages = pages || (total ? Math.ceil(total / 200) : page);
    page += 1;
    await sleep(200);
  }
  return [...new Map(items.map((row) => [row.itemId, row])).values()];
}

async function currentPrice(token, itemId) {
  const xml = await tradingCall(token, "GetItem", `<ItemID>${itemId}</ItemID>
    <OutputSelector>Item.SellingStatus.CurrentPrice</OutputSelector>
    <OutputSelector>Item.SellerProfiles.SellerShippingProfile.ShippingProfileID</OutputSelector>
    <OutputSelector>Item.SellerProfiles.SellerReturnProfile.ReturnProfileID</OutputSelector>`);
  return {
    price: xmlTag(xml, "CurrentPrice"),
    shippingId: xmlTag(xml, "ShippingProfileID"),
    returnId: xmlTag(xml, "ReturnProfileID"),
  };
}

async function inventoryFetch(account, method, path, body) {
  const token = await userTokenForAccount(account);
  const { api } = ebayHosts(process.env.EBAY_ENV);
  const res = await fetch(`${api}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "Content-Language": "en-US",
      "Accept-Language": "en-US",
      "X-EBAY-C-MARKETPLACE-ID": market,
    },
    body: body == null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) {
    const err = new Error(json?.errors?.[0]?.message || text.slice(0, 200));
    err.status = res.status;
    throw err;
  }
  return json;
}

async function updateOffer(account, offer) {
  const current = String(offer.listingDescription || "");
  const next = descriptionWithReturns(current);
  if (next === current) return "unchanged";
  const body = structuredClone(offer);
  delete body.offerId;
  delete body.listing;
  delete body.status;
  delete body.listingPolicies;
  delete body.pricingSummary;
  body.listingDescription = next;
  await inventoryFetch(account, "PUT", `/sell/inventory/v1/offer/${offer.offerId}`, body);
  return "updated";
}

const accounts = [];
for (const row of (await listEbayAccounts(STORE)).filter((row) => row.status === "connected")) {
  accounts.push(await loadEbayAccount(STORE, { id: row.id }));
}
accounts.sort((a, b) => Number(b.role === "selling") - Number(a.role === "selling"));
const market = marketplaceIdFromEnv();
const summary = [];

for (const account of accounts) {
  let token;
  try {
    token = await withTimeout(userTokenForAccount(account), 30000, "token");
  } catch (err) {
    summary.push({ username: account.username, error: String(err.message || err).slice(0, 300) });
    console.log(JSON.stringify(summary.at(-1)));
    continue;
  }
  const listings = await activeListings(token);
  const done = new Set(progress.accounts[account.username]?.done || []);
  const failed = [];
  let updated = progress.accounts[account.username]?.updated || 0;
  let unchanged = progress.accounts[account.username]?.unchanged || 0;
  let sinceCheck = 0;
  for (const listing of listings) {
    if (done.has(listing.itemId)) continue;
    try {
      let result = "no-offer";
      let offers = [];
      if (listing.sku) {
        try {
          const found = await inventoryFetch(account, "GET", `/sell/inventory/v1/offer?sku=${encodeURIComponent(listing.sku)}&marketplace_id=${market}`);
          offers = (found?.offers || []).filter((row) => row.offerId && String(row.status || "PUBLISHED").toUpperCase() !== "UNPUBLISHED");
        } catch (err) {
          if (!/25713|not available|404/i.test(String(err.message || err))) throw err;
        }
        if (!offers.length) result = "no-offer";
        for (const summaryOffer of offers) {
          const offer = summaryOffer.listingDescription != null && summaryOffer.categoryId
            ? summaryOffer
            : await inventoryFetch(account, "GET", `/sell/inventory/v1/offer/${summaryOffer.offerId}`);
          result = await updateOffer(account, offer);
        }
      }
      if (result === "no-offer") {
        const xml = await tradingCall(token, "GetItem", `<ItemID>${listing.itemId}</ItemID><OutputSelector>Item.Description</OutputSelector>`);
        const raw = xmlTag(xml, "Description");
        const text = (raw.match(/<!\[CDATA\[([\s\S]*?)\]\]>/) || [null, raw])[1];
        const next = descriptionWithReturns(text);
        if (next === text) result = "unchanged";
        else {
          const call = /chinese|auction/i.test(listing.listingType) ? "ReviseItem" : "ReviseFixedPriceItem";
          await tradingCall(token, call, reviseReturnPolicyXml({ itemId: listing.itemId, description: next }));
          result = "updated";
        }
      }
      if (result === "updated") {
        updated += 1;
        sinceCheck += 1;
      } else unchanged += 1;
      if (result === "updated" && sinceCheck >= 100) {
        const check = await currentPrice(token, listing.itemId);
        if (listing.price && check.price && check.price !== listing.price) {
          throw new Error(`stopped: price moved on ${listing.itemId} from ${listing.price} to ${check.price}`);
        }
        sinceCheck = 0;
        console.log(JSON.stringify({ username: account.username, spot: listing.itemId, price: check.price, shippingId: check.shippingId, returnId: check.returnId }));
      }
      done.add(listing.itemId);
    } catch (err) {
      const message = String(err.message || err);
      if (/stopped: price moved/.test(message)) throw err;
      failed.push({ itemId: listing.itemId, sku: listing.sku, error: message.slice(0, 240) });
    }
    progress.accounts[account.username] = { active: listings.length, updated, unchanged, failed, done: [...done] };
    if ((done.size + failed.length) % 25 === 0) {
      fs.writeFileSync(OUT, JSON.stringify(progress));
      console.log(JSON.stringify({ username: account.username, seen: done.size, active: listings.length, updated, unchanged, failed: failed.length }));
    }
    await sleep(150);
  }
  fs.writeFileSync(OUT, JSON.stringify(progress));
  summary.push({ username: account.username, role: account.role, active: listings.length, updated, unchanged, failed: failed.length });
  console.log(JSON.stringify(summary.at(-1)));
}

console.log(JSON.stringify({ summary }, null, 2));
