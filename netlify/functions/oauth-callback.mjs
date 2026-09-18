import {
  serviceClient,
  encryptSecret,
  html,
  requireEnv,
} from "../lib/server.mjs";
import { exchangeEbayCode, subscribeNotifications } from "../lib/ebay.mjs";
import { paramsFromNetlifyEvent } from "../lib/oauth-params.mjs";

function deepLink(query) {
  const base = process.env.APP_DEEP_LINK || "floor://connections";
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
  const link = href || deepLink({ ok: "0" });
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

function recoveryPage() {
  return html(
    200,
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Floor — finishing connect</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 28rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.45; background: #0c0b0a; color: #f4efe8; }
      .quiet { color: #c9bba8; }
      a.btn { display: inline-block; margin-top: 1.25rem; padding: 0.7rem 1.1rem; background: #d4a574; color: #1a1410; text-decoration: none; border-radius: 12px; font-weight: 600; }
    </style>
  </head>
  <body>
    <h1>Finishing connect…</h1>
    <p class="quiet" id="msg">eBay hid part of the callback in the URL. Putting it back together.</p>
    <p><a class="btn" href="${esc(deepLink({ ok: "0" }))}">Back to Floor</a></p>
    <script>
      function looksLikeEbayCodePart(value) {
        const s = String(value || "");
        if (!s || s.includes("=")) return false;
        return /^(?:v\\^|[riIpft]\\^)/.test(s);
      }
      function parseHref(href) {
        const url = new URL(href);
        const search = Object.fromEntries(url.searchParams.entries());
        let code = String(search.code || search.isAuthToken || search.ebaytkn || "");
        let state = String(search.state || "");
        let error = String(search.error_description || search.error || "");
        const hash = (url.hash || "").replace(/^#/, "");
        if (!hash) return { code, state, error };
        if (/^(?:code|state|error|error_description)=/.test(hash)) {
          const extra = new URLSearchParams(hash);
          return {
            code: extra.get("code") || code,
            state: extra.get("state") || state,
            error: extra.get("error_description") || extra.get("error") || error,
          };
        }
        const amp = hash.indexOf("&");
        const before = amp >= 0 ? hash.slice(0, amp) : hash;
        const extra = amp >= 0 ? new URLSearchParams(hash.slice(amp + 1)) : new URLSearchParams();
        state = extra.get("state") || state;
        error = extra.get("error_description") || extra.get("error") || error;
        if (code && (amp >= 0 || looksLikeEbayCodePart(before))) code = code + "#" + before;
        else if (!code && looksLikeEbayCodePart(before)) code = before.indexOf("v^") === 0 ? before : "v^1.1#" + before;
        return { code, state, error };
      }
      function postRecovered(parsed) {
        const form = document.createElement("form");
        form.method = "POST";
        form.action = "/.netlify/functions/oauth-callback";
        const fields = {
          recovered: "1",
          code: parsed.code,
          state: parsed.state,
          error: parsed.error,
          href: location.href,
        };
        Object.keys(fields).forEach(function (key) {
          if (!fields[key]) return;
          const input = document.createElement("input");
          input.type = "hidden";
          input.name = key;
          input.value = fields[key];
          form.appendChild(input);
        });
        document.body.appendChild(form);
        form.submit();
      }
      const parsed = parseHref(location.href);
      if (parsed.error && !parsed.code) {
        document.getElementById("msg").textContent = "The platform refused access: " + parsed.error;
      } else {
        postRecovered(parsed);
      }
    </script>
  </body>
</html>`,
  );
}

async function exchangeSquare(code) {
  const host =
    process.env.SQUARE_ENV === "production" ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com";
  const body = new URLSearchParams({
    client_id: requireEnv("SQUARE_APPLICATION_ID"),
    client_secret: requireEnv("SQUARE_APPLICATION_SECRET"),
    code,
    grant_type: "authorization_code",
    redirect_uri: requireEnv("OAUTH_REDIRECT_URI"),
  });
  const res = await fetch(`${host}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.message || json.error || "square_token_failed");
  return json;
}

async function exchangeEbay(code) {
  return exchangeEbayCode(code);
}

async function exchangeAmazon(code) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: requireEnv("AMAZON_LWA_CLIENT_ID"),
    client_secret: requireEnv("AMAZON_LWA_CLIENT_SECRET"),
    redirect_uri: requireEnv("OAUTH_REDIRECT_URI"),
  });
  const res = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error_description || json.error || "amazon_token_failed");
  return json;
}

export async function handler(event) {
  const params = paramsFromNetlifyEvent(event);
  let nonce = params.state;
  const code = params.code;
  const err = params.error;

  console.log(
    "oauth-callback",
    JSON.stringify({
      method: event.httpMethod,
      path: event.path,
      rawQuery: event.rawQuery || event.rawQueryString || null,
      queryKeys: Object.keys(event.queryStringParameters || {}),
      hasCode: Boolean(code),
      codeLen: code.length,
      hasState: Boolean(nonce),
      recovered: params.recovered,
    }),
  );

  if (err) {
    return page(400, {
      title: "Could not connect",
      message: `The platform refused access: ${err}`,
      href: deepLink({ ok: "0", error: err }),
    });
  }

  const sb = serviceClient();

  if (!nonce && code.includes("#")) {
    const { data: pending } = await sb
      .from("oauth_states")
      .select("nonce")
      .is("consumed_at", null)
      .gt("expires_at", new Date().toISOString())
      .order("expires_at", { ascending: false })
      .limit(2);
    if (pending?.length === 1) nonce = pending[0].nonce;
  }

  if (!nonce || !code) {
    if (!params.recovered) return recoveryPage();
    return page(400, {
      title: "Could not connect",
      message: "eBay came back without a code or state.",
      detail: "Close this window and return to Floor, then Connect again after the ios-ebay-connect-2 update. That build stays in Floor instead of the Safari sheet.",
      href: deepLink({ ok: "0" }),
    });
  }

  const { data: state, error } = await sb
    .from("oauth_states")
    .select("*")
    .eq("nonce", nonce)
    .is("consumed_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (error || !state) {
    return page(400, {
      title: "Could not connect",
      message: "This sign-in expired or was already used. Start Connect again from Floor.",
      href: deepLink({ ok: "0" }),
    });
  }

  await sb.from("oauth_states").update({ consumed_at: new Date().toISOString() }).eq("id", state.id);

  try {
    let tokens;
    if (state.provider === "square") tokens = await exchangeSquare(code);
    else if (state.provider === "ebay") tokens = await exchangeEbay(code);
    else if (state.provider === "amazon") tokens = await exchangeAmazon(code);
    else throw new Error("unknown_provider");

    const access = tokens.access_token || tokens.accessToken;
    const refresh = tokens.refresh_token || tokens.refreshToken;
    const expiresIn = Number(tokens.expires_in || tokens.expiresIn || 86400);
    const row = {
      store_id: state.store_id,
      provider: state.provider,
      status: "connected",
      token_ciphertext: encryptSecret(access),
      refresh_ciphertext: refresh ? encryptSecret(refresh) : null,
      scopes: String(tokens.scope || "").split(/[ ,]+/).filter(Boolean),
      expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
      reauthorize_after:
        state.provider === "amazon" ? new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString() : null,
      last_error: null,
      connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const up = await sb.from("connections").upsert(row);
    if (up.error) throw new Error(up.error.message);

    if (state.provider === "square") {
      await sb.from("store_settings").upsert(
        {
          store_id: state.store_id,
          key: "card_payments_enabled",
          value: true,
        },
        { onConflict: "store_id,key" },
      );
    } else {
      await sb.from("channel_config").upsert(
        {
          store_id: state.store_id,
          channel: state.provider,
          mode: "auto",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "store_id,channel" },
      );
    }

    const extra = state.provider === "square" ? { needs_location: "1" } : {};
    if (state.provider === "ebay") {
      try {
        await subscribeNotifications(state.store_id);
      } catch {
        /* listing still works; polling will pick up sandbox sales */
      }
    }
    const href = deepLink({ provider: state.provider, ok: "1", ...extra });
    const result = page(200, {
      title: "Connected",
      message: `${state.provider} is connected. Return to Floor.`,
      href,
    });
    result.body = result.body.replace(
      "</body>",
      `<script>location.href=${JSON.stringify(href)}</script></body>`,
    );
    return result;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await sb.from("connections").upsert({
      store_id: state.store_id,
      provider: state.provider,
      status: "error",
      last_error: message,
      updated_at: new Date().toISOString(),
    });
    return page(400, {
      title: "Could not connect",
      message: `Could not finish connecting: ${message}`,
      detail: "If the platform said you are not the account owner, sign in as that account owner and try again.",
      href: deepLink({ ok: "0", error: message }),
    });
  }
}
