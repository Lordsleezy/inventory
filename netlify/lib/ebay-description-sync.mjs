/**
 * Copy a unit's saved description to its live eBay listing and change nothing else.
 * Inventory-API listing: GET the offer, replace only listingDescription, PUT it back unchanged otherwise.
 * Older Trading listing: ReviseFixedPriceItem with the Description element only.
 */
import { ebayFetch, resolveEbayAccount } from "./ebay.mjs";
import { userTokenForAccount } from "./ebay-accounts.mjs";
import { reviseTradingFixedPrice } from "./ebay-trading.mjs";
import { serviceClient } from "./server.mjs";

const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Plain text to simple HTML: blank-line paragraphs, single newlines as <br>. */
export function descriptionHtml(text) {
  return String(text || "").trim().split(/\n{2,}/).filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("");
}

export async function pushEbayDescription(storeId, sku, deps = {}) {
  const sb = deps.sb || serviceClient();
  const { data: unit } = await sb.from("units").select("listing_body").eq("store_id", storeId).eq("sku", sku).maybeSingle();
  const html = descriptionHtml(unit?.listing_body);
  if (!html) return { updated: false, reason: "no_description" };
  const { data: row } = await sb.from("listings").select("listing_id,offer_id,status").eq("store_id", storeId).eq("sku", sku).eq("channel", "ebay").maybeSingle();
  if (!row || row.status !== "listed") return { updated: false, reason: "not_live_on_ebay" };
  const fetchEbay = deps.ebayFetch || ebayFetch;
  const account = deps.account || (await resolveEbayAccount(storeId, { role: "selling" }));
  const hint = { _account: account, accountId: account.id };
  if (row.offer_id) {
    const offer = await fetchEbay(storeId, "GET", `/sell/inventory/v1/offer/${row.offer_id}`, undefined, hint);
    const body = { ...offer, listingDescription: html };
    delete body.offerId; delete body.listing; delete body.status;
    await fetchEbay(storeId, "PUT", `/sell/inventory/v1/offer/${row.offer_id}`, body, hint);
    return { updated: true, via: "offer" };
  }
  if (/^\d+$/.test(String(row.listing_id || ""))) {
    const revise = deps.revise || reviseTradingFixedPrice;
    await revise(deps.token || (await userTokenForAccount(account)), { itemId: row.listing_id, description: html });
    return { updated: true, via: "trading" };
  }
  return { updated: false, reason: "no_live_ebay_listing" };
}
