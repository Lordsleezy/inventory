/** Split a ticket commission across its lines so the rows add up to the ticket. */
export function shareTicketCents(total: number, weights: number[], index: number): number {
  if (!weights.length) return total;
  if (weights.length === 1) return total;
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    const share = i === weights.length - 1 ? total - acc : Math.floor(total * (weights[i] ?? 0));
    if (i === index) return share;
    acc += share;
  }
  return 0;
}
