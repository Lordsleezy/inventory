import {
  serviceClient,
  encryptSecret,
  html,
  requireEnv,
} from "../lib/server.mjs";

function deepLink(query) {
  const base = process.env.APP_DEEP_LINK || "floor://connections";
  const qs = new URLSearchParams(query).toString();
  return `${base}?${qs}`;
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
  const host =
    process.env.EBAY_ENV === "production" ? "https://api.ebay.com" : "https://api.sandbox.ebay.com";
  const basic = Buffer.from(`${requireEnv("EBAY_CLIENT_ID")}:${requireEnv("EBAY_CLIENT_SECRET")}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: requireEnv("OAUTH_REDIRECT_URI"),
  });
  const res = await fetch(`${host}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error_description || json.error || "ebay_token_failed");
  return json;
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
  const params = event.queryStringParameters || {};
  const nonce = params.state;
  const code = params.code;
  const err = params.error;
  const sb = serviceClient();

  if (err) {
    return html(400, `<p>The platform refused access: ${err}</p><p><a href="${deepLink({ ok: "0" })}">Back to Floor</a></p>`);
  }
  if (!nonce || !code) {
    return html(400, `<p>Missing OAuth state or code.</p>`);
  }

  const { data: state, error } = await sb
    .from("oauth_states")
    .select("*")
    .eq("nonce", nonce)
    .is("consumed_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (error || !state) {
    return html(400, `<p>This sign-in expired or was already used. Start Connect again from Floor.</p>`);
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
    const href = deepLink({ provider: state.provider, ok: "1", ...extra });
    return html(
      200,
      `<p>Connected ${state.provider}. Return to Floor.</p><p><a href="${href}">Open Floor</a></p><script>location.href=${JSON.stringify(href)}</script>`,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await sb.from("connections").upsert({
      store_id: state.store_id,
      provider: state.provider,
      status: "error",
      last_error: message,
      updated_at: new Date().toISOString(),
    });
    return html(
      400,
      `<p>Could not finish connecting: ${message}</p><p>If the platform said you are not the account owner, sign in as the owner of that Square / eBay / Amazon account and try again.</p><p><a href="${deepLink({ ok: "0", error: message })}">Back to Floor</a></p>`,
    );
  }
}
