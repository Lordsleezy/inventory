/**
 * Manual eBay order sync from the admin portal.
 * Runs in ebay-sync-now-background so sync Netlify functions never 504.
 * Progress/result live in store_settings.ebay_sync_now_request.
 */
import { requireEnv, serviceClient } from "./server.mjs";
import { pollEbayOrders, ebayConnectionStatus } from "./ebay.mjs";
import { listEbayAccounts } from "./ebay-accounts.mjs";

export const STORE_DEFAULT = "5487ca47-6147-4fe8-bc6d-46b6472726ba";
export const SYNC_NOW_KEY = "ebay_sync_now_request";

async function setSetting(sb, storeId, key, value) {
  const { error } = await sb.from("store_settings").upsert(
    { store_id: storeId, key, value },
    { onConflict: "store_id,key" },
  );
  if (error) throw new Error(error.message);
}

async function getSetting(sb, storeId, key) {
  const { data, error } = await sb
    .from("store_settings")
    .select("value")
    .eq("store_id", storeId)
    .eq("key", key)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data?.value ?? null;
}

export async function getEbaySyncNowStatus(storeId = STORE_DEFAULT) {
  const sb = serviceClient();
  const value = await getSetting(sb, storeId, SYNC_NOW_KEY);
  return value && typeof value === "object" ? value : null;
}

/**
 * Queue + start background worker. Returns immediately (no long poll).
 */
export async function startEbaySyncNow(
  storeId = STORE_DEFAULT,
  { accountId = null, requestedBy = "portal" } = {},
) {
  const status = await ebayConnectionStatus(storeId);
  if (!status.connected) {
    return { ok: false, error: "eBay is not connected." };
  }

  const sb = serviceClient();
  const cur = (await getEbaySyncNowStatus(storeId)) || {};
  if (cur.status === "running" || cur.status === "started" || cur.status === "queued") {
    const startedMs = Date.parse(cur.started_at || cur.requested_at || "") || 0;
    // Allow restart if stuck > 12 minutes (background budget ~15).
    if (startedMs && Date.now() - startedMs < 12 * 60 * 1000) {
      return {
        ok: true,
        started: false,
        alreadyRunning: true,
        sync: cur,
        message: "eBay sync is already running — progress updates below.",
      };
    }
  }

  const accounts = (status.accounts || []).filter((a) => a.status === "connected");
  const targets = accountId ? accounts.filter((a) => a.id === accountId) : accounts;
  if (!targets.length) {
    return { ok: false, error: accountId ? "Account not connected." : "No connected eBay accounts." };
  }

  const request = {
    status: "queued",
    requested_at: new Date().toISOString(),
    requested_by: requestedBy,
    account_id: accountId || null,
    accounts: targets.map((a) => ({ id: a.id, username: a.username, role: a.role })),
    progress: {
      phase: "queued",
      current: 0,
      total: targets.length,
      message: "Queued — starting background worker…",
    },
    account_results: [],
    summary: null,
    error: null,
    finished_at: null,
  };
  await setSetting(sb, storeId, SYNC_NOW_KEY, request);

  const base = (process.env.URL || "https://inventoryobi.netlify.app").replace(/\/$/, "");
  const token = requireEnv("SUPABASE_SERVICE_ROLE");
  let res;
  try {
    res = await fetch(`${base}/.netlify/functions/ebay-sync-now-background`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        store_id: storeId,
        account_id: accountId,
        requested_by: requestedBy,
      }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await setSetting(sb, storeId, SYNC_NOW_KEY, {
      ...request,
      status: "dispatch_failed",
      error: message.slice(0, 500),
      finished_at: new Date().toISOString(),
    });
    return { ok: false, error: `sync_worker_dispatch_failed: ${message}` };
  }

  const ok = res.ok || res.status === 202;
  const text = ok ? "" : (await res.text()).slice(0, 300);
  const next = {
    ...request,
    status: ok ? "started" : "dispatch_failed",
    http_status: res.status,
    started_at: ok ? new Date().toISOString() : null,
    error: ok ? null : text,
    finished_at: ok ? null : new Date().toISOString(),
    progress: ok
      ? { ...request.progress, phase: "started", message: "Background worker started…" }
      : { ...request.progress, phase: "error", message: text || "Dispatch failed" },
  };
  await setSetting(sb, storeId, SYNC_NOW_KEY, next);
  if (!ok) return { ok: false, error: `sync_worker_failed: ${text || res.status}`, sync: next };

  return {
    ok: true,
    started: true,
    sync: next,
    message: "eBay sync started in the background. Progress updates on this page.",
  };
}

export async function runEbaySyncNow(
  storeId = STORE_DEFAULT,
  { accountId = null, requestedBy = "ebay-sync-now-background" } = {},
) {
  const sb = serviceClient();
  const startedAt = new Date().toISOString();
  let cur = (await getEbaySyncNowStatus(storeId)) || {
    requested_at: startedAt,
    requested_by: requestedBy,
    account_id: accountId,
  };

  const write = async (patch) => {
    cur = { ...cur, ...patch, updated_at: new Date().toISOString() };
    await setSetting(sb, storeId, SYNC_NOW_KEY, cur);
    return cur;
  };

  await write({
    status: "running",
    started_at: cur.started_at || startedAt,
    progress: {
      phase: "running",
      current: 0,
      total: 0,
      message: "Loading connected accounts…",
    },
    account_results: [],
    summary: null,
    error: null,
    finished_at: null,
  });

  let accounts = await listEbayAccounts(storeId);
  accounts = accounts.filter((a) => a.status === "connected");
  if (accountId) accounts = accounts.filter((a) => a.id === accountId);
  if (!accounts.length) {
    return write({
      status: "error",
      error: "No connected eBay accounts to sync.",
      finished_at: new Date().toISOString(),
      progress: { phase: "error", current: 0, total: 0, message: "No connected accounts" },
    });
  }

  const accountResults = [];
  let resultCount = 0;
  let errorCount = 0;

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    await write({
      progress: {
        phase: "syncing_account",
        current: i + 1,
        total: accounts.length,
        account_id: account.id,
        username: account.username,
        role: account.role,
        message: `Syncing ${account.username || account.id} (${i + 1}/${accounts.length})…`,
      },
    });

    try {
      const orders = await pollEbayOrders(storeId, { accountId: account.id });
      const errors = (orders || []).filter((r) => r && r.error);
      const skipped = (orders || []).filter((r) => r && r.skipped).length;
      const matched = (orders || []).filter((r) => r && !r.error && !r.skipped).length;
      resultCount += (orders || []).length;
      errorCount += errors.length;
      accountResults.push({
        account_id: account.id,
        username: account.username,
        role: account.role,
        ok: errors.length === 0,
        result_count: (orders || []).length,
        matched,
        skipped,
        errors: errors.map((e) => e.error).slice(0, 5),
      });
    } catch (err) {
      errorCount += 1;
      accountResults.push({
        account_id: account.id,
        username: account.username,
        role: account.role,
        ok: false,
        result_count: 0,
        matched: 0,
        skipped: 0,
        errors: [err instanceof Error ? err.message : String(err)],
      });
    }

    await write({ account_results: accountResults });
  }

  const summary = {
    accounts: accounts.length,
    results: resultCount,
    errors: errorCount,
    ok_accounts: accountResults.filter((a) => a.ok).length,
    failed_accounts: accountResults.filter((a) => !a.ok).length,
  };

  return write({
    status: errorCount && summary.ok_accounts === 0 ? "error" : "completed",
    finished_at: new Date().toISOString(),
    summary,
    account_results: accountResults,
    error: summary.failed_accounts
      ? `${summary.failed_accounts} account(s) reported errors`
      : null,
    progress: {
      phase: "done",
      current: accounts.length,
      total: accounts.length,
      message: `Done · ${summary.ok_accounts}/${summary.accounts} account(s) · ${summary.results} result(s)${
        summary.failed_accounts ? ` · ${summary.failed_accounts} with errors` : ""
      }`,
    },
  });
}
