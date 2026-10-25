// Scheduled: works the channel checkbox queue (netlify.toml). OFF unless channel_autopush.enabled.
import { serviceClient } from "../lib/server.mjs";
import { runAutopush, supabaseQueueDb } from "../lib/channel-autopush.mjs";
import { publishCreate } from "../lib/listing-manager.mjs";
import { endOnChannel } from "../lib/marketplace-board.mjs";

export const handler = async () => {
  const out = await runAutopush({
    db: supabaseQueueDb(serviceClient()),
    deps: {
      publish: (storeId, channel, sku) => publishCreate(storeId, { channel, sku }),
      end: (storeId, channel, item) => endOnChannel(storeId, channel, item),
    },
  });
  return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(out) };
};
