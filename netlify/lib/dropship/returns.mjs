import { serviceClient } from "../server.mjs";
import { enqueueDropshipAlert } from "./alerts.mjs";
import { isDropshipSku } from "./types.mjs";

/**
 * Dropship returns — extends Floor returns; never auto-refund/cancel.
 * Defaults by reason; cheap items refund-and-keep; returned resalable items
 * become a NEW real Floor unit via Receive (DS- itself never becomes a unit).
 */

export function resolveDropshipReturnDefault(reason, priceCents, settings = {}) {
  const threshold = Number(settings.refund_keep_threshold_cents ?? 2500);
  const r = String(reason || "").toLowerCase();
  const supplierFault = /damaged|defect|wrong|not as described|nad|not.?received|never arrived|missing/.test(r);
  const changeOfMind = /change of mind|unused|remorse|buyer's remorse|no longer/.test(r);

  if (priceCents < threshold) {
    return {
      resolution: "refund_and_keep",
      who_pays_return_shipping: "n/a",
      needs_paul: true,
      note: `Under $${(threshold / 100).toFixed(0)} threshold — refund-and-keep default`,
    };
  }
  if (supplierFault) {
    return {
      resolution: "refund_and_keep",
      who_pays_return_shipping: "seller",
      needs_paul: true,
      open_supplier_claim: true,
      note: "Supplier/our fault — we pay; default refund-and-keep then supplier claim",
    };
  }
  if (changeOfMind) {
    return {
      resolution: "return_then_resell",
      who_pays_return_shipping: "buyer",
      needs_paul: true,
      note: "Change of mind — buyer pays return shipping where channel allows; resell via Receive",
    };
  }
  return {
    resolution: "needs_review",
    who_pays_return_shipping: "unknown",
    needs_paul: true,
    note: "Unrecognized reason — Paul decides",
  };
}

/** Create a Returns-tab task for a DS- order (never auto-refund). */
export async function openDropshipReturnTask(storeId, { orderId, reason, channel, priceCents }) {
  const sb = serviceClient();
  const { data: order } = await sb
    .from("dropship_orders")
    .select("*")
    .eq("id", orderId)
    .eq("store_id", storeId)
    .maybeSingle();
  if (!order || !isDropshipSku(order.sku)) throw new Error("not_dropship_order");

  const { data: settings } = await sb.from("dropship_settings").select("settings").eq("store_id", storeId).maybeSingle();
  const plan = resolveDropshipReturnDefault(reason, priceCents ?? order.cost_cents ?? 0, settings?.settings || {});

  // Prefer existing portal_create_return when possible; fall back to link + alert task.
  let returnId = null;
  try {
    const { data, error } = await sb.rpc("portal_create_return", {
      p_payload: {
        sku: order.sku,
        channel: channel || order.channel,
        reason: reason || "dropship_return",
        order_id: order.channel_order_id,
        dropship: true,
        ds_badge: true,
        suggested_resolution: plan.resolution,
        who_pays_return_shipping: plan.who_pays_return_shipping,
        note: `DS- dropship return. ${plan.note}. Never auto-refund.`,
      },
    });
    if (!error) returnId = data?.id || data;
  } catch {
    /* RPC may reject DS- sku — keep link + alert */
  }

  await sb.from("dropship_return_links").upsert(
    {
      store_id: storeId,
      dropship_order_id: order.id,
      return_id: returnId,
      disposition: "pending",
    },
    { onConflict: "store_id,dropship_order_id" },
  );

  let claimId = null;
  if (plan.open_supplier_claim) {
    const claim = await openSupplierClaim(storeId, {
      dropshipOrderId: order.id,
      returnId,
      reason,
    });
    claimId = claim.id;
  }

  await enqueueDropshipAlert(storeId, order.sku, `DS- return task: ${plan.resolution} — ${plan.note}`, {
    kind_detail: "return_task",
    order_id: order.id,
    return_id: returnId,
    claim_id: claimId,
    plan,
  });

  return { ok: true, plan, returnId, claimId, needsPaul: true };
}

export async function openSupplierClaim(storeId, { dropshipOrderId, returnId, reason }) {
  const sb = serviceClient();
  const { data: settings } = await sb.from("dropship_settings").select("settings").eq("store_id", storeId).maybeSingle();
  const rules = settings?.settings || {};
  const unverified = rules.cj_dispute_window_unverified !== false;
  const windowDays = rules.cj_dispute_window_days != null ? Number(rules.cj_dispute_window_days) : null;
  const deadline = windowDays
    ? new Date(Date.now() + windowDays * 86400_000).toISOString()
    : null;

  const evidence = [
    "Photos or video of damage / wrong item",
    "Screenshot of customer message or case (name + date)",
    "Channel order id + supplier order id",
    "Order dates and tracking",
  ];

  const { data, error } = await sb
    .from("dropship_supplier_claims")
    .insert({
      store_id: storeId,
      dropship_order_id: dropshipOrderId,
      return_id: returnId || null,
      supplier: "cj",
      status: "open",
      reason: reason || null,
      claim_window_days: windowDays,
      claim_window_unverified: unverified,
      evidence,
      deadline_at: deadline,
    })
    .select("*")
    .single();
  if (error) throw error;

  await enqueueDropshipAlert(storeId, "DS-", `Supplier claim opened — file in CJ Disputes dashboard (API filing not verified). Window ${unverified ? "UNVERIFIED" : `${windowDays}d`}.`, {
    kind_detail: "supplier_claim",
    claim_id: data.id,
  });
  return data;
}

/**
 * After garage inspection: create a NEW real Floor unit via normal receive semantics,
 * or write off. The DS- row never becomes a unit.
 */
export async function receiveReturnedDropshipAsUnit(storeId, { orderId, disposition, newSku, lossCents = 0, userId }) {
  const sb = serviceClient();
  if (!["receive_as_unit", "write_off", "buyer_keeps"].includes(disposition)) {
    throw new Error("bad_disposition");
  }
  const { data: order } = await sb.from("dropship_orders").select("*").eq("id", orderId).eq("store_id", storeId).maybeSingle();
  if (!order) throw new Error("order_not_found");

  if (disposition === "receive_as_unit") {
    if (!newSku || isDropshipSku(newSku)) {
      throw new Error("new_real_sku_required"); // must be a normal Floor SKU from Receive
    }
    // Link only — actual unit creation is Paul's Receive flow (photos/dims required).
    await sb.from("dropship_return_links").upsert(
      {
        store_id: storeId,
        dropship_order_id: order.id,
        new_unit_sku: newSku,
        disposition: "receive_as_unit",
        loss_cents: 0,
      },
      { onConflict: "store_id,dropship_order_id" },
    );
    await enqueueDropshipAlert(storeId, order.sku, `Returned DS- item linked to new Floor unit ${newSku} for open-box resale.`, {
      kind_detail: "return_received_as_unit",
      new_sku: newSku,
      actor: userId,
    });
    return { ok: true, newSku };
  }

  await sb.from("dropship_return_links").upsert(
    {
      store_id: storeId,
      dropship_order_id: order.id,
      disposition,
      loss_cents: lossCents,
    },
    { onConflict: "store_id,dropship_order_id" },
  );
  // Best-effort loss ledger if table exists
  try {
    await sb.from("loss_ledger").insert({
      store_id: storeId,
      sku: order.sku,
      reason: `dropship_${disposition}`,
      amount_cents: lossCents,
      note: `DS- return ${disposition}`,
    });
  } catch {
    /* optional table */
  }
  await enqueueDropshipAlert(storeId, order.sku, `DS- return ${disposition}; loss $${(lossCents / 100).toFixed(2)}`, {
    kind_detail: "return_write_off",
  });
  return { ok: true, disposition, lossCents };
}
