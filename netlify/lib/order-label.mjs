/**
 * Store a 4×6 (or uploaded) label in the order-labels bucket and,
 * for uploads, read the tracking number. Uploads never post a shipping expense.
 */
import { compactTracking, extractTrackingFromFile, trackingUrlFor } from "./tracking-extract.mjs";
import { registerOrderTracking } from "./order-tracking.mjs";

const MAX_BYTES = 8_000_000;

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
  if (pdf && ebay && pdf !== ebay) {
    return {
      mismatch: true,
      tracking: pdf,
      carrier: extracted.carrier || null,
      needsEntry: false,
      exception: `Uploaded label ${pdf} does not match eBay ${ebay}`,
    };
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
  if (resolved.tracking) {
    patch.tracking_number = resolved.tracking;
    patch.carrier = resolved.carrier;
    patch.tracking_url = trackingUrlFor(resolved.carrier, resolved.tracking);
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
  const needsManual = resolved.needsEntry && !resolved.tracking;
  return {
    ok: true,
    status: 200,
    order: saved,
    needs_tracking: needsManual,
    mismatch: resolved.mismatch,
    exception: resolved.exception,
    tracking_number: resolved.tracking,
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
    expense_posted: false,
  };
}

export async function setOrderTrackingNumber(sb, storeId, order, { tracking, carrier } = {}, deps = {}) {
  if (!order) return { ok: false, status: 404, error: "Order not found." };
  const number = String(tracking || "").replace(/\s+/g, "").toUpperCase();
  if (number.length < 8 || number.length > 40) return { ok: false, status: 400, error: "Enter the tracking number from the label." };
  const car = String(carrier || "").trim() || (number.startsWith("1Z") ? "UPS" : "USPS");
  const now = new Date().toISOString();
  const { data: saved, error } = await sb.from("web_orders").update({
    tracking_number: number,
    carrier: car,
    tracking_url: trackingUrlFor(car, number),
    tracking_needs_entry: false,
    updated_at: now,
  }).eq("id", order.id).eq("store_id", storeId).select("*").single();
  if (error) return { ok: false, status: 500, error: error.message };
  let registered = null;
  try {
    registered = await (deps.registerTrack || registerOrderTracking)(sb, saved);
  } catch (err) {
    registered = { ok: false, error: err.message };
  }
  return { ok: true, status: 200, order: saved, registered, expense_posted: false };
}
