import { addressTo, allowedCarriers, buyLabel, getRate, liveRates, pickDefaultRate, refundLabel, shippoMode } from "./shippo.mjs";
import { deliverOrderEmails, ownerEmails } from "./web-order-email.mjs";
import {
  channelAllowsLabels,
  decodeRateId,
  LABEL_SOURCES,
} from "./shipping/sources.mjs";
import {
  cleanBox,
  labelFormatSetting,
  loadShipFrom,
  multiSourceQuote,
  buySelectedRate,
  validBox,
} from "./shipping/quote-engine.mjs";
import { pushMarketplaceTracking } from "./shipping/marketplace-tracking.mjs";
import { veeqoVoidLabel } from "./shipping/veeqo.mjs";
import { tiktokVoidLabel } from "./shipping/tiktok-shipping.mjs";

const num = (v) => Number(v);

/** Test keys only ever touch sandbox orders; live keys only ever touch real (production-paid) orders. */
export function shippoMatchesOrder(order, mode = shippoMode()) {
  const real = order.payment_env === "production";
  if (!mode) return { ok: false, error: "No Shippo key is set." };
  if (real && mode !== "live") return { ok: false, error: "This is a real paid order but the Shippo key is a TEST key. Save the live Shippo key first." };
  if (!real && mode === "live") return { ok: false, error: "This is a sandbox test order; the live Shippo key is not used for test orders." };
  return { ok: true };
}

async function loadOrder(sb, storeId, orderId) {
  const { data, error } = await sb.from("web_orders").select("*").eq("id", orderId).eq("store_id", storeId).maybeSingle();
  if (error) throw error;
  return data;
}

async function unitBox(sb, storeId, sku) {
  const { data } = await sb
    .from("units")
    .select("package_length_in,package_width_in,package_height_in,package_weight_lb,dims_source")
    .eq("store_id", storeId)
    .eq("sku", sku)
    .single();
  return {
    length_in: data?.package_length_in ?? null,
    width_in: data?.package_width_in ?? null,
    height_in: data?.package_height_in ?? null,
    weight_lb: data?.package_weight_lb ?? null,
    dims_source: data?.dims_source ?? null,
  };
}

/** Sibling line items sharing the same marketplace order (multi-SKU one box). */
async function siblingSkus(sb, storeId, order) {
  if (!order?.order_no || !order?.channel) return [order.sku];
  const { data } = await sb
    .from("web_orders")
    .select("sku,item_cents")
    .eq("store_id", storeId)
    .eq("channel", order.channel)
    .eq("order_no", order.order_no)
    .eq("status", "paid");
  const skus = [...new Set((data || []).map((r) => r.sku).filter(Boolean))];
  return skus.length ? skus : [order.sku];
}

async function combinedStoredBox(sb, storeId, order) {
  const skus = await siblingSkus(sb, storeId, order);
  const boxes = [];
  for (const sku of skus) boxes.push(await unitBox(sb, storeId, sku));
  const complete = boxes.filter((b) => validBox(b));
  if (!complete.length) return boxes[0] || { length_in: null, width_in: null, height_in: null, weight_lb: null };
  if (complete.length === 1) return complete[0];
  // Multi-item default: max outer dims + summed weight (user must confirm).
  return {
    length_in: Math.max(...complete.map((b) => num(b.length_in))),
    width_in: Math.max(...complete.map((b) => num(b.width_in))),
    height_in: Math.max(...complete.map((b) => num(b.height_in))),
    weight_lb: complete.reduce((n, b) => n + num(b.weight_lb), 0),
    dims_source: "estimated",
    multi_sku: skus,
  };
}

function eligibility(order, { allowShippedWithLabel = false } = {}) {
  if (!order || order.fulfillment !== "ship" || order.status !== "paid") return "Not a paid shipping order.";
  if (order.refund_requested_at) return "Order is being canceled.";
  if (!channelAllowsLabels(order.channel)) {
    return `One-click labels are not available for ${order.channel || "this channel"}.`;
  }
  if (order.shipped_at && !allowShippedWithLabel) return "Order is already marked shipped.";
  if (order.label_url && order.tracking_number) return "This order already has a label. Void it first to buy another.";
  return null;
}

/**
 * Live re-quote. Marketplace channels price-shop every connected source;
 * website stays Shippo-only (existing behavior).
 */
export async function labelQuote(sb, storeId, orderId, box, deps = {}) {
  const order = await loadOrder(sb, storeId, orderId);
  const problem = eligibility(order);
  if (problem) return { ok: false, status: 400, error: problem };

  const stored = await combinedStoredBox(sb, storeId, order);
  const useBox = box && Object.keys(box).length ? box : stored;
  if (!validBox(useBox)) {
    return {
      ok: false,
      status: 400,
      error: "Enter the box length, width, height (in) and weight (lb). Quotes never run on a blank box.",
      stored_box: stored,
      needs_box: true,
    };
  }

  const channel = String(order.channel || "website").toLowerCase();
  const paid = order.shipping_rate || {};

  // Website: preserve classic Shippo-only quote + pickDefaultRate speed rule (existing tests).
  if (channel === "website" || channel === "web") {
    const match = shippoMatchesOrder(order, deps.mode);
    if (!match.ok) return { ok: false, status: 409, error: match.error };
    const shipFrom = await loadShipFrom(sb, storeId);
    const quote = await (deps.liveRates || liveRates)({
      shipFrom,
      to: addressTo({
        name: order.buyer_name,
        line1: order.ship_line1,
        line2: order.ship_line2,
        city: order.ship_city,
        region: order.ship_region,
        postal: order.ship_postal,
        phone: order.buyer_phone,
        email: order.buyer_email,
      }),
      pkg: cleanBox(useBox),
      carriers: await allowedCarriers(sb, storeId),
    });
    const rates = quote.all || quote.rates;
    if (!rates.length) {
      return { ok: false, status: 502, error: `No carrier rates for this box: ${quote.messages.join("; ") || "unknown"}` };
    }
    const pick = pickDefaultRate(rates, paid);
    const format = await labelFormatSetting(sb, storeId);
    return {
      ok: true,
      status: 200,
      order: {
        id: order.id,
        order_no: order.order_no,
        sku: order.sku,
        channel: order.channel || "website",
        paid_shipping_cents: order.shipping_cents,
        paid_service: {
          carrier: paid.carrier || order.carrier || null,
          service: paid.service || order.service || null,
          days: paid.days ?? null,
          source: paid.source || null,
        },
      },
      box: cleanBox(useBox),
      stored_box: stored,
      rates: rates.map((r) => ({ ...r, source: r.source || "shippo" })),
      selected_id: pick.rate.id,
      selected_reason: pick.reason,
      messages: quote.messages,
      sources: [{ source: "shippo", online: true, rate_count: rates.length, messages: [] }],
      label_format: format,
      multi_sku: stored.multi_sku || null,
    };
  }

  const multi = await multiSourceQuote(sb, storeId, order, useBox, deps);
  if (!multi.ok) {
    return { ...multi, stored_box: stored, order: { id: order.id, order_no: order.order_no, sku: order.sku, channel } };
  }
  return {
    ok: true,
    status: 200,
    order: {
      id: order.id,
      order_no: order.order_no,
      sku: order.sku,
      channel: order.channel,
      paid_shipping_cents: order.shipping_cents,
      paid_service: {
        carrier: paid.carrier || order.carrier || null,
        service: paid.service || order.service || null,
        days: paid.days ?? null,
        source: paid.source || null,
      },
    },
    box: multi.box,
    stored_box: stored,
    rates: multi.rates,
    selected_id: multi.selected_id,
    selected_reason: multi.selected_reason,
    messages: multi.messages,
    sources: multi.sources,
    label_format: multi.label_format,
    multi_sku: stored.multi_sku || null,
  };
}

async function claimBuyLock(sb, order) {
  const staleBefore = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const { data: claimed, error: claimError } = await sb
    .from("web_orders")
    .update({ label_buying_at: new Date().toISOString() })
    .eq("id", order.id)
    .is("tracking_number", null)
    .is("label_url", null)
    .or(`label_buying_at.is.null,label_buying_at.lt.${staleBefore}`)
    .select("id")
    .maybeSingle();
  if (claimError) throw claimError;
  if (!claimed) return { ok: false };
  return {
    ok: true,
    release: () => sb.from("web_orders").update({ label_buying_at: null }).eq("id", order.id),
  };
}

/**
 * Buy the chosen rate. Persists label + expense, pushes marketplace tracking, marks Floor shipped.
 */
export async function buyLabelForOrder(sb, storeId, orderId, { rateId, box, actor, purchaseToken, selectedRate, labelFormat }, deps = {}) {
  const order = await loadOrder(sb, storeId, orderId);
  const problem = eligibility(order);
  if (problem) return { ok: false, status: 400, error: problem };

  // Idempotent replay
  if (purchaseToken) {
    const { data: existing } = await sb
      .from("web_order_labels")
      .select("id,label_url,tracking_number,cost_cents,order_id")
      .eq("store_id", storeId)
      .eq("purchase_token", purchaseToken)
      .maybeSingle();
    if (existing) {
      const { data: saved } = await sb.from("web_orders").select("*").eq("id", orderId).single();
      return { ok: true, status: 200, order: saved, label_id: existing.id, cost_cents: existing.cost_cents, idempotent: true };
    }
  }

  const channel = String(order.channel || "website").toLowerCase();
  if (channel === "amazon" || channel === "tiktok") {
    if (!order.pack_proof_photo_path) {
      return { ok: false, status: 400, error: "Amazon/TikTok need a pack photo before buying a label." };
    }
  }
  if (order.pack_condition === "not_as_listed") {
    return { ok: false, status: 409, error: "Condition was marked not as listed. The label was not bought." };
  }
  // Marketplace: confirm-in-dialog is enough; website keeps strict pack_condition=ok.
  if ((channel === "website" || channel === "web") && order.pack_condition !== "ok") {
    return { ok: false, status: 400, error: "Confirm the item matches the listing before buying a label." };
  }
  if (!rateId && !selectedRate) return { ok: false, status: 400, error: "Pick a rate first." };
  if (!validBox(box)) return { ok: false, status: 400, error: "Enter the box length, width, height (in) and weight (lb)." };
  const cb = cleanBox(box);
  const format = labelFormat || (await labelFormatSetting(sb, storeId));

  const lock = await claimBuyLock(sb, order);
  if (!lock.ok) return { ok: false, status: 409, error: "A label for this order is already being bought (or already exists)." };
  const { release } = lock;

  let bought;
  try {
    if (channel === "website" || channel === "web") {
      const match = shippoMatchesOrder(order, deps.mode);
      if (!match.ok) {
        await release();
        return { ok: false, status: 409, error: match.error };
      }
      const shippoRateId = decodeRateId(rateId).source === "shippo" ? decodeRateId(rateId).remoteId : rateId;
      let rate, tx;
      try {
        rate = await (deps.getRate || getRate)(shippoRateId);
        tx = await (deps.buyLabel || buyLabel)(shippoRateId, {
          metadata: `OBI order ${order.order_no} SKU ${order.sku}`,
          labelFileType: format,
        });
      } catch (err) {
        await release();
        return { ok: false, status: 502, error: `Label purchase failed: ${err.detail?.detail || err.message}` };
      }
      if (tx.status !== "SUCCESS" || !tx.tracking_number) {
        await release();
        const msg = (tx.messages || []).map((m) => m.text || String(m)).join("; ");
        return { ok: false, status: 502, error: `Label purchase failed${msg ? `: ${msg}` : ""}` };
      }
      bought = {
        source: LABEL_SOURCES.shippo,
        tracking_number: tx.tracking_number,
        tracking_url: tx.tracking_url_provider || null,
        label_url: tx.label_url,
        external_shipment_id: tx.object_id,
        transaction_id: tx.object_id,
        rate_id: shippoRateId,
        carrier: rate.carrier,
        service: rate.service,
        estimated_days: rate.days,
        cost_cents: rate.amount_cents,
        tracking_pushed_by_source: false,
        label_format: format,
        quote_snapshot: rate,
      };
    } else {
      if (!selectedRate || selectedRate.id !== rateId) {
        // Re-quote to recover raw rate payload (required for Veeqo/TikTok/Amazon buys)
        const q = await multiSourceQuote(sb, storeId, order, cb, deps);
        selectedRate = (q.rates || []).find((r) => r.id === rateId);
      }
      if (!selectedRate) {
        await release();
        return { ok: false, status: 400, error: "That rate expired. Re-quote and try again." };
      }
      bought = await buySelectedRate(storeId, order, selectedRate, cb, { labelFormat: format, deps });
    }
  } catch (err) {
    await release();
    return { ok: false, status: err.status || 502, error: `Label purchase failed: ${err.message}` };
  }

  const now = new Date().toISOString();
  try {
    const { data: label, error: labelError } = await sb
      .from("web_order_labels")
      .insert({
        store_id: storeId,
        order_id: order.id,
        transaction_id: bought.transaction_id || bought.external_shipment_id,
        rate_id: bought.rate_id || rateId,
        carrier: bought.carrier,
        service: bought.service,
        estimated_days: bought.estimated_days ?? null,
        cost_cents: bought.cost_cents,
        tracking_number: bought.tracking_number,
        tracking_url: bought.tracking_url,
        label_url: bought.label_url,
        box: cb,
        purchased_by: actor || null,
        source: bought.source,
        label_format: bought.label_format || format,
        purchase_token: purchaseToken || null,
        external_shipment_id: bought.external_shipment_id || null,
        quote_snapshot: bought.quote_snapshot || selectedRate || null,
      })
      .select("id")
      .single();
    if (labelError) {
      // Unique violation = concurrent buy won
      if (/unique|duplicate/i.test(labelError.message || "")) {
        await release();
        return { ok: false, status: 409, error: "A label was already purchased for this order." };
      }
      throw labelError;
    }

    // Push tracking to marketplace (skip if source already did)
    let push = { ok: true, skipped: true };
    try {
      push = await pushMarketplaceTracking(storeId, order, bought, {
        alreadyPushed: Boolean(bought.tracking_pushed_by_source),
      });
    } catch (err) {
      push = { ok: false, error: err.message };
    }
    await sb
      .from("web_order_labels")
      .update({
        tracking_pushed_at: push.ok ? now : null,
        tracking_push_error: push.ok ? null : String(push.error || "").slice(0, 500),
        tracking_push_source: bought.tracking_pushed_by_source ? bought.source : push.skipped ? "skipped" : order.channel,
      })
      .eq("id", label.id);

    await sb.from("web_order_emails").delete().eq("order_id", order.id).eq("kind", "tracking");
    const isMarketplace = channel === "ebay" || channel === "amazon" || channel === "tiktok";
    const orderPatch = {
      tracking_number: bought.tracking_number,
      tracking_url: bought.tracking_url,
      label_url: bought.label_url,
      label_transaction_id: bought.transaction_id || bought.external_shipment_id,
      label_cost_cents: bought.cost_cents,
      carrier: bought.carrier,
      service: bought.service,
      label_purchased_at: now,
      boxed_at: order.boxed_at || now,
      pack_condition: order.pack_condition || "ok",
      pack_condition_at: order.pack_condition_at || now,
      label_buying_at: null,
      updated_at: now,
    };
    // Marketplace: Floor + channel show shipped once tracking exists. Website keeps prior behavior
    // (tracking email; staff marks shipped separately if desired).
    if (isMarketplace && !order.shipped_at) orderPatch.shipped_at = now;
    const { data: saved, error: saveError } = await sb
      .from("web_orders")
      .update(orderPatch)
      .eq("id", order.id)
      .select("*")
      .single();
    if (saveError) throw saveError;

    const { data: owner } = await sb
      .from("store_settings")
      .select("value")
      .eq("store_id", storeId)
      .eq("key", "online_payout_employee_id")
      .maybeSingle();
    const employeeId = typeof owner?.value === "string" ? owner.value : null;
    const { error: expenseError } = await sb.from("portal_expenses").insert({
      store_id: storeId,
      description: `${bought.source} label ${order.order_no} — ${bought.carrier} ${bought.service}`,
      category: "Shipping",
      amount_cents: bought.cost_cents,
      needs_reimbursement: Boolean(employeeId),
      employee_id: employeeId,
      source: "label",
      order_id: order.id,
      label_id: label.id,
    });
    if (expenseError) throw expenseError;

    const { error: unitError } = await sb
      .from("units")
      .update({
        package_length_in: cb.length_in,
        package_width_in: cb.width_in,
        package_height_in: cb.height_in,
        package_weight_lb: cb.weight_lb,
        dims_source: "measured",
        updated_at: now,
      })
      .eq("store_id", storeId)
      .eq("sku", order.sku);
    if (unitError) throw unitError;

    await sb.from("events").insert({
      store_id: storeId,
      sku: order.sku,
      kind: "edit",
      field: "package_dims",
      new_value: JSON.stringify(cb),
      actor: actor || "admin",
      note: `measured at packing, ${bought.source} label ${order.order_no}`,
    });

    if (channel === "website" || channel === "web") {
      await (deps.deliver || deliverOrderEmails)(sb, order.id).catch(() => []);
    }

    return {
      ok: true,
      status: 200,
      order: saved,
      label_id: label.id,
      cost_cents: bought.cost_cents,
      tracking_push: push,
      label_url: bought.label_url,
    };
  } catch (err) {
    // Best-effort void at vendor when Floor could not record
    try {
      if (bought?.source === LABEL_SOURCES.shippo && bought.transaction_id) {
        await (deps.refundLabel || refundLabel)(bought.transaction_id);
      } else if (bought?.source === LABEL_SOURCES.veeqo && bought.external_shipment_id) {
        await veeqoVoidLabel(bought.external_shipment_id).catch(() => null);
      }
    } catch {
      /* ignore */
    }
    await release();
    return {
      ok: false,
      status: 500,
      error: `Label was bought but could not be saved (${bought?.tracking_number || "?"}). Check the carrier portal and try voiding. (${err.message})`,
    };
  }
}

/**
 * Void the order's current label, reverse expense, clear tracking so a new label can be bought.
 */
export async function voidLabel(sb, storeId, orderId, deps = {}) {
  const order = await loadOrder(sb, storeId, orderId);
  if (!order || (!order.label_transaction_id && !order.label_url)) {
    return { ok: false, status: 400, error: "This order has no label to void." };
  }
  // Allow void after Floor mark-shipped (carrier refund window). Block once delivered unless force.
  if (order.delivered_at && !deps.force) {
    return { ok: false, status: 409, error: "Order is delivered; void the label with the carrier if needed." };
  }

  let labelRow = null;
  {
    const q = sb.from("web_order_labels").select("*").eq("order_id", order.id).is("voided_at", null);
    // Prefer newest active label when the client supports order/limit.
    const ordered = typeof q.order === "function" ? q.order("purchased_at", { ascending: false }) : q;
    const limited = typeof ordered.limit === "function" ? ordered.limit(1) : ordered;
    const res = await limited.maybeSingle();
    labelRow = res?.data || null;
  }

  const source = labelRow?.source || LABEL_SOURCES.shippo;
  const txId = order.label_transaction_id || labelRow?.transaction_id || labelRow?.external_shipment_id;
  let status = "QUEUED";

  if (source === LABEL_SOURCES.shippo) {
    try {
      const result = await (deps.refundLabel || refundLabel)(txId);
      status = String(result?.status || "QUEUED").toUpperCase();
      if (status === "ERROR") {
        return { ok: false, status: 502, error: "Shippo rejected the label refund (it may already be in use)." };
      }
    } catch (err) {
      return { ok: false, status: 502, error: `Shippo would not void the label: ${err.detail?.detail || err.message}` };
    }
  } else if (source === LABEL_SOURCES.veeqo) {
    try {
      await veeqoVoidLabel(labelRow?.external_shipment_id || txId);
      status = "QUEUED";
    } catch (err) {
      return { ok: false, status: 502, error: `Veeqo would not void the label: ${err.message}` };
    }
  } else if (source === LABEL_SOURCES.tiktok) {
    const r = await tiktokVoidLabel(storeId, labelRow?.external_shipment_id || txId);
    if (!r.ok) return { ok: false, status: 400, error: r.error };
  } else if (source === LABEL_SOURCES.amazon) {
    return {
      ok: false,
      status: 400,
      error: "Void Amazon Buy Shipping labels in Seller Central (or Veeqo) within the carrier refund window.",
    };
  }

  const now = new Date().toISOString();
  if (labelRow) {
    await sb.from("web_order_labels").update({ voided_at: now, void_status: status }).eq("id", labelRow.id);
    await sb
      .from("portal_expenses")
      .update({ voided_at: now, void_reason: "label voided" })
      .eq("label_id", labelRow.id)
      .is("voided_at", null);
  } else if (txId) {
    await sb
      .from("web_order_labels")
      .update({ voided_at: now, void_status: status })
      .eq("order_id", order.id)
      .eq("transaction_id", txId);
  }

  await sb.from("web_order_emails").delete().eq("order_id", order.id).eq("kind", "tracking");
  const { data: saved, error } = await sb
    .from("web_orders")
    .update({
      tracking_number: null,
      tracking_url: null,
      label_url: null,
      label_transaction_id: null,
      label_cost_cents: null,
      label_purchased_at: null,
      label_buying_at: null,
      // Keep shipped_at — marketplace may already show shipped; operator can still re-label after void
      updated_at: now,
    })
    .eq("id", order.id)
    .select("*")
    .single();
  if (error) throw error;
  return { ok: true, status: 200, order: saved, void_status: status, source };
}

/** Reprint / download metadata for an existing Floor-bought label. */
export async function labelStatus(sb, storeId, orderId) {
  const order = await loadOrder(sb, storeId, orderId);
  if (!order) return { ok: false, status: 404, error: "order_not_found" };
  let label = null;
  {
    const q = sb.from("web_order_labels").select("*").eq("order_id", order.id).is("voided_at", null);
    const ordered = typeof q.order === "function" ? q.order("purchased_at", { ascending: false }) : q;
    const limited = typeof ordered.limit === "function" ? ordered.limit(1) : ordered;
    const res = await limited.maybeSingle();
    label = res?.data || null;
  }
  return {
    ok: true,
    status: 200,
    order: {
      id: order.id,
      order_no: order.order_no,
      channel: order.channel,
      label_url: order.label_url,
      tracking_number: order.tracking_number,
      label_cost_cents: order.label_cost_cents,
      carrier: order.carrier,
      service: order.service,
      shipped_at: order.shipped_at,
    },
    label: label || null,
    can_buy: !order.label_url && order.status === "paid" && order.fulfillment === "ship" && channelAllowsLabels(order.channel),
    can_void: Boolean(label && !label.voided_at && !order.delivered_at),
  };
}
