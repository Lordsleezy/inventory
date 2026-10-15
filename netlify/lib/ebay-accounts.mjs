/**
 * Multi-account eBay connections for Floor.
 * - role=selling: create/revise/end listings + ingest sales
 * - role=orders_only: ingest sales/fees only (legacy personal seller during cutover)
 */
import { decryptSecret, encryptSecret, serviceClient } from "./server.mjs";
import {
  EBAY_LISTING_OAUTH_SCOPES,
  EBAY_ORDERS_OAUTH_SCOPES,
  ebayDisabled,
  ebayHosts,
  marketplaceIdFromEnv,
  requireEbayEnabled,
} from "./ebay-env.mjs";
import { floorLog, redact } from "./floor-log.mjs";
import { formatEbayError } from "./ebay-errors.mjs";

export { EBAY_LISTING_OAUTH_SCOPES, EBAY_ORDERS_OAUTH_SCOPES };

function basicAuth() {
  const id = process.env.EBAY_CLIENT_ID;
  const secret = process.env.EBAY_CLIENT_SECRET;
  if (!id || !secret) throw new Error("EBAY_CLIENT_ID / EBAY_CLIENT_SECRET missing");
  return Buffer.from(`${id}:${secret}`).toString("base64");
}

async function refreshEbay(refreshToken) {
  const { api } = ebayHosts(process.env.EBAY_ENV);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const res = await fetch(`${api}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basicAuth()}`, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error_description || json.error || "ebay_refresh_failed");
  return json;
}

export function scopesForRole(role) {
  return role === "selling" ? EBAY_LISTING_OAUTH_SCOPES : EBAY_ORDERS_OAUTH_SCOPES;
}

export function accountAllowsListing(account) {
  if (ebayDisabled()) return false;
  return account?.role === "selling" && account?.status === "connected";
}

export async function listEbayAccounts(storeId) {
  const sb = serviceClient();
  const { data, error } = await sb
    .from("ebay_accounts")
    .select(
      "id,store_id,username,role,status,scopes,expires_at,last_error,connected_at,payment_policy_id,return_policy_id,fulfillment_policy_id,policies_ready_at,updated_at",
    )
    .eq("store_id", storeId)
    .order("role", { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []).map((row) => ({
    ...row,
    policiesReady: Boolean(row.payment_policy_id && row.return_policy_id && row.fulfillment_policy_id),
    hasFinances: Array.isArray(row.scopes) && row.scopes.some((s) => String(s).includes("sell.finances")),
    hasInventory: Array.isArray(row.scopes) && row.scopes.some((s) => String(s).includes("sell.inventory")),
  }));
}

export async function loadEbayAccount(storeId, { id, role, username, requireConnected = true } = {}) {
  const sb = serviceClient();
  let q = sb.from("ebay_accounts").select("*").eq("store_id", storeId);
  if (id) q = q.eq("id", id);
  else if (username) q = q.ilike("username", String(username).trim());
  else if (role) q = q.eq("role", role);
  const { data, error } = await q.maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) {
    const err = new Error("ebay_account_not_found");
    err.code = "ebay_account_not_found";
    throw err;
  }
  if (requireConnected && data.status !== "connected") {
    const err = new Error("ebay_not_connected");
    err.code = "ebay_not_connected";
    throw err;
  }
  return data;
}

/** Prefer connected selling account; else any connected account; else legacy connections row. */
export async function resolveEbayAccount(storeId, hint = {}) {
  const sb = serviceClient();
  if (hint.accountId) {
    return loadEbayAccount(storeId, { id: hint.accountId, requireConnected: hint.requireConnected !== false });
  }
  if (hint.role) {
    try {
      return await loadEbayAccount(storeId, { role: hint.role, requireConnected: hint.requireConnected !== false });
    } catch (err) {
      if (err.code !== "ebay_account_not_found" && err.code !== "ebay_not_connected") throw err;
    }
  }
  const { data: selling } = await sb
    .from("ebay_accounts")
    .select("*")
    .eq("store_id", storeId)
    .eq("role", "selling")
    .eq("status", "connected")
    .maybeSingle();
  if (selling) return selling;

  const { data: anyConnected } = await sb
    .from("ebay_accounts")
    .select("*")
    .eq("store_id", storeId)
    .eq("status", "connected")
    .order("connected_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (anyConnected) return anyConnected;

  // Legacy fallback: single connections(ebay) row (pre-migration).
  const { data: legacy } = await sb
    .from("connections")
    .select("*")
    .eq("store_id", storeId)
    .eq("provider", "ebay")
    .maybeSingle();
  if (legacy && legacy.status === "connected" && legacy.token_ciphertext) {
    return {
      id: null,
      store_id: storeId,
      username: legacy.account_label || "pgg124-5",
      role: "orders_only",
      status: legacy.status,
      token_ciphertext: legacy.token_ciphertext,
      refresh_ciphertext: legacy.refresh_ciphertext,
      scopes: legacy.scopes,
      expires_at: legacy.expires_at,
      last_error: legacy.last_error,
      connected_at: legacy.connected_at,
      _legacy: true,
    };
  }
  const err = new Error("ebay_not_connected");
  err.code = "ebay_not_connected";
  throw err;
}

export async function userTokenForAccount(account) {
  requireEbayEnabled();
  if (!account?.token_ciphertext) throw new Error("ebay_not_connected");
  const exp = account.expires_at ? new Date(account.expires_at).getTime() : 0;
  if (exp > Date.now() + 120_000) return decryptSecret(account.token_ciphertext);
  if (!account.refresh_ciphertext) throw new Error("ebay_needs_reconnect");

  const sb = serviceClient();
  let tokens;
  try {
    tokens = await refreshEbay(decryptSecret(account.refresh_ciphertext));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (account.id) {
      await sb
        .from("ebay_accounts")
        .update({ last_error: message.slice(0, 500), updated_at: new Date().toISOString() })
        .eq("id", account.id);
    }
    if (account._legacy) {
      await sb
        .from("connections")
        .update({ last_error: message.slice(0, 500), updated_at: new Date().toISOString() })
        .eq("store_id", account.store_id)
        .eq("provider", "ebay");
    }
    throw err;
  }
  const access = tokens.access_token;
  const refresh = tokens.refresh_token ? encryptSecret(tokens.refresh_token) : account.refresh_ciphertext;
  const expiresIn = Number(tokens.expires_in || 7200);
  const scopes = String(tokens.scope || "")
    .split(/[ ,]+/)
    .filter(Boolean);
  const patch = {
    token_ciphertext: encryptSecret(access),
    refresh_ciphertext: refresh,
    expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
    scopes: scopes.length ? scopes : account.scopes,
    last_error: null,
    updated_at: new Date().toISOString(),
  };
  if (account.id) {
    await sb.from("ebay_accounts").update(patch).eq("id", account.id);
  }
  if (account._legacy || account.role === "selling") {
    await sb
      .from("connections")
      .upsert({
        store_id: account.store_id,
        provider: "ebay",
        status: "connected",
        account_label: account.username,
        ...patch,
      });
  }
  Object.assign(account, patch);
  return access;
}

export async function ebayFetchAccount(account, method, path, body) {
  requireEbayEnabled();
  const hosts = ebayHosts(process.env.EBAY_ENV);
  const base = String(path).startsWith("/sell/finances/") ? hosts.finances : hosts.api;
  const token = await userTokenForAccount(account);
  const mutate = method !== "GET";
  const storeId = account.store_id;
  if (mutate) {
    await floorLog({
      storeId,
      event: "ebay.request",
      message: `${method} ${path}`,
      detail: { method, path, accountId: account.id, username: account.username, body: redact(body) },
    });
  }
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "Content-Language": "en-US",
      "Accept-Language": "en-US",
      "X-EBAY-C-MARKETPLACE-ID": marketplaceIdFromEnv(),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const payload = {
      method,
      path,
      status: res.status,
      accountId: account.id,
      username: account.username,
      errors: json?.errors ?? null,
      body: json,
      raw: text?.slice?.(0, 8000) || text || null,
    };
    console.log("ebay_api_error_full", JSON.stringify(payload));
    await floorLog({
      storeId,
      level: "error",
      event: "ebay.error",
      message: `${method} ${path} ${res.status}`,
      detail: payload,
    });
    const msg = formatEbayError(json, text || `eBay HTTP ${res.status}`);
    const err = new Error(msg);
    err.status = res.status;
    err.body = json;
    err.path = path;
    err.raw = text;
    throw err;
  }
  if (mutate) {
    await floorLog({
      storeId,
      event: "ebay.response",
      message: `${method} ${path} ${res.status}`,
      detail: { method, path, status: res.status, accountId: account.id, body: redact(json) },
    });
  }
  return json;
}

/** Mirror selling (or only) account into legacy connections(ebay) for older callers. */
export async function syncLegacyConnection(storeId) {
  const sb = serviceClient();
  const accounts = await listEbayAccounts(storeId);
  const selling = accounts.find((a) => a.role === "selling" && a.status === "connected");
  const fallback = selling || accounts.find((a) => a.status === "connected");
  if (!fallback) {
    await sb.from("connections").upsert({
      store_id: storeId,
      provider: "ebay",
      status: "disconnected",
      token_ciphertext: null,
      refresh_ciphertext: null,
      scopes: null,
      account_label: null,
      expires_at: null,
      connected_at: null,
      last_error: null,
      updated_at: new Date().toISOString(),
    });
    return null;
  }
  const full = await loadEbayAccount(storeId, { id: fallback.id });
  await sb.from("connections").upsert({
    store_id: storeId,
    provider: "ebay",
    status: full.status,
    account_label: full.username,
    token_ciphertext: full.token_ciphertext,
    refresh_ciphertext: full.refresh_ciphertext,
    scopes: full.scopes,
    expires_at: full.expires_at,
    connected_at: full.connected_at,
    last_error: full.last_error,
    updated_at: new Date().toISOString(),
  });
  return full;
}

export async function upsertEbayAccountFromOAuth({
  storeId,
  username,
  role,
  access,
  refresh,
  expiresIn,
  scopes,
}) {
  const sb = serviceClient();
  const uname = String(username || "").trim();
  if (!uname) throw new Error("eBay username missing after OAuth.");
  if (role !== "selling" && role !== "orders_only") throw new Error("invalid_ebay_role");

  // Demote any other selling account when connecting a new selling one.
  if (role === "selling") {
    await sb
      .from("ebay_accounts")
      .update({ role: "orders_only", updated_at: new Date().toISOString() })
      .eq("store_id", storeId)
      .eq("role", "selling")
      .neq("username", uname);
  }

  const row = {
    store_id: storeId,
    username: uname,
    role,
    status: "connected",
    token_ciphertext: encryptSecret(access),
    refresh_ciphertext: refresh ? encryptSecret(refresh) : null,
    scopes: Array.isArray(scopes) ? scopes : String(scopes || "").split(/[ ,]+/).filter(Boolean),
    expires_at: new Date(Date.now() + Number(expiresIn || 7200) * 1000).toISOString(),
    last_error: null,
    connected_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await sb
    .from("ebay_accounts")
    .upsert(row, { onConflict: "store_id,username" })
    .select("*")
    .maybeSingle();
  if (error) throw new Error(error.message);

  await syncLegacyConnection(storeId);

  // Channel mode: auto when a selling account is connected; else off (orders-only).
  const mode = role === "selling" ? "auto" : "off";
  const { data: sellingStill } = await sb
    .from("ebay_accounts")
    .select("id")
    .eq("store_id", storeId)
    .eq("role", "selling")
    .eq("status", "connected")
    .maybeSingle();
  await sb.from("channel_config").upsert(
    {
      store_id: storeId,
      channel: "ebay",
      mode: sellingStill ? "auto" : mode,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "store_id,channel" },
  );

  return data;
}

export async function disconnectEbayAccount(storeId, accountId) {
  const sb = serviceClient();
  const { error } = await sb
    .from("ebay_accounts")
    .update({
      status: "disconnected",
      token_ciphertext: null,
      refresh_ciphertext: null,
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("store_id", storeId)
    .eq("id", accountId);
  if (error) throw new Error(error.message);
  await syncLegacyConnection(storeId);
  const selling = await sb
    .from("ebay_accounts")
    .select("id")
    .eq("store_id", storeId)
    .eq("role", "selling")
    .eq("status", "connected")
    .maybeSingle();
  if (!selling.data) {
    await sb.from("channel_config").upsert(
      { store_id: storeId, channel: "ebay", mode: "off", updated_at: new Date().toISOString() },
      { onConflict: "store_id,channel" },
    );
  }
  return listEbayAccounts(storeId);
}

export async function markAccountPolicies(accountId, policies) {
  const sb = serviceClient();
  const { error } = await sb
    .from("ebay_accounts")
    .update({
      payment_policy_id: policies.payment,
      return_policy_id: policies.returnP,
      fulfillment_policy_id: policies.fulfillment,
      policies_ready_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", accountId);
  if (error) throw new Error(error.message);
}
