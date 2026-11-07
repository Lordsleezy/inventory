/** Canonical in-person / POS sale channels (see SQL: lower(l.channel) in ('floor','store','in_store',...)). */
const IN_STORE_CHANNELS = new Set(['floor', 'store', 'in_store', 'instore']);

/** True when the sale is in-person (register / POS), not marketplace or website pickup. */
export function isInStoreChannel(channel: string | null | undefined): boolean {
  const c = (channel || '').toLowerCase().trim();
  if (!c) return false;
  return IN_STORE_CHANNELS.has(c);
}
