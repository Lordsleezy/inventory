import { addressTo, allowedCarriers, buyLabel, getRate, liveRates, pickDefaultRate, refundLabel, shippoMode } from "./shippo.mjs";
import { deliverOrderEmails, ownerEmails } from "./web-order-email.mjs";

const num = v => Number(v);
const validBox = b => b && [b.length_in, b.width_in, b.height_in, b.weight_lb].every(v => Number.isFinite(num(v)) && num(v) > 0)
  && num(b.weight_lb) <= 150 && Math.max(num(b.length_in), num(b.width_in), num(b.height_in)) <= 108;
const cleanBox = b => ({ length_in: num(b.length_in), width_in: num(b.width_in), height_in: num(b.height_in), weight_lb: num(b.weight_lb) });

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
  const { data } = await sb.from("units").select("package_length_in,package_width_in,package_height_in,package_weight_lb,dims_source").eq("store_id", storeId).eq("sku", sku).single();
  return { length_in: data?.package_length_in ?? null, width_in: data?.package_width_in ?? null, height_in: data?.package_height_in ?? null, weight_lb: data?.package_weight_lb ?? null, dims_source: data?.dims_source ?? null };
}

function eligibility(order) {
  if (!order || order.fulfillment !== "ship" || order.status !== "paid") return "Not a paid shipping order.";
  if (order.refund_requested_at) return "Order is being canceled.";
  if (order.shipped_at) return "Order is already marked shipped.";
  if (order.label_url && order.tracking_number) return "This order already has a label. Void it first to buy another.";
  return null;
}

/** Live re-quote with the real box. Nothing is bought. */
export async function labelQuote(sb, storeId, orderId, box, deps = {}) {
  const order = await loadOrder(sb, storeId, orderId);
  const problem = eligibility(order);
  if (problem) return { ok: false, status: 400, error: problem };
  const match = shippoMatchesOrder(order, deps.mode);
  if (!match.ok) return { ok: false, status: 409, error: match.error };
  const stored = await unitBox(sb, storeId, order.sku);
  const useBox = box && Object.keys(box).length ? box : stored;
  if (!validBox(useBox)) return { ok: false, status: 400, error: "Enter the box length, width, height (in) and weight (lb)." };
  const { data: from } = await sb.from("store_settings").select("value").eq("store_id", storeId).eq("key", "ship_from").single();
  const shipFrom = { ...(from?.value || {}) };
  if (!shipFrom.email) shipFrom.email = (await ownerEmails(sb, storeId))[0] || "";
  const quote = await (deps.liveRates || liveRates)({
    shipFrom,
    to: addressTo({ name: order.buyer_name, line1: order.ship_line1, line2: order.ship_line2, city: order.ship_city, region: order.ship_region, postal: order.ship_postal, phone: order.buyer_phone, email: order.buyer_email }),
    pkg: cleanBox(useBox),
    carriers: await allowedCarriers(sb, storeId),
  });
  const rates = quote.all || quote.rates;
  if (!rates.length) return { ok: false, status: 502, error: `No carrier rates for this box: ${quote.messages.join("; ") || "unknown"}` };
  const paid = order.shipping_rate || {};
  const pick = pickDefaultRate(rates, paid);
  return {
    ok: true, status: 200,
    order: { id: order.id, order_no: order.order_no, sku: order.sku, paid_shipping_cents: order.shipping_cents,
      paid_service: { carrier: paid.carrier || order.carrier || null, service: paid.service || order.service || null, days: paid.days ?? null, source: paid.source || null } },
    box: cleanBox(useBox), stored_box: stored, rates, selected_id: pick.rate.id, selected_reason: pick.reason, messages: quote.messages,
  };
}

/**
 * Buy the chosen rate. The box is saved back to the unit as measured, the label cost becomes an
 * expense to reimburse, and saving the tracking number queues the customer's tracking email.
 */
export async function buyLabelForOrder(sb, storeId, orderId, { rateId, box, actor }, deps = {}) {
  const order = await loadOrder(sb, storeId, orderId);
  const problem = eligibility(order);
  if (problem) return { ok: false, status: 400, error: problem };
  const match = shippoMatchesOrder(order, deps.mode);
  if (!match.ok) return { ok: false, status: 409, error: match.error };
  if (!rateId) return { ok: false, status: 400, error: "Pick a rate first." };
  if (!validBox(box)) return { ok: false, status: 400, error: "Enter the box length, width, height (in) and weight (lb)." };
  const cb = cleanBox(box);

  // One buy at a time per order (double-click / two admins).
  const staleBefore = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const { data: claimed, error: claimError } = await sb.from("web_orders").update({ label_buying_at: new Date().toISOString() })
    .eq("id", order.id).is("tracking_number", null).or(`label_buying_at.is.null,label_buying_at.lt.${staleBefore}`).select("id").maybeSingle();
  if (claimError) throw claimError;
  if (!claimed) return { ok: false, status: 409, error: "A label for this order is already being bought." };
  const release = () => sb.from("web_orders").update({ label_buying_at: null }).eq("id", order.id);

  let rate, tx;
  try {
    rate = await (deps.getRate || getRate)(rateId);
    tx = await (deps.buyLabel || buyLabel)(rateId);
  } catch (err) {
    await release();
    return { ok: false, status: 502, error: `Label purchase failed: ${err.detail?.detail || err.message}` };
  }
  if (tx.status !== "SUCCESS" || !tx.tracking_number) {
    await release();
    const msg = (tx.messages || []).map(m => m.text || String(m)).join("; ");
    return { ok: false, status: 502, error: `Label purchase failed${msg ? `: ${msg}` : ""}` };
  }

  const now = new Date().toISOString();
  try {
    const { data: label, error: labelError } = await sb.from("web_order_labels").insert({
      store_id: storeId, order_id: order.id, transaction_id: tx.object_id, rate_id: rateId, carrier: rate.carrier, service: rate.service,
      estimated_days: rate.days, cost_cents: rate.amount_cents, tracking_number: tx.tracking_number, tracking_url: tx.tracking_url_provider || null,
      label_url: tx.label_url, box: cb, purchased_by: actor || null,
    }).select("id").single();
    if (labelError) throw labelError;
    await sb.from("web_order_emails").delete().eq("order_id", order.id).eq("kind", "tracking");
    const { data: saved, error: saveError } = await sb.from("web_orders").update({
      tracking_number: tx.tracking_number, tracking_url: tx.tracking_url_provider || null, label_url: tx.label_url,
      label_transaction_id: tx.object_id, label_cost_cents: rate.amount_cents, carrier: rate.carrier, service: rate.service,
      label_purchased_at: now, boxed_at: order.boxed_at || now, label_buying_at: null, updated_at: now,
    }).eq("id", order.id).select("*").single();
    if (saveError) throw saveError;
    const { data: owner } = await sb.from("store_settings").select("value").eq("store_id", storeId).eq("key", "online_payout_employee_id").maybeSingle();
    const employeeId = typeof owner?.value === "string" ? owner.value : null;
    const { error: expenseError } = await sb.from("portal_expenses").insert({
      store_id: storeId, description: `Shippo label ${order.order_no} — ${rate.carrier} ${rate.service}`, category: "Shipping",
      amount_cents: rate.amount_cents, needs_reimbursement: Boolean(employeeId), employee_id: employeeId, source: "label",
      order_id: order.id, label_id: label.id,
    });
    if (expenseError) throw expenseError;
    // Real box → unit (measured), so the next listing/quote uses it.
    const { error: unitError } = await sb.from("units").update({
      package_length_in: cb.length_in, package_width_in: cb.width_in, package_height_in: cb.height_in, package_weight_lb: cb.weight_lb,
      dims_source: "measured", updated_at: now,
    }).eq("store_id", storeId).eq("sku", order.sku);
    if (unitError) throw unitError;
    await sb.from("events").insert({ store_id: storeId, sku: order.sku, kind: "edit", field: "package_dims", new_value: JSON.stringify(cb), actor: actor || "admin", note: `measured at packing, label ${order.order_no}` });
    await (deps.deliver || deliverOrderEmails)(sb, order.id).catch(() => []);
    return { ok: true, status: 200, order: saved, label_id: label.id, cost_cents: rate.amount_cents };
  } catch (err) {
    // The label exists at Shippo but Floor could not record it: undo the purchase rather than lose track of money.
    await (deps.refundLabel || refundLabel)(tx.object_id).catch(() => null);
    await release();
    return { ok: false, status: 500, error: `Label was bought but could not be saved, so it was voided at Shippo (${tx.tracking_number}). Try again. (${err.message})` };
  }
}

/**
 * Void the order's current label through Shippo (refund), reverse its expense, clear the tracking
 * so a new label can be bought, and allow a fresh tracking email.
 */
export async function voidLabel(sb, storeId, orderId, deps = {}) {
  const order = await loadOrder(sb, storeId, orderId);
  if (!order || !order.label_transaction_id) return { ok: false, status: 400, error: "This order has no label to void." };
  if (order.shipped_at && !deps.force) return { ok: false, status: 409, error: "Order is already marked shipped; a shipped label can no longer be voided here." };
  let result;
  try { result = await (deps.refundLabel || refundLabel)(order.label_transaction_id); }
  catch (err) { return { ok: false, status: 502, error: `Shippo would not void the label: ${err.detail?.detail || err.message}` }; }
  const status = String(result?.status || "QUEUED").toUpperCase();
  if (status === "ERROR") return { ok: false, status: 502, error: "Shippo rejected the label refund (it may already be in use)." };
  const now = new Date().toISOString();
  await sb.from("web_order_labels").update({ voided_at: now, void_status: status }).eq("order_id", order.id).eq("transaction_id", order.label_transaction_id);
  const { data: lbl } = await sb.from("web_order_labels").select("id").eq("order_id", order.id).eq("transaction_id", order.label_transaction_id).maybeSingle();
  if (lbl) await sb.from("portal_expenses").update({ voided_at: now, void_reason: "label voided" }).eq("label_id", lbl.id).is("voided_at", null);
  await sb.from("web_order_emails").delete().eq("order_id", order.id).eq("kind", "tracking");
  const { data: saved, error } = await sb.from("web_orders").update({
    tracking_number: null, tracking_url: null, label_url: null, label_transaction_id: null, label_cost_cents: null,
    label_purchased_at: null, label_buying_at: null, updated_at: now,
  }).eq("id", order.id).select("*").single();
  if (error) throw error;
  return { ok: true, status: 200, order: saved, void_status: status };
}
