import { serviceClient } from "../lib/server.mjs";
import { pickupSweep } from "../lib/web-pickup.mjs";
// Scheduled (netlify.toml): pickup reminders, expired-pickup cancel + refund, refund retries.
export const handler = async () => ({ statusCode: 200, body: JSON.stringify(await pickupSweep(serviceClient())) });
