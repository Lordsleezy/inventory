import { serviceClient, json, corsHeaders } from "../lib/server.mjs";
import { pickupSweep } from "../lib/web-pickup.mjs";
import { wrapHandler } from "../lib/floor-log.mjs";
import { isNetlifyScheduleEvent } from "../lib/schedule.mjs";

// Scheduled (netlify.toml): pickup reminders, expired-pickup cancel + refund, refund retries.
async function handle(event) {
  if (event?.httpMethod === "OPTIONS") return { statusCode: 200, headers: corsHeaders(), body: "" };
  const result = await pickupSweep(serviceClient());
  return json(200, { ...(result && typeof result === "object" ? result : { result }), schedule: isNetlifyScheduleEvent(event) });
}

export const handler = wrapHandler("web-pickup-sweep", handle);
