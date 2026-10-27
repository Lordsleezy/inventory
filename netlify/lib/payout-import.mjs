/**
 * Marketplace payouts to the bank, imported as withdrawals (eBay Finances API, Square Payouts API).
 * Piggybacks on the existing eBay sync and runs at most once every 6 hours; no schedule of its own.
 * Rows are upserted by payout id through floor_import_platform_payouts (no duplicates, a removed payout stays removed).
 */
const text = (v) => String(v ?? "").trim();
export const IMPORT_EVERY_MS = 6 * 3600 * 1000;
const LA_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" });
const dayOf = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? null : LA_DATE.format(d); };
const cents = (value) => Math.round(Number(value) * 100);

/** eBay getPayouts response -> import rows. Amounts are dollars ("123.45"). */
export function normalizeEbayPayouts(payload) {
  return (payload?.payouts || []).map((p) => ({
    external_id: text(p.payoutId), amount_cents: cents(p.totalAmount?.value ?? p.amount?.value), on: dayOf(p.payoutDate || p.lastAttemptedPayoutDate),
    status: text(p.payoutStatus).toUpperCase() || "UNKNOWN",
    note: `eBay payout ${text(p.payoutId)}${p.payoutInstrument?.nickname ? ` · ${text(p.payoutInstrument.nickname)}` : ""}${p.payoutInstrument?.accountLastFourDigits ? ` ····${text(p.payoutInstrument.accountLastFourDigits)}` : ""}`,
  })).filter((r) => r.external_id && r.amount_cents > 0 && r.on);
}

/** Square ListPayouts response -> import rows. Amounts are cents; FAILED payouts are kept (shown, not counted). */
export function normalizeSquarePayouts(payload) {
  return (payload?.payouts || []).map((p) => ({
    external_id: text(p.id), amount_cents: Number(p.amount_money?.amount), on: p.arrival_date || dayOf(p.created_at),
    status: text(p.status).toUpperCase() || "UNKNOWN", note: `Square payout ${text(p.id)}`,
  })).filter((r) => r.external_id && Number.isFinite(r.amount_cents) && r.amount_cents > 0 && r.on);
}

export const dueForImport = (state, now = Date.now()) => !state?.at || now - Date.parse(state.at) >= IMPORT_EVERY_MS;

/**
 * deps: fetchEbay(sinceIso) -> raw payload pages merged ({payouts}); fetchSquare(sinceIso) -> {payouts};
 *       importRows(platform, rows) -> counts; loadState() / saveState(state).
 * Each platform fails on its own (e.g. a missing scope) and records why; nothing throws into the sync.
 */
export async function importPayouts(deps, { now = Date.now() } = {}) {
  const state = (await deps.loadState()) || {};
  if (!dueForImport(state, now)) return { skipped: "not_due" };
  const out = {};
  const next = { ...state, at: new Date(now).toISOString() };
  for (const [platform, fetcher, normalize] of [["ebay", deps.fetchEbay, normalizeEbayPayouts], ["square", deps.fetchSquare, normalizeSquarePayouts]]) {
    if (!fetcher) continue;
    try {
      const since = state[`${platform}_done`] ? new Date(now - 120 * 86400000).toISOString() : "2025-01-01T00:00:00.000Z";
      const rows = normalize(await fetcher(since));
      out[platform] = { found: rows.length, ...(rows.length ? await deps.importRows(platform, rows) : {}) };
      next[`${platform}_done`] = true; next[`${platform}_error`] = null;
    } catch (e) {
      next[`${platform}_error`] = String(e?.message || e).slice(0, 300);
      out[platform] = { error: next[`${platform}_error`] };
    }
  }
  await deps.saveState(next);
  return out;
}
