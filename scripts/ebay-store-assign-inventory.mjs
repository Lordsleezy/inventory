/**
 * Assign store categories on Inventory-API listings that ReviseFixedPriceItem cannot touch.
 * Copies the live offer and changes only storeCategoryNames. Refuses the call if the
 * offer price does not match the price we already recorded. Never touches pgg124-5.
 */
import fs from "node:fs";
import path from "node:path";

const envPath = path.join(process.env.TEMP || "", "netlify-env-inventoryobi.json");
const rows = JSON.parse(fs.readFileSync(envPath, "utf8"));
for (const row of rows) {
  if (!row?.key || process.env[row.key]) continue;
  const values = Array.isArray(row.values) ? row.values : [];
  const picked = values.find((v) => v?.context === "production") || values[0];
  if (picked?.value) process.env[row.key] = String(picked.value);
}

const { serviceClient } = await import("../netlify/lib/server.mjs");
const { resolveEbayAccount, ebayFetchAccount, userTokenForAccount } = await import("../netlify/lib/ebay-accounts.mjs");
const { getMyEbaySellingActive } = await import("../netlify/lib/ebay-trading.mjs");
const { classifyEbayStoreCategory, storeCategoryNames } = await import("../netlify/lib/ebay-store-categories.mjs");
const APPLY = process.argv.includes("--apply");
const OUT = path.join(process.env.TEMP || ".", "ebay-storefront");
const result = JSON.parse(fs.readFileSync(path.join(OUT, "result.json"), "utf8"));
const failures = result.failures || [];

const sb = serviceClient();
const { data } = await sb.from("ebay_accounts").select("store_id").ilike("username", "ikonikdeals2026").eq("role", "selling").maybeSingle();
const account = await resolveEbayAccount(data.store_id, { role: "selling" });
if (String(account.username || "").toLowerCase() !== "ikonikdeals2026") throw new Error("wrong account");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function cents(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

const KEEP = [
  "sku",
  "marketplaceId",
  "format",
  "availableQuantity",
  "categoryId",
  "listingDescription",
  "listingPolicies",
  "pricingSummary",
  "merchantLocationKey",
  "listingDuration",
  "tax",
  "storeCategoryNames",
  "quantityLimitPerBuyer",
  "lotSize",
  "includeCatalogProductDetails",
  "hideBuyerDetails",
];

const token = await userTokenForAccount(account);
const beforeActive = await getMyEbaySellingActive(token);
const livePrice = new Map(beforeActive.map((row) => [row.sku, row.currentPrice]));

let ok = 0;
let skipped = 0;
const problems = [];
for (const row of failures) {
  let offers;
  try {
    const json = await ebayFetchAccount(account, "GET", `/sell/inventory/v1/offer?sku=${encodeURIComponent(row.sku)}&marketplace_id=EBAY_US&limit=20`);
    offers = json?.offers || [];
  } catch (err) {
    problems.push({ sku: row.sku, error: err instanceof Error ? err.message : String(err) });
    continue;
  }
  let offer = offers.find((item) => String(item.status || "").toUpperCase() === "PUBLISHED") || offers[0];
  if (!offer?.offerId) {
    problems.push({ sku: row.sku, error: "no offer" });
    continue;
  }
  if (!offer.pricingSummary?.price?.value) {
    try {
      const full = await ebayFetchAccount(account, "GET", `/sell/inventory/v1/offer/${offer.offerId}`);
      if (full?.pricingSummary?.price?.value) offer = { ...offer, ...full };
    } catch {
      /* list payload is enough when the single-offer read is empty */
    }
  }
  if (!offer.listingPolicies?.paymentPolicyId || offer.availableQuantity == null || !offer.pricingSummary?.price?.value) {
    try {
      const full = await ebayFetchAccount(account, "GET", `/sell/inventory/v1/offer/${offer.offerId}`);
      if (full && !full.errors) offer = { ...offer, ...full };
    } catch {
      /* keep the list payload */
    }
  }
  const policies = offer.listingPolicies || {};
  if (!policies.paymentPolicyId || !policies.returnPolicyId || !policies.fulfillmentPolicyId) {
    problems.push({ sku: row.sku, error: "offer payload is missing a business policy; skipped" });
    continue;
  }
  if (offer.availableQuantity == null) {
    problems.push({ sku: row.sku, error: "offer payload has no quantity; skipped" });
    continue;
  }
  const price = offer.pricingSummary?.price?.value;
  const classified = classifyEbayStoreCategory({
    title: row.title,
    priceCents: cents(price || livePrice.get(row.sku)),
  });
  const categoryNames = storeCategoryNames(classified);
  if (!categoryNames.length) {
    problems.push({ sku: row.sku, error: "unclassified" });
    continue;
  }
  const already = Array.isArray(offer.storeCategoryNames) ? offer.storeCategoryNames : [];
  if (already.length === categoryNames.length && categoryNames.every((name, index) => already[index] === name)) {
    skipped += 1;
    continue;
  }
  if (!APPLY) {
    ok += 1;
    continue;
  }
  const before = price == null || price === "" ? null : String(price);
  const body = {};
  for (const key of KEEP) if (offer[key] !== undefined) body[key] = offer[key];
  if (!before) delete body.pricingSummary;
  body.storeCategoryNames = categoryNames;
  if (before && String(body.pricingSummary?.price?.value) !== before) {
    problems.push({ sku: row.sku, error: "refused: price field changed before send" });
    continue;
  }
  try {
    await ebayFetchAccount(account, "PUT", `/sell/inventory/v1/offer/${offer.offerId}`, body);
    const check = await ebayFetchAccount(account, "GET", `/sell/inventory/v1/offer/${offer.offerId}`);
    const after = check?.pricingSummary?.price?.value;
    if (before && after != null && String(after) !== before) {
      problems.push({ sku: row.sku, error: `PRICE CHANGED ${before} -> ${after}` });
      break;
    }
    ok += 1;
    if (ok % 10 === 0) console.log(`inventory assigned ${ok}`);
  } catch (err) {
    problems.push({ sku: row.sku, title: row.title, error: err instanceof Error ? err.message : String(err) });
  }
  await sleep(250);
}
let priceChanges = [];
if (APPLY) {
  const afterActive = await getMyEbaySellingActive(token);
  const afterPrice = new Map(afterActive.map((row) => [row.sku, row.currentPrice]));
  for (const [sku, before] of livePrice) {
    const after = afterPrice.get(sku);
    if (after != null && Number(after) !== Number(before)) priceChanges.push({ sku, before, after });
  }
}
console.log(JSON.stringify({ mode: APPLY ? "apply" : "dry", ok, skipped, problems: problems.length, priceChanges, sampleProblems: problems.slice(0, 8) }, null, 2));
fs.writeFileSync(path.join(OUT, "inventory-assign.json"), JSON.stringify({ ok, skipped, problems }, null, 2));
