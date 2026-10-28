/**
 * Real balances for the Money tab, straight from the platforms. Runs inside the existing channel-fee-sync schedule
 * (the Books importer already pulls the bank payouts there into platform_withdrawals; this file does NOT import payouts).
 * At most once every 6 hours per store. Results go to money_account_sync; a missing permission is recorded as
 * status "reconnect" so the Money card can show a Reconnect button.
 */
const text = (v) => String(v ?? "").trim();
export const MONEY_SYNC_EVERY_MS = 6 * 3600 * 1000;
const STATE_KEY = "money_sync_state";
const cents = (amount) => {
  const n = Number(amount && typeof amount === "object" ? amount.value : amount);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

/** eBay getSellerFundsSummary -> the real balance split. Amounts are dollar strings. */
export function parseEbayFundsSummary(res) {
  const available = cents(res?.availableFunds);
  const processing = cents(res?.processingFunds);
  const onHold = cents(res?.fundsOnHold);
  return { balance_cents: available + processing + onHold, detail: { available_cents: available, processing_cents: processing, on_hold_cents: onHold } };
}

const SQUARE_BALANCE_SOURCES = new Set(["CARD", "WALLET", "BANK_ACCOUNT", "BUY_NOW_PAY_LATER", "SQUARE_ACCOUNT"]);

/**
 * Square has no balance endpoint: money Square holds = card payments taken (after Square's fees and refunds) minus payouts sent
 * to the bank. Cash and external payments never touch Square's balance. Failed payouts are ignored.
 */
export function computeSquareBalance({ payments = [], payouts = [] }) {
  let gross = 0; let fees = 0; let refunds = 0; let counted = 0;
  for (const p of payments) {
    if (text(p.status).toUpperCase() !== "COMPLETED" || !SQUARE_BALANCE_SOURCES.has(text(p.source_type).toUpperCase())) continue;
    counted++;
    gross += Number(p.total_money?.amount) || 0;
    for (const f of p.processing_fee || []) fees += Number(f.amount_money?.amount) || 0;
    refunds += Number(p.refunded_money?.amount) || 0;
  }
  let paid = 0; let payoutCount = 0;
  for (const p of payouts) {
    const amount = Number(p.amount_money?.amount);
    if (!["PAID", "SENT"].includes(text(p.status).toUpperCase()) || !(amount > 0)) continue;
    paid += amount; payoutCount++;
  }
  return { balance_cents: gross - fees - refunds - paid, detail: { gross_cents: gross, fees_cents: fees, refunds_cents: refunds, payouts_cents: paid, payments: counted, payouts: payoutCount } };
}

export const dueForMoneySync = (state, now = Date.now()) => !state?.at || now - Date.parse(state.at) >= MONEY_SYNC_EVERY_MS;

/** A missing Finances / Payments permission, as opposed to a temporary failure. */
export const isPermissionError = (e) => /\b(401|403)\b|insufficient|scope|unauthori[sz]ed|forbidden|reconnect/i.test(String(e?.message || e || ""));

/**
 * deps: loadState(), saveState(state), save(account, row), fetchEbayFunds() -> raw response, fetchSquare() -> { payments, payouts }.
 * fetchers throw Error("not_connected") when there is no connection. Never throws.
 */
export async function syncMoneyBalances(deps, { now = Date.now() } = {}) {
  if (!dueForMoneySync(await deps.loadState(), now)) return { skipped: "not_due" };
  const out = {};
  for (const [account, run, compute, reconnectMessage] of [
    ["ebay", deps.fetchEbayFunds, parseEbayFundsSummary, "Reconnect eBay so Floor can read your funds (Finances permission)."],
    ["ebay_pgg124_5", deps.fetchEbayPersonalFunds, parseEbayFundsSummary, "Reconnect eBay · pgg124-5 so Floor can read its funds (Finances permission)."],
    ["square", deps.fetchSquare, computeSquareBalance, "Square key not working"],
  ]) {
    if (!run) continue;
    try {
      const r = compute(await run());
      await deps.save(account, { status: "ok", message: "", balance_cents: r.balance_cents, detail: r.detail });
      out[account] = { ok: true, balance_cents: r.balance_cents };
    } catch (e) {
      const message = String(e?.message || e);
      const status = /not_connected|not_found/.test(message) ? "not_connected" : isPermissionError(e) ? "reconnect" : "error";
      const accountName = account === "ebay" ? "eBay business" : account === "ebay_pgg124_5" ? "eBay · pgg124-5" : "Square";
      await deps.save(account, { status, message: status === "reconnect" ? reconnectMessage : status === "not_connected" ? `${accountName} is not connected.` : message.slice(0, 300), balance_cents: null, detail: { error: message.slice(0, 400) } }).catch(() => {});
      out[account] = { status };
    }
  }
  await deps.saveState({ at: new Date(now).toISOString() });
  return out;
}

/** Real calls (lazy imports keep the pure parts dependency-free for tests). */
export async function runMoneySync(sb, storeId) {
  const must = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
  return syncMoneyBalances({
    loadState: async () => must(await sb.from("store_settings").select("value").eq("store_id", storeId).eq("key", STATE_KEY).maybeSingle())?.value || {},
    saveState: async (value) => { must(await sb.from("store_settings").upsert({ store_id: storeId, key: STATE_KEY, value }, { onConflict: "store_id,key" })); },
    save: async (account, row) => { must(await sb.from("money_account_sync").upsert({ store_id: storeId, account, ...row, synced_at: new Date().toISOString() }, { onConflict: "store_id,account" })); },
    fetchEbayFunds: async () => {
      const { ebayFetch } = await import("./ebay.mjs");
      const accounts = must(await sb.from("ebay_accounts").select("id,username,role,status").eq("store_id", storeId).eq("status", "connected").order("role", { ascending: false })) || [];
      const account = accounts.find((a) => a.username?.toLowerCase() === "ikonikdeals2026") || accounts.find((a) => a.role === "selling");
      if (!account) throw new Error("not_connected");
      return ebayFetch(storeId, "GET", "/sell/finances/v1/seller_funds_summary", undefined, { accountId: account.id });
    },
    fetchEbayPersonalFunds: async () => {
      const { ebayFetch } = await import("./ebay.mjs");
      const account = must(await sb.from("ebay_accounts").select("id,username,status").eq("store_id", storeId).eq("status", "connected").ilike("username", "pgg124-5").maybeSingle());
      if (!account) throw new Error("not_connected");
      return ebayFetch(storeId, "GET", "/sell/finances/v1/seller_funds_summary", undefined, { accountId: account.id });
    },
    fetchSquare: async () => {
      // The website checkout already has a production Square token + location in the Netlify env; use that same token.
      const { webSquareAccess } = await import("./web-square.mjs");
      let access;
      try { access = webSquareAccess(storeId); } catch (e) { throw new Error(`not_connected: ${e?.message || e}`); }
      const token = access.accessToken;
      const base = access.sandbox ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";
      const headers = { Authorization: `Bearer ${token}`, "Square-Version": "2024-01-18", "Content-Type": "application/json" };
      const pull = async (path, key, params) => {
        const all = []; let cursor = "";
        for (let i = 0; i < 100; i++) {
          const url = new URL(path, base);
          for (const [k, v] of Object.entries({ ...params, limit: "100", ...(cursor ? { cursor } : {}) })) url.searchParams.set(k, v);
          const res = await fetch(url, { headers });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(`square_${res.status}:${body?.errors?.[0]?.code || ""}`);
          all.push(...(body[key] || []));
          cursor = body.cursor || "";
          if (!cursor) break;
        }
        return all;
      };
      const begin = "2013-01-01T00:00:00Z";
      return {
        payments: await pull("/v2/payments", "payments", { begin_time: begin, location_id: access.locationId }),
        payouts: await pull("/v2/payouts", "payouts", { begin_time: begin, location_id: access.locationId }),
      };
    },
  });
}
