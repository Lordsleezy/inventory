// Scheduled: drains listing_queue (checkbox list/end jobs). Does nothing unless store_settings.channel_autopush.enabled.
import { serviceClient, requireEnv } from "../lib/server.mjs";
import { runAutopush, supabaseQueueDb, queuePublish } from "../lib/channel-autopush.mjs";
import { publishCreate } from "../lib/listing-manager.mjs";
import { endOnChannel } from "../lib/marketplace-board.mjs";
import { ebayPublishedListingForSku, setEbayAvailableQuantity } from "../lib/ebay.mjs";
import { amazonListingExists, syncAmazonOfferForFloorSku } from "../lib/amazon.mjs";
import { setTikTokAvailableQuantity } from "../lib/tiktok-shop.mjs";
import { planChannelQuantity } from "../lib/channel-qty-sync.mjs";
import { wrapHandler, asNetlifyFunction } from "../lib/floor-log.mjs";

function publishDeps(sb) {
  return {
    loadUnit: async (storeId, sku) => {
      const { data, error } = await sb.from("units").select("sku, ask_cents, qty_on_hand").eq("store_id", storeId).eq("sku", sku).maybeSingle();
      if (error) throw new Error(error.message);
      const { data: available } = await sb.rpc("channel_available_qty", { p_store: storeId, p_sku: sku });
      return data ? { ...data, qty_on_hand: Number.isFinite(Number(available)) ? Number(available) : data.qty_on_hand } : data;
    },
    existingListing: async (storeId, channel, sku) => {
      if (channel === "ebay") return ebayPublishedListingForSku(storeId, sku);
      if (channel === "amazon") return (await amazonListingExists(storeId, sku)) ? { url: "already_live" } : null;
      if (channel === "tiktok") {
        const { data, error } = await sb.from("tiktok_list_items").select("product_id").eq("store_id", storeId).eq("sku", sku).maybeSingle();
        if (error) throw new Error(error.message);
        return data?.product_id ? { url: "already_live" } : null;
      }
      return null;
    },
    publish: (storeId, args) => publishCreate(storeId, args),
  };
}

async function pushQueuedQuantity(sb, row) {
  const { data: qty } = await sb.rpc("channel_available_qty", { p_store: row.store_id, p_sku: row.sku });
  const available = Number.isFinite(Number(qty)) ? Math.max(0, Math.trunc(Number(qty))) : Math.max(0, Math.trunc(Number(row.available_qty) || 0));
  const { data: listing } = await sb.from("listings").select("status, listing_id").eq("store_id", row.store_id).eq("sku", row.sku).eq("channel", row.channel).maybeSingle();
  const plan = planChannelQuantity({ channel: row.channel, available, listing: listing ? { status: listing.status, quantity: null } : { status: row.channel === "website" ? "listed" : "ended" } });
  if (!plan || plan.op === "flag") return { ok: true, skipped: plan ? "depop_manual" : "unchanged", quantity: available };
  if (row.channel === "ebay") {
    const result = plan.op === "end"
      ? await endOnChannel(row.store_id, "ebay", { sku: row.sku, ...(listing || {}) })
      : await setEbayAvailableQuantity(row.store_id, row.sku, available);
    if (plan.op === "relist" && result?.ok !== false) {
      await sb.from("listings").update({ status: "listed" }).eq("store_id", row.store_id).eq("sku", row.sku).eq("channel", "ebay");
    }
    return result?.ok === false ? result : { ok: true, quantity: available, op: plan.op };
  }
  if (row.channel === "amazon") return syncAmazonOfferForFloorSku(row.store_id, row.sku);
  if (row.channel === "tiktok") return setTikTokAvailableQuantity(row.store_id, row.sku, available);
  if (row.channel === "website") {
    await sb.from("units").update({ show_on_website: available > 0, updated_at: new Date().toISOString() }).eq("store_id", row.store_id).eq("sku", row.sku);
    return { ok: true, quantity: available, op: plan.op };
  }
  return { ok: true, skipped: "manual", quantity: available };
}

async function drainQtyOutbox(sb) {
  const now = new Date().toISOString();
  const { data, error } = await sb.from("channel_qty_outbox").select("*").eq("status", "pending").lte("not_before", now).order("updated_at").limit(20);
  if (error) return { error: error.message };
  const results = [];
  for (const row of data || []) {
    const { data: claimed, error: claimError } = await sb.from("channel_qty_outbox").update({ status: "working", updated_at: now })
      .eq("store_id", row.store_id).eq("sku", row.sku).eq("channel", row.channel).eq("status", "pending").select("sku");
    if (claimError || !claimed?.length) continue;
    try {
      const result = await pushQueuedQuantity(sb, row);
      if (result?.ok === false) throw new Error(result.message || result.reason || result.error || "qty_sync_failed");
      await sb.from("channel_qty_outbox").update({ status: "done", last_error: null, updated_at: new Date().toISOString() })
        .eq("store_id", row.store_id).eq("sku", row.sku).eq("channel", row.channel);
      results.push({ sku: row.sku, channel: row.channel, quantity: result.quantity ?? null });
    } catch (err) {
      const attempts = Number(row.attempts || 0) + 1;
      await sb.from("channel_qty_outbox").update({
        status: attempts >= 3 ? "failed" : "pending",
        attempts,
        last_error: String(err?.message || err).slice(0, 500),
        not_before: new Date(Date.now() + Math.min(15 * 2 ** attempts, 720) * 60000).toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("store_id", row.store_id).eq("sku", row.sku).eq("channel", row.channel);
      results.push({ sku: row.sku, channel: row.channel, error: String(err?.message || err).slice(0, 200) });
    }
  }
  return { drained: results.length, results };
}

async function handle() {
  const sb = serviceClient();
  // Recover interrupted phone saves using this existing schedule, even when channel pushing is off.
  let receive = null;
  try {
    const now = new Date().toISOString();
    const { data, error } = await sb.from('receive_jobs').select('id').neq('status','done').lte('next_attempt_at',now)
      .or('lease_until.is.null,lease_until.lt.' + now).limit(1);
    if (error) throw error;
    if (data?.length) {
      const base = (process.env.URL || 'https://inventoryobi.netlify.app').replace(/\/$/, '');
      const response = await fetch(base + '/.netlify/functions/receive-finish-background', { method: 'POST',
        headers: { Authorization: 'Bearer ' + requireEnv('SUPABASE_SERVICE_ROLE'), 'Content-Type':'application/json' },
        body: JSON.stringify({ scheduled: true }) });
      receive = { dispatched: response.status };
    }
  } catch (error) { receive = { error: error.message }; }
  const pub = publishDeps(sb);
  const out = await runAutopush({
    db: supabaseQueueDb(sb),
    deps: {
      publish: (storeId, channel, sku) => queuePublish(pub, storeId, channel, sku),
      end: (storeId, channel, item) => endOnChannel(storeId, channel, item),
    },
  });
  const quantities = await drainQtyOutbox(sb).catch((error) => ({ error: error.message }));
  return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ ...out, receive, quantities }) };
}

export const invoke = wrapHandler("channel-autopush", handle);
export default asNetlifyFunction(invoke);
