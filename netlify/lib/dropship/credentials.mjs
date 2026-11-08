import { encryptSecret, decryptSecret, serviceClient } from "../server.mjs";

/**
 * Supplier keys live encrypted in dropship_supplier_credentials (AES-GCM via CONNECTIONS_KEY).
 * Never put them in Netlify env vars. Ciphertext is never returned to the browser.
 */

export async function loadSupplierRow(storeId, supplier) {
  const sb = serviceClient();
  const { data, error } = await sb
    .from("dropship_supplier_credentials")
    .select("*")
    .eq("store_id", storeId)
    .eq("supplier", supplier)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function saveApiKey(storeId, supplier, apiKeyPlain) {
  const sb = serviceClient();
  const key = String(apiKeyPlain || "").trim();
  if (!key) throw new Error("api_key_required");
  const { data, error } = await sb
    .from("dropship_supplier_credentials")
    .upsert(
      {
        store_id: storeId,
        supplier,
        api_key_ciphertext: encryptSecret(key),
        status: supplier === "eprolo" || supplier === "printify" ? "waiting_docs" : "disconnected",
        last_error: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "store_id,supplier" },
    )
    .select("supplier, status, updated_at")
    .single();
  if (error) throw error;
  return data;
}

export function decryptField(ciphertext) {
  if (!ciphertext) return null;
  return decryptSecret(ciphertext);
}

export async function persistTokens(storeId, supplier, tokens) {
  const sb = serviceClient();
  const patch = {
    updated_at: new Date().toISOString(),
    status: "connected",
    last_error: null,
  };
  if (tokens.accessToken) patch.access_token_ciphertext = encryptSecret(tokens.accessToken);
  if (tokens.refreshToken) patch.refresh_token_ciphertext = encryptSecret(tokens.refreshToken);
  if (tokens.accessTokenExpiryDate) patch.token_expires_at = new Date(tokens.accessTokenExpiryDate).toISOString();
  if (tokens.refreshTokenExpiryDate) patch.refresh_expires_at = new Date(tokens.refreshTokenExpiryDate).toISOString();
  if (tokens.pointsRemaining != null) {
    patch.points_remaining = tokens.pointsRemaining;
    patch.points_checked_at = new Date().toISOString();
  }
  if (tokens.balanceCents != null) {
    patch.balance_cents = tokens.balanceCents;
    patch.balance_checked_at = new Date().toISOString();
  }
  const { error } = await sb
    .from("dropship_supplier_credentials")
    .update(patch)
    .eq("store_id", storeId)
    .eq("supplier", supplier);
  if (error) throw error;
}

export async function markSupplierError(storeId, supplier, message) {
  const sb = serviceClient();
  await sb
    .from("dropship_supplier_credentials")
    .update({
      status: "error",
      last_error: String(message || "error").slice(0, 500),
      updated_at: new Date().toISOString(),
    })
    .eq("store_id", storeId)
    .eq("supplier", supplier);
}

/** Build adapter context with decrypted secrets (service-role only). */
export async function adapterContext(storeId, supplier) {
  const row = await loadSupplierRow(storeId, supplier);
  if (!row) throw new Error("supplier_not_configured");
  return {
    storeId,
    supplier,
    row,
    apiKey: decryptField(row.api_key_ciphertext),
    accessToken: decryptField(row.access_token_ciphertext),
    refreshToken: decryptField(row.refresh_token_ciphertext),
    pointsRemaining: row.points_remaining,
    balanceCents: row.balance_cents,
    async saveTokens(tokens) {
      await persistTokens(storeId, supplier, tokens);
    },
    async saveMeta(meta) {
      const sb = serviceClient();
      await sb
        .from("dropship_supplier_credentials")
        .update({
          meta: { ...(row.meta || {}), ...meta },
          updated_at: new Date().toISOString(),
        })
        .eq("store_id", storeId)
        .eq("supplier", supplier);
    },
  };
}
