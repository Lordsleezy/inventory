// Scheduled: drains listing_queue (checkbox list/end jobs). Does nothing unless store_settings.channel_autopush.enabled.
import { serviceClient } from "../lib/server.mjs";
import { runAutopush, supabaseQueueDb, queuePublish } from "../lib/channel-autopush.mjs";
import { publishCreate } from "../lib/listing-manager.mjs";
import { endOnChannel } from "../lib/marketplace-board.mjs";
import { ebayPublishedListingForSku } from "../lib/ebay.mjs";
import { amazonListingExists } from "../lib/amazon.mjs";
import { wrapHandler, asNetlifyFunction } from "../lib/floor-log.mjs";

function publishDeps(sb) {
  return {
    loadUnit: async (storeId, sku) => {
      const { data, error } = await sb.from("units").select("sku, ask_cents").eq("store_id", storeId).eq("sku", sku).maybeSingle();
      if (error) throw new Error(error.message);
      return data;
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

async function handle() {
  const sb = serviceClient();
  const pub = publishDeps(sb);
  const out = await runAutopush({
    db: supabaseQueueDb(sb),
    deps: {
      publish: (storeId, channel, sku) => queuePublish(pub, storeId, channel, sku),
      end: (storeId, channel, item) => endOnChannel(storeId, channel, item),
    },
  });
  return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(out) };
}

export const invoke = wrapHandler("channel-autopush", handle);
export default asNetlifyFunction(invoke);
