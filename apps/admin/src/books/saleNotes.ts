import { isRealUnitCost } from './costTruth';
import type { Report, Row } from './types';

export type SaleWhy = { tone: 'extra' | 'less' | 'fix' | 'info'; text: string; tag?: string };

export function saleWhyLines(row: Row, report: Report): SaleWhy[] {
  const out: SaleWhy[] = [];
  const buyerShip = Number(row.shipping_cents || 0);
  const label = Number(row.ship_cost_cents || 0);
  if (label > 0 && buyerShip > label) {
    out.push({ tone: 'extra', tag: 'Extra', text: `Buyer paid ${((buyerShip - label) / 100).toFixed(2)} more shipping than the label cost` });
  }
  if (label > 0 && label > buyerShip) {
    out.push({ tone: 'less', tag: 'Less', text: `Label cost ${(label / 100).toFixed(2)} more than buyer paid` });
  }
  if (!isRealUnitCost(row)) {
    const shown = row.cost_cents == null ? null : Number(row.cost_cents);
    const text = shown != null && ['default', 'builtin', 'estimated'].includes(String(row.cost_source || ''))
      ? `Placeholder cost $${(shown / 100).toFixed(2)} — enter real cost`
      : 'No cost entered, profit not counted yet';
    out.push({ tone: 'fix', tag: 'Fix', text });
  }
  if (row.voided_at) out.push({ tone: 'info', text: 'Sale voided' });
  const ret = (report.returns || []).find((r) => String(r.sale_id) === String(row.id));
  if (ret) {
    const voided = ['voided', 'cancelled', 'refunded_full'].includes(String(ret.status || '').toLowerCase());
    out.push({ tone: voided ? 'less' : 'info', text: voided ? 'Return voided this sale' : `Return: ${ret.status}` });
  }
  const repl = (report.dispositions || []).find((d) => d.kind === 'replacement' && String(d.original_sale_id) === String(row.id));
  if (repl) out.push({ tone: 'less', text: `Replacement issued (${repl.sku})` });
  if (row.commission_override || row.ticket_override) out.push({ tone: 'info', text: 'Commission manually overridden' });
  if (Array.isArray(row.commission_breakdown) && row.commission_breakdown.length) {
    const parts = row.commission_breakdown as Row[];
    if (parts.some((p) => p.amount_cents == null)) out.push({ tone: 'info', text: 'Commission partially pending' });
    else if (String(row.channel || '').toLowerCase().match(/floor|in_store|instore|store/)) {
      const bits = parts.map((p) => {
        const name = String(p.person || '').split(' ')[0];
        const pct = row.price_cents ? Math.round(Number(p.amount_cents) / Number(row.price_cents) * 100) : null;
        return pct != null ? `${pct}% ${name}` : name;
      });
      if (bits.length) out.push({ tone: 'info', text: bits.join(' / ') });
    }
  }
  if (['pending', 'none'].includes(String(row.fee_source)) && !['in_store', 'instore', 'floor', 'store', 'website'].includes(String(row.channel).toLowerCase())) {
    out.push({ tone: 'info', text: 'Waiting for marketplace fees' });
  }
  return out;
}

export function saleWhyText(row: Row, report: Report) {
  return saleWhyLines(row, report).map((w) => w.text).join('; ');
}
