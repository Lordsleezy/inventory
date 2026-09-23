import { createClient } from "@supabase/supabase-js";
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

export function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

export function serviceClient() {
  return createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}

export function json(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", ...corsHeaders() }, body: JSON.stringify(body) };
}

export function redirect(url) {
  return { statusCode: 302, headers: { Location: url, ...corsHeaders() }, body: "" };
}

export function html(status, body) {
  return { statusCode: status, headers: { "Content-Type": "text/html; charset=utf-8" }, body };
}

function keyBytes() {
  const raw = requireEnv("CONNECTIONS_KEY");
  if (/^[0-9a-f]+$/i.test(raw) && raw.length === 64) return Buffer.from(raw, "hex");
  return createHash("sha256").update(raw).digest();
}

export function encryptSecret(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptSecret(blob) {
  const buf = Buffer.from(blob, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", keyBytes(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

export async function staffFromEvent(event) {
  const header = event.headers.authorization || event.headers.Authorization || "";
  const token = header.replace(/^Bearer\s+/i, "");
  if (!token) throw new Error("not_signed_in");
  const sb = serviceClient();
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data.user) throw new Error("not_signed_in");
  const staff = await sb.from("staff").select("user_id, store_id, role, display_name, deactivated_at").eq("user_id", data.user.id).maybeSingle();
  if (staff.error || !staff.data) throw new Error("not_staff");
  if (staff.data.deactivated_at) throw new Error("not_staff");
  return { user: data.user, staff: staff.data, token };
}

export async function ownerFromEvent(event) {
  const ctx = await staffFromEvent(event);
  if (ctx.staff.role !== "owner") throw new Error("not_owner");
  return ctx;
}
