// Admin-only payout + balance sync. Not scheduled: Netlify rejects HTTP calls to scheduled functions.
import { createClient } from "@supabase/supabase-js";
import { serviceClient, json, corsHeaders, requireEnv } from "../lib/server.mjs";
import { wrapHandler, asNetlifyFunction } from "../lib/floor-log.mjs";
import { syncStoreChannels } from "./channel-fee-sync.mjs";

async function callerIsAdmin(event) {
  const token = String(event?.headers?.authorization || event?.headers?.Authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return false;
  const user = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_ANON_KEY"), {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await user.rpc("portal_is_admin");
  return !error && data === true;
}

async function handle(event) {
  if (event?.httpMethod === "OPTIONS") return { statusCode: 200, headers: corsHeaders(), body: "" };
  if (event?.httpMethod !== "POST") return json(405, { error: "method_not_allowed" });
  if (!(await callerIsAdmin(event))) return json(401, { error: "admin_required" });
  const sb = serviceClient();
  const { data: stores, error } = await sb.from("stores").select("id");
  if (error) throw error;
  const out = { stores: {} };
  for (const store of stores || []) {
    const log = [];
    out.stores[store.id] = log;
    await syncStoreChannels(sb, store.id, log, { forceMoney: true });
  }
  return json(200, out);
}

export const invoke = wrapHandler("money-sync-now", handle);

export default asNetlifyFunction(invoke);
