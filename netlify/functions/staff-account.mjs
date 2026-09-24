import { managerFromEvent, json, corsHeaders, serviceClient } from "../lib/server.mjs";
import { wrapHandler } from "../lib/floor-log.mjs";
import { clockLoginEmail, clockRuleError, pinRuleError, authSecretFromLogin } from "../lib/staff-pin.mjs";

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  const { staff } = await managerFromEvent(event);
  const sb = serviceClient();
  const storeId = staff.store_id;

  if (event.httpMethod === "GET") {
    const { data, error } = await sb
      .from("staff")
      .select("user_id, display_name, role, login_code, deactivated_at, created_at")
      .eq("store_id", storeId)
      .order("created_at", { ascending: true });
    if (error) return json(500, { error: error.message });
    return json(200, { employees: data ?? [] });
  }

  if (event.httpMethod !== "POST") return json(405, { error: "method" });
  const body = event.body ? JSON.parse(event.body) : {};
  const action = body.action || "create";

  if (action === "create") {
    const clock = String(body.username || body.login_code || "").trim();
    const pin = String(body.pin || body.password || "").trim();
    const displayName = String(body.display_name || clock).trim() || clock;
    let role = String(body.role || "staff").toLowerCase();
    const clockErr = clockRuleError(clock);
    if (clockErr) return json(400, { error: clockErr });
    const pinErr = pinRuleError(pin, clock);
    if (pinErr) return json(400, { error: pinErr });
    if (role === "owner") return json(400, { error: "cannot_create_owner" });
    if (role === "manager" && staff.role !== "owner") return json(403, { error: "not_owner" });
    if (!["manager", "staff"].includes(role)) role = "staff";

    const email = clockLoginEmail(clock);
    const existingCode = await sb.from("staff").select("user_id").eq("login_code", clock).maybeSingle();
    if (existingCode.error) return json(500, { error: existingCode.error.message });
    if (existingCode.data) return json(409, { error: "clock_in_use" });

    const created = await sb.auth.admin.createUser({
      email,
      password: authSecretFromLogin(clock, pin),
      email_confirm: true,
      user_metadata: { clock, store_id: storeId },
    });
    if (created.error) return json(400, { error: created.error.message });
    const userId = created.data.user.id;
    const inserted = await sb.from("staff").insert({
      user_id: userId,
      store_id: storeId,
      display_name: displayName,
      role,
      delist_duty: role !== "staff",
      login_code: clock,
    });
    if (inserted.error) {
      await sb.auth.admin.deleteUser(userId);
      return json(400, { error: inserted.error.message });
    }
    return json(200, { ok: true, user_id: userId, login_code: clock, email });
  }

  if (action === "set_pin") {
    const userId = body.user_id;
    const pin = String(body.pin || body.password || "").trim();
    if (!userId) return json(400, { error: "user_id_required" });
    const row = await sb.from("staff").select("user_id, login_code, store_id, role").eq("user_id", userId).maybeSingle();
    if (row.error || !row.data || row.data.store_id !== storeId) return json(404, { error: "not_found" });
    if (row.data.role === "owner" && staff.role !== "owner") return json(403, { error: "not_owner" });
    const pinErr = pinRuleError(pin, row.data.login_code || "");
    if (pinErr) return json(400, { error: pinErr });
    const upd = await sb.auth.admin.updateUserById(userId, { password: authSecretFromLogin(row.data.login_code || "", pin) });
    if (upd.error) return json(400, { error: upd.error.message });
    return json(200, { ok: true });
  }

  if (action === "disable" || action === "enable") {
    const userId = body.user_id;
    if (!userId) return json(400, { error: "user_id_required" });
    if (userId === staff.user_id) return json(400, { error: "cannot_disable_self" });
    const row = await sb.from("staff").select("user_id, store_id, role").eq("user_id", userId).maybeSingle();
    if (row.error || !row.data || row.data.store_id !== storeId) return json(404, { error: "not_found" });
    if (row.data.role === "owner") return json(400, { error: "cannot_disable_owner" });
    const deactivated_at = action === "disable" ? new Date().toISOString() : null;
    const upd = await sb.from("staff").update({ deactivated_at }).eq("user_id", userId);
    if (upd.error) return json(400, { error: upd.error.message });
    if (action === "disable") {
      try {
        await sb.auth.admin.updateUserById(userId, { ban_duration: "876000h" });
      } catch {
        /* deactivate flag is enough if GoTrue rejects ban_duration */
      }
    } else {
      try {
        await sb.auth.admin.updateUserById(userId, { ban_duration: "none" });
      } catch {
        /* ignore */
      }
    }
    return json(200, { ok: true });
  }

  return json(400, { error: "unknown_action" });
}

export const handler = wrapHandler("staff-account", async (event) => {
  try {
    return await handle(event);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg === "not_admin" ? 403 : msg === "not_signed_in" || msg === "not_staff" ? 401 : 500;
    return json(status, { error: msg });
  }
});
