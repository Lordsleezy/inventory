/**
 * Decide which Gmail UIDs a sales poll is allowed to spend its budget on.
 *
 * Scheduled polls were searching a 45-day window with INCLUDE_SEEN and then
 * always reading the oldest MAX_PER_RUN messages. Already-ingested Depop mail
 * filled that budget forever, so a newer sale confirmation in the same inbox
 * never reached the parser (live failure: found=22, processed the oldest 15,
 * matched=0, every two minutes).
 *
 * Fresh Message-IDs (not already stored) always come first, newest UID first.
 * Re-reading stored mail happens only on an explicit rescan, and only with
 * whatever budget is left.
 */

export function planPollUids(rows, { rescan = false, limit = 15 } = {}) {
  const sorted = [...(rows || [])].sort((a, b) => Number(b.uid) - Number(a.uid));
  const fresh = [];
  const replay = [];
  for (const row of sorted) {
    if (!row || row.uid == null) continue;
    if (row.stored) replay.push(row);
    else fresh.push(row);
  }
  const chosen = rescan ? [...fresh, ...replay] : fresh;
  const cap = Math.max(0, Number(limit) || 0);
  return chosen.slice(0, cap).map((row) => row.uid);
}

export function normalizeMessageId(id) {
  return String(id || "")
    .replace(/[<>\s]/g, "")
    .toLowerCase();
}
