import { createHash } from "node:crypto";
import { decryptSecret, encryptSecret, requireEnv, serviceClient } from "./server.mjs";
import { EBAY_OAUTH_SCOPES, ebayHosts, ebayItemViewUrl, ebayRuName } from "./ebay-env.mjs";
import { formatEbayError, locationKey } from "./ebay-errors.mjs";
import { publicPhotoUrl } from "./ebay-photos.mjs";
import { composeChannelDescription, parseListingSpecs } from "./listing-copy.mjs";
import { parseMeasure, specInches } from "./ebay-aspects.mjs";
import { listingMeasures, prepareUnitAspects, prepareUnitCondition } from "./ebay-catalog.mjs";
import { floorLog, redact, setTrace } from "./floor-log.mjs";
import {
  compactShippingCatalog,
  getSellerOrders,
  getShippingServiceDetails,
  pickApplianceShipping,
  tradingOrderIsSale,
  tradingOrderToIngest,
} from "./ebay-trading.mjs";

export { EBAY_OAUTH_SCOPES, ebayHosts, ebayItemViewUrl, ebayRuName, formatEbayError };

export function marketplaceId() {
  return process.env.EBAY_MARKETPLACE_ID || "EBAY_US";
}

function basicAuth() {
  return Buffer.from(`${requireEnv("EBAY_CLIENT_ID")}:${requireEnv("EBAY_CLIENT_SECRET")}`).toString("base64");
}

export async function exchangeEbayCode(code) {
  const { api } = ebayHosts(process.env.EBAY_ENV);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: ebayRuName(process.env.EBAY_RU_NAME),
  });
  const res = await fetch(`${api}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basicAuth()}`, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error_description || json.error || "ebay_token_failed");
  return json;
}

async function refreshEbay(refreshToken) {
  const { api } = ebayHosts(process.env.EBAY_ENV);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: EBAY_OAUTH_SCOPES,
  });
  const res = await fetch(`${api}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basicAuth()}`, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error_description || json.error || "ebay_refresh_failed");
  return json;
}

export async function loadEbayConnection(storeId) {
  const sb = serviceClient();
  const { data, error } = await sb
    .from("connections")
    .select("*")
    .eq("store_id", storeId)
    .eq("provider", "ebay")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || data.status !== "connected" || !data.token_ciphertext) {
    const err = new Error("ebay_not_connected");
    err.code = "ebay_not_connected";
    throw err;
  }
  return data;
}

export async function userToken(storeId) {
  const row = await loadEbayConnection(storeId);
  const exp = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  if (exp > Date.now() + 120_000) return decryptSecret(row.token_ciphertext);
  if (!row.refresh_ciphertext) throw new Error("ebay_needs_reconnect");
  const tokens = await refreshEbay(decryptSecret(row.refresh_ciphertext));
  const access = tokens.access_token;
  const refresh = tokens.refresh_token ? encryptSecret(tokens.refresh_token) : row.refresh_ciphertext;
  const expiresIn = Number(tokens.expires_in || 7200);
  const sb = serviceClient();
  await sb
    .from("connections")
    .update({
      token_ciphertext: encryptSecret(access),
      refresh_ciphertext: refresh,
      expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("store_id", storeId)
    .eq("provider", "ebay");
  return access;
}

export async function ebayFetch(storeId, method, path, body) {
  const { api } = ebayHosts(process.env.EBAY_ENV);
  const token = await userToken(storeId);
  const mutate = method !== "GET";
  if (mutate) {
    await floorLog({
      storeId,
      event: "ebay.request",
      message: `${method} ${path}`,
      detail: { method, path, body: redact(body) },
    });
  }
  const res = await fetch(`${api}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "Content-Language": "en-US",
      "Accept-Language": "en-US",
      "X-EBAY-C-MARKETPLACE-ID": marketplaceId(),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const payload = {
      method,
      path,
      status: res.status,
      errors: json?.errors ?? null,
      warnings: json?.warnings ?? null,
      body: json,
      raw: text?.slice?.(0, 8000) || text || null,
    };
    console.log("ebay_api_error_full", JSON.stringify(payload));
    await floorLog({
      storeId,
      level: "error",
      event: "ebay.error",
      message: `${method} ${path} ${res.status}`,
      detail: payload,
    });
    const msg = formatEbayError(json, text || `eBay HTTP ${res.status}`);
    const err = new Error(msg);
    err.status = res.status;
    err.body = json;
    err.path = path;
    err.raw = text;
    throw err;
  }
  if (mutate) {
    await floorLog({
      storeId,
      event: "ebay.response",
      message: `${method} ${path} ${res.status}`,
      detail: { method, path, status: res.status, body: redact(json) },
    });
  }
  return json;
}

async function quietGet(storeId, path) {
  try {
    return await ebayFetch(storeId, "GET", path);
  } catch (err) {
    return { _error: err instanceof Error ? err.message : String(err), _status: err.status || null, _body: err.body || null };
  }
}

async function inspectOfferChain(storeId, sku, offerId, loc, policies) {
  const [location, item, offer, payment, returns, fulfillment] = await Promise.all([
    quietGet(storeId, `/sell/inventory/v1/location/${loc}`),
    quietGet(storeId, `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`),
    offerId ? quietGet(storeId, `/sell/inventory/v1/offer/${offerId}`) : Promise.resolve(null),
    quietGet(storeId, `/sell/account/v1/payment_policy/${policies.payment}`),
    quietGet(storeId, `/sell/account/v1/return_policy/${policies.returnP}`),
    quietGet(storeId, `/sell/account/v1/fulfillment_policy/${policies.fulfillment}`),
  ]);
  const snapshot = {
    locationKey: loc,
    locationStatus: location?.merchantLocationStatus,
    locationTypes: location?.locationTypes,
    sku: item?.sku || sku,
    condition: item?.condition,
    conditionId: item?.conditionId ?? null,
    quantity: item?.availability?.shipToLocationAvailability?.quantity,
    distributions: item?.availability?.shipToLocationAvailability?.availabilityDistributions,
    pickup: item?.availability?.pickupAtLocationAvailability,
    package: item?.packageWeightAndSize,
    aspects: item?.product?.aspects,
    offerId,
    offerStatus: offer?.status,
    offerCategory: offer?.categoryId,
    offerLocation: offer?.merchantLocationKey,
    offerPolicies: offer?.listingPolicies,
    paymentPolicy: payment?.paymentPolicyId || payment?._error,
    returnPolicy: returns?.returnPolicyId || returns?._error,
    fulfillmentPolicy: fulfillment?.fulfillmentPolicyId || fulfillment?._error,
    fulfillmentPickup: fulfillment?.localPickup,
    fulfillmentShipping: fulfillment?.shippingOptions,
    offerErrors: offer?.errors || offer?.warnings,
    locationError: location?._error,
    itemError: item?._error,
  };
  console.log("ebay_offer_chain", JSON.stringify(snapshot));
  await floorLog({
    storeId,
    sku,
    level: "error",
    event: "ebay.offer_chain",
    message: `inspect ${sku}`,
    detail: snapshot,
  });
  return `chain: ${JSON.stringify(snapshot)}`;
}

async function listOffersForSku(storeId, sku) {
  const market = marketplaceId();
  try {
    const json = await ebayFetch(
      storeId,
      "GET",
      `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${market}&limit=100`,
    );
    return json?.offers || [];
  } catch (err) {
    if (err.status === 404) return [];
    throw err;
  }
}

function flattenAspects(aspects) {
  const out = {};
  if (!aspects || typeof aspects !== "object") return out;
  for (const [name, value] of Object.entries(aspects)) {
    out[name] = Array.isArray(value) ? value.join(", ") : value == null ? "" : String(value);
  }
  return out;
}

/** Live GET of what eBay has for a SKU (inventory item + offer). */
export async function inspectLiveSku(storeId, sku) {
  const sb = serviceClient();
  const { data: row } = await sb
    .from("listings")
    .select("listing_id, offer_id, status")
    .eq("store_id", storeId)
    .eq("sku", sku)
    .eq("channel", "ebay")
    .maybeSingle();
  const item = await quietGet(storeId, `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`);
  let offers = [];
  let offerError = null;
  try {
    offers = await listOffersForSku(storeId, sku);
  } catch (err) {
    offerError = err instanceof Error ? err.message : String(err);
  }
  if (row?.offer_id && !offers.some((o) => String(o.offerId) === String(row.offer_id))) {
    const one = await quietGet(storeId, `/sell/inventory/v1/offer/${row.offer_id}`);
    if (one && !one._error) offers = [one, ...offers];
    else if (one?._error) offerError = offerError || one._error;
  }
  const live =
    offers.find((o) => String(o.status || "").toUpperCase() === "PUBLISHED") || offers[0] || null;
  const listingId =
    live?.listing?.listingId || live?.listingId || row?.listing_id || null;
  const product = item?.product || {};
  return {
    sku,
    listingId,
    offerId: live?.offerId || row?.offer_id || null,
    floorStatus: row?.status || null,
    offerStatus: live?.status || null,
    title: product.title || null,
    price: live?.pricingSummary?.price || null,
    quantity: live?.availableQuantity ?? null,
    condition: item?.condition || null,
    conditionDescription: item?.conditionDescription || null,
    categoryId: live?.categoryId || null,
    photos: product.imageUrls || [],
    aspects: flattenAspects(product.aspects),
    viewUrl: ebayItemViewUrl(listingId),
    itemError: item?._error || null,
    offerError,
  };
}

async function deleteOffer(storeId, offerId) {
  try {
    await ebayFetch(storeId, "DELETE", `/sell/inventory/v1/offer/${offerId}`);
  } catch (err) {
    if (err.status === 404 || /25713|not available|not found/i.test(err.message)) return;
    throw err;
  }
}

async function resetUnpublishedOffers(storeId, sku) {
  const offers = await listOffersForSku(storeId, sku);
  console.log(
    "ebay_existing_offers",
    JSON.stringify(
      offers.map((row) => ({
        offerId: row.offerId,
        status: row.status,
        listingId: row.listing?.listingId || row.listingId || null,
        location: row.merchantLocationKey,
        policies: row.listingPolicies,
      })),
    ),
  );
  const live = offers.find(
    (row) =>
      String(row.status || "").toUpperCase() === "PUBLISHED" && (row.listing?.listingId || row.listingId),
  );
  if (live) return live;
  for (const row of offers) {
    console.log("ebay_delete_stale_offer", JSON.stringify({ offerId: row.offerId, status: row.status }));
    await deleteOffer(storeId, row.offerId);
  }
  return null;
}

async function ensureLocation(storeId) {
  const key = locationKey(storeId);
  const body = {
    name: "Floor warehouse",
    merchantLocationStatus: "ENABLED",
    locationTypes: ["WAREHOUSE"],
    location: {
      address: {
        addressLine1: process.env.EBAY_LOCATION_LINE1 || "2051 Challenge Way",
        city: process.env.EBAY_LOCATION_CITY || "Roseville",
        stateOrProvince: process.env.EBAY_LOCATION_REGION || "CA",
        postalCode: process.env.EBAY_LOCATION_POSTAL || "95678",
        country: process.env.EBAY_LOCATION_COUNTRY || "US",
      },
    },
  };
  let existing = null;
  try {
    existing = await ebayFetch(storeId, "GET", `/sell/inventory/v1/location/${key}`);
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  if (!existing) {
    try {
      await ebayFetch(storeId, "POST", `/sell/inventory/v1/location/${key}`, body);
    } catch (err) {
      if (!/already exists|duplicate/i.test(err.message)) throw err;
    }
  }
  try {
    await ebayFetch(storeId, "POST", `/sell/inventory/v1/location/${key}/enable`);
  } catch (err) {
    if (!/already|enabled/i.test(err.message)) {
      console.log("ebay_location_enable", err instanceof Error ? err.message : String(err));
    }
  }
  const ready = await ebayFetch(storeId, "GET", `/sell/inventory/v1/location/${key}`);
  if (String(ready?.merchantLocationStatus || "").toUpperCase() !== "ENABLED") {
    throw new Error(
      `eBay merchant location ${key} is ${ready?.merchantLocationStatus || "missing"}, not ENABLED. ${formatEbayError(ready)}`,
    );
  }
  return key;
}

async function listPolicies(storeId, kind) {
  const market = marketplaceId();
  const json = await ebayFetch(storeId, "GET", `/sell/account/v1/${kind}_policy?marketplace_id=${market}`);
  return json?.[`${kind}Policies`] || json?.policies || [];
}

function policyIdOf(row, kind) {
  return row?.[`${kind}PolicyId`] || row?.policyId || row?.id || null;
}

function hasSellingPolicyProgram(json) {
  const programs = json?.programs || [];
  return programs.some((p) => String(p.programType || p.program || p) === "SELLING_POLICY_MANAGEMENT");
}

async function optInToSellingPolicies(storeId) {
  try {
    const current = await ebayFetch(storeId, "GET", "/sell/account/v1/program/get_opted_in_programs");
    if (hasSellingPolicyProgram(current)) return;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/not found|no program|opted.in/i.test(message)) {
      // Still try opt-in; empty sandbox accounts often 404 this GET.
      console.log("ebay_list_programs", message);
    }
  }
  try {
    await ebayFetch(storeId, "POST", "/sell/account/v1/program/opt_in", {
      programType: "SELLING_POLICY_MANAGEMENT",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/already opted|already enrolled|duplicate/i.test(message)) return;
    throw err;
  }
}

function isPickupOnlyPolicy(policy) {
  if (!policy?.localPickup) return false;
  const services = (policy.shippingOptions || []).flatMap((opt) => opt?.shippingServices || []);
  return services.length === 0 && !policy.freightShipping;
}

function pickupOnlyBody(market, name = "Floor pickup") {
  // Account API: pickup-only is valid (no shippingOptions / handlingTime). Flat-rate codes are for shipped items.
  return {
    name,
    marketplaceId: market,
    categoryTypes: [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES", default: true }],
    localPickup: true,
    freightShipping: false,
    pickupDropOff: false,
    globalShipping: false,
  };
}

function shippingPolicyBody(market, name, service) {
  const flat = (service.serviceTypes || []).some((t) => /^flat$/i.test(t));
  return {
    ...pickupOnlyBody(market, name),
    handlingTime: { value: 2, unit: "DAY" },
    shippingOptions: [
      {
        optionType: "DOMESTIC",
        costType: flat ? "FLAT_RATE" : "CALCULATED",
        shippingServices: [
          {
            sortOrder: 1,
            shippingServiceCode: service.shippingService,
            ...(service.shippingCarrier ? { shippingCarrierCode: service.shippingCarrier } : {}),
            freeShipping: true,
            ...(flat
              ? {
                  shippingCost: { value: "0.0", currency: "USD" },
                  additionalShippingCost: { value: "0.0", currency: "USD" },
                }
              : {}),
            buyerResponsibleForShipping: false,
            buyerResponsibleForPickup: false,
          },
        ],
      },
    ],
  };
}

async function saveFulfillmentPolicy(storeId, id, body) {
  if (id) {
    const updated = await ebayFetch(storeId, "PUT", `/sell/account/v1/fulfillment_policy/${id}`, body);
    return updated.fulfillmentPolicyId || updated.id || id;
  }
  const created = await ebayFetch(storeId, "POST", "/sell/account/v1/fulfillment_policy", body);
  return created.fulfillmentPolicyId || created.id;
}

async function createFulfillmentPolicy(storeId, market, existing) {
  const name = existing?.name || "Floor pickup";
  const id = existing ? policyIdOf(existing, "fulfillment") : null;
  if (existing && id && isPickupOnlyPolicy(existing)) {
    console.log("ebay_fulfillment_policy", JSON.stringify({ mode: "pickup_only", reused: true }));
    return id;
  }

  try {
    const saved = await saveFulfillmentPolicy(storeId, id, pickupOnlyBody(market, name));
    console.log("ebay_fulfillment_policy", JSON.stringify({ mode: "pickup_only", reused: false }));
    return saved;
  } catch (pickupErr) {
    const pickupMsg = pickupErr instanceof Error ? pickupErr.message : String(pickupErr);
    console.log("ebay_fulfillment_pickup_only", pickupMsg);
    if (!/shipping service|shippingservice|domestic|freight|fulfillment|handling/i.test(pickupMsg)) throw pickupErr;
  }

  const catalog = await getShippingServiceDetails(await userToken(storeId));
  const pick = pickApplianceShipping(catalog);
  console.log(
    "ebay_shipping_services",
    JSON.stringify({
      picked: pick,
      services: compactShippingCatalog(catalog),
    }),
  );
  if (!pick) {
    throw new Error(
      "Pickup-only fulfillment was rejected and eBay returned no valid freight/local-delivery shipping service for US. See ebay_shipping_services in function logs.",
    );
  }
  return saveFulfillmentPolicy(storeId, id, shippingPolicyBody(market, name, pick));
}

async function ensurePaymentPolicy(storeId, market, existing) {
  let id = policyIdOf(existing, "payment");
  let current = existing;
  if (id) {
    try {
      current = await ebayFetch(storeId, "GET", `/sell/account/v1/payment_policy/${id}`);
    } catch {
      current = existing;
    }
  }
  if (id && current?.immediatePay === false) return String(id);
  const body = {
    name: current?.name || "Floor payments",
    marketplaceId: current?.marketplaceId || market,
    categoryTypes: current?.categoryTypes?.length
      ? current.categoryTypes
      : [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES", default: true }],
    immediatePay: false,
  };
  if (id) {
    const updated = await ebayFetch(storeId, "PUT", `/sell/account/v1/payment_policy/${id}`, body);
    return String(updated.paymentPolicyId || updated.id || id);
  }
  const created = await ebayFetch(storeId, "POST", "/sell/account/v1/payment_policy", body);
  return String(created.paymentPolicyId || created.id);
}

async function ensurePolicies(storeId) {
  const market = marketplaceId();
  await optInToSellingPolicies(storeId);
  const payments = await listPolicies(storeId, "payment");
  const returns = await listPolicies(storeId, "return");
  const fulfillments = await listPolicies(storeId, "fulfillment");

  let returnP = policyIdOf(returns[0], "return");
  const payment = await ensurePaymentPolicy(storeId, market, payments[0]);
  if (!returnP) {
    const created = await ebayFetch(storeId, "POST", "/sell/account/v1/return_policy", {
      name: "Floor returns",
      marketplaceId: market,
      categoryTypes: [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES", default: true }],
      returnsAccepted: true,
      returnPeriod: { value: 30, unit: "DAY" },
      refundMethod: "MONEY_BACK",
      returnShippingCostPayer: "BUYER",
    });
    returnP = created.returnPolicyId || created.id;
  }
  const fulfillment = await createFulfillmentPolicy(storeId, market, fulfillments[0]);
  if (!payment || !returnP || !fulfillment) {
    throw new Error("eBay did not return payment, return, and fulfillment policy IDs after create.");
  }
  return { payment, returnP, fulfillment };
}

async function applicationToken() {
  const { api } = ebayHosts(process.env.EBAY_ENV);
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "https://api.ebay.com/oauth/api_scope",
  });
  const res = await fetch(`${api}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basicAuth()}`, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error_description || json.error || "ebay_app_token_failed");
  return json.access_token;
}

async function categoryId(storeId, query, hint) {
  const market = marketplaceId();
  try {
    const { api } = ebayHosts(process.env.EBAY_ENV);
    const token = await applicationToken();
    const treeRes = await fetch(
      `${api}/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${market}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const tree = await treeRes.json();
    const treeId = tree?.categoryTreeId;
    if (!treeId) return "20713";
    const sugRes = await fetch(
      `${api}/commerce/taxonomy/v1/category_tree/${treeId}/get_category_suggestions?q=${encodeURIComponent(query || hint || "refrigerator")}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const sug = await sugRes.json();
    const rows = sug?.categorySuggestions || [];
    const needle = String(hint || "").toLowerCase();
    const named = needle
      ? rows.find((row) => String(row?.category?.categoryName || "").toLowerCase().includes(needle))
      : null;
    return named?.category?.categoryId || rows[0]?.category?.categoryId || "20713";
  } catch {
    return "20713";
  }
}

async function catalogEpid(storeId, unit) {
  const brand = String(unit.brand || "").trim();
  const specs = parseListingSpecs(unit.listing_specs);
  const mpn = String(specs?.matched_model || unit.model || "").trim();
  if (!brand || !mpn) return null;
  try {
    const q = encodeURIComponent(`${brand} ${mpn}`);
    const data = await ebayFetch(
      storeId,
      "GET",
      `/commerce/catalog/v1_beta/product_summary/search?q=${q}&limit=8`,
    );
    const rows = data?.productSummaries || [];
    const needle = mpn.replace(/[^a-z0-9]/gi, "").toUpperCase();
    const hit =
      rows.find((row) => String(row.mpn || "").replace(/[^a-z0-9]/gi, "").toUpperCase() === needle) ||
      rows.find((row) => String(row.mpn || "").replace(/[^a-z0-9]/gi, "").toUpperCase().includes(needle)) ||
      rows[0];
    const epid = hit?.epid || hit?.product?.epid;
    return epid ? String(epid) : null;
  } catch {
    return null;
  }
}

async function photoUrls(storeId, sku) {
  const sb = serviceClient();
  const { data } = await sb
    .from("photos")
    .select("path, is_primary")
    .eq("store_id", storeId)
    .eq("sku", sku)
    .order("is_primary", { ascending: false });
  const keys = (data ?? [])
    .map((row) => row.path)
    .filter((path) => path && !String(path).includes("/official-"));
  if (!keys.length) throw new Error(`SKU ${sku} has no photos. Add at least one before listing on eBay.`);
  return keys.slice(0, 12).map((path) => publicPhotoUrl(path));
}

function money(cents) {
  return (Number(cents) / 100).toFixed(2);
}

async function categoryTreeId() {
  const market = marketplaceId();
  const { api } = ebayHosts(process.env.EBAY_ENV);
  const token = await applicationToken();
  const treeRes = await fetch(
    `${api}/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${market}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const tree = await treeRes.json();
  return { api, token, treeId: tree?.categoryTreeId || "0" };
}

async function itemAspects(storeId, unit) {
  const prepared = await prepareUnitAspects({ storeId, unit, liveCheck: true });
  if (!prepared.ready) {
    const err = new Error(
      `eBay still needs: ${prepared.missingRequired.join("; ")}. Set them on the unit’s eBay details, then tap E again.`,
    );
    err.code = "ebay_aspects_missing";
    err.missing = prepared.missingRequired;
    err.refreshed = prepared.refreshed;
    throw err;
  }
  return { aspects: prepared.aspects, categoryId: prepared.floor.ebayCategoryId, floor: prepared.floor };
}

function packageSize(unit) {
  const specs = listingMeasures(unit);
  const width = specInches(specs, "width") || parseMeasure(specs.width_in);
  const height = specInches(specs, "height") || parseMeasure(specs.height_in);
  const depth = specInches(specs, "depth") || parseMeasure(specs.depth_in);
  const weight = parseMeasure(specs.weight_lb || specs.weight_lbs);
  return {
    dimensions: {
      length: String(depth || 32),
      width: String(width || 32),
      height: String(height || 70),
      unit: "INCH",
    },
    weight: {
      value: String(weight > 0 ? weight : 300),
      unit: "POUND",
    },
  };
}

function listingCopy(unit) {
  const name = [unit.brand, unit.model].filter((p) => String(p || "").trim()).join(" ").trim() || unit.title || `SKU ${unit.sku}`;
  const titleBits = [name, unit.condition, unit.category].filter((p) => p && String(p).trim());
  let title = titleBits.join(" — ");
  title += ` | SKU ${unit.sku}`;
  if (title.length > 80) title = title.slice(0, 77) + "...";
  const description = composeChannelDescription({
    listingBody: unit.listing_body,
    brand: unit.brand,
    model: unit.model,
    title: unit.title,
    specs: parseListingSpecs(unit.listing_specs),
    condition: unit.condition,
    testStatus: unit.test_status,
    defectNotes: unit.defect_notes,
    sku: unit.sku,
  });
  return { title, description };
}

export async function listSku(storeId, sku) {
  setTrace({ storeId, sku, source: "ebay-list" });
  const sb = serviceClient();
  const { data: unit, error } = await sb.from("units").select("*").eq("store_id", storeId).eq("sku", sku).maybeSingle();
  if (error) throw new Error(error.message);
  if (!unit) throw new Error(`No unit ${sku}`);
  if (unit.state !== "available" && unit.state !== "reserved") {
    throw new Error(`SKU ${sku} is ${unit.state}, not for sale.`);
  }
  if (unit.ask_cents == null || unit.ask_cents <= 0) {
    throw new Error(`SKU ${sku} needs a price before it can go on eBay.`);
  }
  const images = await photoUrls(storeId, sku);
  const epid = await catalogEpid(storeId, unit);
  const loc = await ensureLocation(storeId);
  const copy = listingCopy(unit);
  const { aspects, categoryId: cat } = await itemAspects(storeId, unit);
  const condition = await prepareUnitCondition({ unit, liveCheck: true });
  const pkg = packageSize(unit);
  const policies = await ensurePolicies(storeId);

  await floorLog({
    storeId,
    sku,
    event: "list.plan",
    message: `list ${sku}`,
    detail: {
      floorGrade: unit.condition,
      category: unit.category,
      categoryId: cat,
      mapped: condition.mapped,
      payload: condition.payload,
      allowed: condition.allowed,
      epid,
      location: loc,
      policies,
      aspectKeys: Object.keys(aspects || {}),
      askCents: unit.ask_cents,
    },
  });

  const live = await resetUnpublishedOffers(storeId, sku);
  await ebayFetch(storeId, "PUT", `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, {
    availability: {
      shipToLocationAvailability: {
        quantity: 1,
        availabilityDistributions: [{ merchantLocationKey: loc, quantity: 1 }],
      },
    },
    ...condition.payload,
    conditionDescription: unit.defect_notes || undefined,
    packageWeightAndSize: pkg,
    product: {
      title: copy.title,
      description: copy.description,
      imageUrls: images,
      brand: unit.brand || undefined,
      mpn: unit.model || undefined,
      aspects,
      ...(epid ? { epid } : {}),
    },
  });
  const storedItem = await quietGet(storeId, `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`);
  await floorLog({
    storeId,
    sku,
    event: "list.inventory_stored",
    detail: {
      condition: storedItem?.condition ?? null,
      conditionId: storedItem?.conditionId ?? storedItem?.conditionDescriptors ?? null,
      conditionDescription: storedItem?.conditionDescription ?? null,
      error: storedItem?._error ?? null,
    },
  });

  const offerBody = {
    sku,
    marketplaceId: marketplaceId(),
    format: "FIXED_PRICE",
    availableQuantity: 1,
    categoryId: cat,
    listingDescription: copy.description,
    listingPolicies: {
      fulfillmentPolicyId: policies.fulfillment,
      paymentPolicyId: policies.payment,
      returnPolicyId: policies.returnP,
    },
    merchantLocationKey: loc,
    listingDuration: "GTC",
    pricingSummary: { price: { value: money(unit.ask_cents), currency: "USD" } },
  };

  let offerId = live?.offerId || null;
  let published = live;
  if (live?.listing?.listingId || live?.listingId) {
    published = live;
  } else {
    const created = await ebayFetch(storeId, "POST", "/sell/inventory/v1/offer", offerBody);
    offerId = created.offerId;
    try {
      published = await ebayFetch(storeId, "POST", `/sell/inventory/v1/offer/${offerId}/publish`);
    } catch (err) {
      const first = formatEbayError(err.body, err instanceof Error ? err.message : String(err));
      console.log("ebay_publish_retry", JSON.stringify({ offerId, error: first, ebay: err.body }));
      await deleteOffer(storeId, offerId);
      const retry = await ebayFetch(storeId, "POST", "/sell/inventory/v1/offer", offerBody);
      offerId = retry.offerId;
      try {
        published = await ebayFetch(storeId, "POST", `/sell/inventory/v1/offer/${offerId}/publish`);
      } catch (again) {
        await inspectOfferChain(storeId, sku, offerId, loc, policies);
        throw again;
      }
    }
  }
  const listingId = published.listingId || published.listing?.listingId || null;
  await sb.from("listings").upsert(
    {
      store_id: storeId,
      sku,
      channel: "ebay",
      status: "listed",
      listing_id: listingId,
      offer_id: offerId,
      listed_at: new Date().toISOString(),
      delisted_at: null,
    },
    { onConflict: "store_id,sku,channel" },
  );
  return { sku, offerId, listingId, viewUrl: ebayItemViewUrl(listingId) };
}

export async function withdrawSku(storeId, sku) {
  const sb = serviceClient();
  const { data: row } = await sb
    .from("listings")
    .select("*")
    .eq("store_id", storeId)
    .eq("sku", sku)
    .eq("channel", "ebay")
    .maybeSingle();
  let offerId = row?.offer_id;
  if (!offerId) {
    const offers = await ebayFetch(storeId, "GET", `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}`);
    offerId = offers?.offers?.[0]?.offerId;
  }
  if (offerId) {
    try {
      await ebayFetch(storeId, "POST", `/sell/inventory/v1/offer/${offerId}/withdraw`, {
        listingId: row?.listing_id || undefined,
      });
    } catch (err) {
      if (!/already|not published|unpublished/i.test(err.message)) throw err;
    }
  }
  await sb.from("listings").upsert(
    {
      store_id: storeId,
      sku,
      channel: "ebay",
      status: "delisted",
      listing_id: row?.listing_id ?? null,
      offer_id: offerId ?? row?.offer_id ?? null,
      delisted_at: new Date().toISOString(),
    },
    { onConflict: "store_id,sku,channel" },
  );
  await sb
    .from("delist_tasks")
    .update({ completed_at: new Date().toISOString() })
    .eq("store_id", storeId)
    .eq("sku", sku)
    .eq("channel", "ebay")
    .is("completed_at", null);
  return { sku, offerId };
}

/** Clear Floor's E when eBay already ended the offer (Seller Hub / API withdraw). */
export async function reconcileListedOffers(storeId) {
  const sb = serviceClient();
  const { data, error } = await sb
    .from("listings")
    .select("sku, offer_id, listing_id")
    .eq("store_id", storeId)
    .eq("channel", "ebay")
    .eq("status", "listed");
  if (error) throw new Error(error.message);
  const results = [];
  for (const row of data ?? []) {
    let offers = [];
    try {
      offers = await listOffersForSku(storeId, row.sku);
    } catch (err) {
      results.push({ sku: row.sku, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const live = offers.find(
      (o) =>
        String(o.status || "").toUpperCase() === "PUBLISHED" && (o.listing?.listingId || o.listingId),
    );
    if (live) {
      results.push({ sku: row.sku, listed: true });
      continue;
    }
    await sb.from("listings").upsert(
      {
        store_id: storeId,
        sku: row.sku,
        channel: "ebay",
        status: "delisted",
        listing_id: row.listing_id ?? null,
        offer_id: row.offer_id ?? null,
        delisted_at: new Date().toISOString(),
      },
      { onConflict: "store_id,sku,channel" },
    );
    results.push({ sku: row.sku, cleared: true });
  }
  return results;
}

export async function withdrawOpenEbayTasks() {
  const sb = serviceClient();
  const { data, error } = await sb
    .from("delist_tasks")
    .select("store_id, sku")
    .eq("channel", "ebay")
    .is("completed_at", null);
  if (error) throw new Error(error.message);
  const results = [];
  for (const row of data ?? []) {
    try {
      await withdrawSku(row.store_id, row.sku);
      results.push({ sku: row.sku, ok: true });
    } catch (err) {
      results.push({ sku: row.sku, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

function orderSku(order) {
  const items = order?.lineItems || [];
  for (const item of items) {
    if (item.sku) return String(item.sku);
  }
  return null;
}

function orderCents(order) {
  const total = order?.pricingSummary?.total?.value ?? order?.lineItems?.[0]?.total?.value;
  const n = Number(total);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

export async function ingestEbayOrder(storeId, order) {
  const orderId = order?.orderId;
  const sku = orderSku(order);
  if (!orderId || !sku) return { skipped: true };
  const sb = serviceClient();
  const seen = await sb
    .from("channel_orders")
    .select("order_id")
    .eq("store_id", storeId)
    .eq("provider", "ebay")
    .eq("order_id", orderId)
    .maybeSingle();
  if (seen.data) return { skipped: true, sku, orderId };

  const { data: sale, error } = await sb.rpc("finalize_sale", {
    p_sku: sku,
    p_channel: "ebay",
    p_price_cents: orderCents(order) || 0,
    p_payment_method: "ebay",
    p_payment_id: `ebay:${orderId}`,
    p_note: "eBay order",
    p_tax_cents: 0,
    p_approval_id: null,
  });
  if (error) {
    if (/unit_not_sellable|duplicate key|23505/i.test(error.message)) {
      await withdrawSku(storeId, sku).catch(() => undefined);
    }
    throw new Error(error.message);
  }
  await sb.from("channel_orders").insert({
    store_id: storeId,
    provider: "ebay",
    order_id: orderId,
    sku,
    sale_id: sale?.id ?? null,
  });
  await sb.from("listings").upsert(
    {
      store_id: storeId,
      sku,
      channel: "ebay",
      status: "delisted",
      delisted_at: new Date().toISOString(),
    },
    { onConflict: "store_id,sku,channel" },
  );
  await withdrawSku(storeId, sku).catch(() => undefined);
  return { sku, orderId, saleId: sale?.id };
}

function fulfillmentOrdersPath() {
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 24 * 3600 * 1000);
  const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, ".000Z");
  const filter = encodeURIComponent(`creationdate:[${iso(start)}..${iso(end)}]`);
  return `/sell/fulfillment/v1/order?limit=50&filter=${filter}`;
}

async function listedSoldBySku(storeId) {
  const sb = serviceClient();
  const { data, error } = await sb
    .from("listings")
    .select("sku, listing_id, offer_id")
    .eq("store_id", storeId)
    .eq("channel", "ebay")
    .eq("status", "listed");
  if (error) throw new Error(error.message);
  const soldQty = {};
  const extras = [];
  for (const row of data ?? []) {
    let offers = [];
    try {
      offers = await listOffersForSku(storeId, row.sku);
    } catch {
      offers = [];
    }
    const live =
      offers.find((o) => String(o.offerId) === String(row.offer_id)) ||
      offers.find((o) => String(o.status || "").toUpperCase() === "PUBLISHED") ||
      offers[0];
    const soldQuantity = Number(live?.listing?.soldQuantity || 0);
    soldQty[row.sku] = soldQuantity;
    if (soldQuantity >= 1) {
      extras.push({
        sku: row.sku,
        listingId: live?.listing?.listingId || live?.listingId || row.listing_id,
        price: live?.pricingSummary?.price?.value || "0",
        soldQuantity,
      });
    }
  }
  return { soldQty, extras };
}

async function ingestFrom(storeId, order, source, bag) {
  const sku = orderSku(order);
  const orderId = order?.orderId;
  if (!orderId || !sku) return;
  if (bag.skus.has(sku) || bag.orders.has(orderId)) return;
  try {
    const row = await ingestEbayOrder(storeId, order);
    bag.results.push({ ...row, source });
    bag.orders.add(orderId);
    if (row?.sku) bag.skus.add(row.sku);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/unit_not_sellable|duplicate key|23505/i.test(message)) {
      bag.skus.add(sku);
      bag.results.push({ sku, orderId, source, skipped: true, reason: "already_sold" });
      return;
    }
    bag.results.push({ orderId, sku, source, error: message });
  }
}

export async function pollEbayOrders(storeId) {
  const bag = { results: [], skus: new Set(), orders: new Set() };
  try {
    const json = await ebayFetch(storeId, "GET", fulfillmentOrdersPath());
    for (const order of json?.orders ?? []) {
      await ingestFrom(storeId, order, "fulfillment", bag);
    }
  } catch (err) {
    bag.results.push({ source: "fulfillment", error: err instanceof Error ? err.message : String(err) });
  }

  let soldQty = {};
  let extras = [];
  try {
    const listed = await listedSoldBySku(storeId);
    soldQty = listed.soldQty;
    extras = listed.extras;
  } catch (err) {
    bag.results.push({ source: "sold_quantity", error: err instanceof Error ? err.message : String(err) });
  }

  try {
    const trading = await getSellerOrders(await userToken(storeId));
    for (const order of trading) {
      if (!tradingOrderIsSale(order, soldQty)) continue;
      await ingestFrom(storeId, tradingOrderToIngest(order), "trading", bag);
    }
  } catch (err) {
    bag.results.push({ source: "trading", error: err instanceof Error ? err.message : String(err) });
  }

  for (const row of extras) {
    await ingestFrom(
      storeId,
      {
        orderId: `ebay-sold:${row.listingId || row.sku}`,
        lineItems: [{ sku: row.sku, total: { value: String(row.price) } }],
        pricingSummary: { total: { value: String(row.price) } },
      },
      "sold_quantity",
      bag,
    );
  }
  return bag.results;
}

export async function pollAllStores() {
  const sb = serviceClient();
  const { data, error } = await sb.from("connections").select("store_id").eq("provider", "ebay").eq("status", "connected");
  if (error) throw new Error(error.message);
  const out = [];
  for (const row of data ?? []) {
    try {
      out.push({ storeId: row.store_id, orders: await pollEbayOrders(row.store_id) });
    } catch (err) {
      out.push({ storeId: row.store_id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

export function notificationChallenge(challengeCode, endpoint, verificationToken) {
  return createHash("sha256").update(challengeCode + verificationToken + endpoint).digest("hex");
}

export async function subscribeNotifications(storeId) {
  const endpoint = requireEnv("EBAY_NOTIFICATION_ENDPOINT");
  const token = requireEnv("EBAY_NOTIFICATION_TOKEN");
  const dests = await ebayFetch(storeId, "GET", "/commerce/notification/v1/destination");
  let destinationId = dests?.destinations?.[0]?.destinationId;
  if (!destinationId) {
    const created = await ebayFetch(storeId, "POST", "/commerce/notification/v1/destination", {
      name: "Floor",
      status: "ENABLED",
      deliveryConfig: { endpoint, verificationToken: token },
    });
    destinationId = created.destinationId;
  }
  const subs = await ebayFetch(storeId, "GET", "/commerce/notification/v1/subscription");
  const have = new Set((subs?.subscriptions ?? []).map((s) => s.topicId));
  if (destinationId) {
    for (const topicId of ["MARKETPLACE_ACCOUNT_DELETION", "ORDER_CONFIRMATION"]) {
      if (have.has(topicId)) continue;
      try {
        await ebayFetch(storeId, "POST", "/commerce/notification/v1/subscription", {
          topicId,
          status: "ENABLED",
          destinationId,
        });
      } catch (err) {
        console.log("ebay_notify_subscribe", topicId, err instanceof Error ? err.message : String(err));
      }
    }
  }
  return { destinationId };
}
