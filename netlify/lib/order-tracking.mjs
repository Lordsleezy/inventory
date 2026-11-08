/**
 * Shippo track_updated → order stage.
 * PRE_TRANSIT stays put. The first real scan sets shipped_at.
 * DELIVERED sets delivered_at. FAILURE / RETURNED flags the order.
 */
import { guessShippoCarrier, registerTrack, shippoMode } from "./shippo.mjs";

export function patchFromShippoStatus(order, { status, statusDate, statusDetails } = {}) {
  const st = String(status || "").toUpperCase();
  const now = new Date().toISOString();
  const when = statusDate || now;
  const detail = String(statusDetails || "").trim();
  const patch = {
    tracking_status: st ? st.toLowerCase() : order.tracking_status || null,
    updated_at: now,
  };
  const exception = st === "FAILURE" || st === "RETURNED" || /return to sender|exception|undeliverable|failure/i.test(detail);
  if (exception) patch.tracking_exception = (detail || st).slice(0, 300);
  else if (st === "TRANSIT" || st === "DELIVERED" || st === "PRE_TRANSIT") patch.tracking_exception = null;

  const scanned = st === "TRANSIT" || st === "DELIVERED" || st === "RETURNED" || st === "FAILURE";
  if (scanned && !order.shipped_at) patch.shipped_at = when;
  if (st === "DELIVERED") {
    patch.delivered_at = order.delivered_at || when;
    if (!order.shipped_at && !patch.shipped_at) patch.shipped_at = when;
  }
  return patch;
}

function historyRows(track) {
  const hist = Array.isArray(track?.tracking_history) ? track.tracking_history : [];
  const rows = hist.map((h) => ({
    status: String(h.status || "UNKNOWN").toUpperCase(),
    status_detail: h.status_details || h.status || null,
    location: [h.location?.city, h.location?.state].filter(Boolean).join(", ") || h.location?.country || null,
    carrier: track?.carrier || null,
    occurred_at: h.status_date || h.object_created || null,
  })).filter((r) => r.occurred_at);
  const current = track?.tracking_status;
  if (current?.status && (current.status_date || current.object_created)) {
    rows.push({
      status: String(current.status).toUpperCase(),
      status_detail: current.status_details || current.status,
      location: [current.location?.city, current.location?.state].filter(Boolean).join(", ") || null,
      carrier: track?.carrier || null,
      occurred_at: current.status_date || current.object_created,
    });
  }
  return rows;
}

export async function applyTrackToOrder(sb, order, track) {
  const current = track?.tracking_status || {};
  const patch = patchFromShippoStatus(order, {
    status: current.status,
    statusDate: current.status_date || current.object_created || null,
    statusDetails: current.status_details || "",
  });
  if (track?.carrier && !order.carrier) patch.carrier = track.carrier;
  const { error } = await sb.from("web_orders").update(patch).eq("id", order.id);
  if (error) throw error;

  for (const ev of historyRows(track)) {
    const { error: insErr } = await sb.from("order_tracking_events").insert({
      store_id: order.store_id,
      order_id: order.id,
      status: ev.status,
      status_detail: ev.status_detail,
      location: ev.location,
      carrier: ev.carrier,
      occurred_at: ev.occurred_at,
      raw: { status: ev.status, status_detail: ev.status_detail, location: ev.location },
    });
    if (insErr && insErr.code !== "23505") throw insErr;
  }
  return { ok: true, order_id: order.id, patch };
}

export async function registerOrderTracking(sb, order, deps = {}) {
  const tracking = String(order?.tracking_number || "").replace(/\s+/g, "");
  if (!tracking) return { ok: false, skipped: "no_tracking" };
  if (!deps.registerTrack && !shippoMode()) return { ok: false, skipped: "shippo_offline" };
  const token = guessShippoCarrier(tracking) || "usps";
  const reg = await (deps.registerTrack || registerTrack)(token, tracking);
  const trackId = reg?.object_id || null;
  if (trackId) {
    await sb.from("web_orders").update({
      shippo_track_id: trackId,
      carrier: order.carrier || reg.carrier || null,
    }).eq("id", order.id);
  }
  if (reg?.tracking_status || reg?.tracking_history) {
    await applyTrackToOrder(sb, { ...order, carrier: order.carrier || reg.carrier || null, shippo_track_id: trackId }, reg);
  }
  return { ok: true, shippo_track_id: trackId };
}

/** Match a Shippo track_updated payload to Floor orders and move their stage. */
export async function applyOrderShippoWebhook(sb, payload) {
  const data = payload?.data || payload || {};
  const trackingNumber = String(data.tracking_number || "").replace(/\s+/g, "");
  if (!trackingNumber) return { ok: false, error: "no_tracking_number" };
  const { data: rows, error } = await sb.from("web_orders").select("*").eq("tracking_number", trackingNumber).limit(8);
  if (error) return { ok: false, error: error.message };
  const results = [];
  for (const row of rows || []) results.push(await applyTrackToOrder(sb, row, data));
  return { ok: true, matched: (rows || []).length, results };
}

/**
 * One-time registration so Shippo will webhook orders that already have a number.
 * Skips anything already registered or already delivered. Not a status poll.
 */
export async function registerPendingOrderTracks(sb, limit = 20) {
  if (!shippoMode()) return { ok: true, skipped: "shippo_offline", registered: 0 };
  const { data: rows, error } = await sb.from("web_orders")
    .select("id,store_id,sku,tracking_number,carrier,shipped_at,delivered_at,packaged_at,tracking_status,order_no,channel")
    .eq("status", "paid")
    .not("tracking_number", "is", null)
    .is("shippo_track_id", null)
    .is("delivered_at", null)
    .limit(limit);
  if (error) return { ok: false, error: error.message };
  let registered = 0;
  const errors = [];
  for (const row of rows || []) {
    try {
      const r = await registerOrderTracking(sb, row);
      if (r.ok) registered += 1;
    } catch (err) {
      errors.push({ id: row.id, error: err.message || String(err) });
    }
  }
  return { ok: true, registered, considered: (rows || []).length, errors };
}
