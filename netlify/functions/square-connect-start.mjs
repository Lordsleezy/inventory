import { json, corsHeaders, connectionAdminFromEvent } from "../lib/server.mjs";
import { wrapHandler } from "../lib/floor-log.mjs";

/**
 * Start Square OAuth for the caller's store (owner/manager).
 * Opens Square authorize URL with state=store_id.
 * Uses SQUARE_REDIRECT_URL (must match Square console + Netlify env).
 */
async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  if (event.httpMethod !== "POST" && event.httpMethod !== "GET") {
    return json(405, { error: "method_not_allowed" });
  }
  let ctx;
  try { ctx = await connectionAdminFromEvent(event, ["owner", "manager"]); }
  catch (error) {
    return json(error.message === "not_owner" ? 403 : error.message === "not_signed_in" ? 401 : 500,
      { error: error.message === "not_owner" ? "not_manager" : error.message === "not_signed_in" ? "not_signed_in" : "auth_failed" });
  }
  const appId = process.env.SQUARE_APPLICATION_ID;
  const redirect = process.env.SQUARE_REDIRECT_URL;
  if (!appId || !redirect) return json(500, { error: "square_env_missing" });

  const host =
    (process.env.SQUARE_ENVIRONMENT || "sandbox").toLowerCase() === "production"
      ? "https://connect.squareup.com"
      : "https://connect.squareupsandbox.com";
  const scope = "MERCHANT_PROFILE_READ PAYMENTS_WRITE PAYMENTS_WRITE_IN_PERSON";
  const url =
    `${host}/oauth2/authorize?client_id=${encodeURIComponent(appId)}` +
    `&scope=${encodeURIComponent(scope)}&session=false` +
    `&state=${encodeURIComponent(ctx.staff.store_id)}` +
    `&redirect_uri=${encodeURIComponent(redirect)}`;

  return json(200, { url, store_id: ctx.staff.store_id });
}

export const handler = wrapHandler("square-connect-start", handle);
