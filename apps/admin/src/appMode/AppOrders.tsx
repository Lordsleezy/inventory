import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { type WebOrder } from '../OrdersPage';
import { ReturnsPage } from '../ReturnsPage';
import { errText } from '../errText';
import { shortError } from './shortError';

type Seg = 'toShip' | 'pickup' | 'done' | 'returns';

const CHANNEL: Record<string, string> = {
  website: 'Website', ebay: 'eBay', amazon: 'Amazon', tiktok: 'TikTok', depop: 'Depop',
};

type Props = {
  client: SupabaseClient;
  storeId: string;
  accessToken: string;
  money: (n: number) => string;
  stamp: (s: string) => string;
};

function statusPill(o: WebOrder): { text: string; tone: 'warn' | 'ok' | 'muted' } {
  if (o.status === 'canceled' || o.status === 'refunded') return { text: 'Canceled', tone: 'muted' };
  if (o.fulfillment === 'pickup' && !o.picked_up_at) return { text: 'Ready', tone: 'ok' };
  if (o.fulfillment === 'ship' && !o.shipped_at) return { text: 'Ship today', tone: 'warn' };
  if (o.shipped_at && !o.delivered_at) return { text: 'Shipped', tone: 'muted' };
  if (o.delivered_at || o.picked_up_at) {
    const d = o.delivered_at || o.picked_up_at;
    return { text: d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'Done', tone: 'muted' };
  }
  return { text: o.status, tone: 'muted' };
}

export function AppOrders({ client, storeId, accessToken, money, stamp }: Props) {
  const [seg, setSeg] = useState<Seg>('toShip');
  const [orders, setOrders] = useState<WebOrder[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<WebOrder | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const { data, error: e } = await client.rpc('portal_web_orders', { p_days: 400 });
      if (e) throw e;
      const list = (data as WebOrder[]).filter((o) => o.payment_env !== 'sandbox' && !(o.order_no || '').toLowerCase().startsWith('sandbox'));
      setOrders(list);
      const skus = [...new Set(list.map((o) => o.sku).filter(Boolean))];
      if (skus.length) {
        const { data: photos } = await client.from('photos').select('sku, path, is_primary').in('sku', skus.slice(0, 80));
        const bySku = new Map<string, string>();
        for (const p of photos || []) {
          if (p.is_primary || !bySku.has(p.sku)) bySku.set(p.sku, p.path);
        }
        const paths = [...bySku.values()];
        if (paths.length) {
          const { data: signed } = await client.storage.from('unit-photos').createSignedUrls(paths, 3600);
          const map: Record<string, string> = {};
          paths.forEach((path, i) => {
            const sku = [...bySku.entries()].find(([, v]) => v === path)?.[0];
            if (sku && signed?.[i]?.signedUrl) map[sku] = signed[i].signedUrl!;
          });
          setUrls(map);
        }
      }
    } catch (e) {
      setError(shortError(errText(e)));
    }
  }, [client]);

  useEffect(() => { void load(); const t = setInterval(() => void load(), 30000); return () => clearInterval(t); }, [load]);

  const buckets = useMemo(() => {
    const list = orders || [];
    const paid = list.filter((o) => o.status === 'paid');
    return {
      toShip: paid.filter((o) => o.fulfillment === 'ship' && !o.shipped_at),
      pickup: paid.filter((o) => o.fulfillment === 'pickup' && !o.picked_up_at),
      done: paid.filter((o) => o.delivered_at || o.picked_up_at || (o.shipped_at && o.delivered_at)),
      allPaid: paid,
    };
  }, [orders]);

  const rows = seg === 'toShip' ? buckets.toShip : seg === 'pickup' ? buckets.pickup : seg === 'done' ? buckets.done : [];
  const totals = useMemo(() => {
    const src = seg === 'returns' ? [] : rows;
    return {
      count: src.length,
      total: src.reduce((n, o) => n + (o.total_cents || 0), 0),
    };
  }, [rows, seg]);

  if (open) {
    const pill = statusPill(open);
    return (
      <div className="app-stack">
        <div className="app-nav">
          <button type="button" onClick={() => setOpen(null)}>‹ Orders</button>
          <div className="app-nav-title">Order</div>
          <button type="button" style={{ visibility: 'hidden' }}>·</button>
        </div>
        <div className="app-item-head">
          <h1>{open.title}</h1>
          <p className="meta">{CHANNEL[(open.channel || 'website').toLowerCase()] || open.channel} · {open.order_no || open.id.slice(0, 8)}</p>
          <p className="price">{money(open.total_cents)}</p>
        </div>
        <div className="app-group">
          <div className="app-kv"><span>Status</span><strong className={pill.tone === 'warn' ? 'warn' : pill.tone === 'ok' ? 'live' : 'muted'}>{pill.text}</strong></div>
          <div className="app-kv"><span>SKU</span><strong>{open.sku}</strong></div>
          <div className="app-kv"><span>Buyer</span><strong>{open.buyer_name || '—'}</strong></div>
          <div className="app-kv"><span>Placed</span><strong>{stamp(open.created_at)}</strong></div>
          {open.tracking_number && <div className="app-kv"><span>Tracking</span><strong>{open.tracking_number}</strong></div>}
        </div>
        <p className="app-footer-count">Full ship / pack / cancel actions stay on desktop Orders if needed.</p>
      </div>
    );
  }

  return (
    <>
      <div className="app-large-title"><h1>Orders</h1></div>
      <div className="app-segment">
        {([
          ['toShip', 'To ship', buckets.toShip.length],
          ['pickup', 'Pickup', buckets.pickup.length],
          ['done', 'Done', buckets.done.length],
          ['returns', 'Returns', null],
        ] as const).map(([id, label, n]) => (
          <button key={id} type="button" className={seg === id ? 'active' : ''} onClick={() => setSeg(id)}>
            {label}{n != null ? ` ${n}` : ''}
          </button>
        ))}
      </div>
      {error && <p className="app-inline-error">{error}</p>}
      {seg === 'returns' ? (
        <div className="app-embed-soft">
          <ReturnsPage client={client} storeId={storeId} money={money} stamp={stamp} />
        </div>
      ) : (
        <>
          <div className="app-group">
            {!orders && <div className="app-empty-row">Loading…</div>}
            {orders && rows.length === 0 && <div className="app-empty-row">None right now</div>}
            {rows.map((o) => {
              const pill = statusPill(o);
              const ch = CHANNEL[(o.channel || 'website').toLowerCase()] || o.channel || 'Website';
              return (
                <button key={o.id} type="button" className="app-row" onClick={() => setOpen(o)}>
                  <span className="app-thumb">{urls[o.sku] ? <img src={urls[o.sku]} alt="" /> : '+'}</span>
                  <span className="app-row-text">
                    <strong>{o.title}</strong>
                    <small>{ch} · {o.order_no || o.sku}</small>
                  </span>
                  <span className={`app-pill ${pill.tone}`}>{pill.text}</span>
                  <span className="app-chevron">›</span>
                </button>
              );
            })}
          </div>
          <p className="app-footer-count">{totals.count} orders · {money(totals.total)}</p>
        </>
      )}
    </>
  );
}
