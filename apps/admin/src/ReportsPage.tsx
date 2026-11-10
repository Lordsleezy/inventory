import { useEffect, useState, type ReactNode } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ReportTab } from './navigation';
import { AppScrollTabs } from './appMode/AppScrollTabs';
import { ChannelReportPage } from './ChannelReportPage';
import { OverheadPage } from './OverheadPage';
import { TaxReportPage } from './TaxReportPage';
import { ReturnsReportPanel } from './ReturnsReportPanel';
import { TaxPage } from './TaxPage';
import { DispositionsPanel } from './DispositionDialogs';
import { ReceiptsPage } from './ReceiptsPage';
import { ShippingAuditPage } from './ShippingAuditPage';

type Props = {
  client: SupabaseClient;
  money: (n: number) => string;
  tab: ReportTab;
  onTab: (t: ReportTab) => void;
  closeouts: ReactNode;
  expenses: ReactNode;
  payouts: ReactNode;
  native?: boolean;
  nativeCloseouts?: ReactNode;
  onOrderLinked?: () => void;
  renderSplit?: (args: { start: string; end: string; profitCents: number }) => ReactNode;
};

export function ReportsPage({ client, money, tab, onTab, closeouts, expenses, payouts, native, nativeCloseouts, onOrderLinked, renderSplit }: Props) {
  const [showSkuLinks, setShowSkuLinks] = useState(false);
  const [reportVersion, setReportVersion] = useState(0);
  const tabs: { id: ReportTab; label: string }[] = native
    ? [{id:'profit',label:'Profit'},{id:'shipping',label:'Fees'},{id:'expenses',label:'Expenses'},{id:'payouts',label:'Payouts'},{id:'sales-tax',label:'Tax'},{id:'sold',label:'Sold'}]
    : [{id:'profit',label:'Profit'},{id:'shipping',label:'Fees'},{id:'expenses',label:'Expenses'},{id:'payouts',label:'Payouts'},{id:'returns',label:'Returns'},{id:'replacements',label:'Replacements'},{id:'sales-tax',label:'Sales tax'},{id:'ship-audit',label:'Shipping check'}];
  return <>
    {!native && <header><div><div className="eyebrow">STORE LEDGER</div><h1>Numbers</h1>
      <p>Profit, shipping and fees, expenses, payouts, and period closeouts.</p></div></header>}
    {native ? (
      <AppScrollTabs className="report-tabs" ariaLabel="Report sections" items={tabs} value={tab} onChange={onTab} />
    ) : (
      <div className="inventory-tabs report-tabs" role="tablist" aria-label="Report sections">
        {tabs.map(t => <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'active' : ''} onClick={() => onTab(t.id)}>{t.label}</button>)}
      </div>
    )}
    {tab === 'profit' && <>
      <ChannelReportPage key={reportVersion} client={client} money={money} embedded native={native} onLinkSku={() => setShowSkuLinks(true)} renderSplit={renderSplit} />
      {!native && closeouts}
    </>}
    {tab === 'shipping' && <>
      <ChannelReportPage client={client} money={money} embedded mode="fees" native={native} />
    </>}
    {tab === 'expenses' && expenses}
    {tab === 'overhead' && <OverheadPage client={client} money={money} native={native} onBack={() => onTab('profit')} />}
    {tab === 'payouts' && payouts}
    {tab === 'daily' && (native ? nativeCloseouts : closeouts)}
    {tab === 'sales-tax' && <><TaxReportPage client={client} money={money} embedded native={native} /><TaxPage client={client} money={money} stamp={s => new Date(s).toLocaleDateString()} embedded={native} native={native} /></>}
    {tab === 'returns' && <ReturnsReportPanel client={client} money={money} />}
    {tab === 'replacements' && <DispositionsPanel client={client} money={money} stamp={s => new Date(s).toLocaleDateString()} kind="replacement" title="Replacements" hint="Units sent to customers to replace a bad one. Each replacement's cost comes off the original sale's profit and commission." />}
    {tab === 'sold' && <ReceiptsPage client={client} money={money} stamp={s => new Date(s).toLocaleDateString()} variant={native ? 'app' : 'desktop'} />}
    {tab === 'ship-audit' && <ShippingAuditPage />}
    {native && showSkuLinks && <LinkSkuSheet client={client} money={money} onClose={() => setShowSkuLinks(false)} onLinked={() => { setReportVersion(v => v + 1); onOrderLinked?.(); }} />}
  </>;
}

type UnmatchedOrder = { id: string; title: string; channel: string; order_no: string | null; price_cents: number; sku: string | null };

function LinkSkuSheet({ client, money, onClose, onLinked }: { client: SupabaseClient; money: (n: number) => string; onClose: () => void; onLinked: () => void }) {
  const [orders, setOrders] = useState<UnmatchedOrder[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void client.rpc('portal_unmatched_orders', { p_from: '2020-01-01T00:00:00Z', p_to: new Date(Date.now() + 86400000).toISOString() }).then(({ data, error: err }) => {
      if (!alive) return;
      if (err) setError(err.message);
      else setOrders((data || []) as UnmatchedOrder[]);
    });
    return () => { alive = false; };
  }, [client]);
  async function link(order: UnmatchedOrder) {
    setBusy(order.id); setError('');
    try {
      if (!(Number(order.price_cents) > 0)) { setError('This order has no sale price and cannot be linked yet.'); return; }
      let suggestions: { sku?: string }[] = [];
      try {
        const result = await client.rpc('portal_suggest_order_skus', { p_order: order.id, p_limit: 5 });
        if (Array.isArray(result.data)) suggestions = result.data as { sku?: string }[];
      } catch { /* suggestions are optional */ }
      const hint = suggestions.length ? `\nSuggested: ${suggestions.map(s => s.sku).filter(Boolean).join(', ')}` : '';
      const sku = window.prompt(`Link ${order.channel} order ${order.order_no || order.id} to a Floor SKU.${hint}\nEnter SKU:`, order.sku === 'UNMATCHED' ? '' : order.sku || '');
      if (!sku?.trim()) return;
      const { error: err } = await client.rpc('portal_match_web_order', { p_order: order.id, p_sku: sku.trim() });
      if (err) setError(err.message);
      else { setOrders(rows => (rows || []).filter(r => r.id !== order.id)); onLinked(); }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }
  return <div className="native-sku-sheet" role="dialog" aria-modal="true" aria-label="Link marketplace SKUs"><div className="app-nav"><button type="button" onClick={onClose}>‹ Numbers</button><div className="app-nav-title">Link SKUs</div><button type="button" style={{ visibility: 'hidden' }}>·</button></div><p className="native-report-footnote">Link marketplace orders to Floor items so item cost can be included in profit and payouts.</p>{error && <p className="error" role="alert">{error}</p>}{orders === null ? <div className="native-skeleton-row"><span className="native-skeleton" /></div> : orders.length === 0 ? <p className="native-report-empty">No unmatched orders.</p> : <div className="native-report-group">{orders.map(o => <button type="button" className="native-report-row" key={o.id} disabled={busy === o.id} onClick={() => void link(o)}><span>{o.title || o.channel}<small>{o.channel} · {o.order_no || 'Order'} · {o.sku && o.sku !== 'UNMATCHED' ? `SKU ${o.sku}` : 'Needs SKU'}</small></span><b>{money(o.price_cents)}</b><span className="native-chevron">›</span></button>)}</div>}</div>;
}
