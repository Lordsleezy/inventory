import { isBonusCategory } from '../payouts';
import { channelTitle } from './booksMath';
import type { DuplicateNote, ExpenseDisplayLine, ExpenseLine, Report, Row } from './types';

const STORE_CHECKOUT = new Set(['ebay', 'tiktok', 'amazon']);
const SKIP_SOURCES = new Set(['fee']); // promoted with sale_id — counted on Sales

function normText(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function isUuid(s: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function cleanTitle(description: string, source: string, sku?: string, order?: string) {
  const src = String(source || '').toLowerCase();
  if (src === 'manual_label' || src === 'label') {
    const ch = channelTitle(src === 'manual_label' ? description.split(' ')[0] : 'mercari');
    const skuBit = sku ? `SKU ${sku}` : order ? `order ${order}` : '';
    if (description.toLowerCase().includes('mercari') || src === 'manual_label') {
      return ['Mercari label', skuBit].filter(Boolean).join(' · ');
    }
  }
  let title = description.trim();
  if (isUuid(title)) title = sku ? `SKU ${sku}` : 'Expense';
  title = title.replace(/\bmanual_label\b/gi, '').replace(/\s+/g, ' ').trim();
  if (/^shipping label\b/i.test(title) && sku) return `Mercari label · SKU ${sku}`;
  return title || 'Expense';
}

function storeCheckoutLabel(e: Row, l?: Row): boolean {
  const src = String(e?.source || l?.carrier || '').toLowerCase();
  if (src !== 'label' && src !== 'manual_label') {
    const carrier = String(l?.carrier || '').toLowerCase();
    if (carrier.includes('ebay')) return true;
    if (l?.order_id && String(l.service || '').toLowerCase().includes('ebay')) return true;
  }
  const desc = String(e?.description || l?.service || '').toLowerCase();
  for (const ch of STORE_CHECKOUT) {
    if (desc.includes(ch) || String(e?.source || '').toLowerCase().includes(ch)) return true;
  }
  if (String(l?.carrier || '').toLowerCase() === 'ebay') return true;
  return false;
}

function expenseCategory(raw: string, source: string, description: string): string {
  const c = raw.trim();
  const d = description.toLowerCase();
  const src = source.toLowerCase();
  if (c.toLowerCase() === 'bonus' || d.includes('bonus')) return 'Bonus';
  if (src === 'return' || c.toLowerCase().includes('return')) return 'Returns';
  if (
    c.toLowerCase().includes('promoted')
    || d.includes('promoted')
    || src === 'fee'
  ) return 'Promoted listings';
  if (
    c.toLowerCase().includes('shipping')
    || src === 'label'
    || src === 'manual_label'
    || d.includes('label')
    || d.includes('postage')
  ) return 'Out-of-pocket shipping';
  return c || 'Other';
}

export type BuiltExpenses = {
  rows: ExpenseDisplayLine[];
  exportRows: ExpenseLine[];
  categoryTotals: { category: string; amount_cents: number }[];
  total_cents: number;
  reimburse_cents: number;
  otherExpenses_cents: number;
  duplicates: DuplicateNote[];
};

function detectDuplicates(lines: ExpenseDisplayLine[]): DuplicateNote[] {
  const notes: DuplicateNote[] = [];
  const groups = new Map<string, ExpenseDisplayLine[]>();
  for (const line of lines) {
    if (line.excludeFromTotals) continue;
    const key = `${line.date.slice(0, 10)}|${line.amount_cents}|${normText(line.kindKey)}`;
    const list = groups.get(key) || [];
    list.push(line);
    groups.set(key, list);
  }
  for (const [, list] of groups) {
    if (list.length < 2) continue;
    const primary = list[0];
    for (let i = 1; i < list.length; i++) {
      const dup = list[i];
      dup.excludeFromTotals = true;
      dup.duplicateFlag = true;
      notes.push({
        message: '',
        lineIds: [primary.id, dup.id],
        pair: { id: `${primary.id}:${dup.id}`, primary, duplicate: dup },
      });
    }
  }
  return notes;
}

export function buildExpenses(report: Report, attributedPromotedIds: Set<string>): BuiltExpenses {
  const rows: ExpenseDisplayLine[] = [];
  const labelIdsInExpenses = new Set((report.expenses || []).map((e) => String(e.label_id || '')).filter(Boolean));
  const returnExpenseKeys = new Set(
    (report.expenses || [])
      .filter((e) => String(e.source || '').toLowerCase() === 'return')
      .map((e) => String(e.external_id || e.id || ''))
      .filter(Boolean),
  );
  const saleIds = new Set((report.sales || []).map((s) => String(s.id)));

  for (const e of (report.expenses || []).filter((x) => !x.voided_at)) {
    const source = String(e.source || 'manual');
    if (SKIP_SOURCES.has(source.toLowerCase())) continue;
    if ((source === 'label' || source === 'manual_label') && storeCheckoutLabel(e)) continue;
    const sku = String(e.sku || '');
    const category = expenseCategory(String(e.category || ''), source, String(e.description || ''));
    const title = cleanTitle(String(e.description || ''), source, sku, String(e.order_id || ''));
    const isBonus = category === 'Bonus' || isBonusCategory(String(e.category || ''));
    const reimburse = Boolean(e.needs_reimbursement) && !isBonus;
    rows.push({
      id: String(e.id || `${e.date}-${title}`),
      date: String(e.date ?? e.spent_on ?? ''),
      category,
      title,
      amount_cents: Number(e.amount_cents || 0),
      sourceDisplay: source === 'manual' ? '' : channelTitle(source) || source,
      sku_or_order: sku || String(e.order_id || e.external_id || ''),
      needs_reimbursement: reimburse,
      countsInProfit: false,
      kindKey: category,
      excludeFromTotals: false,
    });
  }

  for (const l of report.labels || []) {
    if (labelIdsInExpenses.has(String(l.id))) continue;
    if (storeCheckoutLabel({}, l)) continue;
    const cents = Math.abs(Number(l.signed_amount_cents ?? l.cost_cents ?? 0));
    if (!cents) continue;
    const order = String(l.order_id || l.transaction_id || '');
    rows.push({
      id: `label:${l.id}`,
      date: String(l.date || '').slice(0, 10),
      category: 'Out-of-pocket shipping',
      title: String(l.carrier || '').toLowerCase() === 'ebay'
        ? `eBay label${order ? ` · ${order}` : ''}`
        : ['Shipping label', order].filter(Boolean).join(' · '),
      amount_cents: cents,
      sourceDisplay: channelTitle(l.carrier || 'Store'),
      sku_or_order: order,
      needs_reimbursement: false,
      countsInProfit: true,
      kindKey: 'shipping-label',
      excludeFromTotals: false,
    });
  }

  const promotedGroups = new Map<string, { account: string; charges: ExpenseDisplayLine[]; total: number; dates: string[] }>();
  for (const f of report.fees || []) {
    const type = String(f.type || '').toLowerCase();
    if (!type.includes('promoted') && !type.includes('ad')) continue;
    const fid = String(f.id || '');
    if (f.sale_id && saleIds.has(String(f.sale_id))) continue;
    if (attributedPromotedIds.has(fid)) continue;
    const account = String(f.account || f.channel || 'Marketplace');
    const key = `promoted:${account.toLowerCase()}`;
    const g = promotedGroups.get(key) || { account, charges: [], total: 0, dates: [] };
    const charge: ExpenseDisplayLine = {
      id: fid || `promoted:${f.date}`,
      date: String(f.date || '').slice(0, 10),
      category: 'Promoted listings',
      title: String(f.type || 'Promoted listing'),
      amount_cents: Number(f.amount_cents || 0),
      sourceDisplay: channelTitle(f.channel || 'ebay'),
      sku_or_order: String(f.order_id || ''),
      needs_reimbursement: false,
      countsInProfit: false,
      kindKey: 'promoted',
      excludeFromTotals: false,
    };
    g.charges.push(charge);
    g.total += charge.amount_cents;
    g.dates.push(charge.date);
    promotedGroups.set(key, g);
  }
  for (const g of promotedGroups.values()) {
    const minD = g.dates.sort()[0] || '';
    const maxD = g.dates.sort().slice(-1)[0] || '';
    const range = minD && maxD && minD !== maxD ? `${minD.slice(5)} – ${maxD.slice(5)}` : minD.slice(5);
    rows.push({
      id: `promoted-roll:${g.account}`,
      category: 'Promoted listings',
      title: `eBay promoted · ${g.account}`,
      amount_cents: g.total,
      date: minD,
      meta: `${g.charges.length} charges · ${range}`,
      sourceDisplay: 'eBay',
      sku_or_order: '',
      needs_reimbursement: false,
      countsInProfit: false,
      kindKey: 'promoted',
      excludeFromTotals: false,
      children: g.charges,
    });
  }

  for (const r of report.returns || []) {
    const key = `return-label:${r.id}`;
    if (returnExpenseKeys.has(key) || returnExpenseKeys.has(String(r.id))) continue;
    const labelCents = Number(r.return_label_cents || 0);
    if (labelCents <= 0 || String(r.label_paid_by || 'seller') !== 'seller') continue;
    rows.push({
      id: key,
      date: String(r.created_at || r.date || '').slice(0, 10),
      category: 'Out-of-pocket shipping',
      title: `Return label · ${channelTitle(r.channel)} · SKU ${r.sku}`,
      amount_cents: labelCents,
      sourceDisplay: channelTitle(r.channel),
      sku_or_order: String(r.sku || r.external_order_id || ''),
      needs_reimbursement: true,
      countsInProfit: false,
      kindKey: 'return-label',
      excludeFromTotals: false,
    });
  }

  rows.sort((a, b) => a.date.localeCompare(b.date) || a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
  const duplicates = detectDuplicates(rows);

  const counting = rows.filter((r) => !r.excludeFromTotals);
  const byCat = new Map<string, number>();
  for (const e of counting) byCat.set(e.category, (byCat.get(e.category) || 0) + e.amount_cents);
  const categoryTotals = [...byCat.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([category, amount_cents]) => ({ category, amount_cents }));

  const total_cents = counting.reduce((n, e) => n + e.amount_cents, 0);
  const reimburse_cents = counting.filter((r) => r.needs_reimbursement).reduce((n, r) => n + r.amount_cents, 0);
  const otherExpenses_cents = counting.filter((r) => !r.countsInProfit).reduce((n, r) => n + r.amount_cents, 0);

  const exportRows: ExpenseLine[] = rows.map((r) => ({
    date: r.date,
    category: r.category,
    description: r.children?.length ? `${r.title} · ${r.meta}` : r.title,
    amount_cents: r.excludeFromTotals ? 0 : r.amount_cents,
    sku_or_order: r.sku_or_order,
    paid_by: r.sourceDisplay || 'Store',
    needs_reimbursement: r.needs_reimbursement ? 'Yes' : 'No',
    source: r.sourceDisplay,
  }));

  return { rows, exportRows, categoryTotals, total_cents, reimburse_cents, otherExpenses_cents, duplicates };
}

export function filterReceived(items: Row[]): Row[] {
  return items.filter((r) => {
    const state = String(r.unit_state || '').toLowerCase();
    if (['voided', 'lost', 'scrapped', 'deleted'].includes(state)) return false;
    if (state === 'mistake') return false;
    return true;
  });
}
