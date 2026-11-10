import { compactTracking } from '../../../shared/tracking-normalize.mjs';

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
  const b = normalizeTracking(scanned);
  if (!b) return false;
  return orderTrackingCandidates(order).some((a) => a === b);
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
