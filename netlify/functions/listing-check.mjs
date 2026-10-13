import { requireEnv, json, corsHeaders } from "../lib/server.mjs";
import { wrapHandler } from "../lib/floor-log.mjs";
import { isNetlifyScheduleEvent } from "../lib/schedule.mjs";

// Scheduled daily (netlify.toml). Hands off to the background function (15-minute limit).
async function handle(event) {
  if (event?.httpMethod === "OPTIONS") return { statusCode: 200, headers: corsHeaders(), body: "" };
  const base = (process.env.URL || "https://inventoryobi.netlify.app").replace(/\/$/, "");
  const res = await fetch(`${base}/.netlify/functions/listing-check-background`, {
    method: "POST",
    headers: { Authorization: `Bearer ${requireEnv("SUPABASE_SERVICE_ROLE")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ all_stores: true }),
  });
  return json(200, { queued: res.status, schedule: isNetlifyScheduleEvent(event) });
}

export const handler = wrapHandler("listing-check", handle);
