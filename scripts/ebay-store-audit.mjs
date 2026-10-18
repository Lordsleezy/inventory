/**
 * Read-only snapshot of the ikonikdeals2026 eBay store and active listings.
 * Does not revise, end, reprice, or touch pgg124-5.
 */
import fs from "node:fs";
import path from "node:path";

const envPath = path.join(process.env.TEMP || "", "netlify-env-inventoryobi.json");
if (fs.existsSync(envPath)) {
  const rows = JSON.parse(fs.readFileSync(envPath, "utf8"));
  for (const row of rows) {
    if (!row?.key || process.env[row.key]) continue;
    const values = Array.isArray(row.values) ? row.values : [];
    const picked = values.find((v) => v?.context === "production") || values[0];
    if (picked?.value != null && picked.value !== "") process.env[row.key] = String(picked.value);
  }
}
await import("./load-env.mjs");
import { serviceClient } from "../netlify/lib/server.mjs";
import { resolveEbayAccount, userTokenForAccount, ebayFetchAccount } from "../netlify/lib/ebay-accounts.mjs";
import { ebayHosts } from "../netlify/lib/ebay-env.mjs";

const SELLING_USER = "ikonikdeals2026";
const OUT = path.join(process.env.TEMP || ".", "ebay-storefront");
fs.mkdirSync(OUT, { recursive: true });

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
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  ${innerXml}
</${callName}Request>`;
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
  if (!/success|warning/i.test(ack)) {
    const msg = xmlTag(xml, "LongMessage") || xmlTag(xml, "ShortMessage") || xml.slice(0, 500);
    const err = new Error(`${callName}: ${msg}`);
    err.body = xml;
    throw err;
  }
  return xml;
}

function parseCustomCategories(xml) {
  const sliceMatch = String(xml).match(/<CustomCategories\b[^>]*>([\s\S]*)<\/CustomCategories>/i);
  const slice = sliceMatch ? sliceMatch[1] : "";
  const roots = [];
  const stack = [{ children: roots }];
  const re = /<(\/?)CustomCategory\b[^>]*>|<Name>([\s\S]*?)<\/Name>|<CategoryID>([\s\S]*?)<\/CategoryID>|<Order>([\s\S]*?)<\/Order>/gi;
  let current = null;
  let m;
  while ((m = re.exec(slice))) {
    if (m[1] === "/") {
      stack.pop();
      current = stack.length > 1 ? stack[stack.length - 1].node : null;
      continue;
    }
    if (m[0].startsWith("<CustomCategory")) {
      const node = { name: "", id: "", order: "", children: [] };
      stack[stack.length - 1].children.push(node);
      stack.push({ node, children: node.children });
      current = node;
      continue;
    }
    if (!current) continue;
    if (m[2] != null && !current.name) current.name = m[2].trim();
    else if (m[3] != null && !current.id) current.id = m[3].trim();
    else if (m[4] != null && !current.order) current.order = m[4].trim();
  }
  const flat = [];
  function walk(nodes, depth, parent) {
    for (const node of nodes) {
      flat.push({ id: node.id, name: node.name, order: node.order, depth, parent, childCount: node.children.length });
      walk(node.children, depth + 1, node.name);
    }
  }
  walk(roots, 0, "");
  return { roots, flat };
}

function parseItems(xml) {
  return xmlBlocks(xml, "Item").map((block) => {
    const selling = xmlBlocks(block, "SellingStatus")[0] || "";
    const listing = xmlBlocks(block, "ListingDetails")[0] || "";
    const picture = xmlBlocks(block, "PictureDetails")[0] || "";
    const primary = xmlBlocks(block, "PrimaryCategory")[0] || "";
    const storefront = xmlBlocks(block, "Storefront")[0] || "";
    const shipping = xmlBlocks(block, "ShippingDetails")[0] || "";
    const returns = xmlBlocks(block, "ReturnPolicy")[0] || "";
    const profiles = xmlBlocks(block, "SellerProfiles")[0] || "";
    const pics = xmlBlocks(picture, "PictureURL");
    return {
      itemId: xmlTag(block, "ItemID"),
      title: xmlTag(block, "Title"),
      sku: xmlTag(block, "SKU"),
      price: xmlTag(selling, "CurrentPrice") || xmlTag(block, "StartPrice") || xmlTag(block, "BuyItNowPrice"),
      quantity: xmlTag(block, "Quantity"),
      quantitySold: xmlTag(selling, "QuantitySold"),
      startTime: xmlTag(listing, "StartTime"),
      viewUrl: xmlTag(listing, "ViewItemURL"),
      categoryId: xmlTag(primary, "CategoryID"),
      categoryName: xmlTag(primary, "CategoryName"),
      conditionId: xmlTag(block, "ConditionID"),
      condition: xmlTag(block, "ConditionDisplayName"),
      pictureCount: pics.length,
      gallery: xmlTag(picture, "GalleryURL"),
      storeCategoryId: xmlTag(storefront, "StoreCategoryID"),
      storeCategory2Id: xmlTag(storefront, "StoreCategory2ID"),
      storeCategoryName: xmlTag(storefront, "StoreCategoryName"),
      storeCategory2Name: xmlTag(storefront, "StoreCategory2Name"),
      shippingType: xmlTag(shipping, "ShippingType"),
      returnsAccepted: xmlTag(returns, "ReturnsAccepted"),
      returnOption: xmlTag(returns, "ReturnsAcceptedOption"),
      paymentProfile: xmlTag(profiles, "PaymentProfileName"),
      returnProfile: xmlTag(profiles, "ReturnProfileName"),
      shippingProfile: xmlTag(profiles, "ShippingProfileName"),
      pickup: /PickupInStore|LocalPickup|ClickAndCollect/i.test(block),
    };
  }).filter((row) => row.itemId);
}

async function activeListings(token) {
  const items = [];
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages && page <= 40) {
    const xml = await tradingCall(
      token,
      "GetMyeBaySelling",
      `<ActiveList>
  <Include>true</Include>
  <Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination>
</ActiveList>`,
    );
    const active = xmlBlocks(xml, "ActiveList")[0] || xml;
    if (page === 1) fs.writeFileSync(path.join(OUT, "active-page1.xml"), active.slice(0, 80000));
    items.push(...parseItems(active));
    const pagination = xmlBlocks(active, "PaginationResult")[0] || "";
    const pages = Number(xmlTag(pagination, "TotalNumberOfPages") || 0);
    const total = Number(xmlTag(pagination, "TotalNumberOfEntries") || 0);
    if (pages > 0) totalPages = pages;
    else if (total > 0) totalPages = Math.ceil(total / 200);
    else break;
    console.log(`active page ${page}/${totalPages} items=${items.length} totalEntries=${total}`);
    page += 1;
  }
  const byId = new Map();
  for (const row of items) byId.set(row.itemId, row);
  return [...byId.values()];
}

const sb = serviceClient();
const { data: accountRow, error: accountError } = await sb
  .from("ebay_accounts")
  .select("store_id,username,role,status")
  .ilike("username", SELLING_USER)
  .eq("role", "selling")
  .maybeSingle();
if (accountError) throw new Error(accountError.message);
if (!accountRow?.store_id) throw new Error(`No connected selling account named ${SELLING_USER}`);
const storeId = accountRow.store_id;

const account = await resolveEbayAccount(storeId, { role: "selling" });
const username = String(account.username || "").toLowerCase();
if (username !== SELLING_USER) {
  throw new Error(`Refusing to continue: selling account is ${username || "unknown"}, expected ${SELLING_USER}`);
}
console.log(`account=${username} role=${account.role} status=${account.status}`);

const token = await userTokenForAccount(account);
const storeXml = await tradingCall(token, "GetStore", `<CategoryStructureOnly>false</CategoryStructureOnly><LevelLimit>3</LevelLimit>`);
fs.writeFileSync(path.join(OUT, "get-store.xml"), storeXml);
const { flat: tree } = parseCustomCategories(storeXml);

const items = await activeListings(token);
console.log(`active listings ${items.length}`);

let policies = {};
try {
  const [payment, returns, fulfillment] = await Promise.all([
    ebayFetchAccount(account, "GET", "/sell/account/v1/payment_policy?marketplace_id=EBAY_US"),
    ebayFetchAccount(account, "GET", "/sell/account/v1/return_policy?marketplace_id=EBAY_US"),
    ebayFetchAccount(account, "GET", "/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_US"),
  ]);
  const slim = (row) => ({
    name: row.name,
    id: row.paymentPolicyId || row.returnPolicyId || row.fulfillmentPolicyId,
    returnsAccepted: row.returnsAccepted,
    returnPeriod: row.returnPeriod,
    handlingTime: row.handlingTime,
    localPickup: row.localPickup,
    freightShipping: row.freightShipping,
    shippingOptions: (row.shippingOptions || []).map((opt) => ({
      optionType: opt.optionType,
      costType: opt.costType,
      services: (opt.shippingServices || []).map((s) => s.shippingServiceCode || s.shippingCarrierCode),
    })),
  });
  policies = {
    payment: (payment.paymentPolicies || []).map(slim),
    returns: (returns.returnPolicies || []).map(slim),
    fulfillment: (fulfillment.fulfillmentPolicies || []).map(slim),
  };
} catch (err) {
  policies = { error: err instanceof Error ? err.message : String(err) };
}

const skus = [...new Set(items.map((row) => row.sku).filter(Boolean))];
const units = [];
for (let i = 0; i < skus.length; i += 80) {
  const slice = skus.slice(i, i + 80);
  const { data, error } = await sb
    .from("units")
    .select("sku,title,brand,category,condition,ask_cents,msrp_cents,acquisition_cost_cents,floor_cents,defect_notes,location,retail_price_sources,retail_source_name")
    .eq("store_id", storeId)
    .in("sku", slice);
  if (error) throw new Error(error.message);
  units.push(...(data || []));
}

const settings = {};
{
  const { data, error } = await sb.from("store_settings").select("key,value").eq("store_id", storeId);
  if (error) throw new Error(error.message);
  for (const row of data || []) {
    if (/ebay|fee|ship/i.test(row.key)) settings[row.key] = row.value;
  }
}

const summary = {
  username,
  storeName: xmlTag(storeXml, "Name"),
  storeUrl: xmlTag(storeXml, "URL"),
  storeDescription: xmlTag(storeXml, "Description").slice(0, 2000),
  subscription: xmlTag(storeXml, "SubscriptionLevel") || xmlTag(xmlBlocks(storeXml, "Subscription")[0] || "", "Level"),
  logoUrl: xmlTag(xmlBlocks(storeXml, "Logo")[0] || "", "URL"),
  categories: tree,
  categoryCount: tree.length,
  activeCount: items.length,
  policies,
  settings,
  floorMatched: units.length,
};

fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(OUT, "listings.json"), JSON.stringify(items, null, 2));
fs.writeFileSync(path.join(OUT, "units.json"), JSON.stringify(units, null, 2));

const byCat = new Map();
for (const row of items) {
  const key = row.categoryName || "(none)";
  byCat.set(key, (byCat.get(key) || 0) + 1);
}
const ranked = [...byCat.entries()].sort((a, b) => b[1] - a[1]);
console.log("--- ebay categories ---");
for (const [name, count] of ranked) console.log(`${count}\t${name}`);
console.log("--- store ---");
console.log(JSON.stringify({
  storeName: summary.storeName,
  storeUrl: summary.storeUrl,
  subscription: summary.subscription,
  categoryCount: summary.categoryCount,
  categories: tree.map((c) => `${"  ".repeat(c.depth)}${c.name} (${c.id})`),
  activeCount: items.length,
  floorMatched: units.length,
}, null, 2));
console.log("wrote", OUT);
