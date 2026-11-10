/** Confirm-only bundle price, and tracking upload after a verified scan. */
import { json, corsHeaders, serviceClient } from "../lib/server.mjs";
import { wrapHandler, asNetlifyFunction } from "../lib/floor-log.mjs";
import { applyBundlePrice, enableCombinedWeight, previewBundle, pushBundleTracking } from "../lib/bundle-ebay.mjs";

async function actorFromEvent(event) {
  const token = (event.headers?.authorization || event.headers?.Authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) throw Object.assign(new Error("Sign in required"), { status: 401 });
  const sb = serviceClient();
  if (process.env.SUPABASE_SERVICE_ROLE && token === process.env.SUPABASE_SERVICE_ROLE) {
    return { sb, storeId: null, isAdmin: true, service: true };
  }
  const { data: auth, error } = await sb.auth.getUser(token);
  if (error || !auth.user) throw Object.assign(new Error("Sign in required"), { status: 401 });
  const [{ data: admin }, { data: staff }] = await Promise.all([
    sb.from("portal_admins").select("store_id").eq("user_id", auth.user.id).maybeSingle(),
    sb.from("staff").select("store_id, role").eq("user_id", auth.user.id).is("deactivated_at", null).maybeSingle(),
  ]);
  const storeId = admin?.store_id || staff?.store_id;
  if (!storeId) throw Object.assign(new Error("Sign in required"), { status: 403 });
  const isAdmin = !!admin || staff?.role === "manager" || staff?.role === "owner";
  return { sb, storeId, isAdmin };
}

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: corsHeaders(), body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "post_only" });
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "bad_json" }); }
  let actor;
  try { actor = await actorFromEvent(event); }
  catch (err) { return json(err.status || 401, { error: err.message }); }
  const storeId = actor.storeId || body.store_id;
  if (!storeId) return json(400, { error: "store_id required" });
  const ids = Array.isArray(body.order_ids) ? body.order_ids.map(String) : [];

  try {
    if (body.action === "preview") {
      return json(200, await previewBundle(actor.sb, storeId, ids));
    }
    if (body.action === "tracking") {
      return json(200, await pushBundleTracking(actor.sb, storeId, body.order_id));
    }
    if (!actor.isAdmin) return json(403, { error: "Admin access required" });
    if (body.action === "enable") {
      return json(200, await enableCombinedWeight(actor.sb, storeId, { confirm: body.confirm === true }));
    }
    if (body.action === "apply") {
      return json(200, await applyBundlePrice(actor.sb, storeId, ids, {
        confirm: body.confirm === true,
        confirmCents: body.confirm_cents,
      }));
    }
    return json(400, { error: "unknown_action" });
  } catch (err) {
    const message = String(err?.message || err).slice(0, 400);
    const status = err?.code === "confirm_required" ? 400 : (err?.status || 500);
    return json(status, { error: message });
  }
}

export default asNetlifyFunction(handle);
export const invoke = wrapHandler("bundle-apply", handle);
