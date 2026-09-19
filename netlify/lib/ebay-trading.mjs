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

export async function addFixedPriceItem(token, item) {
  const { api } = ebayHosts(process.env.EBAY_ENV);
  const pictures = (item.imageUrls || [])
    .map((url) => `<PictureURL>${xmlEsc(url)}</PictureURL>`)
    .join("");
  const specifics = Object.entries(item.aspects || {})
    .filter(([, values]) => values?.[0])
    .map(
      ([name, values]) =>
        `<NameValueList><Name>${xmlEsc(name)}</Name><Value>${xmlEsc(values[0])}</Value></NameValueList>`,
    )
    .join("");
  const body = `<?xml version="1.0" encoding="utf-8"?>
<AddFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  <Item>
    <Title>${xmlEsc(item.title)}</Title>
    <Description><![CDATA[${String(item.description || "").slice(0, 500000)}]]></Description>
    <PrimaryCategory><CategoryID>${xmlEsc(item.categoryId)}</CategoryID></PrimaryCategory>
    <StartPrice>${xmlEsc(item.price)}</StartPrice>
    <ConditionID>${tradingConditionId(item.condition)}</ConditionID>
    ${item.conditionDescription ? `<ConditionDescription>${xmlEsc(item.conditionDescription)}</ConditionDescription>` : ""}
    <Country>US</Country>
    <Currency>USD</Currency>
    <DispatchTimeMax>2</DispatchTimeMax>
    <ListingDuration>GTC</ListingDuration>
    <ListingType>FixedPriceItem</ListingType>
    <Location>${xmlEsc(item.city || "Roseville")}</Location>
    <PostalCode>${xmlEsc(item.postalCode || "95678")}</PostalCode>
    <Quantity>1</Quantity>
    <SKU>${xmlEsc(item.sku)}</SKU>
    <PictureDetails>${pictures}</PictureDetails>
    ${specifics ? `<ItemSpecifics>${specifics}</ItemSpecifics>` : ""}
    <ReturnPolicy>
      <ReturnsAcceptedOption>ReturnsAccepted</ReturnsAcceptedOption>
      <RefundOption>MoneyBack</RefundOption>
      <ReturnsWithinOption>Days_30</ReturnsWithinOption>
      <ShippingCostPaidByOption>Buyer</ShippingCostPaidByOption>
    </ReturnPolicy>
    <ShippingDetails>
      <ShippingType>Flat</ShippingType>
      <ShippingServiceOptions>
        <ShippingServicePriority>1</ShippingServicePriority>
        <ShippingService>Pickup</ShippingService>
        <ShippingServiceCost>0.00</ShippingServiceCost>
        <ShippingServiceAdditionalCost>0.00</ShippingServiceAdditionalCost>
      </ShippingServiceOptions>
    </ShippingDetails>
    <ShipToLocations>US</ShipToLocations>
  </Item>
</AddFixedPriceItemRequest>`;
  const res = await fetch(`${api}/ws/api.dll`, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml",
      "X-EBAY-API-COMPATIBILITY-LEVEL": "1315",
      "X-EBAY-API-CALL-NAME": "AddFixedPriceItem",
      "X-EBAY-API-SITEID": "0",
      "X-EBAY-API-IAF-TOKEN": token,
    },
    body,
  });
  const xml = await res.text();
  const ack = xmlTag(xml, "Ack");
  const itemId = xmlTag(xml, "ItemID");
  if (/success|warning/i.test(ack) && itemId) {
    return { listingId: itemId, xml };
  }
  const longs = xmlAll(xml, "LongMessage");
  const shorts = xmlAll(xml, "ShortMessage");
  const msg = [...longs, ...shorts].filter(Boolean).join(" ") || xml.slice(0, 400) || `Trading API HTTP ${res.status}`;
  const err = new Error(msg);
  err.status = res.status;
  err.body = xml;
  throw err;
}
