import { requireEnv } from "../lib/server.mjs";
// Scheduled daily (netlify.toml). Hands off to the background function (15-minute limit).
export const handler = async () => {
  const base = (process.env.URL || "https://inventoryobi.netlify.app").replace(/\/$/, "");
  const res = await fetch(`${base}/.netlify/functions/listing-check-background`, {
    method: "POST",
    headers: { Authorization: `Bearer ${requireEnv("SUPABASE_SERVICE_ROLE")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ all_stores: true }),
  });
  return { statusCode: 200, body: JSON.stringify({ queued: res.status }) };
};
