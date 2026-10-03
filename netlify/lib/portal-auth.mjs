import { timingSafeEqual } from "node:crypto";
import { serviceClient } from "./server.mjs";

function same(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Floor Admin portal caller (portal_admins row), or an operator holding the Supabase service-role
 * key (already full database access) for scripted checks. Returns { sb, storeId, actor }.
 */
export async function portalAdminFromEvent(event, storeIdHint) {
  const token = (event.headers?.authorization || event.headers?.Authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) throw Object.assign(new Error("Sign in required"), { status: 401 });
  const sb = serviceClient();
  if (process.env.SUPABASE_SERVICE_ROLE && same(token, process.env.SUPABASE_SERVICE_ROLE)) {
    if (!storeIdHint) throw Object.assign(new Error("store_id required"), { status: 400 });
    return { sb, storeId: storeIdHint, actor: "ops" };
  }
  const { data: auth, error } = await sb.auth.getUser(token);
  if (error || !auth.user) throw Object.assign(new Error("Sign in required"), { status: 401 });
  const { data: member } = await sb.from("portal_admins").select("store_id").eq("user_id", auth.user.id).maybeSingle();
  if (!member) throw Object.assign(new Error("Admin access required"), { status: 403 });
  return { sb, storeId: member.store_id, actor: auth.user.email || auth.user.id };
}
