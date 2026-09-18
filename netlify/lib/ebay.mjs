import { createHash } from "node:crypto";
import { decryptSecret, encryptSecret, requireEnv, serviceClient } from "./server.mjs";
import { EBAY_OAUTH_SCOPES, ebayCondition, ebayHosts, ebayRuName } from "./ebay-env.mjs";

export { EBAY_OAUTH_SCOPES, ebayHosts, ebayRuName };

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
  const res = await fetch(`${api}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "Content-Language": "en-US",
      "Accept-Language": "en-US",
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
    const msg =
      json?.errors?.[0]?.message ||
      json?.error_description ||
      json?.error ||
      text ||
      `ebay ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

function locationKey(storeId) {
  return `floor-${String(storeId).replace(/-/g, "").slice(0, 12)}`;
}

async function ensureLocation(storeId) {
  const key = locationKey(storeId);
  try {
    await ebayFetch(storeId, "GET", `/sell/inventory/v1/location/${key}`);
    return key;
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  await ebayFetch(storeId, "POST", `/sell/inventory/v1/location/${key}`, {
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
  });
  return key;
}

async function firstPolicy(storeId, kind) {
  const market = marketplaceId();
  const json = await ebayFetch(storeId, "GET", `/sell/account/v1/${kind}_policy?marketplace_id=${market}`);
  const list = json?.[`${kind}Policies`] || json?.policies || [];
  if (list[0]?.[`${kind}PolicyId`] || list[0]?.policyId) {
    return list[0][`${kind}PolicyId`] || list[0].policyId;
  }
  return null;
}

async function ensurePolicies(storeId) {
  const market = marketplaceId();
  let fulfillment = await firstPolicy(storeId, "fulfillment");
  let payment = await firstPolicy(storeId, "payment");
  let returnP = await firstPolicy(storeId, "return");

  if (!payment) {
    const created = await ebayFetch(storeId, "POST", "/sell/account/v1/payment_policy", {
      name: "Floor payments",
      marketplaceId: market,
      categoryTypes: [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES", default: true }],
      paymentMethods: [{ paymentMethodType: "PERSONAL_CHECK" }],
      immediatePay: false,
    });
    payment = created.paymentPolicyId || created.id;
  }
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
  if (!fulfillment) {
    const created = await ebayFetch(storeId, "POST", "/sell/account/v1/fulfillment_policy", {
      name: "Floor shipping",
      marketplaceId: market,
      categoryTypes: [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES", default: true }],
      handlingTime: { value: 3, unit: "DAY" },
      shippingOptions: [
        {
          optionType: "DOMESTIC",
          costType: "FLAT_RATE",
          shippingServices: [
            {
              sortOrder: 1,
              shippingCarrierCode: "USPS",
              shippingServiceCode: "USPSGround",
              shippingCost: { value: "15.00", currency: "USD" },
              freeShipping: false,
              buyerResponsibleForShipping: false,
            },
          ],
        },
      ],
    });
    fulfillment = created.fulfillmentPolicyId || created.id;
  }
  if (!payment || !returnP || !fulfillment) {
    throw new Error(
      "eBay needs payment, return, and shipping business policies. Open sandbox Seller Hub → Account → Business policies, then try listing again.",
    );
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

async function categoryId(storeId, query) {
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
    if (!treeId) return "58058";
    const sugRes = await fetch(
      `${api}/commerce/taxonomy/v1/category_tree/${treeId}/get_category_suggestions?q=${encodeURIComponent(query || "appliance")}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const sug = await sugRes.json();
    return sug?.categorySuggestions?.[0]?.category?.categoryId || "58058";
  } catch {
    return "58058";
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
  const keys = (data ?? []).map((row) => row.path).filter(Boolean);
  if (!keys.length) throw new Error(`SKU ${sku} has no photos. Add at least one before listing on eBay.`);
  const signed = await sb.storage.from("unit-photos").createSignedUrls(keys.slice(0, 12), 60 * 60 * 24 * 7);
  if (signed.error) throw new Error(signed.error.message);
  const urls = (signed.data ?? []).map((row) => row.signedUrl).filter(Boolean);
  if (!urls.length) throw new Error(`Could not sign photos for SKU ${sku}.`);
  return urls;
}

function money(cents) {
  return (Number(cents) / 100).toFixed(2);
}

function listingCopy(unit) {
  const name = [unit.brand, unit.model].filter((p) => String(p || "").trim()).join(" ").trim() || unit.title || `SKU ${unit.sku}`;
  const titleBits = [name, unit.condition, unit.category].filter((p) => p && String(p).trim());
  let title = titleBits.join(" — ");
  title += ` | SKU ${unit.sku}`;
  if (title.length > 80) title = title.slice(0, 77) + "...";
  const lines = [
    name,
    "",
    unit.category ? `Category: ${unit.category}` : "",
    unit.condition ? `Condition: ${unit.condition}` : "",
    unit.test_status ? `Test status: ${unit.test_status}` : "",
    `SKU: ${unit.sku}`,
    "",
    (unit.defect_notes || "").trim() ? `Notes:\n${unit.defect_notes}` : "",
    "",
    "Sold as-is. Local pickup unless arranged.",
  ].filter((line) => line !== "");
  return { title, description: lines.join("\n") };
}

export async function listSku(storeId, sku) {
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
  const loc = await ensureLocation(storeId);
  const policies = await ensurePolicies(storeId);
  const copy = listingCopy(unit);
  const cat = await categoryId(storeId, [unit.brand, unit.model, unit.title, unit.category].filter(Boolean).join(" "));

  await ebayFetch(storeId, "PUT", `/sell/inventory/v1/inventory_item/${sku}`, {
    availability: { shipToLocationAvailability: { quantity: 1 } },
    condition: ebayCondition(unit.condition),
    conditionDescription: unit.defect_notes || undefined,
    product: {
      title: copy.title,
      description: copy.description,
      imageUrls: images,
      brand: unit.brand || undefined,
      mpn: unit.model || undefined,
    },
  });

  const offers = await ebayFetch(storeId, "GET", `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}`);
  let offerId = offers?.offers?.[0]?.offerId;
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
    pricingSummary: { price: { value: money(unit.ask_cents), currency: "USD" } },
  };
  if (offerId) {
    await ebayFetch(storeId, "PUT", `/sell/inventory/v1/offer/${offerId}`, offerBody);
  } else {
    const created = await ebayFetch(storeId, "POST", "/sell/inventory/v1/offer", offerBody);
    offerId = created.offerId;
  }
  const published = await ebayFetch(storeId, "POST", `/sell/inventory/v1/offer/${offerId}/publish`);
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
  return { sku, offerId, listingId };
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
  return { sku, orderId, saleId: sale?.id };
}

export async function pollEbayOrders(storeId) {
  const json = await ebayFetch(
    storeId,
    "GET",
    "/sell/fulfillment/v1/order?limit=50&filter=orderfulfillmentstatus:%7BNOT_STARTED%7CIN_PROGRESS%7D",
  );
  const results = [];
  for (const order of json?.orders ?? []) {
    try {
      results.push(await ingestEbayOrder(storeId, order));
    } catch (err) {
      results.push({ orderId: order.orderId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
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
  const have = (subs?.subscriptions ?? []).some((s) => s.topicId === "ORDER_CONFIRMATION");
  if (!have && destinationId) {
    await ebayFetch(storeId, "POST", "/commerce/notification/v1/subscription", {
      topicId: "ORDER_CONFIRMATION",
      status: "ENABLED",
      destinationId,
    });
  }
  return { destinationId };
}
