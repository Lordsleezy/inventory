/**
 * Build the ikonikdeals2026 eBay store categories and profile.
 * Does not change price, title, photos, quantity, condition, or shipping.
 * Refuses any account other than ikonikdeals2026. Never calls EndItem.
 *
 *   node scripts/ebay-store-apply.mjs           # plan only
 *   node scripts/ebay-store-apply.mjs --apply   # write categories, profile, assignments
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

const { serviceClient } = await import("../netlify/lib/server.mjs");
const { resolveEbayAccount, userTokenForAccount } = await import("../netlify/lib/ebay-accounts.mjs");
const { ebayHosts } = await import("../netlify/lib/ebay-env.mjs");
const {
  getItemStorefront,
  getStoreCategoryMap,
  reviseItemStoreCategories,
  setEbayStoreCustomPage,
  setEbayStoreProfile,
  setStoreCategories,
  uploadEbayPicture,
} = await import("../netlify/lib/ebay-trading.mjs");
const {
  STORE_CATEGORY_ORDER,
  UNDER_25,
  classifyEbayStoreCategory,
} = await import("../netlify/lib/ebay-store-categories.mjs");

const SELLING_USER = "ikonikdeals2026";
const APPLY = process.argv.includes("--apply");
const OUT = path.join(process.env.TEMP || ".", "ebay-storefront");
const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), "ebay-store-assets");
fs.mkdirSync(OUT, { recursive: true });

const STORE_NAME = "Open Box Industries";
const ABOUT = fs.readFileSync(path.join(ASSETS, "about.txt"), "utf8").trim();

function xmlTag(xml, tag) {
  const match = String(xml).match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? match[1].trim() : "";
}
function xmlBlocks(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  let match;
  while ((match = re.exec(String(xml)))) out.push(match[1]);
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
    const err = new Error(xmlTag(xml, "LongMessage") || xmlTag(xml, "ShortMessage") || `${callName} failed`);
    err.callName = callName;
    throw err;
  }
  return xml;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function cents(price) {
  const n = Number(price);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}
function money(centsValue) {
  return (Number(centsValue) / 100).toFixed(2);
}

async function activeListings(token) {
  const items = [];
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages && page <= 40) {
    const xml = await tradingCall(
      token,
      "GetMyeBaySelling",
      `<ActiveList><Include>true</Include><Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination></ActiveList>`,
    );
    const active = xmlBlocks(xml, "ActiveList")[0] || xml;
    for (const block of xmlBlocks(active, "Item")) {
      const selling = xmlBlocks(block, "SellingStatus")[0] || "";
      const promo = xmlBlocks(selling, "PromotionalSaleDetails")[0] || "";
      items.push({
        itemId: xmlTag(block, "ItemID"),
        title: xmlTag(block, "Title"),
        sku: xmlTag(block, "SKU"),
        price: xmlTag(selling, "CurrentPrice") || xmlTag(block, "BuyItNowPrice"),
        originalPrice: xmlTag(promo, "OriginalPrice"),
        shippingProfile: xmlTag(block, "ShippingProfileName"),
      });
    }
    const pagination = xmlBlocks(active, "PaginationResult")[0] || "";
    const pages = Number(xmlTag(pagination, "TotalNumberOfPages") || 0);
    if (pages > 0) totalPages = pages;
    else break;
    page += 1;
  }
  const byId = new Map();
  for (const row of items) if (row.itemId) byId.set(row.itemId, row);
  return [...byId.values()];
}

function proposalsFor(rows) {
  const fee = 0.13;
  const groups = new Map();
  for (const row of rows) {
    if (!(row.costCents > 0) || row.costCents === 900) continue;
    const minCents = Math.ceil((row.costCents + 500) / (1 - fee));
    const room = row.priceCents - minCents;
    if (room < Math.round(row.priceCents * 0.1)) continue;
    const list = groups.get(row.primary) || [];
    list.push({ ...row, minCents, maxOffPct: room / row.priceCents });
    groups.set(row.primary, list);
  }
  const ideas = [];
  for (const [category, list] of groups) {
    const supported = [10, 15].filter((pct) => list.every((row) => row.priceCents * (1 - pct / 100) >= row.minCents - 1));
    if (!supported.length) continue;
    const pct = supported[supported.length - 1];
    ideas.push({
      category,
      discountPct: pct,
      items: list.length,
      note: "Buyer pays calculated shipping, so seller shipping in the floor is $0. eBay fee used is 13%. Floor is cost + fee on the discounted price + $5.",
      examples: list.slice(0, 3).map((row) => ({
        sku: row.sku,
        title: row.title,
        price: money(row.priceCents),
        cost: money(row.costCents),
        floor: money(row.minCents),
        discounted: money(Math.round(row.priceCents * (1 - pct / 100))),
      })),
    });
  }
  return ideas;
}

const sb = serviceClient();
const { data: accountRow, error: accountError } = await sb
  .from("ebay_accounts")
  .select("store_id,username,role,status")
  .ilike("username", SELLING_USER)
  .eq("role", "selling")
  .maybeSingle();
if (accountError) throw new Error(accountError.message);
if (!accountRow?.store_id) throw new Error(`No selling account named ${SELLING_USER}`);
const account = await resolveEbayAccount(accountRow.store_id, { role: "selling" });
if (String(account.username || "").toLowerCase() !== SELLING_USER) {
  throw new Error(`Refusing to continue on ${account.username || "unknown"}`);
}
const token = await userTokenForAccount(account);
const items = await activeListings(token);
console.log(`active ${items.length} on ${SELLING_USER} apply=${APPLY}`);

const skus = [...new Set(items.map((row) => row.sku).filter(Boolean))];
const units = [];
for (let i = 0; i < skus.length; i += 80) {
  const { data, error } = await sb
    .from("units")
    .select("sku,category,msrp_cents,acquisition_cost_cents")
    .eq("store_id", accountRow.store_id)
    .in("sku", skus.slice(i, i + 80));
  if (error) throw new Error(error.message);
  units.push(...(data || []));
}
const bySku = new Map(units.map((row) => [row.sku, row]));

const plans = items.map((item) => {
  const unit = bySku.get(item.sku) || {};
  const priceCents = cents(item.price);
  const classified = classifyEbayStoreCategory({
    title: item.title,
    category: unit.category,
    priceCents,
  });
  return {
    ...item,
    priceCents,
    msrpCents: Number(unit.msrp_cents) || 0,
    costCents: Number(unit.acquisition_cost_cents) || 0,
    primary: classified.primary,
    secondary: classified.secondary,
    pickupOnly: /local pickup/i.test(item.shippingProfile || ""),
  };
});
const missed = plans.filter((row) => !row.primary);
if (missed.length) {
  console.log(missed.map((row) => `${row.sku} ${row.title}`).join("\n"));
  throw new Error(`${missed.length} listings have no store category. Nothing was written.`);
}

const profileCounts = new Map();
for (const row of plans) profileCounts.set(row.shippingProfile || "(none)", (profileCounts.get(row.shippingProfile || "(none)") || 0) + 1);
console.log("--- shipping profiles (not modified) ---");
for (const [name, count] of profileCounts) console.log(`${String(count).padStart(4)}  ${name}`);

const counts = new Map();
let under = 0;
for (const row of plans) {
  counts.set(row.primary, (counts.get(row.primary) || 0) + 1);
  if (row.secondary === UNDER_25) under += 1;
}
const categoryNames = STORE_CATEGORY_ORDER.filter((name) => name === UNDER_25 ? under > 0 : counts.get(name) > 0);
console.log("--- tree ---");
for (const name of categoryNames) {
  const n = name === UNDER_25 ? under : counts.get(name);
  console.log(`${String(n).padStart(4)}  ${name}${name === UNDER_25 ? " (second category)" : ""}`);
}

const comparable = plans.filter((row) => row.msrpCents > row.priceCents);
const offs = comparable.map((row) => (row.msrpCents - row.priceCents) / row.msrpCents).sort((a, b) => a - b);
const cost900 = plans.filter((row) => row.costCents === 900).length;
const costOther = plans.filter((row) => row.costCents > 0 && row.costCents !== 900).length;
const promoCount = plans.filter((row) => row.originalPrice).length;
const featured = [];
const perCategory = new Map();
for (const row of [...comparable].sort((a, b) => (b.msrpCents - b.priceCents) / b.msrpCents - (a.msrpCents - a.priceCents) / a.msrpCents)) {
  const used = perCategory.get(row.primary) || 0;
  if (used >= 2) continue;
  featured.push({
    sku: row.sku,
    itemId: row.itemId,
    title: row.title,
    price: money(row.priceCents),
    msrp: money(row.msrpCents),
    offPct: Math.round(((row.msrpCents - row.priceCents) / row.msrpCents) * 100),
    category: row.primary,
  });
  perCategory.set(row.primary, used + 1);
  if (featured.length === 8) break;
}
const verifiedCosts = plans.filter((row) => row.costCents > 0 && row.costCents !== 900);
console.log("--- costs other than the $9 placeholder ---");
for (const row of verifiedCosts) {
  console.log(`${row.sku} cost ${money(row.costCents)} price ${money(row.priceCents)} ${row.title}`);
}
const ideas = proposalsFor(plans);
const summary = {
  storeName: STORE_NAME,
  active: plans.length,
  categories: categoryNames.map((name) => ({
    name,
    count: name === UNDER_25 ? under : counts.get(name) || 0,
    role: name === UNDER_25 ? "secondary" : "primary",
  })),
  pickupOnly: plans.filter((row) => row.pickupOnly).length,
  alreadyOnMarkdown: promoCount,
  retailCompared: comparable.length,
  discountOffRetail: offs.length
    ? {
      minPct: Math.round(offs[0] * 100),
      medianPct: Math.round(offs[Math.floor(offs.length / 2)] * 100),
      maxPct: Math.round(offs[offs.length - 1] * 100),
    }
    : null,
  costPlaceholder900: cost900,
  costOther,
  featured,
  promotionProposals: ideas,
};
fs.writeFileSync(path.join(OUT, "plan.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({
  retailCompared: summary.retailCompared,
  discountOffRetail: summary.discountOffRetail,
  costPlaceholder900: cost900,
  costOther,
  alreadyOnMarkdown: promoCount,
  proposals: ideas.length,
  featured: featured.length,
}, null, 2));

if (!APPLY) {
  console.log("dry run only. re-run with --apply to write.");
  process.exit(0);
}

const priceBefore = new Map(plans.map((row) => [row.itemId, row.priceCents]));
console.log("adding categories");
let map = await getStoreCategoryMap(token, { force: true });
const missing = categoryNames.filter((name) => !map.has(name));
if (missing.length) {
  await setStoreCategories(
    token,
    "Add",
    missing.map((name) => ({ name, order: categoryNames.indexOf(name) + 1 })),
  );
  map = await getStoreCategoryMap(token, { force: true });
}
for (const name of categoryNames) {
  if (!map.has(name)) throw new Error(`Store category was not created: ${name}`);
}
console.log([...map.entries()].map(([name, id]) => `${id} ${name}`).join("\n"));

let profile = { name: null, description: null, logo: null, aboutPage: null };
try {
  await setEbayStoreProfile(token, { name: STORE_NAME, description: ABOUT });
  profile.name = "set";
  profile.description = "set";
} catch (err) {
  profile.name = err instanceof Error ? err.message : String(err);
  try {
    await setEbayStoreProfile(token, { description: ABOUT });
    profile.description = "set";
  } catch (again) {
    profile.description = again instanceof Error ? again.message : String(again);
  }
}

const failures = [];
let assigned = 0;
for (const row of plans) {
  const primaryId = map.get(row.primary);
  const secondId = row.secondary ? map.get(row.secondary) || "0" : "0";
  let done = false;
  let lastError = "";
  for (let attempt = 1; attempt <= 3 && !done; attempt += 1) {
    try {
      await reviseItemStoreCategories(token, row.itemId, primaryId, secondId);
      assigned += 1;
      done = true;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < 3 && /limit|rate|busy|timeout|temporarily/i.test(lastError)) {
        await sleep(2000 * attempt);
        continue;
      }
      break;
    }
  }
  if (!done) failures.push({ sku: row.sku, itemId: row.itemId, title: row.title, error: lastError });
  if (assigned % 25 === 0) console.log(`assigned ${assigned}/${plans.length} failed ${failures.length}`);
  await sleep(200);
}
console.log(`assigned ${assigned} failed ${failures.length}`);

let other = "left";
try {
  await setStoreCategories(token, "Delete", [{ id: "1" }]);
  other = "deleted";
} catch (err) {
  other = err instanceof Error ? err.message : String(err);
  try {
    await setStoreCategories(token, "Move", [{ id: "1", order: 99 }]);
    other = `${other} | moved to end`;
  } catch {
    /* default Other category often cannot be removed */
  }
}

const logoPath = path.join(ASSETS, "logo-300.png");
if (fs.existsSync(logoPath)) {
  try {
    const url = await uploadEbayPicture(token, {
      filename: "open-box-logo.png",
      pictureName: "open-box-logo",
      bytes: fs.readFileSync(logoPath),
    });
    await setEbayStoreProfile(token, { logoUrl: url });
    profile.logo = url;
  } catch (err) {
    profile.logo = err instanceof Error ? err.message : String(err);
  }
}

if (featured.length) {
  const lines = featured
    .map((row) => `<p><a href="https://www.ebay.com/itm/${row.itemId}">${row.title.replace(/&/g, "and")}</a></p>`)
    .join("");
  const content = `<p>${ABOUT.replace(/\n+/g, "</p><p>")}</p><h3>Worth a look</h3>${lines}`;
  try {
    await setEbayStoreCustomPage(token, { name: "About", content, order: 1 });
    profile.aboutPage = "set";
  } catch (err) {
    profile.aboutPage = err instanceof Error ? err.message : String(err);
  }
}

const after = await activeListings(token);
const priceChanges = [];
for (const row of after) {
  const before = priceBefore.get(row.itemId);
  const now = cents(row.price);
  if (before != null && now !== before) priceChanges.push({ itemId: row.itemId, sku: row.sku, before: money(before), after: row.price });
}

const spotIds = [];
for (const name of categoryNames.filter((n) => n !== UNDER_25)) {
  const hit = plans.find((row) => row.primary === name);
  if (hit) spotIds.push(hit.itemId);
}
if (plans.find((row) => row.originalPrice)) spotIds.push(plans.find((row) => row.originalPrice).itemId);
const spots = [];
for (const itemId of [...new Set(spotIds)].slice(0, 12)) {
  try {
    const live = await getItemStorefront(token, itemId);
    const planned = plans.find((row) => row.itemId === itemId);
    spots.push({
      sku: planned?.sku,
      price: live.price,
      expectedPrice: planned ? money(planned.priceCents) : null,
      storeCategory: live.storeCategoryName || live.storeCategoryId,
      storeCategory2: live.storeCategory2Name || live.storeCategory2Id,
      expected: planned?.primary,
      expected2: planned?.secondary,
    });
  } catch (err) {
    spots.push({ itemId, error: err instanceof Error ? err.message : String(err) });
  }
  await sleep(150);
}

const storeXml = await tradingCall(token, "GetStore", "<CategoryStructureOnly>false</CategoryStructureOnly><LevelLimit>1</LevelLimit>");
const result = {
  ...summary,
  assigned,
  failures,
  otherCategory: other,
  profile,
  priceChanges,
  spots,
  liveStoreName: xmlTag(storeXml, "Name"),
  liveDescription: xmlTag(storeXml, "Description").slice(0, 400),
  liveLogo: xmlTag(storeXml, "URL"),
};
fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify({
  assigned,
  failed: failures.length,
  priceChanges: priceChanges.length,
  other,
  profile,
  liveStoreName: result.liveStoreName,
  liveDescription: result.liveDescription.slice(0, 180),
}, null, 2));
if (priceChanges.length) {
  console.log("PRICE CHANGED — review result.json. No automatic price restore was attempted.");
}
if (failures.length) console.log(failures.slice(0, 8));
