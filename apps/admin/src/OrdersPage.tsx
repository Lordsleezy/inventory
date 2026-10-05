import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { LabelDialog } from './LabelDialog';

const functionsBase = (import.meta.env.VITE_FLOOR_FUNCTIONS_URL || 'https://inventoryobi.netlify.app').replace(/\/$/, '');

export type WebOrder = {
  id: string; order_no: string | null; sku: string; title: string; status: string; fulfillment: 'ship' | 'pickup'; channel?: string;
  buyer_name: string | null; buyer_email: string | null; buyer_phone: string | null;
  ship_line1: string | null; ship_line2: string | null; ship_city: string | null; ship_region: string | null; ship_postal: string | null;
  item_cents: number; shipping_cents: number; tax_cents: number; total_cents: number; payment_env: string | null;
  created_at: string; paid_at: string | null; pickup_deadline: string | null; picked_up_at: string | null; picked_up_by: string | null;
  shipped_at: string | null; tracking_number: string | null; tracking_url: string | null; carrier: string | null; service: string | null;
  label_url: string | null; label_purchased_at: string | null; label_cost_cents: number | null;
  refund_requested_at: string | null; cancel_source: string | null; cancel_reason: string | null; canceled_at: string | null;
  shipping_rate: { source?: string; days?: number | null } | null;
  package: { length_in: number | null; width_in: number | null; height_in: number | null; weight_lb: number | null };
};
type Props = { client: SupabaseClient; accessToken: string; money: (n: number) => string; stamp: (s: string) => string };

function timeLeft(deadline: string | null, now: number) {
  if (!deadline) return '';
  const ms = new Date(deadline).getTime() - now;
  if (ms <= 0) return 'Deadline passed — auto-cancel pending';
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h left` : `${h}h ${m}m left`;
}

export function OrdersPage({ client, accessToken, money, stamp }: Props) {
  const [orders, setOrders] = useState<WebOrder[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [labelFor, setLabelFor] = useState<WebOrder | null>(null);

  const load = useCallback(async () => {
    const { data, error: e } = await client.rpc('portal_web_orders', { p_days: 120 });
    if (e) { setError(e.message); return; }
    setOrders(data as WebOrder[]);
  }, [client]);
  useEffect(() => { void load(); const t = setInterval(() => { void load(); }, 30000); return () => clearInterval(t); }, [load]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(t); }, []);

  async function act(id: string, action: string, extra: Record<string, unknown> = {}) {
    setBusy(id + action); setError('');
    try {
      const res = await fetch(`${functionsBase}/.netlify/functions/web-order-admin`, {
        method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, id, ...extra }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) throw new Error(body.error || `Request failed (${res.status})`);
      if (action === 'buy_label' && body.order?.label_url) window.open(body.order.label_url, '_blank', 'noopener');
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }
  function voidLabel(o: WebOrder) {
    if (!window.confirm(`Void the ${o.carrier} label for ${o.order_no}?

Shippo refunds the label cost, the label expense is reversed, and you can buy a different label.`)) return;
    void act(o.id, 'void_label');
  }
  async function pickedUp(o: WebOrder) {
    if (!window.confirm(`Hand over ${o.title} (SKU ${o.sku})?\n\nCheck the customer's name (${o.buyer_name}) and order number ${o.order_no}.`)) return;
    setBusy(o.id + 'pickup'); setError('');
    const { error: e } = await client.rpc('mark_pickup_complete', { p_order: o.id });
    if (e) setError(e.message);
    await load(); setBusy(null);
  }
  function cancel(o: WebOrder) {
    const reason = window.prompt(`Cancel order ${o.order_no} and refund ${money(o.total_cents)} in full?\n\nThe sale is reversed and the unit goes back on sale everywhere.\n\nReason (optional):`, '');
    if (reason === null) return;
    void act(o.id, 'cancel_refund', { reason });
  }

  const groups = useMemo(() => {
    const list = orders || [];
    return {
      toShip: list.filter(o => o.status === 'paid' && o.fulfillment === 'ship' && !o.shipped_at),
      pickup: list.filter(o => o.status === 'paid' && o.fulfillment === 'pickup' && !o.picked_up_at),
      done: list.filter(o => o.status === 'paid' && (o.shipped_at || o.picked_up_at)),
      canceled: list.filter(o => o.status === 'refunded' || o.status === 'canceled'),
    };
  }, [orders]);

const head = (o: WebOrder) => <div className="ticket-top"><strong>{o.channel && o.channel !== 'website' ? `${o.channel} ` : ''}{o.order_no || 'Order'} · {money(o.total_cents)}</strong><span>{o.paid_at ? stamp(o.paid_at) : stamp(o.created_at)}{o.channel && o.channel !== 'website' && <b className="badge"> {o.channel.toUpperCase()}</b>}{o.payment_env === 'sandbox' && <b className="badge"> SANDBOX</b>}</span></div>;
  const item = (o: WebOrder) => <div className="ticket-items"><div>{o.title} <span>· SKU {o.sku}</span></div>
    <small>{o.buyer_name} · {o.buyer_email} · {o.buyer_phone}</small>
    <small>Item {money(o.item_cents)} · {o.fulfillment === 'ship' ? `Shipping ${money(o.shipping_cents)}${o.carrier ? ` (${o.carrier} ${o.service || ''})` : ''}${o.shipping_rate?.source === 'fallback' ? ' · flat-rate fallback' : ''}` : 'Store pickup'} · Tax {money(o.tax_cents)}</small></div>;

  return <>
    <header><div><div className="eyebrow">WEBSITE AND MARKETPLACES</div><h1>Orders</h1><p>Website and marketplace orders. Buy shipping labels here. Refreshes every 30 seconds.</p></div>
      <div className="actions"><button className="secondary" onClick={() => void load()}>Refresh</button></div></header>
    {error && <div className="alert" role="alert">{error}<button onClick={() => setError('')}>Dismiss</button></div>}
    <div className="stats"><div className="stat"><span>To ship</span><strong>{groups.toShip.length}</strong></div><div className="stat"><span>Awaiting pickup</span><strong>{groups.pickup.length}</strong></div><div className="stat"><span>Completed</span><strong>{groups.done.length}</strong></div><div className="stat"><span>Cancelled / refunded</span><strong>{groups.canceled.length}</strong></div></div>
    {orders === null && <p className="hint">Loading orders…</p>}
    {labelFor && <LabelDialog order={labelFor} accessToken={accessToken} money={money} onClose={() => setLabelFor(null)} onDone={() => void load()} />}

    <section className="panel"><h2>To ship</h2>{groups.toShip.length === 0 ? <div className="empty">Nothing to ship.</div> : <div className="ticket-list">{groups.toShip.map(o => <div className="ticket order" key={o.id}>{head(o)}{item(o)}
      <div className="order-address">{[o.buyer_name, o.ship_line1, o.ship_line2, [o.ship_city, o.ship_region, o.ship_postal].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}</div>
      <small>Package {o.package.length_in ?? '?'}×{o.package.width_in ?? '?'}×{o.package.height_in ?? '?'} in · {o.package.weight_lb ?? '?'} lb</small>
      {o.tracking_number && <div className="order-tracking">Tracking {o.carrier} {o.tracking_number}{o.tracking_url && <> · <a href={o.tracking_url} target="_blank" rel="noreferrer">track</a></>}{o.label_url && <> · <a href={o.label_url} target="_blank" rel="noreferrer">Print label</a></>}{o.label_cost_cents != null && ` · label cost ${money(o.label_cost_cents)}`}</div>}
      {o.refund_requested_at ? <p className="hint">Cancel & refund in progress…</p> : <div className="actions">
        {!o.label_url ? <button disabled={!!busy} onClick={() => setLabelFor(o)}>Buy label…</button>
          : <><button className="secondary" onClick={() => window.open(o.label_url!, '_blank', 'noopener')}>Print label</button>
            <button className="text-button danger" disabled={!!busy} onClick={() => voidLabel(o)}>{busy === o.id + 'void_label' ? 'Voiding…' : 'Void label'}</button></>}
        <button className="secondary" disabled={!!busy || !o.tracking_number} onClick={() => void act(o.id, 'mark_shipped')}>Mark shipped</button>
        {(!o.channel || o.channel === 'website') && <button className="text-button danger" disabled={!!busy} onClick={() => cancel(o)}>Cancel & refund</button>}</div>}
    </div>)}</div>}</section>

    <section className="panel"><h2>Awaiting pickup</h2>{groups.pickup.length === 0 ? <div className="empty">No pickups waiting.</div> : <div className="ticket-list">{groups.pickup.map(o => <div className="ticket order" key={o.id}>{head(o)}{item(o)}
      <div className={`countdown${o.pickup_deadline && new Date(o.pickup_deadline).getTime() - now < 86400000 ? ' urgent' : ''}`}>Pick up by {o.pickup_deadline ? stamp(o.pickup_deadline) : '—'} · {timeLeft(o.pickup_deadline, now)}</div>
      {o.refund_requested_at ? <p className="hint">Cancel & refund in progress…</p> : <div className="actions">
        <button disabled={!!busy} onClick={() => void pickedUp(o)}>Picked up</button>
        <button className="text-button danger" disabled={!!busy} onClick={() => cancel(o)}>Cancel & refund</button></div>}
    </div>)}</div>}</section>

    <section className="panel"><h2>Completed</h2>{groups.done.length === 0 ? <div className="empty">No completed orders yet.</div> : <div className="ticket-list">{groups.done.map(o => <div className="ticket order" key={o.id}>{head(o)}{item(o)}
      <small>{o.picked_up_at ? `Picked up ${stamp(o.picked_up_at)} · ${o.picked_up_by || ''}` : `Shipped ${stamp(o.shipped_at!)} · ${o.carrier || ''} ${o.tracking_number || ''}`}</small></div>)}</div>}</section>

    <section className="panel"><h2>Cancelled / refunded</h2>{groups.canceled.length === 0 ? <div className="empty">None.</div> : <div className="ticket-list">{groups.canceled.map(o => <div className="ticket order" key={o.id}>{head(o)}{item(o)}
      <small>{o.cancel_source === 'pickup_expired' ? 'Not picked up by the deadline' : o.cancel_source === 'admin' ? `Canceled in admin${o.cancel_reason ? `: ${o.cancel_reason}` : ''}` : 'Could not complete; refunded automatically'}{o.canceled_at ? ` · ${stamp(o.canceled_at)}` : ''}</small></div>)}</div>}</section>
  </>;
}
