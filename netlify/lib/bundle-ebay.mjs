/**
 * Confirm-only eBay money for a one-box bundle.
 * Calculated listings can get eBay's combined-weight rule. Flat policies are not changed.
 * Nothing here runs unless confirm is true, and tests pass a fake fetch.
 */
import { ebayFetchAccount, loadEbayAccount, userTokenForAccount } from "./ebay-accounts.mjs";
import { ebayTradingCall } from "./ebay-trading.mjs";
import { buyerPaysPolicyId } from "./ebay-shipping-edit.mjs";
import { pushMarketplaceTracking } from "./shipping/marketplace-tracking.mjs";
import { serviceClient } from "./server.mjs";
import {
  BUYER_REFUND_NOTE,
  DEFAULT_RATES,
  addOrderInnerXml,
  allocateBundleShipping,
  allocateByWeight,
  assertBundleConfirm,
  bundleMoneyPlan,
  calculatedCombinedWeightBody,
  combinedWeightDecision,
  issueRefundBody,
  quoteBundle,
  sendInvoiceInnerXml,
} from "../../shared/bundle-shipping.mjs";

const SELLING = "ikonikdeals2026";

function xmlTag(xml, tag) {
  const match = String(xml || "").match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return match ? match[1] : "";
}

function lineItemsFromOrder(order) {
  return (order?.lineItems || []).map((line) => {
    const lineId = String(line.lineItemId || "");
    const parts = lineId.split("-");
    const legacy = String(line.legacyItemId || parts[0] || "");
    const transactionId = parts.length >= 2 ? parts[parts.length - 1] : "0";
    return { legacyItemId: legacy, transactionId };
  }).filter((line) => line.legacyItemId);
}

function shippingServiceFromOrder(order) {
  const step = order?.fulfillmentStartInstructions?.[0]?.shippingStep;
  return step?.shippingServiceCode || order?.lineItems?.[0]?.deliveryCost?.shippingServiceCode || "USPSGroundAdvantage";
}

function paidOnEbay(order) {
  const status = String(order?.orderPaymentStatus || "").toUpperCase();
  return status === "PAID" || status === "PARTIALLY_REFUNDED" || status === "FULLY_REFUNDED";
}

async function loadRows(sb, storeId, orderIds) {
  const { data, error } = await sb
    .from("web_orders")
    .select("id, sku, order_no, channel, status, paid_at, shipped_at, canceled_at, buyer_name, buyer_email, ship_line1, ship_line2, ship_city, ship_region, ship_postal, item_cents, shipping_cents, label_cost_cents, sale_id, carrier, tracking_number, fulfillment")
    .eq("store_id", storeId)
    .in("id", orderIds);
  if (error) throw new Error(error.message);
  const skus = [...new Set((data || []).map((row) => row.sku).filter(Boolean))];
  const { data: units } = skus.length
    ? await sb.from("units").select("sku, package_length_in, package_width_in, package_height_in, package_weight_lb").eq("store_id", storeId).in("sku", skus)
    : { data: [] };
  const bySku = new Map((units || []).map((unit) => [unit.sku, unit]));
  return (data || []).map((row) => {
    const unit = bySku.get(row.sku) || {};
    return {
      ...row,
      length_in: unit.package_length_in,
      width_in: unit.package_width_in,
      height_in: unit.package_height_in,
      weight_lb: unit.package_weight_lb,
    };
  });
}

async function ratesFor(sb, storeId) {
  const { data } = await sb.from("bundle_ship_rates").select("max_lb, size_class, price_cents").eq("store_id", storeId);
  return data?.length ? data : DEFAULT_RATES;
}

async function alreadyRefunded(sb, storeId, orderNos) {
  const { data } = await sb
    .from("bundle_applies")
    .select("detail, status")
    .eq("store_id", storeId)
    .in("status", ["done", "partial"])
    .order("created_at", { ascending: false })
    .limit(40);
  const done = new Set();
  for (const row of data || []) {
    for (const item of row.detail?.refunded || []) {
      if (item?.order_no && orderNos.includes(String(item.order_no))) done.add(String(item.order_no));
    }
  }
  return done;
}

function scopeMessage(err) {
  const text = String(err?.message || err || "");
  if (/scope|unauthorized|insufficient|403/i.test(text)) {
    return "eBay refused this. Reconnect ikonikdeals2026 and allow sell.fulfillment and sell.account, then try Apply bundle price again.";
  }
  return text.slice(0, 400);
}

export async function previewBundle(sb, storeId, orderIds) {
  const rows = await loadRows(sb, storeId, orderIds);
  if (rows.length < 2) return { ok: false, error: "Pick at least two open orders." };
  const quote = quoteBundle(rows, await ratesFor(sb, storeId));
  const money = bundleMoneyPlan(rows, quote);
  const labelTotal = rows.reduce((n, row) => n + Math.max(0, Number(row.label_cost_cents) || 0), 0);
  return {
    ok: true,
    buyer: rows[0].buyer_name || rows[0].buyer_email || "",
    orders: rows.map((row) => ({
      id: row.id,
      order_no: row.order_no,
      sku: row.sku,
      shipping_cents: row.shipping_cents,
      item_cents: row.item_cents,
    })),
    quote,
    money,
    label_shares: allocateByWeight(rows, labelTotal),
    label_note: "The label cost stays on the order that already has it, so the books count that one label once.",
  };
}

export async function applyBundlePrice(sb, storeId, orderIds, { confirm, confirmCents } = {}) {
  assertBundleConfirm(confirm);
  const preview = await previewBundle(sb, storeId, orderIds);
  if (!preview.ok) return preview;
  const { quote, money, orders } = preview;
  if (!quote.ok) return { ok: false, error: "These do not fit in one Ground Advantage box. Shipping stays separate.", preview };
  if (money.action === "mixed") {
    return { ok: false, error: "Some of these are paid and some are not. Nothing was sent.", preview };
  }
  const expected = money.action === "invoice" ? money.invoice_cents : money.refund_cents;
  if (Number(confirmCents) !== expected) {
    return { ok: false, needs_confirm: true, preview };
  }
  if (expected === 0 && money.action !== "invoice") {
    await writeShares(sb, preview);
    return { ok: true, action: "none", preview, note: "The separate charges already match the one-box price." };
  }

  const account = await loadEbayAccount(storeId, { username: SELLING });
  const token = await userTokenForAccount(account);
  const ebayOrders = [];
  for (const row of orders) {
    if (!row.order_no || String(row.order_no).startsWith("B-")) continue;
    const remote = await ebayFetchAccount(account, "GET", `/sell/fulfillment/v1/order/${encodeURIComponent(row.order_no)}`);
    ebayOrders.push({ row, remote });
  }
  if (!ebayOrders.length) return { ok: false, error: "These orders do not have eBay order numbers.", preview };

  const refunded = [];
  try {
    if (money.action === "invoice") {
      if (ebayOrders.some((entry) => paidOnEbay(entry.remote))) {
        return { ok: false, error: "eBay already shows at least one of these as paid. Nothing was invoiced. Use the refund once they are all paid.", preview };
      }
      const lineItems = ebayOrders.flatMap((entry) => lineItemsFromOrder(entry.remote));
      if (lineItems.length < 2) return { ok: false, error: "eBay did not return two line items to combine. Nothing was sent.", preview };
      const service = shippingServiceFromOrder(ebayOrders[0].remote);
      const itemCents = orders.reduce((n, row) => n + Math.max(0, Number(row.item_cents) || 0), 0);
      const created = await ebayTradingCall(token, "AddOrder", addOrderInnerXml({
        lineItems, shippingCents: money.invoice_cents, itemCents, shippingService: service,
      }), account);
      const orderId = xmlTag(created, "OrderID");
      if (!orderId) throw new Error("eBay did not return a combined order id. No invoice was sent.");
      await ebayTradingCall(token, "SendInvoice", sendInvoiceInnerXml(orderId), account);
    } else {
      const prior = await alreadyRefunded(sb, storeId, ebayOrders.map((entry) => String(entry.row.order_no)));
      for (const entry of ebayOrders) {
        const refund = (money.refunds || []).find((item) => item.id === entry.row.id);
        const amount = refund?.refund_cents || 0;
        if (amount <= 0 || prior.has(String(entry.row.order_no))) continue;
        await ebayFetchAccount(
          account,
          "POST",
          `/sell/fulfillment/v1/order/${encodeURIComponent(entry.row.order_no)}/issue_refund`,
          issueRefundBody(amount, BUYER_REFUND_NOTE),
        );
        refunded.push({ order_no: entry.row.order_no, refund_cents: amount });
        await sb.from("bundle_applies").insert({
          store_id: storeId,
          action: "refund",
          buyer_name: preview.buyer,
          order_ids: orderIds,
          separate_cents: money.separate_cents,
          bundle_cents: money.bundle_cents,
          refund_cents: amount,
          status: "partial",
          detail: { refunded: refunded.slice() },
        });
      }
    }
  } catch (err) {
    return {
      ok: false,
      error: scopeMessage(err),
      refunded: refunded.map((item) => item.order_no),
      preview,
    };
  }

  await writeShares(sb, preview);
  await sb.from("bundle_applies").insert({
    store_id: storeId,
    action: money.action,
    buyer_name: preview.buyer,
    order_ids: orderIds,
    separate_cents: money.separate_cents,
    bundle_cents: money.bundle_cents,
    refund_cents: money.refund_cents,
    status: "done",
    detail: { refunded, allocations: money.allocations },
  });
  return { ok: true, action: money.action, preview, refunded: refunded.map((item) => item.order_no) };
}

async function writeShares(sb, preview) {
  const shares = preview.money.allocations || {};
  for (const row of preview.orders) {
    const { error } = await sb.rpc("portal_bundle_set_shipping", {
      p_order: row.id,
      p_shipping: shares[row.id] ?? row.shipping_cents,
      p_label: null,
    });
    if (error) throw new Error(error.message);
  }
}

export async function enableCombinedWeight(sb, storeId, { confirm } = {}) {
  assertBundleConfirm(confirm);
  const account = await loadEbayAccount(storeId, { username: SELLING });
  let policyId = "";
  let policy = null;
  try {
    policyId = await buyerPaysPolicyId(account);
    policy = await ebayFetchAccount(account, "GET", `/sell/account/v1/fulfillment_policy/${policyId}`);
  } catch (err) {
    return { ok: false, skipped: true, reason: "flat", error: scopeMessage(err), policy_id: policyId || null };
  }
  let rules = null;
  let preferences = null;
  try {
    rules = await ebayFetchAccount(account, "GET", "/sell/account/v2/combined_shipping_rules");
  } catch (err) {
    if (!/404|not found/i.test(String(err.message))) return { ok: false, error: scopeMessage(err), policy_id: policyId };
  }
  try {
    preferences = await ebayFetchAccount(account, "GET", "/sell/account/v2/user_preferences");
  } catch {
    preferences = null;
  }
  const decision = combinedWeightDecision(policy, rules);
  await sb.from("ebay_policy_backups").insert({
    store_id: storeId,
    kind: "combined_shipping_before_bundle",
    policy_id: policyId,
    body: { policy, rules, preferences, decision: decision.reason },
  });
  if (!decision.write) {
    return {
      ok: true,
      skipped: true,
      reason: decision.reason,
      policy_id: policyId,
      rollback: "The backup is in ebay_policy_backups. Nothing was changed.",
    };
  }
  const path = rules?.calculatedShippingRule
    ? "/sell/account/v2/combined_shipping_rules/update_calculated_shipping_rules"
    : "/sell/account/v2/combined_shipping_rules/create_calculated_shipping_rules";
  await ebayFetchAccount(account, "POST", path, decision.body);
  const option = preferences?.combinedPaymentPreferences?.combinedPaymentOption;
  if (option === "NO_COMBINED_PAYMENT") {
    await ebayFetchAccount(account, "PATCH", "/sell/account/v2/user_preferences", {
      combinedPaymentPreferences: { combinedPaymentOption: "DISCOUNT_SPECIFIED" },
    });
  }
  return {
    ok: true,
    policy_id: policyId,
    reason: "calculated",
    rule: "COMBINED_ITEM_WEIGHT",
    rollback: "Post the saved rules from ebay_policy_backups kind combined_shipping_before_bundle, or set combinedShippingRuleType back to INDIVIDUAL_ITEM_WEIGHT. The fulfillment policy itself was not edited.",
  };
}

export async function pushBundleTracking(sb, storeId, leadId) {
  const { data: lead, error } = await sb.from("web_orders").select("id, sku, order_no, channel, buyer_name, ship_line1, ship_line2, ship_city, ship_region, ship_postal, tracking_number, carrier, shipped_at").eq("store_id", storeId).eq("id", leadId).maybeSingle();
  if (error || !lead?.shipped_at || !lead.tracking_number) return { ok: false, error: "The lead order is not shipped yet." };
  const { data: peers } = await sb
    .from("web_orders")
    .select("id, sku, order_no, channel, buyer_name, tracking_number, carrier, shipped_at")
    .eq("store_id", storeId)
    .eq("channel", lead.channel)
    .eq("buyer_name", lead.buyer_name)
    .not("shipped_at", "is", null);
  const rows = (peers || []).filter((row) => row.tracking_number && row.tracking_number === lead.tracking_number);
  const results = [];
  for (const row of rows) {
    const pushed = await pushMarketplaceTracking(storeId, row, {
      tracking_number: row.tracking_number,
      carrier: row.carrier || lead.carrier || "USPS",
    }).catch((err) => ({ ok: false, error: String(err?.message || err).slice(0, 200) }));
    results.push({ order_no: row.order_no, sku: row.sku, ok: pushed.ok !== false, skipped: !!pushed.skipped });
  }
  return { ok: results.every((row) => row.ok), uploaded: results.filter((row) => row.ok).length, results };
}

export function bundleService() {
  return serviceClient();
}

export { allocateBundleShipping, quoteBundle, calculatedCombinedWeightBody };
