import { getTrack, guessShippoCarrier, registerTrack, shippoMode } from "./shippo.mjs";

function mapShippoStatus(track) {
  const st = String(track?.tracking_status?.status || track?.tracking_status?.status_details || "").toLowerCase();
  if (st.includes("delivered")) return "received";
  if (st.includes("transit") || st.includes("picked") || st.includes("depart") || st.includes("arriv")) return "in_transit";
  if (st.includes("pre_transit") || st.includes("label") || st.includes("unknown")) return "in_transit";
  return null;
}

function eventsFromTrack(track) {
  const hist = track?.tracking_history || [];
  return hist.map((h) => ({
    status: String(h.status || h.status_details || "update").toLowerCase(),
    status_detail: h.status_details || h.status || "Update",
    location: [h.location?.city, h.location?.state].filter(Boolean).join(", ") || h.location?.country || null,
    carrier: track?.carrier || null,
    occurred_at: h.status_date || h.object_created || new Date().toISOString(),
    raw: h,
  }));
}

export async function syncReturnTracking(sb, storeId, returnId) {
  const { data: row, error } = await sb.from("returns").select("*").eq("store_id", storeId).eq("id", returnId).maybeSingle();
  if (error) throw error;
  if (!row?.tracking_number) return { ok: true, skipped: "no_tracking" };
  const carrier = (row.carrier || guessShippoCarrier(row.tracking_number) || "usps").toLowerCase();
  let track = null;
  if (shippoMode()) {
    try {
      if (!row.shippo_track_id) {
        const reg = await registerTrack(carrier, row.tracking_number);
        if (reg?.object_id) {
          await sb.from("returns").update({ shippo_track_id: reg.object_id, carrier: reg.carrier || carrier }).eq("id", returnId);
        }
      }
      track = await getTrack(carrier, row.tracking_number);
    } catch (err) {
      return { ok: false, error: err.message || "shippo_track_failed" };
    }
  }
  if (!track?.tracking_history?.length) return { ok: true, skipped: "no_history" };

  for (const ev of eventsFromTrack(track)) {
    const { error: insErr } = await sb.from("return_tracking_events").insert({
      store_id: storeId,
      return_id: returnId,
      status: ev.status,
      status_detail: ev.status_detail,
      location: ev.location,
      carrier: ev.carrier,
      occurred_at: ev.occurred_at,
      raw: ev.raw,
    });
    if (insErr && insErr.code !== "23505") throw insErr;
  }

  const mapped = mapShippoStatus(track);
  const eta = track?.eta ? String(track.eta).slice(0, 10) : null;
  const patch = { carrier: track?.carrier || carrier, tracking_eta: eta, updated_at: new Date().toISOString() };
  if (mapped === "received" && !["closed", "canceled", "dispositioned", "refunded_no_return"].includes(row.status)) {
    patch.status = "received";
    patch.received_at = row.received_at || new Date().toISOString();
  } else if (mapped === "in_transit" && ["requested", "label_sent", "approved"].includes(row.status)) {
    patch.status = "in_transit";
    patch.in_transit_at = row.in_transit_at || new Date().toISOString();
  }
  await sb.from("returns").update(patch).eq("id", returnId);
  return { ok: true, status: patch.status || row.status, events: track.tracking_history.length };
}

/** Shippo track_updated webhook payload → same sync path when return_id is embedded in metadata. */
export async function applyShippoTrackWebhook(sb, payload) {
  const data = payload?.data || payload;
  const trackingNumber = data?.tracking_number;
  if (!trackingNumber) return { ok: false, error: "no_tracking_number" };
  const { data: rows } = await sb.from("returns").select("id, store_id").eq("tracking_number", trackingNumber).limit(5);
  if (!rows?.length) return { ok: true, skipped: "no_matching_return" };
  const out = [];
  for (const r of rows) {
    out.push(await syncReturnTracking(sb, r.store_id, r.id));
  }
  return { ok: true, results: out };
}
