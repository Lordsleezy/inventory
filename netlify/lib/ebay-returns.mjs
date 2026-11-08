/**
 * eBay Post-Order returns for the selling account.
 * Not-as-described refunds include the original shipping and the seller pays
 * the return label. Change-of-mind refunds are the item price only, and a
 * used or damaged remorse return can deduct up to 50% after a note and photo.
 * https://developer.ebay.com/api-docs/user-guides/static/post-order-user-guide/post-order-returns.html
 * https://developer.ebay.com/devzone/post-order/types/RefundFeeTypeEnum.html
 * https://www.ebay.com/help/policies/return-policy/return-policy?id=4210
 */
import { userTokenForAccount } from "./ebay-accounts.mjs";
import { assertEbaySellerWrite } from "./ebay-write-guard.mjs";
import { ebayHosts } from "./ebay-env.mjs";
import { ingestReturnRow } from "./returns.mjs";
import { serviceClient } from "./server.mjs";

const REMORSE = /remorse|ordered_wrong|ordered_accident|found_better|changed_mind|no_longer_need|just_didn/i;
const SNAD = /not_as_described|snad|defective|damaged|wrong_item|missing|fake|counterfeit|doesn.?t_match/i;

export function deductionRefundCents(itemCents, percent) {
  const item = Math.max(0, Math.round(Number(itemCents) || 0));
  const pct = Math.min(50, Math.max(0, Math.round(Number(percent) || 0)));
  const deducted = Math.min(item, Math.round((item * pct) / 100));
  return { refundCents: item - deducted, deductedCents: deducted, percent: pct };
}

function moneyValue(node) {
  const raw = node?.value ?? node?.amount ?? node;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function firstMoney(row, keys) {
  for (const key of keys) {
    const cents = moneyValue(row?.[key]);
    if (cents > 0) return cents;
  }
  return 0;
}

export function ebayRefundPlan({ reason, fault, itemCents, shippingCents }) {
  const blob = `${reason || ""} ${fault || ""}`;
  const snad = SNAD.test(blob) || fault === "seller";
  const remorse = !snad && (REMORSE.test(blob) || reason === "buyer_remorse" || fault === "buyer");
  const item = Math.max(0, Math.round(Number(itemCents) || 0));
  const shipping = Math.max(0, Math.round(Number(shippingCents) || 0));
  if (remorse) {
    return {
      kind: "remorse",
      reasonLabel: "Change of mind",
      refundCents: item,
      itemCents: item,
      originalShippingCents: shipping,
      includeOriginalShipping: false,
      labelPaidBy: "buyer",
      deductionAllowed: true,
    };
  }
  return {
    kind: "snad",
    reasonLabel: "Not as described",
    refundCents: item + shipping,
    itemCents: item,
    originalShippingCents: shipping,
    includeOriginalShipping: shipping > 0,
    labelPaidBy: "seller",
    deductionAllowed: false,
  };
}

export function mapEbayReturn(row) {
  const reason = String(row?.creationInfo?.reason || row?.reason || "");
  const reasonType = String(row?.creationInfo?.reasonType || row?.reasonType || "");
  const blob = `${reason} ${reasonType}`;
  const remorse = REMORSE.test(blob) && !SNAD.test(blob);
  const itemCents = firstMoney(row, ["itemPrice", "purchasePrice"]) ||
    moneyValue(row?.sellerTotalRefund?.estimatedRefundAmount) ||
    moneyValue(row?.buyerTotalRefund?.estimatedRefundAmount);
  const shippingCents = firstMoney(row, ["shippingPrice", "originalShipping"]);
  const plan = ebayRefundPlan({
    reason: remorse ? "buyer_remorse" : SNAD.test(blob) ? "not_as_described" : reason,
    fault: remorse ? "buyer" : SNAD.test(blob) ? "seller" : "unknown",
    itemCents,
    shippingCents,
  });
  const state = String(row?.state || row?.status || "RETURN_REQUESTED").toLowerCase();
  let status = "requested";
  if (/in_transit|shipped/.test(state) && !/ready_to_ship|ready_for_shipping/.test(state)) status = "in_transit";
  else if (/delivered|received/.test(state)) status = "received";
  else if (/closed|refunded/.test(state)) status = "closed";
  else if (/rejected|declined/.test(state)) status = "denied";
  const item = row?.creationInfo?.item || row?.item || {};
  return {
    channel: "ebay",
    external_return_id: String(row?.returnId || ""),
    external_order_id: String(row?.orderId || ""),
    sku: String(item.sku || row?.sellerItemId || row?.sku || ""),
    reason: remorse ? "buyer_remorse" : SNAD.test(blob) ? "not_as_described" : reason || "other",
    fault: remorse ? "buyer" : SNAD.test(blob) ? "seller" : "unknown",
    status,
    needs_decision: !/closed|refunded|rejected/.test(state),
    refund_cents: plan.refundCents,
    item_cents: itemCents,
    shipping_cents: shippingCents,
    label_paid_by: plan.labelPaidBy,
    return_label_cents: 0,
    buyer_name: row?.buyerLoginName || null,
    tracking_number: row?.returnShipmentInfo?.shipmentTracking?.trackingNumber || null,
    carrier: row?.returnShipmentInfo?.shipmentTracking?.carrierEnum || null,
    ebay_item_id: String(row?.creationInfo?.item?.itemId || row?.itemId || ""),
    raw_state: state,
  };
}

function refundLineCents(detail, feeType) {
  const lines = detail?.detail?.refundInfo?.estimatedRefundDetail?.itemizedRefundDetails
    || detail?.refundInfo?.estimatedRefundDetail?.itemizedRefundDetails
    || [];
  const hit = lines.find((line) => String(line?.refundFeeType || "").toUpperCase() === feeType);
  return moneyValue(hit?.estimatedAmount);
}

async function postOrder(account, method, path, body) {
  if (String(method || "GET").toUpperCase() !== "GET") assertEbaySellerWrite(account);
  const token = await userTokenForAccount(account);
  const { api } = ebayHosts(process.env.EBAY_ENV);
  const res = await fetch(`${api}${path}`, {
    method,
    headers: {
      Authorization: `TOKEN ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text.slice(0, 500) }; }
  if (!res.ok) {
    const message = json?.error?.[0]?.message || json?.errors?.[0]?.message || json?.message || text.slice(0, 300);
    const err = new Error(`eBay returns ${res.status}: ${message}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

export async function searchEbayReturns(account) {
  const json = await postOrder(account, "GET", "/post-order/v2/return/search?limit=200", null);
  const rows = json?.members || json?.returns || json?.returnSummaries || [];
  return rows.map(mapEbayReturn).filter((row) => row.external_return_id);
}

async function skuForItem(storeId, itemId) {
  if (!itemId) return "";
  const sb = serviceClient();
  const { data } = await sb.from("listings").select("sku").eq("store_id", storeId).eq("channel", "ebay").eq("listing_id", itemId).limit(1).maybeSingle();
  return data?.sku || "";
}

export async function syncEbayReturns(storeId, account) {
  const rows = await searchEbayReturns(account);
  const saved = [];
  for (const row of rows) {
    const detail = await postOrder(account, "GET", `/post-order/v2/return/${encodeURIComponent(row.external_return_id)}`, null).catch(() => null);
    const itemCents = refundLineCents(detail, "PURCHASE_PRICE") || moneyValue(detail?.detail?.itemDetail?.itemPrice) || row.item_cents;
    const shippingCents = refundLineCents(detail, "ORIGINAL_SHIPPING") || row.shipping_cents;
    const labelCents = moneyValue(detail?.detail?.returnShipmentInfo?.shippingLabelCost?.totalAmount);
    const plan = ebayRefundPlan({ reason: row.reason, fault: row.fault, itemCents, shippingCents });
    const title = String(detail?.detail?.itemDetail?.itemTitle || "");
    const titleSku = (title.match(/\bSKU\s+([A-Za-z0-9-]+)\b/) || [])[1] || "";
    const sku = row.sku || await skuForItem(storeId, row.ebay_item_id) || titleSku;
    saved.push(await ingestReturnRow(storeId, {
      ...row,
      sku,
      item_cents: itemCents,
      shipping_cents: shippingCents,
      refund_cents: plan.refundCents,
      label_paid_by: plan.labelPaidBy,
      return_label_cents: plan.labelPaidBy === "seller" ? labelCents : 0,
      force_physical_return: true,
    }));
  }
  return { ok: true, count: saved.length, username: account.username };
}

function dollars(cents) {
  return (Math.max(0, Math.round(Number(cents) || 0)) / 100).toFixed(2);
}

export async function issueEbayReturnRefund(account, returnId, plan, note) {
  const lines = [
    { refundFeeType: "PURCHASE_PRICE", refundAmount: { value: dollars(plan.itemCents), currency: "USD" } },
  ];
  if (plan.includeOriginalShipping && plan.originalShippingCents > 0) {
    lines.push({
      refundFeeType: "ORIGINAL_SHIPPING",
      refundAmount: { value: dollars(plan.originalShippingCents), currency: "USD" },
    });
  }
  const total = lines.reduce((sum, line) => sum + Math.round(Number(line.refundAmount.value) * 100), 0);
  return postOrder(account, "POST", `/post-order/v2/return/${encodeURIComponent(returnId)}/issue_refund`, {
    comments: note ? { content: String(note).slice(0, 1000) } : undefined,
    refundDetail: {
      itemizedRefundDetail: lines,
      totalAmount: { value: dollars(total), currency: "USD" },
    },
  });
}

export async function issueEbayItemRefund(account, returnId, itemCents, note) {
  return issueEbayReturnRefund(account, returnId, ebayRefundPlan({
    reason: "buyer_remorse",
    fault: "buyer",
    itemCents,
    shippingCents: 0,
  }), note || "Refund of the item price. Original shipping is not refunded.");
}

export async function offerEbayPartialRefund(account, returnId, itemCents, percent, note) {
  const money = deductionRefundCents(itemCents, percent);
  if (!note || !String(note).trim()) throw new Error("A note about the condition is required before a deduction.");
  if (money.percent <= 0) throw new Error("Deduction percent must be greater than 0.");
  const value = (money.refundCents / 100).toFixed(2);
  await postOrder(account, "POST", `/post-order/v2/return/${encodeURIComponent(returnId)}/decide`, {
    decision: "OFFER_PARTIAL_REFUND",
    partialRefundAmount: { value, currency: "USD" },
    comments: { content: String(note).slice(0, 1000) },
  });
  return money;
}

export async function uploadEbayReturnFile(account, returnId, { filename, contentType, bytes }) {
  assertEbaySellerWrite(account);
  const token = await userTokenForAccount(account);
  const { api } = ebayHosts(process.env.EBAY_ENV);
  const form = new FormData();
  form.append("filePurpose", "ITEM_RELATED");
  form.append("file", new Blob([bytes], { type: contentType || "image/jpeg" }), filename || "condition.jpg");
  const res = await fetch(`${api}/post-order/v2/return/${encodeURIComponent(returnId)}/file/upload`, {
    method: "POST",
    headers: {
      Authorization: `TOKEN ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    },
    body: form,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`eBay photo upload ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : { ok: true };
}
