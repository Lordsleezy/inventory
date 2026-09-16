export const CHANNELS = ["floor", "ebay", "amazon", "facebook", "tiktok", "website", "offerup", "other"] as const;
export type Channel = (typeof CHANNELS)[number];
export type ChannelMode = "off" | "manual" | "auto";

export const MANUAL_INSTRUCTIONS: Record<string, string> = {
  ebay: "Open eBay → end the listing for this SKU.",
  amazon: "Open Seller Central → close the offer for this SKU.",
  facebook: "Open Marketplace → mark the listing sold / delete it.",
  tiktok: "Open TikTok Shop → take the listing down.",
  website: "It drops off public_items on its own. No extra step.",
  offerup: "Open OfferUp → mark as sold.",
  other: "Take the listing down on that channel.",
};

export function amazonConnectAllowed(accountType: "individual" | "professional"): boolean {
  return accountType === "professional";
}
