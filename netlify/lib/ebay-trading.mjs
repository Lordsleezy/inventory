import { ebayHosts } from "./ebay-env.mjs";
import { classifyEbayStoreCategory, storeCategoryNames } from "./ebay-store-categories.mjs";

export function xmlEsc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function tradingConditionId(ebayEnum) {
  switch (String(ebayEnum || "")) {
    case "NEW":
      return "1000";
    case "LIKE_NEW":
      return "1500";
    case "USED_EXCELLENT":
    case "USED_VERY_GOOD":
    case "USED_GOOD":
      return "3000";
    case "USED_ACCEPTABLE":
      return "3000";
    case "FOR_PARTS_OR_NOT_WORKING":
      return "7000";
    default:
      return "3000";
  }
}

function xmlTag(xml, tag) {
  const m = String(xml).match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? m[1].trim() : "";
}

function xmlAll(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  let m;
  while ((m = re.exec(String(xml)))) out.push(m[1].trim());
  return out;
}

function xmlBlocks(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  let m;
  while ((m = re.exec(String(xml)))) out.push(m[1]);
  return out;
}

export function parseShippingServiceDetails(xml) {
  return xmlBlocks(xml, "ShippingServiceDetails").map((block) => {
    const serviceTypes = xmlAll(block, "ServiceType").map((t) => String(t).trim()).filter(Boolean);
    const international = /^true$/i.test(xmlTag(block, "InternationalService"));
    const valid = /^true$/i.test(xmlTag(block, "ValidForSellingFlow"));
    return {
      shippingService: xmlTag(block, "ShippingService"),
      description: xmlTag(block, "Description"),
      shippingCategory: xmlTag(block, "ShippingCategory"),
      shippingCarrier: xmlTag(block, "ShippingCarrier") || "",
      validForSellingFlow: valid,
      international,
      serviceTypes,
    };
  }).filter((row) => row.shippingService);
}

export function pickApplianceShipping(services) {
  const usable = (services || []).filter((row) => {
    if (!row?.validForSellingFlow || row.international) return false;
    const blob = `${row.shippingService} ${row.description} ${row.shippingCategory}`;
    if (/pickup/i.test(blob)) return false;
    return true;
  });
  const freight = usable.find((row) => /freight/i.test(`${row.shippingCategory} ${row.shippingService} ${row.description}`));
  const local = usable.find((row) => /local.?deliver|courier/i.test(`${row.shippingService} ${row.description}`));
  return freight || local || null;
}

export function compactShippingCatalog(services) {
  return (services || []).map((row) => ({
    code: row.shippingService,
    name: row.description,
    category: row.shippingCategory,
    valid: row.validForSellingFlow,
    international: row.international,
    types: row.serviceTypes,
  }));
}

export function parseTradingOrders(xml) {
  return xmlBlocks(xml, "Order").map((block) => {
    const checkout = xmlBlocks(block, "CheckoutStatus")[0] || "";
    const txn = xmlBlocks(block, "Transaction")[0] || "";
    const item = xmlBlocks(txn, "Item")[0] || xmlBlocks(block, "Item")[0] || "";
    return {
      orderId: xmlTag(block, "OrderID"),
      orderStatus: xmlTag(block, "OrderStatus"),
      cancelStatus: xmlTag(block, "CancelStatus"),
      amountPaid: xmlTag(block, "AmountPaid"),
      paidTime: xmlTag(block, "PaidTime"),
      checkoutStatus: xmlTag(checkout, "Status"),
      paymentMethod: xmlTag(checkout, "PaymentMethod"),
      sku: xmlTag(item, "SKU") || xmlTag(txn, "SKU") || xmlTag(block, "SKU"),
      itemId: xmlTag(item, "ItemID"),
      quantityPurchased: Number(xmlTag(txn, "QuantityPurchased") || xmlTag(block, "QuantityPurchased") || 0),
      transactionPrice: xmlTag(txn, "TransactionPrice"),
      total: xmlTag(block, "Total"),
    };
  });
}

export function tradingOrderIsSale(order, soldQtyBySku = {}) {
  if (!order?.orderId || !order.sku) return false;
  const cancel = String(order.cancelStatus || "").replace(/_/g, "").toLowerCase();
  // CancelClosedWithRefund / CancelClosedNoRefund / CancelPending / etc. are not live sales.
  if (/cancel/.test(cancel) && !/notapplicable|none/.test(cancel)) return false;
  if (Number(order.quantityPurchased) < 1) return false;
  const paid =
    Number(order.amountPaid) > 0 ||
    Boolean(order.paidTime) ||
    /^complete$/i.test(String(order.checkoutStatus || ""));
  if (paid) return true;
  return Number(soldQtyBySku[order.sku] || 0) >= 1;
}

export function tradingOrderToIngest(order) {
  const paid = Number(order.amountPaid);
  const value =
    Number.isFinite(paid) && paid > 0
      ? String(order.amountPaid)
      : String(order.total || order.transactionPrice || "0");
  const item = String(order.transactionPrice || value);
  return {
    orderId: order.orderId,
    lineItems: [{ sku: order.sku, lineItemCost: { value: item }, total: { value } }],
    pricingSummary: { priceSubtotal: { value: item }, total: { value } },
  };
}

export async function getSellerUsername(token) {
  const { api } = ebayHosts(process.env.EBAY_ENV);
  const body = `<?xml version="1.0" encoding="utf-8"?>
<GetUserRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ErrorLanguage>en_US</ErrorLanguage>
  <DetailLevel>ReturnSummary</DetailLevel>
</GetUserRequest>`;
  const res = await fetch(`${api}/ws/api.dll`, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml",
      "X-EBAY-API-COMPATIBILITY-LEVEL": "1315",
      "X-EBAY-API-CALL-NAME": "GetUser",
      "X-EBAY-API-SITEID": "0",
      "X-EBAY-API-IAF-TOKEN": token,
    },
    body,
  });
  const xml = await res.text();
  const ack = xmlTag(xml, "Ack");
  if (!/success|warning/i.test(ack)) {
    const longs = xmlAll(xml, "LongMessage");
    const shorts = xmlAll(xml, "ShortMessage");
    throw new Error([...longs, ...shorts].filter(Boolean).join(" ") || xml.slice(0, 400) || `GetUser HTTP ${res.status}`);
  }
  const userBlock = xmlBlocks(xml, "User")[0] || xml;
  return xmlTag(userBlock, "UserID") || xmlTag(xml, "UserID") || "";
}

export async function getSellerOrders(token, days = 7) {
  const { api } = ebayHosts(process.env.EBAY_ENV);
  const body = `<?xml version="1.0" encoding="utf-8"?>
<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ErrorLanguage>en_US</ErrorLanguage>
  <NumberOfDays>${Number(days) || 7}</NumberOfDays>
  <OrderStatus>All</OrderStatus>
  <Pagination><EntriesPerPage>100</EntriesPerPage><PageNumber>1</PageNumber></Pagination>
</GetOrdersRequest>`;
  const res = await fetch(`${api}/ws/api.dll`, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml",
      "X-EBAY-API-COMPATIBILITY-LEVEL": "1315",
      "X-EBAY-API-CALL-NAME": "GetOrders",
      "X-EBAY-API-SITEID": "0",
      "X-EBAY-API-IAF-TOKEN": token,
    },
    body,
  });
  const xml = await res.text();
  const ack = xmlTag(xml, "Ack");
  if (!/success|warning/i.test(ack)) {
    const longs = xmlAll(xml, "LongMessage");
    const shorts = xmlAll(xml, "ShortMessage");
    throw new Error([...longs, ...shorts].filter(Boolean).join(" ") || xml.slice(0, 400) || `GetOrders HTTP ${res.status}`);
  }
  return parseTradingOrders(xml);
}

export async function getShippingServiceDetails(token) {
  const { api } = ebayHosts(process.env.EBAY_ENV);
  const body = `<?xml version="1.0" encoding="utf-8"?>
<GeteBayDetailsRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ErrorLanguage>en_US</ErrorLanguage>
  <DetailName>ShippingServiceDetails</DetailName>
</GeteBayDetailsRequest>`;
  const res = await fetch(`${api}/ws/api.dll`, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml",
      "X-EBAY-API-COMPATIBILITY-LEVEL": "1315",
      "X-EBAY-API-CALL-NAME": "GeteBayDetails",
      "X-EBAY-API-SITEID": "0",
      "X-EBAY-API-IAF-TOKEN": token,
    },
    body,
  });
  const xml = await res.text();
  const ack = xmlTag(xml, "Ack");
  if (!/success|warning/i.test(ack)) {
    const longs = xmlAll(xml, "LongMessage");
    const shorts = xmlAll(xml, "ShortMessage");
    throw new Error([...longs, ...shorts].filter(Boolean).join(" ") || xml.slice(0, 400) || `GeteBayDetails HTTP ${res.status}`);
  }
  return parseShippingServiceDetails(xml);
}

async function tradingCall(token, callName, innerXml) {
  const { api } = ebayHosts(process.env.EBAY_ENV);
  const body = `<?xml version="1.0" encoding="utf-8"?>
<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">
  <ErrorLanguage>en_US</ErrorLanguage>
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
    const longs = xmlAll(xml, "LongMessage");
    const shorts = xmlAll(xml, "ShortMessage");
    const msg = [...longs, ...shorts].filter(Boolean).join(" ") || xml.slice(0, 400) || `${callName} HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = xml;
    err.callName = callName;
    throw err;
  }
  return xml;
}

export function parseActiveListSummaries(xml) {
  return xmlBlocks(xml, "Item").map((block) => {
    const selling = xmlBlocks(block, "SellingStatus")[0] || "";
    const listingDetails = xmlBlocks(block, "ListingDetails")[0] || "";
    const picture = xmlBlocks(block, "PictureDetails")[0] || "";
    const primary = xmlBlocks(block, "PrimaryCategory")[0] || "";
    const pictureUrls = xmlAll(picture, "PictureURL").filter(Boolean);
    const gallery = xmlTag(picture, "GalleryURL");
    if (gallery && !pictureUrls.includes(gallery)) pictureUrls.unshift(gallery);
    return {
      itemId: xmlTag(block, "ItemID"),
      title: xmlTag(block, "Title"),
      sku: xmlTag(block, "SKU") || xmlTag(block, "CustomLabel") || "",
      currentPrice: xmlTag(selling, "CurrentPrice") || xmlTag(block, "BuyItNowPrice") || xmlTag(block, "StartPrice"),
      quantity: Number(xmlTag(block, "Quantity") || 0),
      quantitySold: Number(xmlTag(selling, "QuantitySold") || 0),
      bidCount: Number(xmlTag(selling, "BidCount") || 0),
      listingType: xmlTag(block, "ListingType"),
      listingStatus: xmlTag(selling, "ListingStatus") || "Active",
      categoryId: xmlTag(primary, "CategoryID"),
      categoryName: xmlTag(primary, "CategoryName"),
      imageUrls: pictureUrls,
      viewItemUrl: xmlTag(listingDetails, "ViewItemURL"),
      timeLeft: xmlTag(block, "TimeLeft"),
    };
  }).filter((row) => row.itemId);
}

/** Paginate GetMyeBaySelling ActiveList — includes Vendoo / Seller Hub listings Inventory API misses. */
export async function getMyEbaySellingActive(token, { entriesPerPage = 200, maxPages = 50 } = {}) {
  const items = [];
  let page = 1;
  let totalPages = 1;
  const perPage = Math.min(200, Math.max(1, Number(entriesPerPage) || 200));
  while (page <= totalPages && page <= maxPages) {
    const xml = await tradingCall(
      token,
      "GetMyeBaySelling",
      `<ActiveList>
  <Include>true</Include>
  <Pagination><EntriesPerPage>${perPage}</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination>
</ActiveList>`,
    );
    // IMPORTANT: PaginationResult must come from ActiveList — the response also embeds
    // PaginationResult for SoldList/UnsoldList/etc. Taking xml's first match stopped after page 1.
    const active = xmlBlocks(xml, "ActiveList")[0] || xml;
    items.push(...parseActiveListSummaries(active));
    const pagination = xmlBlocks(active, "PaginationResult")[0] || "";
    const pages = Number(xmlTag(pagination, "TotalNumberOfPages") || 0);
    const totalEntries = Number(xmlTag(pagination, "TotalNumberOfEntries") || 0);
    if (pages > 0) totalPages = pages;
    else if (totalEntries > 0) totalPages = Math.max(1, Math.ceil(totalEntries / perPage));
    else if (parseActiveListSummaries(active).length < perPage) totalPages = page;
    else totalPages = page + 1;
    page += 1;
  }
  // Dedupe by ItemID (safe if a page is re-fetched).
  const byId = new Map();
  for (const row of items) {
    if (row?.itemId) byId.set(String(row.itemId), row);
  }
  return [...byId.values()];
}

function isoDaysFromNow(days) {
  return new Date(Date.now() + Number(days) * 86400000).toISOString();
}

/**
 * Backup active-listing discovery via GetSellerList (EndTime window).
 * Catches listings GetMyeBaySelling ActiveList pagination can miss.
 */
export async function getSellerListActive(token, { entriesPerPage = 200, maxPages = 50, endDays = 120 } = {}) {
  const items = [];
  let page = 1;
  let totalPages = 1;
  const perPage = Math.min(200, Math.max(1, Number(entriesPerPage) || 200));
  const endFrom = new Date().toISOString();
  const endTo = isoDaysFromNow(Math.min(120, Math.max(1, Number(endDays) || 120)));
  while (page <= totalPages && page <= maxPages) {
    const xml = await tradingCall(
      token,
      "GetSellerList",
      `<EndTimeFrom>${xmlEsc(endFrom)}</EndTimeFrom>
<EndTimeTo>${xmlEsc(endTo)}</EndTimeTo>
<IncludeVariations>true</IncludeVariations>
<Pagination><EntriesPerPage>${perPage}</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination>
<DetailLevel>ReturnSummary</DetailLevel>
<OutputSelector>ItemArray.Item.ItemID</OutputSelector>
<OutputSelector>ItemArray.Item.Title</OutputSelector>
<OutputSelector>ItemArray.Item.SKU</OutputSelector>
<OutputSelector>ItemArray.Item.SellingStatus</OutputSelector>
<OutputSelector>ItemArray.Item.PrimaryCategory</OutputSelector>
<OutputSelector>ItemArray.Item.PictureDetails</OutputSelector>
<OutputSelector>ItemArray.Item.ListingType</OutputSelector>
<OutputSelector>ItemArray.Item.ListingDetails</OutputSelector>
<OutputSelector>ItemArray.Item.Quantity</OutputSelector>
<OutputSelector>PaginationResult</OutputSelector>`,
    );
    const array = xmlBlocks(xml, "ItemArray")[0] || xml;
    const rows = parseActiveListSummaries(array).filter((row) => {
      const status = String(row.listingStatus || "Active").toLowerCase();
      return !status || status === "active";
    });
    items.push(...rows);
    const pagination = xmlBlocks(xml, "PaginationResult")[0] || "";
    const pages = Number(xmlTag(pagination, "TotalNumberOfPages") || 0);
    const totalEntries = Number(xmlTag(pagination, "TotalNumberOfEntries") || 0);
    if (pages > 0) totalPages = pages;
    else if (totalEntries > 0) totalPages = Math.max(1, Math.ceil(totalEntries / perPage));
    else if (rows.length < perPage) totalPages = page;
    else totalPages = page + 1;
    page += 1;
  }
  const byId = new Map();
  for (const row of items) {
    if (row?.itemId) byId.set(String(row.itemId), row);
  }
  return [...byId.values()];
}

export function parseTradingItem(xml) {
  const item = xmlBlocks(xml, "Item")[0] || xml;
  const selling = xmlBlocks(item, "SellingStatus")[0] || "";
  const bestOffer = xmlBlocks(item, "BestOfferDetails")[0] || "";
  const picture = xmlBlocks(item, "PictureDetails")[0] || "";
  const primary = xmlBlocks(item, "PrimaryCategory")[0] || "";
  const returnPol = xmlBlocks(item, "ReturnPolicy")[0] || "";
  const ship = xmlBlocks(item, "ShippingDetails")[0] || "";
  const specifics = {};
  for (const nv of xmlBlocks(item, "NameValueList")) {
    const name = xmlTag(nv, "Name");
    const values = xmlAll(nv, "Value").filter(Boolean);
    if (name && values.length) specifics[name] = values;
  }
  const imageUrls = xmlAll(picture, "PictureURL").filter(Boolean);
  const price =
    xmlTag(selling, "CurrentPrice") ||
    xmlTag(item, "BuyItNowPrice") ||
    xmlTag(item, "StartPrice") ||
    "0";
  return {
    itemId: xmlTag(item, "ItemID"),
    title: xmlTag(item, "Title"),
    description: xmlTag(item, "Description"),
    sku: xmlTag(item, "SKU") || "",
    categoryId: xmlTag(primary, "CategoryID"),
    categoryName: xmlTag(primary, "CategoryName"),
    conditionId: xmlTag(item, "ConditionID"),
    conditionDisplayName: xmlTag(item, "ConditionDisplayName"),
    conditionDescription: xmlTag(item, "ConditionDescription"),
    price,
    currency: "USD",
    quantity: Number(xmlTag(item, "Quantity") || 0),
    quantitySold: Number(xmlTag(selling, "QuantitySold") || 0),
    bidCount: Number(xmlTag(selling, "BidCount") || 0),
    listingStatus: xmlTag(selling, "ListingStatus"),
    listingType: xmlTag(item, "ListingType"),
    bestOfferCount: Number(xmlTag(bestOffer, "BestOfferCount") || 0),
    bestOfferEnabled: /^true$/i.test(xmlTag(bestOffer, "BestOfferEnabled") || ""),
    imageUrls,
    aspects: specifics,
    location: xmlTag(item, "Location"),
    postalCode: xmlTag(item, "PostalCode"),
    country: xmlTag(item, "Country") || "US",
    dispatchTimeMax: Number(xmlTag(item, "DispatchTimeMax") || 2),
    returnsAccepted: xmlTag(returnPol, "ReturnsAcceptedOption"),
    shippingType: xmlTag(ship, "ShippingType"),
    viewItemUrl: xmlTag(xmlBlocks(item, "ListingDetails")[0] || "", "ViewItemURL"),
  };
}

export async function getItemStorefront(token, itemId) {
  const xml = await tradingCall(
    token,
    "GetItem",
    `<ItemID>${xmlEsc(itemId)}</ItemID>
<OutputSelector>Item.ItemID</OutputSelector>
<OutputSelector>Item.Title</OutputSelector>
<OutputSelector>Item.SellingStatus.CurrentPrice</OutputSelector>
<OutputSelector>Item.Storefront</OutputSelector>`,
  );
  const store = xmlBlocks(xml, "Storefront")[0] || "";
  const selling = xmlBlocks(xml, "SellingStatus")[0] || "";
  return {
    itemId: xmlTag(xml, "ItemID"),
    title: xmlTag(xml, "Title"),
    price: xmlTag(selling, "CurrentPrice") || "",
    storeCategoryId: xmlTag(store, "StoreCategoryID"),
    storeCategory2Id: xmlTag(store, "StoreCategory2ID"),
    storeCategoryName: xmlTag(store, "StoreCategoryName"),
    storeCategory2Name: xmlTag(store, "StoreCategory2Name"),
  };
}

export async function getTradingItem(token, itemId) {
  const xml = await tradingCall(
    token,
    "GetItem",
    `<ItemID>${xmlEsc(itemId)}</ItemID>
<DetailLevel>ReturnAll</DetailLevel>
<IncludeItemSpecifics>true</IncludeItemSpecifics>`,
  );
  return parseTradingItem(xml);
}

/** In-place revise of condition, description, and pictures only. */
export async function reviseFixedPriceStandards(token, change) {
  const { reviseStandardsXml } = await import("./ebay-listing-standards.mjs");
  const xml = await tradingCall(token, "ReviseFixedPriceItem", reviseStandardsXml(change));
  return { itemId: String(change.itemId), ack: xmlTag(xml, "Ack"), xml };
}

export async function uploadSiteHostedPicture(token, externalUrl) {
  const xml = await tradingCall(
    token,
    "UploadSiteHostedPictures",
    `<ExternalPictureURL>${xmlEsc(externalUrl)}</ExternalPictureURL>`,
  );
  const url = xmlTag(xml, "FullURL") || xmlTag(xml, "PictureURL");
  if (!url) throw new Error("UploadSiteHostedPictures returned no URL");
  return url;
}

export async function endTradingItem(token, itemId, reason = "NotAvailable") {
  const xml = await tradingCall(
    token,
    "EndItem",
    `<ItemID>${xmlEsc(itemId)}</ItemID>
<EndingReason>${xmlEsc(reason)}</EndingReason>`,
  );
  return { itemId: String(itemId), endTime: xmlTag(xml, "EndTime"), xml };
}

let storeCategoryCache = { at: 0, map: null };

function decodeXml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseStoreCategoryMap(xml) {
  const sliceMatch = String(xml).match(/<CustomCategories\b[^>]*>([\s\S]*)<\/CustomCategories>/i);
  const slice = sliceMatch ? sliceMatch[1] : "";
  const map = new Map();
  const stack = [];
  const re = /<(\/?)CustomCategory\b[^>]*>|<Name>([\s\S]*?)<\/Name>|<CategoryID>([\s\S]*?)<\/CategoryID>/gi;
  let current = null;
  let match;
  const remember = (node) => {
    if (node?.name && node?.id) map.set(decodeXml(node.name), node.id);
  };
  while ((match = re.exec(slice))) {
    if (match[1] === "/") {
      remember(current);
      stack.pop();
      current = stack[stack.length - 1] || null;
      continue;
    }
    if (match[0].startsWith("<CustomCategory")) {
      current = { name: "", id: "" };
      stack.push(current);
      continue;
    }
    if (!current) continue;
    if (match[2] != null && !current.name) current.name = match[2].trim();
    else if (match[3] != null && !current.id) current.id = match[3].trim();
    remember(current);
  }
  return map;
}

export async function getStoreCategoryMap(token, { force = false } = {}) {
  if (!force && storeCategoryCache.map && Date.now() - storeCategoryCache.at < 10 * 60_000) {
    return storeCategoryCache.map;
  }
  const xml = await tradingCall(token, "GetStore", "<CategoryStructureOnly>true</CategoryStructureOnly><LevelLimit>3</LevelLimit>");
  const map = parseStoreCategoryMap(xml);
  storeCategoryCache = { at: Date.now(), map };
  return map;
}

async function ensureStoreCategoryIds(token, names) {
  let map = await getStoreCategoryMap(token);
  const missing = names.filter((name) => name && !map.has(name));
  if (!missing.length) return map;
  const blocks = missing
    .map((name) => `<CustomCategory><Name>${xmlEsc(name)}</Name></CustomCategory>`)
    .join("");
  await tradingCall(token, "SetStoreCategories", `<Action>Add</Action><StoreCategories>${blocks}</StoreCategories>`);
  return getStoreCategoryMap(token, { force: true });
}

/**
 * Make sure the department (and Under $25, when the price qualifies) exists,
 * then return the names and store category IDs. Never throws for a missing
 * department — callers skip the storefront rather than block a listing.
 */
export async function ensureListingStoreCategories(token, input) {
  const classified = classifyEbayStoreCategory(input);
  const names = storeCategoryNames(classified);
  if (!names.length) return { names: [], ids: [], classified };
  const map = await ensureStoreCategoryIds(token, names);
  const resolved = names
    .map((name) => ({ name, id: map.get(name) }))
    .filter((row) => row.id && row.id !== "1");
  return { names: resolved.map((row) => row.name), ids: resolved.map((row) => row.id), classified };
}

export function invalidateStoreCategoryCache() {
  storeCategoryCache = { at: 0, map: null };
}

export async function setStoreCategories(token, action, categories) {
  const allowed = new Set(["Add", "Delete", "Rename", "Move"]);
  if (!allowed.has(action)) throw new Error(`unsupported store category action ${action}`);
  const blocks = (categories || []).map((cat) => {
    const id = cat.id ? `<CategoryID>${xmlEsc(cat.id)}</CategoryID>` : "";
    const name = cat.name ? `<Name>${xmlEsc(cat.name)}</Name>` : "";
    const order = cat.order ? `<Order>${xmlEsc(cat.order)}</Order>` : "";
    return `<CustomCategory>${id}${name}${order}</CustomCategory>`;
  }).join("");
  const xml = await tradingCall(
    token,
    "SetStoreCategories",
    `<Action>${action}</Action><StoreCategories>${blocks}</StoreCategories>`,
  );
  invalidateStoreCategoryCache();
  return xml;
}

/** Change only the store categories on a live fixed-price listing. Does not send price, title, photos, quantity, or shipping. */
export async function reviseItemStoreCategories(token, itemId, categoryId, category2Id = "0") {
  const id = String(itemId || "").trim();
  const primary = String(categoryId || "").trim();
  if (!/^\d+$/.test(id) || !/^\d+$/.test(primary)) throw new Error("store category revise needs a numeric item id and category id");
  const second = /^\d+$/.test(String(category2Id || "")) ? String(category2Id) : "0";
  return tradingCall(
    token,
    "ReviseFixedPriceItem",
    `<Item>
      <ItemID>${xmlEsc(id)}</ItemID>
      <Storefront>
        <StoreCategoryID>${xmlEsc(primary)}</StoreCategoryID>
        <StoreCategory2ID>${xmlEsc(second)}</StoreCategory2ID>
      </Storefront>
    </Item>`,
  );
}

export async function setEbayStoreProfile(token, { name, description, logoUrl } = {}) {
  const parts = [];
  if (name) parts.push(`<Name>${xmlEsc(name)}</Name>`);
  if (description) parts.push(`<Description><![CDATA[${String(description).replace(/\]\]>/g, "")}]]></Description>`);
  if (logoUrl) parts.push(`<Logo><URL>${xmlEsc(logoUrl)}</URL></Logo>`);
  if (!parts.length) throw new Error("setEbayStoreProfile needs a name, description, or logo");
  return tradingCall(token, "SetStore", `<Store>${parts.join("")}</Store>`);
}

export async function uploadEbayPicture(token, { filename, bytes, pictureName }) {
  const { api } = ebayHosts(process.env.EBAY_ENV);
  const boundary = `ebaypic${Date.now()}`;
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<UploadSiteHostedPicturesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ErrorLanguage>en_US</ErrorLanguage>
  <PictureName>${xmlEsc(pictureName || filename || "store-image")}</PictureName>
  <PictureSet>Supersize</PictureSet>
</UploadSiteHostedPicturesRequest>`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="XML Payload"\r\nContent-Type: text/xml; charset=utf-8\r\n\r\n${xml}\r\n--${boundary}\r\nContent-Disposition: form-data; name="${pictureName || "image"}"; filename="${filename || "image.png"}"\r\nContent-Type: image/png\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, Buffer.from(bytes), tail]);
  const res = await fetch(`${api}/ws/api.dll`, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "X-EBAY-API-COMPATIBILITY-LEVEL": "1315",
      "X-EBAY-API-CALL-NAME": "UploadSiteHostedPictures",
      "X-EBAY-API-SITEID": "0",
      "X-EBAY-API-IAF-TOKEN": token,
    },
    body,
  });
  const text = await res.text();
  const ack = xmlTag(text, "Ack");
  if (!/success|warning/i.test(ack)) {
    throw new Error(xmlTag(text, "LongMessage") || xmlTag(text, "ShortMessage") || text.slice(0, 400));
  }
  return xmlTag(text, "FullURL") || xmlTag(text, "PictureURL") || "";
}

export async function setEbayStoreCustomPage(token, { name, content, order = 1 }) {
  return tradingCall(
    token,
    "SetStoreCustomPage",
    `<CustomPage>
      <Name>${xmlEsc(name)}</Name>
      <Content><![CDATA[${String(content || "").replace(/\]\]>/g, "")}]]></Content>
      <Status>Active</Status>
      <LeftNav>true</LeftNav>
      <Order>${xmlEsc(order)}</Order>
    </CustomPage>`,
  );
}

/**
 * Migration listing create via Trading API when Inventory offer publish is unavailable.
 * Uses Seller Profiles (business policies) when policy IDs are provided; otherwise embeds
 * calculated buyer-pays shipping and no-returns inline (accounts without policy opt-in).
 */
export async function addFixedPriceItem(token, item) {
  const pictures = (item.imageUrls || [])
    .map((url) => `<PictureURL>${xmlEsc(url)}</PictureURL>`)
    .join("");
  const specifics = Object.entries(item.aspects || {})
    .filter(([, values]) => (Array.isArray(values) ? values[0] : values))
    .map(([name, values]) => {
      const vals = Array.isArray(values) ? values : [values];
      return `<NameValueList><Name>${xmlEsc(name)}</Name>${vals.map((v) => `<Value>${xmlEsc(v)}</Value>`).join("")}</NameValueList>`;
    })
    .join("");
  const conditionId = item.conditionId || tradingConditionId(item.condition);
  const sellerProfiles =
    item.paymentPolicyId && item.returnPolicyId && item.fulfillmentPolicyId
      ? `<SellerProfiles>
      <SellerPaymentProfile><PaymentProfileID>${xmlEsc(item.paymentPolicyId)}</PaymentProfileID></SellerPaymentProfile>
      <SellerReturnProfile><ReturnProfileID>${xmlEsc(item.returnPolicyId)}</ReturnProfileID></SellerReturnProfile>
      <SellerShippingProfile><ShippingProfileID>${xmlEsc(item.fulfillmentPolicyId)}</ShippingProfileID></SellerShippingProfile>
    </SellerProfiles>`
      : `<ReturnPolicy>
      <ReturnsAcceptedOption>ReturnsNotAccepted</ReturnsAcceptedOption>
    </ReturnPolicy>
    <ShippingDetails>
      <ShippingType>Calculated</ShippingType>
      <ShippingServiceOptions>
        <ShippingServicePriority>1</ShippingServicePriority>
        <ShippingService>${xmlEsc(item.shippingService || "USPSPriority")}</ShippingService>
        <FreeShipping>false</FreeShipping>
      </ShippingServiceOptions>
      <CalculatedShippingRate>
        <OriginatingPostalCode>${xmlEsc(item.postalCode || "95663")}</OriginatingPostalCode>
        <PackagingHandlingCosts currencyID="USD">0.00</PackagingHandlingCosts>
      </CalculatedShippingRate>
    </ShippingDetails>`;
  // Calculated shipping (business policy) requires package weight + dims — defaults when unknown.
  const weightLb = Number(item.weightLb) > 0 ? Number(item.weightLb) : 1;
  const weightMajor = Math.max(0, Math.floor(weightLb));
  const weightMinor = Math.min(15, Math.max(0, Math.round((weightLb % 1) * 16)));
  // eBay rejects 0/0 weight; ensure at least 1 oz equivalent when major is 0.
  const majorOut = weightMajor > 0 || weightMinor > 0 ? weightMajor : 1;
  const minorOut = weightMajor > 0 || weightMinor > 0 ? weightMinor : 0;
  const lengthIn = Number(item.lengthIn) > 0 ? Number(item.lengthIn) : 12;
  const widthIn = Number(item.widthIn) > 0 ? Number(item.widthIn) : 9;
  const heightIn = Number(item.heightIn) > 0 ? Number(item.heightIn) : 3;
  const packageDetails = `<ShippingPackageDetails>
      <MeasurementUnit>English</MeasurementUnit>
      <PackageLength>${xmlEsc(lengthIn)}</PackageLength>
      <PackageWidth>${xmlEsc(widthIn)}</PackageWidth>
      <PackageDepth>${xmlEsc(heightIn)}</PackageDepth>
      <WeightMajor unit="lbs">${xmlEsc(majorOut)}</WeightMajor>
      <WeightMinor unit="oz">${xmlEsc(minorOut)}</WeightMinor>
      <ShippingPackage>PackageThickEnvelope</ShippingPackage>
    </ShippingPackageDetails>`;
  let storefrontXml = "";
  if (item.storeCategory !== false && !item.storeCategoryId) {
    try {
      const resolved = await ensureListingStoreCategories(token, {
        title: item.title,
        category: item.floorCategory || "",
        priceCents: Math.round(Number(item.price) * 100),
      });
      if (resolved.ids[0]) {
        storefrontXml = `<Storefront><StoreCategoryID>${xmlEsc(resolved.ids[0])}</StoreCategoryID><StoreCategory2ID>${xmlEsc(resolved.ids[1] || "0")}</StoreCategory2ID></Storefront>`;
      }
    } catch (err) {
      console.warn("ebay_store_category_skip", err instanceof Error ? err.message : String(err));
    }
  } else if (item.storeCategoryId) {
    storefrontXml = `<Storefront><StoreCategoryID>${xmlEsc(item.storeCategoryId)}</StoreCategoryID><StoreCategory2ID>${xmlEsc(item.storeCategory2Id || "0")}</StoreCategory2ID></Storefront>`;
  }
  const inner = `<WarningLevel>High</WarningLevel>
  <Item>
    <Title>${xmlEsc(item.title)}</Title>
    <Description><![CDATA[${String(item.description || "").slice(0, 500000)}]]></Description>
    <PrimaryCategory><CategoryID>${xmlEsc(item.categoryId)}</CategoryID></PrimaryCategory>
    <StartPrice>${xmlEsc(item.price)}</StartPrice>
    <ConditionID>${xmlEsc(conditionId)}</ConditionID>
    ${item.conditionDescription ? `<ConditionDescription>${xmlEsc(item.conditionDescription)}</ConditionDescription>` : ""}
    <Country>US</Country>
    <Currency>USD</Currency>
    <DispatchTimeMax>${xmlEsc(item.dispatchTimeMax || 2)}</DispatchTimeMax>
    <ListingDuration>GTC</ListingDuration>
    <ListingType>FixedPriceItem</ListingType>
    <Location>${xmlEsc(item.city || item.location || "Penryn")}</Location>
    <PostalCode>${xmlEsc(item.postalCode || "95663")}</PostalCode>
    <Quantity>1</Quantity>
    ${item.sku ? `<SKU>${xmlEsc(item.sku)}</SKU>` : ""}
    <PictureDetails>${pictures}</PictureDetails>
    ${specifics ? `<ItemSpecifics>${specifics}</ItemSpecifics>` : ""}
    ${packageDetails}
    ${sellerProfiles}
    ${storefrontXml}
    <ShipToLocations>US</ShipToLocations>
  </Item>`;
  const send = async (body) => {
    const xml = await tradingCall(token, "AddFixedPriceItem", body);
    const itemId = xmlTag(xml, "ItemID");
    if (!itemId) throw new Error("AddFixedPriceItem succeeded without ItemID");
    return { listingId: itemId, xml };
  };
  try {
    return await send(inner);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (storefrontXml && /store categor/i.test(message)) {
      console.warn("ebay_store_category_skip", message);
      return send(inner.replace(storefrontXml, ""));
    }
    throw err;
  }
}

/** True when the active listing should not be ended (open sale activity). */
export function tradingItemBlockedReason(item, { openOrderItemIds = new Set() } = {}) {
  if (!item?.itemId) return "missing_item";
  if (openOrderItemIds.has(String(item.itemId))) return "open_order_on_source";
  if (Number(item.bidCount) > 0) return "active_bids";
  if (Number(item.bestOfferCount) > 0) return "active_best_offer";
  if (Number(item.quantitySold) > 0 && Number(item.quantity) - Number(item.quantitySold) <= 0) {
    return "fully_sold";
  }
  if (Number(item.quantitySold) > 0) return "partial_sale_quantity";
  const status = String(item.listingStatus || "").toLowerCase();
  if (status && status !== "active") return `listing_status_${status}`;
  return null;
}
