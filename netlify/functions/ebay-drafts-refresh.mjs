import { requireEnv } from "../lib/server.mjs";

// Scheduled every 15 minutes (netlify.toml). Only hands off to the background function, which holds the lock.
export const handler = async () => {
  if (process.env.EBAY_BACKGROUND_WORK !== "on") return { statusCode: 200, body: JSON.stringify({ skipped: "EBAY_BACKGROUND_WORK is off" }) };
  const base = (process.env.URL || "https://inventoryobi.netlify.app").replace(/\/$/, "");
  const res = await fetch(`${base}/.netlify/functions/ebay-drafts-refresh-background`, {
    method: "POST",
    headers: { Authorization: `Bearer ${requireEnv("SUPABASE_SERVICE_ROLE")}`, "Content-Type": "application/json" },
    body: "{}",
  });
  return { statusCode: 200, body: JSON.stringify({ queued: res.status }) };
};
