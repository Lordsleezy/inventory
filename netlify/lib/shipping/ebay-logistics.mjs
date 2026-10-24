/**
 * eBay Sell Logistics API — restricted / limited release.
 * Stubbed offline until the store is approved; quote layer already includes it as a source.
 */

import { LABEL_SOURCES } from "./sources.mjs";

export function ebayLogisticsStatus() {
  if (process.env.EBAY_LOGISTICS_ENABLED === "1") {
    return {
      online: false,
      reason: "eBay Logistics enabled in env but client not implemented pending API approval",
      source: LABEL_SOURCES.ebay_logistics,
    };
  }
  return {
    online: false,
    reason: "eBay Sell Logistics API not approved yet (apply in eBay Developer Program)",
    source: LABEL_SOURCES.ebay_logistics,
  };
}

export async function ebayLogisticsQuoteRates() {
  const st = ebayLogisticsStatus();
  return { online: false, rates: [], messages: [st.reason] };
}

export async function ebayLogisticsBuyLabel() {
  throw new Error("ebay_logistics_unavailable — apply for Sell Logistics API access first");
}
