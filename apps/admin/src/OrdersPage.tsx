import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

const CHANNEL_LABEL: Record<string, string> = {
  website: 'Website',
  ebay: 'eBay',
  whatnot: 'Whatnot',
  depop: 'Depop',
  mercari: 'Mercari',
  vendoo: 'Vendoo',
  facebook: 'Facebook',
  poshmark: 'Poshmark',
  etsy: 'Etsy',
  other: 'Other',
};

export type WebOrder = {
  id: string; order_no: string | null; sku: string; title: string; status: string; fulfillment: 'ship' | 'pickup'; channel?: string;
  buyer_name: string | null; buyer_email: string | null; buyer_phone: string | null;
  ship_line1: string | null; ship_line2: string | null; ship_city: string | null; ship_region: string | null; ship_postal: string | null;
  item_cents: number; shipping_cents: number; tax_cents: number; total_cents: number; payment_env: string | null;
  created_at: string; paid_at: string | null; pickup_deadline: string | null; picked_up_at: string | null; picked_up_by: string | null;
  shipped_at: string | null; delivered_at: string | null;
  tracking_number: string | null; tracking_url: string | null; carrier: string | null; service: string | null;
  label_url: string | null; label_purchased_at: string | null; label_cost_cents: number | null;
  refund_requested_at: string | null; cancel_source: string | null; cancel_reason: string | null; canceled_at: string | null;
  shipping_rate: { source?: string; days?: number | null } | null;
  package: { length_in: number | null; width_in: number | null; height_in: number | null; weight_lb: number | null };
  match_status?: string | null;
  marketplace_fee_cents?: number | null;
  fee_cents?: number | null;
  marketplace_url?: string | null;
  listed_on?: string[] | null;
};
type Props = { client: SupabaseClient; accessToken: string; money: (n: number) => string; stamp: (s: string) => string };

function timeLeft(deadline: string | null, now: number) {
  if (!deadline) return '';
  const ms = new Date(deadline).getTime() - now;
  if (ms <= 0) return 'Deadline passed — auto-cancel pending';
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h left` : `${h}h ${m}m left`;
}

function channelLabel(channel?: string | null) {
  if (!channel) return 'Website';
  return CHANNEL_LABEL[channel.toLowerCase()] || channel;
}

function otherStores(o: WebOrder) {
  const listed = (o.listed_on || []).map((x) => x.toLowerCase()).filter(Boolean);
  const self = (o.channel || '').toLowerCase();
  return listed.filter((c) => c !== self && c !== 'website' && c !== 'ebay');
}

type OrderView = 'toShip' | 'shipped' | 'pickup' | 'done' | 'canceled';

const VIEW_LABEL: Record<OrderView, string> = {
  toShip: 'To ship',
  shipped: 'Shipped',
  pickup: 'Awaiting pickup',
  done: 'Completed',
  canceled: 'Cancelled / refunded',
};

function orderFee(o: WebOrder) {
  return o.fee_cents ?? o.marketplace_fee_cents ?? 0;
}

function breakdown(rows: WebOrder[]) {
  const byChannel = new Map<string, { count: number; item: number; fees: number; ship: number; tax: number; total: number }>();
  let item = 0, fees = 0, ship = 0, tax = 0, total = 0;
  for (const o of rows) {
    const ch = (o.channel || 'website').toLowerCase();
    const cur = byChannel.get(ch) || { count: 0, item: 0, fees: 0, ship: 0, tax: 0, total: 0 };
    const f = orderFee(o);
    cur.count += 1;
    cur.item += o.item_cents;
    cur.fees += f;
    cur.ship += o.shipping_cents;
    cur.tax += o.tax_cents;
    cur.total += o.total_cents;
    byChannel.set(ch, cur);
    item += o.item_cents; fees += f; ship += o.shipping_cents; tax += o.tax_cents; total += o.total_cents;
  }
  return {
    channels: [...byChannel.entries()].map(([channel, v]) => ({ channel, ...v })).sort((a, b) => b.total - a.total),
    totals: { count: rows.length, item, fees, ship, tax, total },
  };
}

export function OrdersPage({ client, accessToken, money, stamp }: Props) {
  const [orders, setOrders] = useState<WebOrder[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [view, setView] = useState<OrderView>('toShip');

  const load = useCallback(async () => {
    const { data, error: e } = await client.rpc('portal_web_orders', { p_days: 120 });
    if (e) { setError(e.message); return; }
    setOrders(data as WebOrder[]);
  }, [client]);
  useEffect(() => { void load(); const t = setInterval(() => { void load(); }, 30000); return () => clearInterval(t); }, [load]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(t); }, []);

  async function markShipped(o: WebOrder) {
    setBusy(o.id + 'ship'); setError('');
    const { error: e } = await client.rpc('portal_mark_order_shipped', { p_order: o.id });
    if (e) setError(e.message);
    await load(); setBusy(null);
  }
  async function markDelivered(o: WebOrder) {
    setBusy(o.id + 'deliver'); setError('');
    const { error: e } = await client.rpc('portal_mark_order_delivered', { p_order: o.id });
    if (e) setError(e.message);
    await load(); setBusy(null);
  }
  async function pickedUp(o: WebOrder) {
    if (!window.confirm(`Hand over ${o.title} (SKU ${o.sku})?\n\nCheck the customer's name (${o.buyer_name}) and order number ${o.order_no}.`)) return;
    setBusy(o.id + 'pickup'); setError('');
    const { error: e } = await client.rpc('mark_pickup_complete', { p_order: o.id });
    if (e) setError(e.message);
    await load(); setBusy(null);
  }
  async function cancel(o: WebOrder) {
    const reason = window.prompt(`Cancel order ${o.order_no} and refund ${money(o.total_cents)} in full?\n\nThe sale is reversed and the unit goes back on sale everywhere.\n\nReason (optional):`, '');
    if (reason === null) return;
    setBusy(o.id + 'cancel'); setError('');
    try {
      const functionsBase = (import.meta.env.VITE_FLOOR_FUNCTIONS_URL || 'https://inventoryobi.netlify.app').replace(/\/$/, '');
      const res = await fetch(`${functionsBase}/.netlify/functions/web-order-admin`, {
        method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel_refund', id: o.id, reason }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) throw new Error(body.error || `Request failed (${res.status})`);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }
  async function matchSku(o: WebOrder) {
    const sku = window.prompt(`Link this ${channelLabel(o.channel)} order to a Floor SKU.\n\nOrder ${o.order_no || o.id}`, o.sku === 'UNMATCHED' ? '' : o.sku);
    if (sku == null || !sku.trim()) return;
    setBusy(o.id + 'match'); setError('');
    const { error: e } = await client.rpc('portal_match_web_order', { p_order: o.id, p_sku: sku.trim() });
    if (e) setError(e.message);
    else await load();
    setBusy(null);
  }
  async function recordLabelCost(o: WebOrder) {
    const current = o.label_cost_cents != null ? (o.label_cost_cents / 100).toFixed(2) : '';
    const raw = window.prompt(
      `Label cost for ${channelLabel(o.channel)} order ${o.order_no || o.id} (USD).\n\nUse this for Pirate Ship, USPS, eBay labels, Depop, Mercari, Whatnot, Vendoo — whatever you paid to ship.`,
      current,
    );
    if (raw == null) return;
    const cents = Math.round(Number(String(raw).replace(/[$,\s]/g, '')) * 100);
    if (!Number.isFinite(cents) || cents < 0 || cents > 50000) {
      setError('Enter a valid label cost between $0 and $500.');
      return;
    }
    setBusy(o.id + 'label'); setError('');
    const { error: e } = await client.rpc('portal_set_order_label_cost', { p_order: o.id, p_label_cents: cents });
    if (e) setError(e.message);
    else await load();
    setBusy(null);
  }

  const groups = useMemo(() => {
    // Sandbox / test rows are not real customer orders — keep them out of the counts.
    const list = (orders || []).filter(o => o.payment_env !== 'sandbox' && !(o.order_no || '').toLowerCase().startsWith('sandbox'));
    return {
      toShip: list.filter(o => o.status === 'paid' && o.fulfillment === 'ship' && !o.shipped_at),
      shipped: list.filter(o => o.status === 'paid' && o.fulfillment === 'ship' && o.shipped_at && !o.delivered_at),
      pickup: list.filter(o => o.status === 'paid' && o.fulfillment === 'pickup' && !o.picked_up_at),
      done: list.filter(o => o.status === 'paid' && (o.delivered_at || o.picked_up_at)),
      canceled: list.filter(o => o.status === 'refunded' || o.status === 'canceled'),
    };
  }, [orders]);

  const active = groups[view];
  const summary = useMemo(() => breakdown(groups[view]), [groups, view]);

  const head = (o: WebOrder) => <div className="ticket-top"><strong>{channelLabel(o.channel)} {o.marketplace_url && o.order_no ? <a href={o.marketplace_url} target="_blank" rel="noreferrer">{o.order_no}</a> : (o.order_no || 'Order')} · {money(o.total_cents)}</strong><span>{o.paid_at ? stamp(o.paid_at) : stamp(o.created_at)}<b className="badge"> {channelLabel(o.channel).toUpperCase()}</b>{o.match_status && o.match_status !== 'matched' && <b className="badge"> UNMATCHED</b>}</span></div>;
  const item = (o: WebOrder) => <div className="ticket-items"><div>{o.title} <span>· SKU {o.sku}</span></div>
    <small>{o.buyer_name}{o.buyer_email ? ` · ${o.buyer_email}` : ''}{o.buyer_phone ? ` · ${o.buyer_phone}` : ''}</small>
    <small>Item {money(o.item_cents)}{orderFee(o) ? ` · Fees ${money(orderFee(o))}` : ''} · {o.fulfillment === 'ship' ? `Buyer ship ${money(o.shipping_cents)}` : 'Store pickup'}{o.fulfillment === 'ship' ? ` · Label ${o.label_cost_cents != null ? money(o.label_cost_cents) : '—'}` : ''} · Tax {money(o.tax_cents)}</small>
    {otherStores(o).length > 0 && <div className="alert" role="status">Pull from other stores: still marked live on {otherStores(o).map(channelLabel).join(', ')}. End those listings in Vendoo / each app.</div>}
    {(o.match_status === 'unmatched' || o.match_status === 'already_sold') && <div className="alert" role="status">This sale is in Orders but not linked to an available Floor unit. <button className="secondary" disabled={!!busy} onClick={() => void matchSku(o)}>Link SKU…</button></div>}
  </div>;

  function selectView(next: OrderView) {
    setView(next);
  }

  return <>
    <header><div><div className="eyebrow">WEBSITE AND MARKETPLACES</div><h1>Orders</h1><p>Internal ship / deliver status for inventory. Click a card for that breakdown. No customer emails. Refreshes every 30 seconds.</p></div>
      <div className="actions"><button className="secondary" onClick={() => void load()}>Refresh</button></div></header>
    {error && <div className="alert" role="alert">{error}<button onClick={() => setError('')}>Dismiss</button></div>}
    <div className="stats">
      {([
        ['toShip', groups.toShip.length],
        ['shipped', groups.shipped.length],
        ['pickup', groups.pickup.length],
        ['done', groups.done.length],
        ['canceled', groups.canceled.length],
      ] as const).map(([key, count]) => (
        <button key={key} type="button" className={`stat stat-button${view === key ? ' active' : ''}`} onClick={() => selectView(key)}>
          <span>{VIEW_LABEL[key]}</span><strong>{count}</strong><small>View details</small>
        </button>
      ))}
    </div>
    {orders === null && <p className="hint">Loading orders…</p>}

    <section className="panel drilldown" aria-live="polite">
      <div className="section-head">
        <div>
          <div className="eyebrow">BREAKDOWN</div>
          <h2>{VIEW_LABEL[view]} · {summary.totals.count} order{summary.totals.count === 1 ? '' : 's'} · {money(summary.totals.total)}</h2>
        </div>
      </div>
      {summary.totals.count > 0 && (
        <div className="table-wrap" style={{ marginBottom: 16 }}>
          <table>
            <thead>
              <tr><th>Channel</th><th>Orders</th><th>Item</th><th>Fees</th><th>Shipping</th><th>Tax</th><th>Total</th></tr>
            </thead>
            <tbody>
              {summary.channels.map(row => (
                <tr key={row.channel}>
                  <td>{channelLabel(row.channel)}</td>
                  <td>{row.count}</td>
                  <td>{money(row.item)}</td>
                  <td>{money(row.fees)}</td>
                  <td>{money(row.ship)}</td>
                  <td>{money(row.tax)}</td>
                  <td>{money(row.total)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Total</td>
                <td>{summary.totals.count}</td>
                <td>{money(summary.totals.item)}</td>
                <td>{money(summary.totals.fees)}</td>
                <td>{money(summary.totals.ship)}</td>
                <td>{money(summary.totals.tax)}</td>
                <td>{money(summary.totals.total)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {view === 'toShip' && (active.length === 0 ? <div className="empty">Nothing to ship.</div> : <div className="ticket-list">{active.map(o => <div className="ticket order" key={o.id}>{head(o)}{item(o)}
        <div className="order-address">{[o.buyer_name, o.ship_line1, o.ship_line2, [o.ship_city, o.ship_region, o.ship_postal].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}</div>
        {o.refund_requested_at ? <p className="hint">Cancel & refund in progress…</p> : <div className="actions">
          <button disabled={!!busy} onClick={() => void markShipped(o)}>{busy === o.id + 'ship' ? 'Saving…' : 'Mark shipped'}</button>
          <button className="secondary" disabled={!!busy} onClick={() => void markDelivered(o)}>{busy === o.id + 'deliver' ? 'Saving…' : 'Mark delivered'}</button>
          <button className="secondary" disabled={!!busy} onClick={() => void recordLabelCost(o)}>{busy === o.id + 'label' ? 'Saving…' : o.label_cost_cents != null ? 'Edit label cost' : 'Record label cost'}</button>
          {(!o.channel || o.channel === 'website') && <button className="text-button danger" disabled={!!busy} onClick={() => void cancel(o)}>Cancel & refund</button>}
        </div>}
      </div>)}</div>)}

      {view === 'shipped' && (active.length === 0 ? <div className="empty">None in transit.</div> : <div className="ticket-list">{active.map(o => <div className="ticket order" key={o.id}>{head(o)}{item(o)}
        <small>Shipped {stamp(o.shipped_at!)}</small>
        {o.refund_requested_at ? <p className="hint">Cancel & refund in progress…</p> : <div className="actions">
          <button disabled={!!busy} onClick={() => void markDelivered(o)}>{busy === o.id + 'deliver' ? 'Saving…' : 'Mark delivered'}</button>
          <button className="secondary" disabled={!!busy} onClick={() => void recordLabelCost(o)}>{busy === o.id + 'label' ? 'Saving…' : o.label_cost_cents != null ? 'Edit label cost' : 'Record label cost'}</button>
          {(!o.channel || o.channel === 'website') && <button className="text-button danger" disabled={!!busy} onClick={() => void cancel(o)}>Cancel & refund</button>}
        </div>}
      </div>)}</div>)}

      {view === 'pickup' && (active.length === 0 ? <div className="empty">No pickups waiting.</div> : <div className="ticket-list">{active.map(o => <div className="ticket order" key={o.id}>{head(o)}{item(o)}
        <div className={`countdown${o.pickup_deadline && new Date(o.pickup_deadline).getTime() - now < 86400000 ? ' urgent' : ''}`}>Pick up by {o.pickup_deadline ? stamp(o.pickup_deadline) : '—'} · {timeLeft(o.pickup_deadline, now)}</div>
        {o.refund_requested_at ? <p className="hint">Cancel & refund in progress…</p> : <div className="actions">
          <button disabled={!!busy} onClick={() => void pickedUp(o)}>Picked up</button>
          <button className="text-button danger" disabled={!!busy} onClick={() => void cancel(o)}>Cancel & refund</button></div>}
      </div>)}</div>)}

      {view === 'done' && (active.length === 0 ? <div className="empty">No completed orders yet.</div> : <div className="ticket-list">{active.map(o => <div className="ticket order" key={o.id}>{head(o)}{item(o)}
        <small>{o.picked_up_at ? `Picked up ${stamp(o.picked_up_at)} · ${o.picked_up_by || ''}` : `Delivered ${stamp(o.delivered_at!)}${o.shipped_at ? ` · shipped ${stamp(o.shipped_at)}` : ''}`}</small></div>)}</div>)}

      {view === 'canceled' && (active.length === 0 ? <div className="empty">None.</div> : <div className="ticket-list">{active.map(o => <div className="ticket order" key={o.id}>{head(o)}{item(o)}
        <small>{o.cancel_source === 'pickup_expired' ? 'Not picked up by the deadline' : o.cancel_source === 'admin' ? `Canceled in admin${o.cancel_reason ? `: ${o.cancel_reason}` : ''}` : o.cancel_source === 'ebay_api' ? `Canceled on eBay${o.cancel_reason ? `: ${o.cancel_reason}` : ''}` : o.status === 'refunded' ? 'Refunded' : o.status === 'canceled' ? `Canceled${o.cancel_reason ? `: ${o.cancel_reason}` : ''}` : 'Could not complete; refunded automatically'}{o.canceled_at ? ` · ${stamp(o.canceled_at)}` : ''}</small></div>)}</div>)}
    </section>
  </>;
}
