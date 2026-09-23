import { staffFromEvent, serviceClient, json, corsHeaders } from "../lib/server.mjs";
import { wrapHandler } from "../lib/floor-log.mjs";
import { randomBytes } from "node:crypto";

/**
 * Employee management for the Employees screen.
 *
 * Every action needs a caller whose staff row is owner or manager — "admin".
 * The store-level rules (can't act on yourself, can't orphan the store without
 * an admin, only an owner can touch an owner) live in the admin_* RPCs so a
 * direct PostgREST caller hits the same wall; this function repeats the checks
 * that need the caller's identity because service_role has no auth.uid().
 */
const ADMIN_ROLES = new Set(["owner", "manager"]);
const ROLES = new Set(["owner", "manager", "staff"]);

async function adminFromEvent(event) {
  const ctx = await staffFromEvent(event);
  if (!ADMIN_ROLES.has(ctx.staff.role)) {
    const err = new Error("not_admin");
    err.status = 403;
    throw err;
  }
  return ctx;
}

function rpcErr(res) {
  const msg = res.error?.message || "unknown";
  if (/not_manager|not_staff|owner_only|not_store_staff/.test(msg)) {
    const err = new Error(msg);
    err.status = 403;
    return err;
  }
  const err = new Error(msg);
  err.status = 400;
  return err;
}

async function targetStaff(sb, storeId, userId) {
  const { data } = await sb
    .from("staff")
    .select("user_id, store_id, role, display_name, deactivated_at")
    .eq("store_id", storeId)
    .eq("user_id", userId)
    .maybeSingle();
  return data ?? null;
}

/** The caller's role gates what may happen to an 'owner' row or an 'owner' grant. */
function checkHierarchy(ctx, target, nextRole) {
  const self = target && target.user_id === ctx.user.id;
  const touchesOwner = target?.role === "owner" || nextRole === "owner";
  if (touchesOwner && ctx.staff.role !== "owner") {
    const err = new Error("owner_only");
    err.status = 403;
    throw err;
  }
  return { self };
}

function signInEmail(identifier) {
  const raw = String(identifier || "").trim().toLowerCase();
  if (!raw) return null;
  if (raw.includes("@")) return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? raw : null;
  // Username → synthetic mailbox; shown back to the admin as the sign-in id.
  const slug = raw.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug ? `${slug}@employees.floor.local` : null;
}

async function findUserByEmail(sb, email) {
  let page = 1;
  for (;;) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    if (error) return null;
    const hit = (data?.users ?? []).find(
      (u) => (u.email || "").toLowerCase() === email.toLowerCase(),
    );
    if (hit) return hit;
    if (!data?.users?.length || data.users.length < 200) return null;
    page += 1;
  }
}

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "method_not_allowed" });

  let ctx;
  try {
    ctx = await adminFromEvent(event);
  } catch (err) {
    return json(err.status ?? 401, { error: err.message });
  }

  const body = JSON.parse(event.body || "{}");
  const action = String(body.action || "");
  const sb = serviceClient();
  const storeId = ctx.staff.store_id;

  // ------------------------------------------------------------------ list
  if (action === "list") {
    const { data, error } = await sb.rpc("admin_list_staff", { p_store: storeId });
    if (error) return json(400, { error: error.message });
    const rows = Array.isArray(data) ? data : [];
    const employees = await Promise.all(
      rows.map(async (row) => {
        const { data: u } = await sb.auth.admin.getUserById(row.user_id).catch(() => ({ data: null }));
        const user = u?.user ?? u ?? null;
        return {
          ...row,
          email: user?.email ?? null,
          last_sign_in_at: user?.last_sign_in_at ?? null,
          banned_until: user?.banned_until ?? null,
        };
      }),
    );
    return json(200, { employees });
  }

  // ---------------------------------------------------------------- create
  if (action === "create") {
    const name = String(body.name || "").trim();
    const email = signInEmail(body.email || body.username);
    const role = String(body.role || "staff").toLowerCase();
    const password = String(body.password || "") || randomBytes(9).toString("base64url");
    if (!name) return json(400, { error: "name_required" });
    if (!email) return json(400, { error: "email_or_username_required" });
    if (!ROLES.has(role)) return json(400, { error: "invalid_role" });
    if (password.length < 6) return json(400, { error: "password_too_short" });
    if (role === "owner" && ctx.staff.role !== "owner") return json(403, { error: "owner_only" });

    let userId = null;
    const { data: created, error: createErr } = await sb.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: name },
    });
    if (createErr) {
      const existing = await findUserByEmail(sb, email);
      if (!existing) return json(400, { error: createErr.message });
      userId = existing.id;
    } else {
      userId = created.user.id;
    }

    const { data, error } = await sb.rpc("admin_add_staff", {
      p_user_id: userId,
      p_display_name: name,
      p_role: role,
      p_store: storeId,
    });
    if (error) return json(400, { error: error.message });
    return json(200, { employee: data, signInEmail: email, password });
  }

  // -------------------------------------------------- everything below here
  const userId = String(body.userId || "");
  if (!userId) return json(400, { error: "userId_required" });
  const target = await targetStaff(sb, storeId, userId);
  if (!target) return json(404, { error: "staff_not_found" });

  if (action === "setRole") {
    const role = String(body.role || "").toLowerCase();
    if (!ROLES.has(role)) return json(400, { error: "invalid_role" });
    const { self } = checkHierarchy(ctx, target, role);
    if (self) return json(400, { error: "cannot_change_self" });
    const { error } = await sb.rpc("admin_set_staff_role", {
      p_user_id: userId,
      p_role: role,
      p_store: storeId,
    });
    if (error) throw rpcErr({ error });
    return json(200, { ok: true });
  }

  if (action === "resetPassword") {
    const password = String(body.password || "");
    if (password.length < 6) return json(400, { error: "password_too_short" });
    checkHierarchy(ctx, target, null);
    const { error } = await sb.auth.admin.updateUserById(userId, { password });
    if (error) return json(400, { error: error.message });
    return json(200, { ok: true });
  }

  if (action === "setActive") {
    const active = Boolean(body.active);
    const { self } = checkHierarchy(ctx, target, null);
    if (self && !active) return json(400, { error: "cannot_deactivate_self" });
    const { error } = await sb.rpc("admin_set_staff_active", {
      p_user_id: userId,
      p_active: active,
      p_store: storeId,
    });
    if (error) throw rpcErr({ error });
    // Ban/unban kills token refresh; the deactivated staff row kills data
    // access immediately either way.
    const ban = await sb.auth.admin
      .updateUserById(userId, { ban_duration: active ? "none" : "876000h" })
      .catch(() => null);
    return json(200, { ok: true, authBan: !ban?.error });
  }

  if (action === "remove") {
    const { self } = checkHierarchy(ctx, target, null);
    if (self) return json(400, { error: "cannot_remove_self" });
    const { error } = await sb.rpc("admin_remove_staff", {
      p_user_id: userId,
      p_store: storeId,
    });
    if (error) throw rpcErr({ error });
    const del = await sb.auth.admin.deleteUser(userId).catch(() => null);
    return json(200, { ok: true, authUserDeleted: !del?.error });
  }

  return json(400, { error: "unknown_action" });
}

export const handler = wrapHandler("employees", async (event) => {
  try {
    return await handle(event);
  } catch (err) {
    return json(err.status ?? 500, { error: err instanceof Error ? err.message : String(err) });
  }
});
