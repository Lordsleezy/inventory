/** ebay-sync must not hold its lock longer than this, even if the process is killed mid-run. */
export const EBAY_SYNC_LOCK_SECONDS = 10 * 60;

/** Email the owner when no ebay-sync run has finished inside this window. */
export const EBAY_SYNC_STALL_MS = 30 * 60 * 1000;

export function syncCompletedAt(rows) {
  const byKey = Object.fromEntries((rows || []).map((row) => [row.key, row.value]));
  const times = [byKey.ebay_sync_completed_at, byKey.ebay_last_sync_at]
    .map((value) => Date.parse(typeof value === "string" ? value : ""))
    .filter((time) => Number.isFinite(time));
  return times.length ? Math.max(...times) : null;
}

/** True when the last finished sync is missing or older than 30 minutes, and we have not already emailed for this gap. */
export function syncNeedsStallEmail({ completedAt, alertedAt, now = Date.now(), stallMs = EBAY_SYNC_STALL_MS } = {}) {
  const completed = completedAt == null ? NaN : Number(completedAt);
  const alerted = alertedAt == null ? NaN : Number(alertedAt);
  const stalled = !Number.isFinite(completed) || now - completed >= stallMs;
  const recentlyAlerted = Number.isFinite(alerted) && now - alerted < stallMs;
  return stalled && !recentlyAlerted;
}
