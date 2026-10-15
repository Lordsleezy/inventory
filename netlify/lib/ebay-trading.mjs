import { ebayHosts } from "./ebay-env.mjs";

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
    return {
      itemId: xmlTag(block, "ItemID"),
      title: xmlTag(block, "Title"),
      sku: xmlTag(block, "SKU") || xmlTag(block, "CustomLabel") || "",
      currentPrice: xmlTag(selling, "CurrentPrice") || xmlTag(block, "BuyItNowPrice") || xmlTag(block, "StartPrice"),
      quantity: Number(xmlTag(block, "Quantity") || 0),
      quantitySold: Number(xmlTag(selling, "QuantitySold") || 0),
      bidCount: Number(xmlTag(selling, "BidCount") || 0),
      listingType: xmlTag(block, "ListingType"),
      listingStatus: xmlTag(selling, "ListingStatus"),
      viewItemUrl: xmlTag(listingDetails, "ViewItemURL"),
      timeLeft: xmlTag(block, "TimeLeft"),
    };
  }).filter((row) => row.itemId);
}

/** Paginate GetMyeBaySelling ActiveList — includes Vendoo / Seller Hub listings Inventory API misses. */
export async function getMyEbaySellingActive(token, { entriesPerPage = 100, maxPages = 50 } = {}) {
  const items = [];
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages && page <= maxPages) {
    const xml = await tradingCall(
      token,
      "GetMyeBaySelling",
      `<ActiveList>
  <Include>true</Include>
  <Pagination><EntriesPerPage>${Number(entriesPerPage) || 100}</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination>
</ActiveList>`,
    );
    const active = xmlBlocks(xml, "ActiveList")[0] || xml;
    items.push(...parseActiveListSummaries(active));
    const pagination = xmlBlocks(xml, "PaginationResult")[0] || "";
    totalPages = Math.max(1, Number(xmlTag(pagination, "TotalNumberOfPages") || 1));
    page += 1;
  }
  return items;
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

export async function endTradingItem(token, itemId, reason = "NotAvailable") {
  const xml = await tradingCall(
    token,
    "EndItem",
    `<ItemID>${xmlEsc(itemId)}</ItemID>
<EndingReason>${xmlEsc(reason)}</EndingReason>`,
  );
  return { itemId: String(itemId), endTime: xmlTag(xml, "EndTime"), xml };
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
  const packageDetails =
    item.weightLb || item.lengthIn
      ? `<ShippingPackageDetails>
      <MeasurementUnit>English</MeasurementUnit>
      ${item.weightLb ? `<WeightMajor>${xmlEsc(Math.floor(Number(item.weightLb) || 1))}</WeightMajor><WeightMinor>${xmlEsc(Math.round(((Number(item.weightLb) || 1) % 1) * 16))}</WeightMinor>` : ""}
      ${item.lengthIn ? `<PackageLength>${xmlEsc(item.lengthIn)}</PackageLength>` : ""}
      ${item.widthIn ? `<PackageWidth>${xmlEsc(item.widthIn)}</PackageWidth>` : ""}
      ${item.heightIn ? `<PackageDepth>${xmlEsc(item.heightIn)}</PackageDepth>` : ""}
      <ShippingPackage>PackageThickEnvelope</ShippingPackage>
    </ShippingPackageDetails>`
      : "";
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
    ${sellerProfiles}
    ${packageDetails}
    <ShipToLocations>US</ShipToLocations>
  </Item>`;
  const xml = await tradingCall(token, "AddFixedPriceItem", inner);
  const itemId = xmlTag(xml, "ItemID");
  if (!itemId) throw new Error("AddFixedPriceItem succeeded without ItemID");
  return { listingId: itemId, xml };
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
