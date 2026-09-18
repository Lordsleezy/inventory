import { html, serviceClient } from "../lib/server.mjs";
import { authorizeUrl } from "../lib/oauth-authorize.mjs";

function fail(message) {
  return html(
    400,
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Floor — could not connect</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 28rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.45; background: #0c0b0a; color: #f4efe8; }
      a.btn { display: inline-block; margin-top: 1.25rem; padding: 0.7rem 1.1rem; background: #d4a574; color: #1a1410; text-decoration: none; border-radius: 12px; font-weight: 600; }
    </style>
  </head>
  <body>
    <h1>Could not connect</h1>
    <p>${message}</p>
    <p><a class="btn" href="floor://connections">Back to Floor</a></p>
  </body>
</html>`,
  );
}

export async function handler(event) {
  const nonce = String(event.queryStringParameters?.n || "").trim();
  if (!nonce) return fail("This connect link is missing. Close this window and tap Connect again in Floor.");
  const sb = serviceClient();
  const { data, error } = await sb
    .from("oauth_states")
    .select("provider, nonce, expires_at, consumed_at")
    .eq("nonce", nonce)
    .maybeSingle();
  if (error || !data || data.consumed_at || new Date(data.expires_at) <= new Date()) {
    return fail("This sign-in expired or was already used. Start Connect again from Floor.");
  }
  const location = authorizeUrl(data.provider, data.nonce);
  return {
    statusCode: 302,
    headers: { Location: location, "Cache-Control": "no-store" },
    body: "",
  };
}
