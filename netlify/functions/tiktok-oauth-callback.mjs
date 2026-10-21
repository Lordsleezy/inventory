/**
 * TikTok Shop OAuth callback (US Custom app).
 * Register this exact URL in Partner Center:
 *   https://inventoryobi.netlify.app/.netlify/functions/tiktok-oauth-callback
 */
import { html, serviceClient } from "../lib/server.mjs";
import { wrapHandler, asNetlifyFunction } from "../lib/floor-log.mjs";
import {
  exchangeTikTokCode,
  saveTikTokOAuthTokens,
  TIKTOK_OAUTH_REDIRECT,
  tiktokAppCredsPresent,
} from "../lib/tiktok-shop.mjs";

function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function adminHref(query = {}) {
  const base = process.env.ADMIN_PORTAL_URL || "https://admin.openboxindustries.com";
  const qs = new URLSearchParams({ page: "marketplaces", ...query }).toString();
  return `${base}/?${qs}`;
}

function page(status, { title, message, detail, href, linkLabel }) {
  const link = href || adminHref({ tiktok: "0" });
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
    <p><a class="btn" href="${esc(link)}">${esc(linkLabel || "Back to Marketplaces")}</a></p>
  </body>
</html>`,
  );
}

async function handle(event) {
  try {
    if (!tiktokAppCredsPresent()) {
      return page(503, {
        title: "TikTok not configured",
        message: "Set TIKTOK_SHOP_APP_KEY and TIKTOK_SHOP_APP_SECRET in Netlify before connecting.",
        detail: `Redirect URL for Partner Center: ${TIKTOK_OAUTH_REDIRECT}`,
      });
    }

    const url = new URL(event.rawUrl || `https://inventoryobi.netlify.app/?${event.rawQuery || ""}`);
    const code = url.searchParams.get("code") || url.searchParams.get("auth_code");
    const state = url.searchParams.get("state");
    const err = url.searchParams.get("error") || url.searchParams.get("error_description");

    if (err) {
      return page(400, {
        title: "TikTok connect canceled",
        message: `TikTok refused access: ${err}`,
        href: adminHref({ tiktok: "0", error: err }),
      });
    }
    if (!code || !state) {
      return page(400, {
        title: "Could not connect TikTok",
        message: "TikTok returned without a code or state. Start Authorize again from Marketplaces.",
        detail: `Expected redirect: ${TIKTOK_OAUTH_REDIRECT}`,
      });
    }

    const sb = serviceClient();
    const { data: oauthState, error } = await sb
      .from("oauth_states")
      .select("*")
      .eq("nonce", state)
      .eq("provider", "tiktok")
      .is("consumed_at", null)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();
    if (error || !oauthState) {
      return page(400, {
        title: "Could not connect TikTok",
        message: "This sign-in expired or was already used. Start Authorize again from Marketplaces.",
      });
    }

    await sb.from("oauth_states").update({ consumed_at: new Date().toISOString() }).eq("id", oauthState.id);

    const tokens = await exchangeTikTokCode(code);
    await saveTikTokOAuthTokens(oauthState.store_id, tokens);

    const href = oauthState.return_to || adminHref({ tiktok: "1", ok: "1" });
    const result = page(200, {
      title: "TikTok Shop connected",
      message: "TikTok Shop is connected. Return to Marketplaces to queue listings and sync orders.",
      href,
      linkLabel: "Back to Marketplaces",
    });
    result.body = result.body.replace(
      "</body>",
      `<script>location.href=${JSON.stringify(href)}</script></body>`,
    );
    return result;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return page(400, {
      title: "Could not connect TikTok",
      message: `Could not finish connecting: ${message}`,
      detail: `Check Netlify env (TIKTOK_SHOP_APP_KEY/SECRET, CONNECTIONS_KEY) and that Partner Center redirect is exactly ${TIKTOK_OAUTH_REDIRECT}`,
      href: adminHref({ tiktok: "0", error: message }),
    });
  }
}

export const invoke = wrapHandler("tiktok-oauth-callback", handle);
export default asNetlifyFunction(invoke);
