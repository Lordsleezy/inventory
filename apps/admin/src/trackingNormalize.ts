import { compactTracking, scanContainsTracking, takeLabelScans } from '../../../shared/tracking-normalize.mjs';

export { scanContainsTracking, takeLabelScans };

/** Every scan and typed tracking value goes through compactTracking. */
export function normalizeTracking(raw: string | null | undefined): string | null {
  const v = compactTracking(raw || '');
  return v || null;
}

export function trackingNumbersMatch(expected: string | null | undefined, scanned: string | null | undefined): boolean {
  const a = normalizeTracking(expected);
  const b = normalizeTracking(scanned);
  if (!a || !b) return false;
  return a === b;
}

export function orderTrackingCandidates(order: {
  tracking_number?: string | null;
  marketplace_tracking_number?: string | null;
}): string[] {
  const out: string[] = [];
  for (const n of [order.tracking_number, order.marketplace_tracking_number]) {
    const norm = normalizeTracking(n);
    if (norm && !out.includes(norm)) out.push(norm);
  }
  return out;
}

export function matchesOrderTracking(
  order: { tracking_number?: string | null; marketplace_tracking_number?: string | null },
  scanned: string,
): boolean {
  const candidates = orderTrackingCandidates(order);
  const exact = normalizeTracking(scanned);
  if (exact && candidates.some((candidate) => candidate === exact)) return true;
  return candidates.some((candidate) => scanContainsTracking(scanned, candidate));
}

/** One order, or nothing. Two different long numbers in one scan is a refusal. */
export function soleTrackingMatch<T extends { tracking_number?: string | null; marketplace_tracking_number?: string | null }>(
  scanned: string,
  orders: T[],
): T | null {
  const ranked = orders.flatMap((order) => orderTrackingCandidates(order).map((number) => {
    const hit = (normalizeTracking(scanned) === number) || scanContainsTracking(scanned, number);
    return hit && number.length >= 18 ? { order, number } : null;
  })).filter((row): row is { order: T; number: string } => row != null);
  if (!ranked.length) return null;
  const max = Math.max(...ranked.map((row) => row.number.length));
  const top = ranked.filter((row) => row.number.length === max);
  const numbers = new Set(top.map((row) => row.number));
  if (numbers.size !== 1) return null;
  return top[0].order;
}

export function formatTrackingDisplay(carrier: string | null | undefined, number: string | null | undefined): string {
  if (!number) return '';
  const core = normalizeTracking(number) || String(number).replace(/\s+/g, '');
  const grouped = core.replace(/(.{4})/g, '$1 ').trim();
  const c = (carrier || '').trim();
  return c ? `${c} ${grouped}` : grouped;
}

export function trackingExpectTail(order: {
  tracking_number?: string | null;
  marketplace_tracking_number?: string | null;
}): string {
  const primary = normalizeTracking(order.tracking_number) || normalizeTracking(order.marketplace_tracking_number);
  if (!primary) return '';
  const digits = primary.replace(/\D/g, '');
  const tail = digits.slice(-6);
  if (tail.length <= 4) return tail;
  return `${tail.slice(0, 4)} ${tail.slice(4)}`;
}
