import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { type WebOrder } from '../OrdersPage';
import { LabelDialog } from '../LabelDialog';
import { ReturnsPage } from '../ReturnsPage';
import { errText } from '../errText';
import { shortError } from './shortError';

function channelAllowsLabels(channel?: string | null) {
  const ch = (channel || 'website').toLowerCase();
  return ch === 'website' || ch === 'web' || ch === 'ebay' || ch === 'amazon' || ch === 'tiktok';
}

type Seg = 'toShip' | 'shipped' | 'pickup' | 'done' | 'canceled' | 'returns';

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
  const [busy, setBusy] = useState('');
  const [labelOpen, setLabelOpen] = useState(false);
  const packProofInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const { data, error: e } = await client.rpc('portal_web_orders', { p_days: 400 });
      if (e) throw e;
      const list = (data as WebOrder[]).filter((o) => o.payment_env !== 'sandbox' && !(o.order_no || '').toLowerCase().startsWith('sandbox'));
      setOrders(list);
      setOpen((prev) => (prev ? list.find((o) => o.id === prev.id) || prev : null));
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
      shipped: paid.filter((o) => o.fulfillment === 'ship' && !!o.shipped_at && !o.delivered_at),
      pickup: paid.filter((o) => o.fulfillment === 'pickup' && !o.picked_up_at),
      done: paid.filter((o) => o.delivered_at || o.picked_up_at),
      canceled: list.filter((o) => o.status === 'canceled' || o.status === 'refunded'),
    };
  }, [orders]);

  const rows = seg === 'toShip' ? buckets.toShip
    : seg === 'shipped' ? buckets.shipped
      : seg === 'pickup' ? buckets.pickup
        : seg === 'done' ? buckets.done
          : seg === 'canceled' ? buckets.canceled
            : [];
  const totals = useMemo(() => {
    const src = seg === 'returns' ? [] : rows;
    return {
      count: src.length,
      total: src.reduce((n, o) => n + (o.total_cents || 0), 0),
    };
  }, [rows, seg]);

  async function runAction(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError('');
    try {
      await fn();
      await load();
    } catch (e) {
      setError(shortError(errText(e)));
    } finally {
      setBusy('');
    }
  }

  async function markShipped(o: WebOrder) {
    const ch = (o.channel || '').toLowerCase();
    if ((ch === 'amazon' || ch === 'tiktok') && !o.pack_proof_photo_path) {
      setError('Amazon/TikTok need a pack photo first — use Add pack photo below.');
      return;
    }
    await runAction('ship', async () => {
      const { error: e } = await client.rpc('portal_mark_order_shipped', { p_order: o.id });
      if (e) {
        throw new Error(e.message === 'pack_proof_required'
          ? 'Upload a pack photo of the unit before marking shipped.'
          : e.message);
      }
    });
  }

  async function markDelivered(o: WebOrder) {
    await runAction('deliver', async () => {
      const { error: e } = await client.rpc('portal_mark_order_delivered', { p_order: o.id });
      if (e) throw e;
    });
  }

  async function markPickup(o: WebOrder) {
    if (!window.confirm(`Hand over ${o.title} (SKU ${o.sku}) to ${o.buyer_name || 'the buyer'}?`)) return;
    await runAction('pickup', async () => {
      const { error: e } = await client.rpc('mark_pickup_complete', { p_order: o.id });
      if (e) throw e;
    });
  }

  /** Floor-local cancel only — never marketplace API / Square refund. */
  async function floorCancel(o: WebOrder) {
    const ok = window.confirm(
      `Cancel ${CHANNEL[(o.channel || 'website').toLowerCase()] || o.channel} order ${o.order_no || o.id.slice(0, 8)} in Floor?\n\n`
      + 'This voids the Floor sale and puts the unit back available.\n'
      + 'It does NOT cancel or refund on eBay / Amazon / TikTok / Depop / Square.\n'
      + 'Marketplace cancel stays manual for the owner.',
    );
    if (!ok) return;
    const reason = window.prompt('Reason (optional):', '');
    if (reason === null) return;
    await runAction('cancel', async () => {
      const { error: e } = await client.rpc('portal_floor_cancel_order', {
        p_order: o.id,
        p_reason: reason.trim() || null,
      });
      if (e) throw e;
    });
  }

  async function uploadPackProof(o: WebOrder, file: File) {
    if (!file.type.startsWith('image/') && file.type !== '') {
      setError('Choose an image for pack proof.');
      return;
    }
    await runAction('proof', async () => {
      const serial = window.prompt('Serial number (optional):', o.pack_proof_serial || '') ?? '';
      const safe = (file.name || 'pack.jpg').replace(/[^a-zA-Z0-9._-]/g, '_') || 'pack.jpg';
      const path = `${storeId}/${o.sku}/pack-proof/${Date.now()}-${crypto.randomUUID()}-${safe}`;
      const buf = await file.arrayBuffer();
      const body = new Blob([buf], { type: file.type || 'image/jpeg' });
      const upload = await client.storage.from('unit-photos').upload(path, body, {
        contentType: file.type || 'image/jpeg',
        upsert: false,
      });
      if (upload.error) throw upload.error;
      const { error: e } = await client.rpc('portal_set_pack_proof', {
        p_order: o.id,
        p_photo_path: path,
        p_serial: serial.trim() || null,
      });
      if (e) throw e;
    });
  }

  if (open) {
    const pill = statusPill(open);
    const ch = (open.channel || 'website').toLowerCase();
    const paid = open.status === 'paid';
    const ship = open.fulfillment === 'ship';
    const pickup = open.fulfillment === 'pickup';
    const needsProof = (ch === 'amazon' || ch === 'tiktok') && !open.pack_proof_photo_path;
    const canLabel = channelAllowsLabels(ch) && ship && paid;
    if (labelOpen && canLabel) {
      return (
        <LabelDialog
          order={open}
          accessToken={accessToken}
          money={money}
          appMode
          onClose={() => setLabelOpen(false)}
          onDone={() => { setLabelOpen(false); void load(); }}
        />
      );
    }
    return (
      <div className="app-stack">
        <div className="app-nav">
          <button type="button" onClick={() => setOpen(null)}>‹ Orders</button>
          <div className="app-nav-title">Order</div>
          <button type="button" style={{ visibility: 'hidden' }}>·</button>
        </div>
        <div className="app-item-head">
          <h1>{open.title}</h1>
          <p className="meta">{CHANNEL[ch] || open.channel} · {open.order_no || open.id.slice(0, 8)}</p>
          <p className="price">{money(open.total_cents)}</p>
        </div>
        <div className="app-group">
          <div className="app-kv"><span>Status</span><strong className={pill.tone === 'warn' ? 'warn' : pill.tone === 'ok' ? 'live' : 'muted'}>{pill.text}</strong></div>
          <div className="app-kv"><span>SKU</span><strong>{open.sku}</strong></div>
          <div className="app-kv"><span>Buyer</span><strong>{open.buyer_name || '—'}</strong></div>
          <div className="app-kv"><span>Placed</span><strong>{stamp(open.created_at)}</strong></div>
          {open.shipped_at && <div className="app-kv"><span>Shipped</span><strong>{stamp(open.shipped_at)}</strong></div>}
          {open.delivered_at && <div className="app-kv"><span>Delivered</span><strong>{stamp(open.delivered_at)}</strong></div>}
          {open.picked_up_at && <div className="app-kv"><span>Picked up</span><strong>{stamp(open.picked_up_at)}</strong></div>}
          {open.tracking_number && <div className="app-kv"><span>Tracking</span><strong>{open.tracking_number}</strong></div>}
          {open.cancel_reason && <div className="app-kv"><span>Cancel</span><strong className="muted">{open.cancel_reason}</strong></div>}
        </div>

        {error && <p className="app-inline-error">{error}</p>}

        {paid && (
          <div className="app-actions" style={{ paddingTop: 8 }}>
            {canLabel && (
              <button type="button" disabled={!!busy} onClick={() => setLabelOpen(true)}>
                {open.label_url ? 'Download / Reprint label' : 'Get label'}
              </button>
            )}
            {ship && !open.shipped_at && (
              <button type="button" disabled={!!busy} onClick={() => void markShipped(open)}>
                {busy === 'ship' ? '…' : 'Mark shipped'}
              </button>
            )}
            {ship && open.shipped_at && !open.delivered_at && (
              <button type="button" disabled={!!busy} onClick={() => void markDelivered(open)}>
                {busy === 'deliver' ? '…' : 'Mark delivered'}
              </button>
            )}
            {pickup && !open.picked_up_at && (
              <button type="button" disabled={!!busy} onClick={() => void markPickup(open)}>
                {busy === 'pickup' ? '…' : 'Mark picked up'}
              </button>
            )}
            {(ch === 'amazon' || ch === 'tiktok') && !open.delivered_at && (
              <>
                <input
                  ref={packProofInput}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="sr-only"
                  aria-hidden
                  tabIndex={-1}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (f) void uploadPackProof(open, f);
                  }}
                />
                <button type="button" className="secondary" disabled={!!busy} onClick={() => packProofInput.current?.click()}>
                  {busy === 'proof' ? '…' : open.pack_proof_photo_path ? 'Replace pack photo' : 'Add pack photo'}
                </button>
              </>
            )}
            {!open.delivered_at && !open.picked_up_at && (
              <button type="button" className="secondary" disabled={!!busy} onClick={() => void floorCancel(open)}>
                {busy === 'cancel' ? '…' : 'Cancel in Floor'}
              </button>
            )}
          </div>
        )}

        {needsProof && (
          <p className="app-footer-count">Amazon/TikTok: add a pack photo before Mark shipped.</p>
        )}
        {paid && !open.delivered_at && !open.picked_up_at && (
          <p className="app-footer-count">
            Cancel in Floor only voids the Floor sale — it does not cancel the marketplace listing or refund the buyer.
          </p>
        )}
      </div>
    );
  }

  return (
    <>
      <div className="app-large-title"><h1>Orders</h1></div>
      <div className="app-segment">
        {([
          ['toShip', 'To ship', buckets.toShip.length],
          ['shipped', 'Shipped', buckets.shipped.length],
          ['pickup', 'Pickup', buckets.pickup.length],
          ['done', 'Done', buckets.done.length],
          ['canceled', 'Canceled', buckets.canceled.length],
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
