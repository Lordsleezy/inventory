const IN_STORE = new Set(['floor', 'in_store', 'instore', 'store', 'website']);

/**
 * In-store card sales charge the processing fee on top of the sticker price.
 * That surcharge is not a fee taken out of the sale, so the books report shows 0.
 * A card sale with no surcharge still shows the fee the store paid.
 */
export function booksCardFeeCents(row: {
  channel?: unknown;
  card_fee_cents?: unknown;
  processing_fee_cents?: unknown;
}): number {
  const channel = String(row.channel || '').toLowerCase();
  const surcharge = Math.max(0, Number(row.card_fee_cents || 0));
  if (IN_STORE.has(channel) && surcharge > 0) return 0;
  return Math.max(0, Number(row.processing_fee_cents || 0));
}
