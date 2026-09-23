import { exchangeSquareCode, upsertEncryptedSquareTokens } from "../lib/square.mjs";
import { html, serviceClient } from "../lib/server.mjs";
import { wrapHandler } from "../lib/floor-log.mjs";

function deepLink(query) {
  const base = process.env.APP_DEEP_LINK_SETTINGS || "floor://settings";
  const qs = new URLSearchParams(query).toString();
  return `${base}?${qs}`;
}

function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function page(status, { title, message, detail, href }) {
  const link = href || deepLink({ square: "0" });
  return html(
    status,
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${esc(title)}</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 28rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.45; background: #0c0b0a; color: #f4efe8; }
      .quiet { color: #c9bba8; }
      a.btn { display: inline-block; margin-top: 1.25rem; padding: 0.7rem 1.1rem; background: #d4a574; color: #1a1410; text-decoration: none; border-radius: 12px; font-weight: 600; }
    </style>
  </head>
  <body>
    <h1>${esc(title)}</h1>
    <p>${esc(message)}</p>
    ${detail ? `<p class="quiet">${esc(detail)}</p>` : ""}
    <p><a class="btn" href="${esc(link)}">Back to Floor</a></p>
  </body>
</html>`,
  );
}

async function handle(event) {
  try {
    const url = new URL(event.rawUrl || `https://x/?${event.rawQuery || ""}`);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state"); // store_id
    const err = url.searchParams.get("error");
    if (err) {
      return page(400, {
        title: "Square connect canceled",
        message: `Square refused access: ${err}`,
        href: deepLink({ square: "0", error: err }),
      });
    }
    if (!code || !state) {
      return page(400, {
        title: "Could not connect Square",
        message: "Square returned without a code or store id. Start Connect again from Floor Settings.",
        href: deepLink({ square: "0" }),
      });
    }
    const tokens = await exchangeSquareCode(code);
    await upsertEncryptedSquareTokens(state, {
      accessToken: tokens.accessToken || tokens.access_token,
      refreshToken: tokens.refreshToken || tokens.refresh_token,
      expiresAt: tokens.expiresAt
        || (tokens.expires_in
          ? new Date(Date.now() + Number(tokens.expires_in) * 1000).toISOString()
          : undefined),
      merchantId: tokens.merchantId || tokens.merchant_id || null,
    });
    try {
      const sb = serviceClient();
      await sb.from("store_settings").upsert(
        { store_id: state, key: "card_payments_enabled", value: true },
        { onConflict: "store_id,key" },
      );
    } catch (settingsErr) {
      console.error("card_payments_enabled upsert failed", settingsErr);
    }
    const href = deepLink({ square: "1", ok: "1", needs_location: "1" });
    return page(200, {
      title: "Square connected",
      message: "Square is connected for this store. Close this tab and return to the register — it will show Connected within a few seconds, then pick a location.",
      href,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return page(400, {
      title: "Could not connect Square",
      message: `Could not finish connecting: ${message}`,
      detail:
        "Check Netlify env (SQUARE_APPLICATION_ID/SECRET, SQUARE_REDIRECT_URL, CONNECTIONS_KEY) and that the redirect URL matches the Square Developer Console.",
      href: deepLink({ square: "0", error: message }),
    });
  }
}

export const handler = wrapHandler("square-oauth-callback", handle);
