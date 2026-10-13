import { serviceClient, json, corsHeaders } from "../lib/server.mjs";
import { deliverOrderEmails } from "../lib/web-order-email.mjs";
import { wrapHandler } from "../lib/floor-log.mjs";
import { isNetlifyScheduleEvent } from "../lib/schedule.mjs";

// Public HTTP invoke returns 403 on schedule-only functions; Netlify schedules still run.
async function handle(event) {
  if (event?.httpMethod === "OPTIONS") return { statusCode: 200, headers: corsHeaders(), body: "" };
  const result = await deliverOrderEmails(serviceClient());
  return json(200, { ...result, schedule: isNetlifyScheduleEvent(event) });
}

export const handler = wrapHandler("web-order-email", handle);
