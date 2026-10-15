/**
 * Business policies for the store selling account.
 * Required: Calculated Shipping – Buyer Pays (no free shipping, no local pickup),
 * NO returns (as-is), and a payment policy.
 */
import { ebayFetchAccount, markAccountPolicies, userTokenForAccount } from "./ebay-accounts.mjs";
import { marketplaceIdFromEnv } from "./ebay-env.mjs";
import {
  compactShippingCatalog,
  getShippingServiceDetails,
  pickApplianceShipping,
} from "./ebay-trading.mjs";

const POLICY_NAMES = {
  payment: "OBI Payments",
  returnP: "OBI No Returns – As Is",
  fulfillment: "OBI Calculated Shipping – Buyer Pays",
};

function policyIdOf(row, kind) {
  return row?.[`${kind}PolicyId`] || row?.policyId || row?.id || null;
}

function hasSellingPolicyProgram(json) {
  const programs = json?.programs || [];
  return programs.some((p) => String(p.programType || p.program || p) === "SELLING_POLICY_MANAGEMENT");
}

async function optIn(account) {
  try {
    const current = await ebayFetchAccount(account, "GET", "/sell/account/v1/program/get_opted_in_programs");
    if (hasSellingPolicyProgram(current)) return;
  } catch (err) {
    console.log("ebay_list_programs", err instanceof Error ? err.message : String(err));
  }
  try {
    await ebayFetchAccount(account, "POST", "/sell/account/v1/program/opt_in", {
      programType: "SELLING_POLICY_MANAGEMENT",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/already opted|already enrolled|duplicate/i.test(message)) return;
    throw err;
  }
}

async function listPolicies(account, kind) {
  const market = marketplaceIdFromEnv();
  const json = await ebayFetchAccount(
    account,
    "GET",
    `/sell/account/v1/${kind}_policy?marketplace_id=${market}`,
  );
  return json?.[`${kind}Policies`] || json?.policies || [];
}

function findNamed(rows, kind, name) {
  return (rows || []).find((row) => String(row?.name || "").trim() === name) || null;
}

async function ensurePayment(account, market, existing) {
  const named = findNamed(existing, "payment", POLICY_NAMES.payment) || existing[0] || null;
  const id = policyIdOf(named, "payment");
  const body = {
    name: POLICY_NAMES.payment,
    marketplaceId: market,
    categoryTypes: [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES", default: true }],
    immediatePay: false,
  };
  if (id) {
    const updated = await ebayFetchAccount(account, "PUT", `/sell/account/v1/payment_policy/${id}`, body);
    return String(updated.paymentPolicyId || updated.id || id);
  }
  const created = await ebayFetchAccount(account, "POST", "/sell/account/v1/payment_policy", body);
  return String(created.paymentPolicyId || created.id);
}

async function ensureNoReturns(account, market, existing) {
  const named = findNamed(existing, "return", POLICY_NAMES.returnP) || null;
  const id = policyIdOf(named, "return");
  const body = {
    name: POLICY_NAMES.returnP,
    marketplaceId: market,
    categoryTypes: [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES", default: true }],
    returnsAccepted: false,
  };
  if (id) {
    const updated = await ebayFetchAccount(account, "PUT", `/sell/account/v1/return_policy/${id}`, body);
    return String(updated.returnPolicyId || updated.id || id);
  }
  // Prefer creating the named no-returns policy even if other return policies exist.
  const created = await ebayFetchAccount(account, "POST", "/sell/account/v1/return_policy", body);
  return String(created.returnPolicyId || created.id);
}

function calculatedBuyerPaysBody(market, service) {
  return {
    name: POLICY_NAMES.fulfillment,
    marketplaceId: market,
    categoryTypes: [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES", default: true }],
    localPickup: false,
    freightShipping: false,
    pickupDropOff: false,
    globalShipping: false,
    handlingTime: { value: 2, unit: "DAY" },
    shippingOptions: [
      {
        optionType: "DOMESTIC",
        costType: "CALCULATED",
        shippingServices: [
          {
            sortOrder: 1,
            shippingServiceCode: service.shippingService,
            ...(service.shippingCarrier ? { shippingCarrierCode: service.shippingCarrier } : {}),
            freeShipping: false,
            buyerResponsibleForShipping: true,
            buyerResponsibleForPickup: false,
          },
        ],
      },
    ],
  };
}

async function pickCalculatedService(account) {
  const token = await userTokenForAccount(account);
  const catalog = await getShippingServiceDetails(token);
  const usable = (catalog || []).filter((row) => {
    if (!row?.validForSellingFlow || row.international) return false;
    const blob = `${row.shippingService} ${row.description} ${row.shippingCategory}`;
    if (/pickup|freight/i.test(blob)) return false;
    const types = row.serviceTypes || [];
    return types.some((t) => /calculated/i.test(t)) || /usps|ups|fedex|parcel|priority|ground/i.test(blob);
  });
  const preferred =
    usable.find((r) => /USPSPriority/i.test(r.shippingService)) ||
    usable.find((r) => /usps/i.test(r.shippingService)) ||
    usable.find((r) => /UPSGround/i.test(r.shippingService)) ||
    usable[0] ||
    pickApplianceShipping(catalog);
  console.log(
    "ebay_policy_shipping_services",
    JSON.stringify({ picked: preferred, services: compactShippingCatalog(usable).slice(0, 40) }),
  );
  if (!preferred) {
    throw new Error("eBay returned no valid calculated domestic shipping service for the buyer-pays policy.");
  }
  return preferred;
}

async function ensureFulfillment(account, market, existing) {
  const named = findNamed(existing, "fulfillment", POLICY_NAMES.fulfillment) || null;
  const id = policyIdOf(named, "fulfillment");
  const service = await pickCalculatedService(account);
  const body = calculatedBuyerPaysBody(market, service);
  if (id) {
    const updated = await ebayFetchAccount(account, "PUT", `/sell/account/v1/fulfillment_policy/${id}`, body);
    return String(updated.fulfillmentPolicyId || updated.id || id);
  }
  const created = await ebayFetchAccount(account, "POST", "/sell/account/v1/fulfillment_policy", body);
  return String(created.fulfillmentPolicyId || created.id);
}

/**
 * Create or update the three required business policies on a selling account.
 * Persists IDs on ebay_accounts.
 */
export async function ensureBusinessPolicies(account) {
  if (!account || account.role !== "selling") {
    throw new Error("Business policies can only be created on the selling eBay account.");
  }
  const market = marketplaceIdFromEnv();
  await optIn(account);
  const [payments, returns, fulfillments] = await Promise.all([
    listPolicies(account, "payment"),
    listPolicies(account, "return"),
    listPolicies(account, "fulfillment"),
  ]);
  const payment = await ensurePayment(account, market, payments);
  const returnP = await ensureNoReturns(account, market, returns);
  const fulfillment = await ensureFulfillment(account, market, fulfillments);
  if (!payment || !returnP || !fulfillment) {
    throw new Error("eBay did not return payment, return, and fulfillment policy IDs after create.");
  }
  const policies = { payment, returnP, fulfillment, names: POLICY_NAMES };
  if (account.id) await markAccountPolicies(account.id, policies);
  return policies;
}

export { POLICY_NAMES };
