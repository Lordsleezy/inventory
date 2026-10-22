/**
 * Switch a live eBay listing between the buyer-pays and free-shipping business policies.
 * Reads policies. Creates the free-shipping policy only when the account does not have one.
 * Does not rewrite the buyer-pays policy, and does not touch any other SKU.
 */
import { ebayFetch, resolveEbayAccount } from "./ebay.mjs";
import { ebayFetchAccount, userTokenForAccount } from "./ebay-accounts.mjs";
import { ensureFreeShippingPolicy } from "./ebay-free-ship-bump.mjs";
import { marketplaceIdFromEnv } from "./ebay-env.mjs";
import { reviseFixedPricePriceAndShipping } from "./ebay-trading.mjs";

function policyId(row) {
  return row?.fulfillmentPolicyId || row?.policyId || row?.id || null;
}

function policyMode(policy) {
  const options = policy?.shippingOptions || [];
  const services = options.flatMap((opt) => opt?.shippingServices || []);
  const calculated = options.some((opt) => String(opt.costType || "").toUpperCase() === "CALCULATED");
  const free = services.some((svc) => svc.freeShipping)
    || (services.length > 0 && services.every((svc) => Number(svc.shippingCost?.value || 0) === 0) && !calculated);
  if (calculated) return "calculated";
  if (free) return "free";
  return null;
}

export async function buyerPaysPolicyId(account) {
  if (account?.fulfillment_policy_id) return String(account.fulfillment_policy_id);
  const market = marketplaceIdFromEnv();
  const json = await ebayFetchAccount(account, "GET", `/sell/account/v1/fulfillment_policy?marketplace_id=${market}`);
  const rows = json?.fulfillmentPolicies || [];
  const named = rows.find((row) => /calculated|buyer pays/i.test(String(row?.name || "")));
  const calculated = named || rows.find((row) => policyMode(row) === "calculated");
  const id = policyId(calculated);
  if (!id) throw new Error("No buyer-pays fulfillment policy on the selling eBay account.");
  return String(id);
}

export async function applyEbayShippingMode(storeId, { sku, itemId, offerId, mode, accountId } = {}) {
  const shipping = mode === "free" ? "free" : "calculated";
  const account = await resolveEbayAccount(storeId, accountId ? { accountId } : { role: "selling" });
  const [free, buyer] = await Promise.all([
    ensureFreeShippingPolicy(account),
    buyerPaysPolicyId(account),
  ]);
  const fulfillment = shipping === "free" ? free.fulfillmentPolicyId : buyer;
  const payment = account.payment_policy_id || free.paymentPolicyId;
  const returnP = account.return_policy_id || free.returnPolicyId;
  if (!fulfillment || !payment || !returnP) {
    throw new Error("eBay payment, return, and shipping policies are not all set on the selling account.");
  }
  const hint = { _account: account, accountId: account.id };
  let offer = null;
  if (offerId) {
    offer = await ebayFetch(storeId, "GET", `/sell/inventory/v1/offer/${offerId}`, undefined, hint);
  } else if (sku) {
    const found = await ebayFetch(
      storeId,
      "GET",
      `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}`,
      undefined,
      hint,
    ).catch(() => null);
    offer = found?.offers?.[0] || null;
  }
  if (offer?.offerId) {
    const body = {
      ...offer,
      listingPolicies: {
        ...(offer.listingPolicies || {}),
        fulfillmentPolicyId: fulfillment,
        paymentPolicyId: payment,
        returnPolicyId: returnP,
      },
    };
    delete body.offerId;
    delete body.listing;
    delete body.status;
    await ebayFetch(storeId, "PUT", `/sell/inventory/v1/offer/${offer.offerId}`, body, hint);
    return { ok: true, mode: shipping, via: "offer", policyId: fulfillment };
  }
  const tradingId = itemId || offer?.listing?.listingId || null;
  if (tradingId) {
    const token = await userTokenForAccount(account);
    await reviseFixedPricePriceAndShipping(token, {
      itemId: tradingId,
      fulfillmentPolicyId: fulfillment,
      paymentPolicyId: payment,
      returnPolicyId: returnP,
    });
    return { ok: true, mode: shipping, via: "trading", policyId: fulfillment };
  }
  return { ok: false, error: "no_live_ebay_listing" };
}
