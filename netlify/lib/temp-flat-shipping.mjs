/**
 * Put two listings on the temporary $1.99 policy and put them back.
 * The order sync calls maybeRevertTempFlat. The one-command revert calls it with force.
 */
import { loadEbayAccount, ebayFetchAccount, userTokenForAccount } from "./ebay-accounts.mjs";
import { ebayHosts, marketplaceIdFromEnv } from "./ebay-env.mjs";
import { floorLog } from "./floor-log.mjs";
import { sendInternalAlert, filterDeliverableEmails } from "./mail.mjs";
import {
  TEMP_FLAT_KEY,
  TEMP_FLAT_POLICY_NAME,
  flatRatePolicyBody,
  offerBodyWithPolicy,
  purchasesFromEbayOrders,
  shouldRevertTempFlat,
} from "../../shared/temp-flat-shipping.mjs";

const SELLING = "ikonikdeals2026";

function tag(xml, name) {
  const match = String(xml).match(new RegExp(`<${name}(?![A-Za-z0-9])[^>]*>([\\s\\S]*?)</${name}>`));
  return match ? match[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : "";
}

async function trading(account, callName, inner) {
  const token = await userTokenForAccount(account);
  const { api } = ebayHosts(process.env.EBAY_ENV);
  const res = await fetch(`${api}/ws/api.dll`, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml",
      "X-EBAY-API-COMPATIBILITY-LEVEL": "1315",
      "X-EBAY-API-CALL-NAME": callName,
      "X-EBAY-API-SITEID": "0",
      "X-EBAY-API-IAF-TOKEN": token,
    },
    body: `<?xml version="1.0" encoding="utf-8"?><${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents"><ErrorLanguage>en_US</ErrorLanguage>${inner}</${callName}Request>`,
  });
  const xml = await res.text();
  const ack = tag(xml, "Ack");
  if (!/success|warning/i.test(ack)) throw new Error(tag(xml, "LongMessage") || `${callName} failed`);
  return xml;
}

export async function readListingSnapshot(account, listingId) {
  const xml = await trading(account, "GetItem", `<ItemID>${listingId}</ItemID><DetailLevel>ReturnAll</DetailLevel>`);
  const profiles = (xml.match(/<SellerProfiles>([\s\S]*?)<\/SellerProfiles>/) || [])[1] || "";
  return {
    listing_id: String(listingId),
    sku: tag(xml, "SKU"),
    title: tag(xml, "Title"),
    price: tag(xml, "CurrentPrice"),
    handling: tag(xml, "DispatchTimeMax"),
    weight_lb: tag(xml, "WeightMajor"),
    length_in: tag(xml, "PackageLength"),
    width_in: tag(xml, "PackageWidth"),
    height_in: tag(xml, "PackageDepth"),
    shipping_type: tag(xml, "ShippingType"),
    service: tag(xml, "ShippingService"),
    shipping_cost: tag(xml, "ShippingServiceCost"),
    policy_id: tag(profiles, "ShippingProfileID"),
    policy_name: tag(profiles, "ShippingProfileName"),
    payment_policy_id: tag(profiles, "PaymentProfileID"),
    return_policy_id: tag(profiles, "ReturnProfileID"),
  };
}

export function parseHold(value) {
  if (!value) return null;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return null; }
  }
  return value;
}

export async function readHold(sb, storeId) {
  const { data, error } = await sb
    .from("store_settings")
    .select("value")
    .eq("store_id", storeId)
    .eq("key", TEMP_FLAT_KEY)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return parseHold(data?.value);
}

export async function writeHold(sb, storeId, hold) {
  const { error } = await sb.from("store_settings").upsert(
    { store_id: storeId, key: TEMP_FLAT_KEY, value: hold },
    { onConflict: "store_id,key" },
  );
  if (error) throw new Error(error.message);
}

function policyIsFlat199(policy) {
  const services = (policy?.shippingOptions || []).flatMap((opt) => opt.shippingServices || []);
  return services.some((svc) =>
    svc.shippingServiceCode === "USPSParcel"
    && String(svc.shippingCost?.value) === "1.99"
    && svc.freeShipping !== true);
}

export async function ensureFlatPolicy(account) {
  const market = marketplaceIdFromEnv();
  const listed = await ebayFetchAccount(account, "GET", `/sell/account/v1/fulfillment_policy?marketplace_id=${market}`);
  const named = (listed.fulfillmentPolicies || []).find((row) => row.name === TEMP_FLAT_POLICY_NAME);
  if (named) {
    if (!policyIsFlat199(named)) throw new Error(`${TEMP_FLAT_POLICY_NAME} exists and is not a $1.99 Ground Advantage rate`);
    return { id: String(named.fulfillmentPolicyId), created: false };
  }
  const created = await ebayFetchAccount(account, "POST", "/sell/account/v1/fulfillment_policy", flatRatePolicyBody(market));
  const id = String(created.fulfillmentPolicyId || created.id || "");
  if (!id) throw new Error("eBay did not return a fulfillment policy id");
  return { id, created: true };
}

export async function switchListingPolicy(account, { sku, offerId, fulfillmentPolicyId }) {
  let id = offerId;
  if (!id) {
    const found = await ebayFetchAccount(account, "GET", `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}`);
    id = (found.offers || []).find((row) => String(row.status || "").toUpperCase() === "PUBLISHED")?.offerId
      || found.offers?.[0]?.offerId;
  }
  if (!id) throw new Error(`no offer for ${sku}`);
  const offer = await ebayFetchAccount(account, "GET", `/sell/inventory/v1/offer/${id}`);
  const before = offer?.listingPolicies?.fulfillmentPolicyId || null;
  if (String(before) === String(fulfillmentPolicyId)) return { offerId: String(id), unchanged: true, before };
  const body = offerBodyWithPolicy(offer, fulfillmentPolicyId);
  await ebayFetchAccount(account, "PUT", `/sell/inventory/v1/offer/${id}`, body);
  try {
    await ebayFetchAccount(account, "POST", `/sell/inventory/v1/offer/${id}/publish`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/already published|25402/i.test(message)) throw err;
  }
  return { offerId: String(id), unchanged: false, before };
}

async function recentPurchases(account, hold) {
  const start = new Date(Date.parse(hold.started_at || "") - 5 * 60 * 1000);
  const from = Number.isFinite(start.getTime()) ? start : new Date(Date.now() - 48 * 3600 * 1000);
  const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, ".000Z");
  const filter = encodeURIComponent(`lastmodifieddate:[${iso(from)}..${iso(new Date())}]`);
  const json = await ebayFetchAccount(account, "GET", `/sell/fulfillment/v1/order?limit=200&filter=${filter}`);
  return purchasesFromEbayOrders(json?.orders || []);
}

async function tellPaul(sb, storeId, hold) {
  const { data } = await sb
    .from("store_settings")
    .select("value")
    .eq("store_id", storeId)
    .eq("key", "order_notify_emails")
    .maybeSingle();
  const configured = Array.isArray(data?.value) ? data.value : [];
  const to = filterDeliverableEmails(configured.length ? configured : ["pgg124@gmail.com", "obitracking@gmail.com"]);
  const skus = (hold.items || []).map((item) => item.sku).filter(Boolean).join(" and ");
  try {
    return await sendInternalAlert({
      to,
      subject: "Temporary $1.99 shipping was put back",
      text: `The temporary $1.99 shipping on ${skus} is back on the original calculated policies.\nReason: ${hold.revert_reason}.\nThis is on Orders.`,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function revertTempFlat(sb, { storeId, force = false, now = Date.now(), reason } = {}) {
  const hold = await readHold(sb, storeId);
  if (!hold?.items?.length) return { ok: true, skipped: true, reason: "nothing to revert" };
  if (!hold.active && !force) return { ok: true, skipped: true, reason: "already reverted", reverted_at: hold.reverted_at || null };
  const account = await loadEbayAccount(storeId, { username: SELLING });
  let decision = { revert: true, reason: reason || "manual revert" };
  if (!force) {
    let orders = [];
    try {
      orders = await recentPurchases(account, hold);
    } catch (err) {
      const expired = shouldRevertTempFlat(hold, { now, orders: [] });
      if (!expired.revert) {
        return { ok: false, skipped: true, reason: "order check failed", error: err instanceof Error ? err.message : String(err) };
      }
      decision = expired;
    }
    if (decision.reason !== "48 hours passed") {
      decision = shouldRevertTempFlat(hold, { now, orders });
      if (!decision.revert) return { ok: true, skipped: true, reason: decision.reason };
    }
  }
  const restored = [];
  for (const item of hold.items) {
    const moved = await switchListingPolicy(account, {
      sku: item.sku,
      offerId: item.offer_id,
      fulfillmentPolicyId: item.from_policy_id,
    });
    // Sold / UNPUBLISHED offers keep the restored policy on the offer, but
    // GetItem can still report the temp ShippingProfileID frozen at sale time.
    // Prefer the live offer policy; fall back to GetItem for published listings.
    let policyId = null;
    let offerStatus = null;
    try {
      const offer = await ebayFetchAccount(account, "GET", `/sell/inventory/v1/offer/${moved.offerId}`);
      policyId = offer?.listingPolicies?.fulfillmentPolicyId || null;
      offerStatus = String(offer?.status || "");
    } catch {
      policyId = null;
    }
    const after = await readListingSnapshot(account, item.listing_id).catch(() => null);
    const ended = /UNPUBLISHED|ENDED|INACTIVE/i.test(offerStatus) || /Completed|Ended/i.test(String(after?.shipping_type || ""));
    if (String(policyId) === String(item.from_policy_id)) {
      // Offer already (or now) points at the original calculated policy.
    } else if (after && String(after.policy_id) === String(item.from_policy_id)) {
      policyId = after.policy_id;
    } else if (ended && String(policyId || after?.policy_id) === String(hold.policy_id)) {
      // Last resort for a sold listing stuck on the temp profile id in GetItem:
      // the inventory offer already has the original id from switchListingPolicy,
      // or switch reported unchanged because offer matched. Accept offer truth.
      if (String(moved.before || policyId) === String(item.from_policy_id) || moved.unchanged) {
        policyId = item.from_policy_id;
      } else {
        throw new Error(`SKU ${item.sku} is still on policy ${policyId || after?.policy_id}, expected ${item.from_policy_id}`);
      }
    } else {
      throw new Error(`SKU ${item.sku} is still on policy ${policyId || after?.policy_id}, expected ${item.from_policy_id}`);
    }
    if (!ended && item.price && after?.price && String(after.price) !== String(item.price)) {
      throw new Error(`SKU ${item.sku} price changed from ${item.price} to ${after.price}`);
    }
    restored.push({
      sku: item.sku,
      listing_id: item.listing_id,
      policy_id: String(policyId || item.from_policy_id),
      offer_id: moved.offerId,
      offer_status: offerStatus,
    });
  }
  const next = {
    ...hold,
    active: false,
    reverted_at: new Date(now).toISOString(),
    revert_reason: decision.reason,
    restore: restored,
  };
  await writeHold(sb, storeId, next);
  const mail = await tellPaul(sb, storeId, next);
  await floorLog({
    storeId,
    event: "ebay.temp_flat_reverted",
    message: decision.reason,
    detail: { restored, mail: mail?.ok === true ? "sent" : mail?.reason || mail?.error || "skipped" },
  });
  return { ok: true, reverted: true, reason: decision.reason, restored, mail };
}

export async function maybeRevertTempFlat(sb, storeId) {
  const hold = await readHold(sb, storeId);
  if (!hold?.active) return { skipped: true, reason: "not active" };
  return revertTempFlat(sb, { storeId });
}
