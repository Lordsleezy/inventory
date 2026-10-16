/** Parse ship_cost_source from sale_ledger / channel_orders.
 * Fee sync encodes void-in-flight credits as `ebay|pending:11021`. */
export function parseShipCostSource(source: string | null | undefined): {
  base: string;
  pendingCreditCents: number;
} {
  const raw = String(source || '').trim();
  if (!raw || raw === 'none') return { base: raw || 'none', pendingCreditCents: 0 };
  const m = raw.match(/\|pending:(\d+)\b/i);
  const pendingCreditCents = m ? Math.max(0, Number(m[1]) || 0) : 0;
  const base = raw.replace(/\|pending:\d+\b/gi, '').replace(/\|+/g, '|').replace(/^\||\|$/g, '') || 'ebay';
  return { base, pendingCreditCents };
}

export function formatLabelWithPending(
  money: (n: number) => string,
  labelCents: number,
  pendingCreditCents: number,
): string {
  if (pendingCreditCents <= 0) return money(labelCents);
  // Label cost = what actually shipped; () = voided label still charged on eBay.
  return `${money(labelCents)} (${money(pendingCreditCents)} void pending — still on eBay)`;
}
