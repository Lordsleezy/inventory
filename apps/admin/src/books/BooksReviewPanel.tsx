import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { listBookIssues, type ReviewIssue, type ReviewSheet } from './booksReview';
import type { BooksWorkbook, Report, SalesLine } from './types';

type SaleChoice = { id: string; label: string };

export function BooksReview({
  workbook,
  report,
  money,
  client,
  onOpen,
  onResolveLabel,
}: {
  workbook: BooksWorkbook;
  report: Report;
  money: (cents: number) => string;
  client: SupabaseClient;
  onOpen: (sheet: ReviewSheet, saleIds: string[]) => void;
  onResolveLabel?: (expenseId: string, choice: { saleId?: string; asExpense?: boolean }) => void;
}) {
  const issues = listBookIssues(workbook, report);
  const [open, setOpen] = useState(false);
  if (!issues.length) return null;
  const n = issues.length;
  return (
    <div className="books-desk-alert" role="status">
      <div>
        <strong>{n === 1 ? '1 thing to fix before you lock' : `${n} things to fix before you lock`}</strong>
        {issues.map((issue) => <p key={issue.id}>{issue.message}</p>)}
      </div>
      <button type="button" onClick={() => setOpen((value) => !value)}>{open ? 'Hide' : 'Review'}</button>
      {open && (
        <div className="books-review-list">
          {issues.map((issue) => (
            <ReviewItem
              key={issue.id}
              issue={issue}
              report={report}
              money={money}
              client={client}
              onOpen={onOpen}
              onResolveLabel={onResolveLabel}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function saleChoices(report: Report): SaleChoice[] {
  return (report.sales || []).map((sale) => ({
    id: String(sale.id),
    label: [String(sale.sold_at || sale.date || '').slice(0, 10), sale.receipt_no || sale.order_no || '', sale.sku, sale.item_title || sale.title || ''].filter(Boolean).join(' · '),
  }));
}

function ReviewItem({
  issue,
  report,
  money,
  client,
  onOpen,
  onResolveLabel,
}: {
  issue: ReviewIssue;
  report: Report;
  money: (cents: number) => string;
  client: SupabaseClient;
  onOpen: (sheet: ReviewSheet, saleIds: string[]) => void;
  onResolveLabel?: (expenseId: string, choice: { saleId?: string; asExpense?: boolean }) => void;
}) {
  const choices = saleChoices(report);
  const [saleId, setSaleId] = useState(issue.label?.suggestedSaleId || choices[0]?.id || '');
  const [orderNote, setOrderNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const orderId = issue.label?.orderId;
    if (!orderId) return;
    let cancel = false;
    void client.from('web_orders').select('carrier,tracking_number,marketplace_title,order_no,channel').eq('id', orderId).maybeSingle().then((res) => {
      if (cancel || res.error || !res.data) return;
      const row = res.data as { carrier?: string | null; tracking_number?: string | null; marketplace_title?: string | null; order_no?: string | null; channel?: string | null };
      const bits = [row.channel || row.carrier, row.order_no, row.marketplace_title, row.tracking_number ? `tracking ${row.tracking_number}` : 'no tracking number saved'].filter(Boolean);
      setOrderNote(bits.join(' · '));
    });
    return () => { cancel = true; };
  }, [client, issue.label?.orderId]);

  const go = () => onOpen(issue.sheet, issue.sales.map((sale) => sale.sale_id));
  return (
    <article className="books-review-item">
      <p>{issue.message}</p>
      {issue.label && (
        <dl className="books-review-label">
          <div><dt>Amount</dt><dd>{money(issue.label.amount_cents)}</dd></div>
          <div><dt>Date</dt><dd>{issue.label.date || '—'}</dd></div>
          <div><dt>Carrier</dt><dd>{issue.label.carrier || '—'}</dd></div>
          <div><dt>Tracking</dt><dd>{issue.label.tracking || '—'}</dd></div>
          <div><dt>Where it came from</dt><dd>{issue.label.source || 'shipping label'}{issue.label.sku ? ` · SKU ${issue.label.sku}` : ''}</dd></div>
          {orderNote && <div><dt>Order</dt><dd>{orderNote}</dd></div>}
        </dl>
      )}
      {issue.sales.length > 0 && (
        <ul className="books-review-sales">
          {issue.sales.map((sale) => <SaleLine key={sale.sale_id + sale.sku} sale={sale} money={money} />)}
        </ul>
      )}
      <div className="books-review-actions">
        {issue.label && onResolveLabel && (
          <>
            <label>
              Sale
              <select aria-label="Sale to match" value={saleId} onChange={(e) => setSaleId(e.target.value)}>
                {choices.map((choice) => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
              </select>
            </label>
            <button type="button" disabled={busy || !saleId} onClick={() => { setBusy(true); onResolveLabel(issue.label!.id, { saleId }); }}>Match to this sale</button>
            <button type="button" disabled={busy} onClick={() => { setBusy(true); onResolveLabel(issue.label!.id, { asExpense: true }); }}>Keep as an expense</button>
          </>
        )}
        <button type="button" onClick={go}>{issue.action}</button>
      </div>
    </article>
  );
}

function SaleLine({ sale, money }: { sale: SalesLine; money: (cents: number) => string }) {
  return (
    <li>
      <span>{sale.date} · {sale.title} · SKU {sale.sku}</span>
      <span>Sale {money(sale.price_cents)} · Cost {sale.cost_cents == null ? '—' : money(sale.cost_cents)} · Profit {sale.profit_cents == null ? '—' : money(sale.profit_cents)}</span>
    </li>
  );
}
