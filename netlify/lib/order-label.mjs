/**
 * Store a 4×6 (or uploaded) label in the order-labels bucket and,
 * for uploads, read the tracking number. Uploads never post a shipping expense.
 */
import { compactTracking, extractTrackingFromFile, trackingUrlFor } from "./tracking-extract.mjs";
import { registerOrderTracking } from "./order-tracking.mjs";
import { trackingNumbersEquivalent } from "../../shared/tracking-reconcile.mjs";
import { classifyCarrier } from "../../shared/tracking-validate.mjs";

const MAX_BYTES = 8_000_000;

function normAddr(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Copy lead label + tracking onto open peers in the same one-box shipment. */
export async function mirrorShipmentLabel(sb, storeId, lead) {
  if (!lead?.id || !storeId) return { ok: true, mirrored: 0, skus: [] };
  if (!lead.label_storage_path && !lead.label_uploaded_at && !lead.tracking_number) {
    return { ok: true, mirrored: 0, skus: [] };
  }
  const { data: peers, error } = await sb
    .from("web_orders")
    .select("*")
    .eq("store_id", storeId)
    .eq("channel", lead.channel)
    .eq("status", "paid")
    .eq("fulfillment", "ship")
    .is("shipped_at", null)
    .is("canceled_at", null)
    .neq("id", lead.id);
  if (error) return { ok: false, error: error.message, mirrored: 0, skus: [] };
  const { data: splits } = await sb.from("bundle_splits").select("order_id").eq("store_id", storeId);
  const splitIds = new Set((splits || []).map((row) => String(row.order_id)));
  const { data: links } = await sb.from("bundle_links").select("order_id, peer_id").eq("store_id", storeId);
  const linked = new Set();
  for (const link of links || []) {
    if (String(link.order_id) === String(lead.id)) linked.add(String(link.peer_id));
    if (String(link.peer_id) === String(lead.id)) linked.add(String(link.order_id));
  }
  const buyer = normAddr(lead.buyer_name);
  const sameAddress = (peer) =>
    buyer
    && buyer === normAddr(peer.buyer_name)
    && normAddr(lead.ship_line1)
    && normAddr(lead.ship_line1) === normAddr(peer.ship_line1)
    && normAddr(lead.ship_line2) === normAddr(peer.ship_line2)
    && normAddr(lead.ship_city) === normAddr(peer.ship_city)
    && normAddr(lead.ship_region) === normAddr(peer.ship_region)
    && normAddr(lead.ship_postal) === normAddr(peer.ship_postal);
  const skus = [];
  for (const peer of peers || []) {
    if (splitIds.has(String(peer.id))) continue;
    if (!linked.has(String(peer.id)) && !sameAddress(peer)) continue;
    const { error: upErr } = await sb.from("web_orders").update({
      label_storage_path: lead.label_storage_path || peer.label_storage_path,
      label_file_name: lead.label_file_name || peer.label_file_name,
      label_mime: lead.label_mime || peer.label_mime,
      label_uploaded_at: lead.label_uploaded_at || peer.label_uploaded_at,
      label_purchased_at: lead.label_purchased_at || peer.label_purchased_at,
      label_origin: lead.label_origin || peer.label_origin,
      label_url: lead.label_url || peer.label_url,
      tracking_number: lead.tracking_number || peer.tracking_number,
      carrier: lead.carrier || peer.carrier,
      tracking_url: lead.tracking_url || peer.tracking_url,
      tracking_needs_entry: lead.tracking_needs_entry,
      label_tracking_mismatch: lead.label_tracking_mismatch,
      tracking_exception: lead.tracking_exception,
      updated_at: new Date().toISOString(),
    }).eq("id", peer.id).eq("store_id", storeId);
    if (!upErr) skus.push(peer.sku);
  }
  return { ok: true, mirrored: skus.length, skus };
}

export function safeLabelName(name, fallback = "label.pdf") {
  const base = String(name || fallback).split(/[/\\]/).pop() || fallback;
  const clean = base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  return clean || fallback;
}

export async function storeOrderLabelFile(sb, { storeId, orderId, bytes, filename, contentType }) {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (!body.length) throw new Error("Empty label file.");
  if (body.length > MAX_BYTES) throw new Error("Label file is over 8 MB.");
  const fileName = safeLabelName(filename, contentType?.includes("pdf") ? "label.pdf" : "label.jpg");
  const path = `${storeId}/${orderId}/${Date.now()}-${fileName}`;
  const { error } = await sb.storage.from("order-labels").upload(path, body, {
    contentType: contentType || "application/pdf",
    upsert: false,
  });
  if (error) throw new Error(error.message || "Could not store the label.");
  return { path, fileName };
}

export async function archiveRemoteLabel(sb, { storeId, orderId, url, filename, fetchImpl = fetch }) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`label_download_${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  return storeOrderLabelFile(sb, {
    storeId,
    orderId,
    bytes,
    filename: filename || "label-4x6.pdf",
    contentType: "application/pdf",
  });
}

/**
 * Decide which tracking number an uploaded label should keep.
 * eBay's fulfillment number wins when the PDF can't be read.
 * A PDF that disagrees with eBay is a mismatch and stays in Needs label.
 */
export function resolveUploadedTracking(order, extracted) {
  const ebay = compactTracking(order?.marketplace_tracking_number);
  const pdf = extracted?.confident && extracted?.number ? compactTracking(extracted.number) : "";
  if (pdf && ebay && !trackingNumbersEquivalent(pdf, ebay)) {
    const ch = String(order?.channel || "").toLowerCase();
    const market = ch === "ebay" ? "eBay" : ch === "depop" ? "Depop" : "marketplace";
    return {
      mismatch: true,
      labelTracking: pdf,
      marketplaceTracking: ebay,
      tracking: null,
      carrier: extracted.carrier || classifyCarrier(pdf) || null,
      needsEntry: false,
      exception: `label_mismatch|${pdf}|${ebay}`,
    };
  }
  if (pdf && ebay && trackingNumbersEquivalent(pdf, ebay)) {
    return { mismatch: false, tracking: ebay, carrier: order.carrier || extracted.carrier || classifyCarrier(ebay) || "USPS", needsEntry: false, exception: null, usedEbay: true };
  }
  if (pdf) {
    return { mismatch: false, tracking: pdf, carrier: extracted.carrier || null, needsEntry: false, exception: null };
  }
  if (ebay) {
    return {
      mismatch: false,
      tracking: ebay,
      carrier: order.carrier || "USPS",
      needsEntry: false,
      exception: null,
      usedEbay: true,
    };
  }
  return { mismatch: false, tracking: null, carrier: null, needsEntry: true, exception: null };
}

/**
 * Attach a buyer-provided or eBay-downloaded label PDF.
 * Confident tracking is saved and registered with Shippo. Otherwise the order asks for the number.
 * Depop uploads do not post a label expense. An eBay finances cost already on the order is left in place.
 */
export async function attachUploadedLabel(sb, storeId, order, file, deps = {}) {
  if (!order || order.store_id && order.store_id !== storeId) return { ok: false, status: 404, error: "Order not found." };
  if (order.status !== "paid" || order.fulfillment !== "ship") {
    return { ok: false, status: 400, error: "This order is not waiting to ship." };
  }
  const bytes = Buffer.isBuffer(file?.bytes) ? file.bytes : Buffer.from(file?.bytes || []);
  if (!bytes.length) return { ok: false, status: 400, error: "Choose a PDF or a screenshot." };
  if (bytes.length > MAX_BYTES) return { ok: false, status: 400, error: "Label file is over 8 MB." };
  const mime = String(file.mime || "application/pdf");
  const extracted = await (deps.extract || extractTrackingFromFile)(bytes, mime, {
    filename: file.name,
    marketplaceTracking: order.marketplace_tracking_number,
  });

  let stored = null;
  if (typeof sb.storage?.from === "function") {
    try {
      stored = await (deps.storeFile || storeOrderLabelFile)(sb, {
        storeId,
        orderId: order.id,
        bytes,
        filename: file.name,
        contentType: mime,
      });
    } catch (err) {
      return { ok: false, status: 500, error: `Could not store the label. ${err.message || ""}`.trim() };
    }
  } else if (!deps.allowMissingStorage) {
    return { ok: false, status: 500, error: "Label storage is not available." };
  }

  const now = new Date().toISOString();
  const resolved = resolveUploadedTracking(order, extracted);
  const patch = {
    label_storage_path: stored?.path || null,
    label_file_name: stored?.fileName || safeLabelName(file.name),
    label_mime: mime,
    label_uploaded_at: now,
    label_origin: "upload",
    label_tracking_mismatch: resolved.mismatch,
    tracking_exception: resolved.exception,
    tracking_needs_entry: resolved.needsEntry,
    updated_at: now,
  };
  if (String(order.channel || "").toLowerCase() !== "ebay") patch.label_cost_cents = null;
  if (resolved.tracking && !resolved.mismatch) {
    patch.tracking_number = resolved.tracking;
    patch.carrier = resolved.carrier;
    patch.tracking_url = trackingUrlFor(resolved.carrier, resolved.tracking);
  }
  if (resolved.mismatch) {
    patch.tracking_number = order.tracking_number || null;
    patch.tracking_needs_entry = false;
  }
  const { data: saved, error } = await sb.from("web_orders").update(patch).eq("id", order.id).eq("store_id", storeId).select("*").single();
  if (error) return { ok: false, status: 500, error: error.message };

  let registered = null;
  if (resolved.tracking && !resolved.mismatch && typeof sb.storage?.from === "function") {
    try {
      registered = await (deps.registerTrack || registerOrderTracking)(sb, saved);
    } catch (err) {
      registered = { ok: false, error: err.message };
    }
  }
  let mirrored = null;
  try {
    mirrored = await (deps.mirrorShipment || mirrorShipmentLabel)(sb, storeId, saved);
  } catch (err) {
    mirrored = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const needsManual = resolved.needsEntry && !resolved.tracking;
  return {
    ok: true,
    status: 200,
    order: saved,
    needs_tracking: needsManual,
    mismatch: resolved.mismatch,
    exception: resolved.exception,
    label_tracking: resolved.labelTracking || null,
    marketplace_tracking: resolved.marketplaceTracking || compactTracking(order?.marketplace_tracking_number) || null,
    tracking_number: resolved.mismatch ? null : resolved.tracking,
    carrier: resolved.carrier,
    reason: extracted.reason || null,
    engine: extracted.engine || extracted.layer || null,
    layer: extracted.layer || null,
    tracking_candidates: (extracted.alternatives || []).map((row) => ({
      number: row.number,
      carrier: row.carrier || null,
      source: row.source || row.layer || null,
    })),
    needs_picker: Boolean(extracted.needsPicker && !resolved.tracking),
    registered,
    mirrored,
    expense_posted: false,
  };
}

export async function setOrderTrackingNumber(sb, storeId, order, { tracking, carrier } = {}, deps = {}) {
  if (!order) return { ok: false, status: 404, error: "Order not found." };
  // Compact FedEx 34-digit door tags / USPS 420 wrappers before save.
  const number = compactTracking(tracking);
  if (!number || number.length < 8 || number.length > 40) {
    return { ok: false, status: 400, error: "Enter the tracking number from the label." };
  }
  const car = String(carrier || "").trim() || classifyCarrier(number) || (number.startsWith("1Z") ? "UPS" : "USPS");
  const now = new Date().toISOString();
  const { data: saved, error } = await sb.from("web_orders").update({
    tracking_number: number,
    carrier: car,
    tracking_url: trackingUrlFor(car, number),
    tracking_needs_entry: false,
    label_tracking_mismatch: false,
    tracking_exception: null,
    updated_at: now,
  }).eq("id", order.id).eq("store_id", storeId).select("*").single();
  if (error) return { ok: false, status: 500, error: error.message };
  let registered = null;
  try {
    registered = await (deps.registerTrack || registerOrderTracking)(sb, saved);
  } catch (err) {
    registered = { ok: false, error: err.message };
  }
  let mirrored = null;
  try {
    mirrored = await (deps.mirrorShipment || mirrorShipmentLabel)(sb, storeId, saved);
  } catch (err) {
    mirrored = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, status: 200, order: saved, registered, mirrored, expense_posted: false };
}

async function loadLabelBytes(sb, order) {
  const path = order?.label_storage_path;
  if (!path || typeof sb.storage?.from !== "function") return null;
  const { data, error } = await sb.storage.from("order-labels").download(path);
  if (error || !data) return null;
  return Buffer.from(await data.arrayBuffer());
}

/** Save marketplace tracking on an uploaded label after a mismatch. */
export async function acceptMarketplaceTracking(sb, storeId, order, deps = {}) {
  if (!order) return { ok: false, status: 404, error: "Order not found." };
  const number = compactTracking(order.marketplace_tracking_number);
  if (!number) return { ok: false, status: 400, error: "This order has no marketplace tracking number." };
  const carrier = order.carrier || classifyCarrier(number) || "USPS";
  return setOrderTrackingNumber(sb, storeId, order, { tracking: number, carrier }, deps);
}

/** Save a label-read number (after user confirms). */
export async function acceptLabelTracking(sb, storeId, order, { tracking, carrier } = {}, deps = {}) {
  if (!order) return { ok: false, status: 404, error: "Order not found." };
  const number = compactTracking(tracking);
  if (!number || number.length < 8) return { ok: false, status: 400, error: "Enter a valid tracking number." };
  const car = carrier || classifyCarrier(number) || "USPS";
  return setOrderTrackingNumber(sb, storeId, order, { tracking: number, carrier: car }, deps);
}

/** Re-run extraction on the stored label PDF. */
export async function retryLabelExtract(sb, storeId, order, deps = {}) {
  if (!order) return { ok: false, status: 404, error: "Order not found." };
  const bytes = await loadLabelBytes(sb, order);
  if (!bytes?.length) return { ok: false, status: 400, error: "No label file is stored on this order." };
  const mime = order.label_mime || "application/pdf";
  const extracted = await (deps.extract || extractTrackingFromFile)(bytes, mime, {
    filename: order.label_file_name,
    marketplaceTracking: order.marketplace_tracking_number,
  });
  const resolved = resolveUploadedTracking(order, extracted);
  const now = new Date().toISOString();
  const patch = {
    label_tracking_mismatch: resolved.mismatch,
    tracking_exception: resolved.exception,
    tracking_needs_entry: resolved.needsEntry,
    updated_at: now,
  };
  if (resolved.tracking && !resolved.mismatch) {
    patch.tracking_number = resolved.tracking;
    patch.carrier = resolved.carrier || classifyCarrier(resolved.tracking);
    patch.tracking_url = trackingUrlFor(patch.carrier, resolved.tracking);
    patch.label_tracking_mismatch = false;
    patch.tracking_exception = null;
    patch.tracking_needs_entry = false;
  }
  const { data: saved, error } = await sb.from("web_orders").update(patch).eq("id", order.id).eq("store_id", storeId).select("*").single();
  if (error) return { ok: false, status: 500, error: error.message };
  let registered = null;
  if (patch.tracking_number && !resolved.mismatch) {
    try {
      registered = await (deps.registerTrack || registerOrderTracking)(sb, saved);
    } catch (err) {
      registered = { ok: false, error: err.message };
    }
  }
  return {
    ok: true,
    status: 200,
    order: saved,
    mismatch: resolved.mismatch,
    exception: resolved.exception,
    label_tracking: resolved.labelTracking || (extracted.confident ? compactTracking(extracted.number) : null),
    marketplace_tracking: compactTracking(order.marketplace_tracking_number) || null,
    tracking_number: resolved.mismatch ? null : resolved.tracking,
    carrier: resolved.carrier,
    layer: extracted.layer || null,
    needs_picker: Boolean(extracted.needsPicker),
    tracking_candidates: (extracted.alternatives || []).map((row) => ({
      number: row.number,
      carrier: row.carrier || null,
      source: row.source || row.layer || null,
    })),
    registered,
  };
}
