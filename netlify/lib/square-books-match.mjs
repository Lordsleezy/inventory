export function matchSquarePaymentsToTickets(payments, tickets, { maxTimeDiffMs = 12 * 60 * 60 * 1000, amountToleranceCents = 1 } = {}) {
  const open = new Set(tickets.map((t) => String(t.ticket_id)));
  const rows = [];
  const completed = payments.filter((p) => String(p.status).toUpperCase() === "COMPLETED" && String(p.source_type).toUpperCase() === "CARD").sort((a, b) => Date.parse(a.created_at || 0) - Date.parse(b.created_at || 0));
  for (const payment of completed) {
    const amount = Number(payment.total_money?.amount ?? 0); const time = Date.parse(payment.created_at || 0);
    const candidates = tickets.filter((t) => open.has(String(t.ticket_id)) && Math.abs(Number(t.card_cents || 0) - amount) <= amountToleranceCents && Math.abs(Date.parse(t.sold_at || 0) - time) <= maxTimeDiffMs)
      .map((t) => ({ ticket: t, diff: Math.abs(Date.parse(t.sold_at || 0) - time) })).sort((a, b) => a.diff - b.diff);
    const best = candidates[0]; const tie = best && candidates[1]?.diff === best.diff;
    const matched = best && !tie ? best.ticket : null;
    if (matched) open.delete(String(matched.ticket_id));
    const fee = (payment.processing_fee || []).reduce((sum, f) => sum + Number(f.amount_money?.amount || 0), 0);
    rows.push({ payment_id: String(payment.id), created_at: payment.created_at, amount_cents: amount, fee_cents: fee, refund_cents: Number(payment.refunded_money?.amount || 0), status: matched ? "matched" : tie ? "ambiguous" : "unmatched", ticket_id: matched?.ticket_id || null, sale_ids: matched?.sale_ids || [], candidates: tie ? candidates.filter((x) => x.diff === best.diff).map((x) => x.ticket.ticket_id) : [] });
  }
  return rows;
}

export function allocateTicketFee(feeCents, saleIds, weights = []) {
  if (!saleIds.length) return [];
  const values = weights.length === saleIds.length ? weights.map((x) => Math.max(0, Number(x) || 0)) : saleIds.map(() => 1);
  const total = values.reduce((a, b) => a + b, 0) || saleIds.length;
  const equal = values.every((x) => x === 0);
  const shares = values.map((w) => Math.floor(feeCents * (equal ? 1 : w) / total));
  let remainder = feeCents - shares.reduce((a, b) => a + b, 0);
  for (let i = 0; remainder > 0; i = (i + 1) % shares.length, remainder--) shares[i]++;
  return saleIds.map((saleId, i) => ({ sale_id: saleId, fee_cents: shares[i] }));
}
