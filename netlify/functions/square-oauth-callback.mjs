import { exchangeSquareCode } from "../lib/square.mjs";
import { createClient } from "@supabase/supabase-js";

function sb() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE, {
    auth: { persistSession: false },
  });
}

export async function handler(event) {
  try {
    const url = new URL(event.rawUrl || `https://x/?${event.rawQuery || ""}`);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state"); // store_id
    if (!code || !state) {
      return { statusCode: 400, body: "missing code or state" };
    }
    const tokens = await exchangeSquareCode(code);
    const expires = tokens.expiresAt ? new Date(tokens.expiresAt) : new Date(Date.now() + 30 * 864e5);
    await sb().from("square_connections").upsert({
      store_id: state,
      merchant_id: tokens.merchantId || null,
      access_token_enc: tokens.accessToken, // TODO: encrypt at rest with CONNECTIONS_KEY
      refresh_token_enc: tokens.refreshToken || null,
      expires_at: expires.toISOString(),
      sandbox: (process.env.SQUARE_ENVIRONMENT || "sandbox") !== "production",
      updated_at: new Date().toISOString(),
    });
    return {
      statusCode: 200,
      headers: { "Content-Type": "text/html" },
      body: "<html><body><h1>Square connected</h1><p>You can close this window.</p></body></html>",
    };
  } catch (err) {
    return { statusCode: 500, body: err instanceof Error ? err.message : String(err) };
  }
}
