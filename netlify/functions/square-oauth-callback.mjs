import { exchangeSquareCode, upsertEncryptedSquareTokens } from "../lib/square.mjs";
import { html } from "../lib/server.mjs";
import { wrapHandler } from "../lib/floor-log.mjs";

async function handle(event) {
  const url = new URL(event.rawUrl || `https://x/?${event.rawQuery || ""}`);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state"); // store_id
  const err = url.searchParams.get("error");
  if (err) {
    return html(400, `<h1>Square connect canceled</h1><p>${err}</p>`);
  }
  if (!code || !state) {
    return { statusCode: 400, body: "missing code or state" };
  }
  const tokens = await exchangeSquareCode(code);
  await upsertEncryptedSquareTokens(state, tokens);
  return html(
    200,
    `<!doctype html><html><body style="font-family:system-ui;max-width:28rem;margin:3rem auto">
      <h1>Square connected</h1>
      <p>Tokens are stored encrypted on the server. You can close this window and return to Floor Settings.</p>
    </body></html>`,
  );
}

export const handler = wrapHandler("square-oauth-callback", handle);
