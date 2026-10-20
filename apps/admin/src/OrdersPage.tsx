import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { floorFunctionUrl } from './floorApi';
import { CommissionOverrideControls, CommissionOverrideMark } from './CommissionOverride';
import { type CommissionOverride, type OnlineCfg, type Rule } from './payouts';
import { ReturnsPage } from './ReturnsPage';

const CHANNEL_LABEL: Record<string, string> = {
  website: 'Website',
  ebay: 'eBay',
  amazon: 'Amazon',
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
  pack_condition?: 'ok' | 'not_as_listed' | null;
  pack_proof_photo_path?: string | null;
  pack_proof_serial?: string | null;
  pack_proof_at?: string | null;
  refund_requested_at: string | null; cancel_source: string | null; cancel_reason: string | null; canceled_at: string | null;
  shipping_rate: { source?: string; days?: number | null } | null;
  package: { length_in: number | null; width_in: number | null; height_in: number | null; weight_lb: number | null };
  match_status?: string | null;
  marketplace_title?: string | null;
  marketplace_fee_cents?: number | null;
  fee_cents?: number | null;
  marketplace_url?: string | null;
  listed_on?: string[] | null;
  sale_id?: number | null;
  ticket_key?: string | null;
  cost_cents?: number | null;
  profit_cents?: number | null;
};
type Props = {
  client: SupabaseClient; accessToken: string; storeId: string; money: (n: number) => string; stamp: (s: string) => string;
  rules: Rule[]; cfg: OnlineCfg; commissionOverrides: Map<string, CommissionOverride>;
  personName: (id: string) => string; busy: boolean;
  onCommissionChanged: (ticketKey: string, next: CommissionOverride | null) => void;
};

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

type OrderView = 'all' | 'toShip' | 'shipped' | 'pickup' | 'done' | 'canceled';
type StatusFilter = 'all' | 'paid' | 'canceled' | 'refunded';
type OrdersSection = 'orders' | 'returns';

const VIEW_LABEL: Record<OrderView, string> = {
  all: 'All orders',
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

export function OrdersPage({ client, accessToken, storeId, money, stamp, rules, cfg, commissionOverrides, personName, busy: parentBusy, onCommissionChanged }: Props) {
  const [orders, setOrders] = useState<WebOrder[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [view, setView] = useState<OrderView>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [section, setSection] = useState<OrdersSection>('orders');

  const load = useCallback(async () => {
    // No practical date hide: cover store day-one history (portal still clamps to p_days).
    const { data, error: e } = await client.rpc('portal_web_orders', { p_days: 400 });
    if (e) { setError(e.message); return; }
    setOrders(data as WebOrder[]);
  }, [client]);
  useEffect(() => { void load(); const t = setInterval(() => { void load(); }, 30000); return () => clearInterval(t); }, [load]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(t); }, []);

  async function markShipped(o: WebOrder) {
    const ch = (o.channel || '').toLowerCase();
    if ((ch === 'amazon' || ch === 'tiktok') && !o.pack_proof_photo_path) {
      setError('Amazon/TikTok orders need a pack-time unit photo (and serial if any) before Mark shipped.');
      return;
    }
    setBusy(o.id + 'ship'); setError('');
    const { error: e } = await client.rpc('portal_mark_order_shipped', { p_order: o.id });
    if (e) setError(e.message === 'pack_proof_required'
      ? 'Upload a pack-time photo of the actual unit before marking shipped.'
      : e.message);
    await load(); setBusy(null);
  }

  async function uploadPackProof(o: WebOrder, file: File) {
    if (!file.type.startsWith('image/')) {
      setError('Choose an image for pack proof.');
      return;
    }
    setBusy(o.id + 'proof'); setError('');
    try {
      const serial = window.prompt('Serial number (optional — leave blank if none):', o.pack_proof_serial || '') ?? '';
      const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_') || 'pack.jpg';
      const path = `${storeId}/${o.sku}/pack-proof/${Date.now()}-${crypto.randomUUID()}-${safe}`;
      const upload = await client.storage.from('unit-photos').upload(path, file, {
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
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
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
      const res = await fetch(floorFunctionUrl('web-order-admin'), {
        method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel_refund', id: o.id, reason }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) throw new Error(body.error || `Request failed (${res.status})`);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }
  async function deleteOrder(o: WebOrder) {
    const live = o.status === 'paid';
    const ok = window.confirm(
      `Delete ${channelLabel(o.channel)} order ${o.order_no || o.id} (SKU ${o.sku}) from Orders?\n\n` +
      (live
        ? 'This removes it from Orders and reverses the Floor sale (unit goes available again).\nIt does NOT refund the buyer on eBay / Amazon / Depop / Mercari / Square.'
        : 'This only removes the row from Orders. It does not refund anyone.') +
      '\n\nThis cannot be undone from the UI.',
    );
    if (!ok) return;
    setBusy(o.id + 'delete'); setError('');
    try {
      const res = await fetch(floorFunctionUrl('web-order-admin'), {
        method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete_order', id: o.id }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) throw new Error(body.error || `Request failed (${res.status})`);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }
  async function matchSku(o: WebOrder) {
    setBusy(o.id + 'match'); setError('');
    let hint = '';
    try {
      const { data: suggestions } = await client.rpc('portal_suggest_order_skus', { p_order: o.id, p_limit: 5 });
      const list = Array.isArray(suggestions) ? suggestions : [];
      if (list.length) {
        hint =
          '\n\nSuggested (listed on this channel · title/price):\n' +
          list
            .map(
              (s: { sku?: string; title?: string; ask_cents?: number; score?: number }) =>
                `  ${s.sku} · ${s.title || 'untitled'} · ${money(Number(s.ask_cents || 0))} (score ${s.score ?? '?'})`,
            )
            .join('\n');
      }
    } catch {
      /* suggestions optional */
    }
    if (!(Number(o.item_cents) > 0)) {
      setError('This order has no sale price, so it cannot be linked to a Floor SKU. It is probably a promo/reminder email — ignore it or wait for the real sale confirmation.');
      setBusy(null);
      return;
    }
    const sku = window.prompt(
      `Needs SKU match — link this ${channelLabel(o.channel)} order to a Floor SKU.\n\n` +
        `${o.marketplace_title || o.title || 'Sale'} · ${money(o.item_cents)}\n` +
        `Buyer: ${o.buyer_name || '—'}\n` +
        `Order ${o.order_no || o.id}` +
        hint +
        '\n\nEnter SKU:',
      o.sku === 'UNMATCHED' ? '' : o.sku,
    );
    if (sku == null || !sku.trim()) {
      setBusy(null);
      return;
    }
    const { error: e } = await client.rpc('portal_match_web_order', { p_order: o.id, p_sku: sku.trim() });
    if (e) setError(e.message === 'sale_price_required' ? 'Cannot link a $0 order. Use a real sale confirmation with a price.' : e.message);
    else await load();
    setBusy(null);
  }
  async function setPackCondition(o: WebOrder, status: 'ok' | 'not_as_listed') {
    setBusy(o.id + 'pack'); setError('');
    try {
      const res = await fetch(floorFunctionUrl('web-order-admin'), {
        method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'pack_condition', id: o.id, status }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) {
        const { error: rpcErr } = await client.rpc('portal_set_pack_condition', { p_order: o.id, p_status: status });
        if (rpcErr) throw new Error(body.error || rpcErr.message);
      }
      if (status === 'not_as_listed') setError(`SKU ${o.sku} marked not as listed. The owner is alerted. Do not buy a label.`);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }
  async function recordLabelCost(o: WebOrder) {
    if (o.pack_condition !== 'ok') {
      setError('Confirm the item matches the listing before recording a label cost.');
      return;
    }
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

  const { groups, rawCount } = useMemo(() => {
    // Sandbox / test rows are not real customer orders — keep them out of the counts.
    const list = (orders || []).filter(o => o.payment_env !== 'sandbox' && !(o.order_no || '').toLowerCase().startsWith('sandbox'));
    const byStatus = statusFilter === 'all'
      ? list
      : list.filter(o => o.status === statusFilter);
    return {
      rawCount: list.length,
      groups: {
        all: byStatus,
        toShip: byStatus.filter(o => o.status === 'paid' && o.fulfillment === 'ship' && !o.shipped_at),
        shipped: byStatus.filter(o => o.status === 'paid' && o.fulfillment === 'ship' && o.shipped_at && !o.delivered_at),
        pickup: byStatus.filter(o => o.status === 'paid' && o.fulfillment === 'pickup' && !o.picked_up_at),
        done: byStatus.filter(o => o.status === 'paid' && (o.delivered_at || o.picked_up_at)),
        canceled: byStatus.filter(o => o.status === 'refunded' || o.status === 'canceled'),
      } as Record<OrderView, WebOrder[]>,
    };
  }, [orders, statusFilter]);

  const active = groups[view];
  const summary = useMemo(() => breakdown(groups[view]), [groups, view]);

  const head = (o: WebOrder) => {
    const ov = o.ticket_key ? commissionOverrides.get(o.ticket_key) : null;
    const needsSku = o.match_status && o.match_status !== 'matched';
    return <div className="ticket-top"><strong>{channelLabel(o.channel)} {o.marketplace_url && o.order_no ? <a href={o.marketplace_url} target="_blank" rel="noreferrer">{o.order_no}</a> : (o.order_no || 'Order')} · {money(o.total_cents)}{ov ? <small className="ticket-profit"> · split overridden</small> : null}</strong><span>{o.paid_at ? stamp(o.paid_at) : stamp(o.created_at)}<b className="badge"> {channelLabel(o.channel).toUpperCase()}</b>{ov && <b className="badge badge-override"> SPLIT</b>}{needsSku && <b className="badge"> Needs SKU match</b>}</span></div>;
  };
  const item = (o: WebOrder) => {
    const ov = o.ticket_key ? commissionOverrides.get(o.ticket_key) || null : null;
    const ticketLike = {
      subtotal: o.item_cents,
      cost: o.cost_cents ?? null,
      channel: (o.channel || 'website').toLowerCase(),
      shippingCents: o.shipping_cents || 0,
      commissionOverride: ov,
      lines: [{ sku: o.sku, price_cents: o.item_cents, cost_cents: o.cost_cents ?? null }],
    };
    const canOverride = !!o.ticket_key && (o.status === 'paid' || !!o.paid_at);
    // Matched: Floor unit title. Unmatched: email/listing title until Link SKU.
    const linked = o.match_status === 'matched' || (!!o.sku && o.sku !== 'UNMATCHED' && !!o.sale_id);
    const displayTitle = linked
      ? (o.title || o.marketplace_title || 'Item')
      : (o.marketplace_title || o.title || 'Marketplace sale');
    const skuLabel = linked ? `SKU ${o.sku}` : 'Needs SKU match';
    return <div className="ticket-items"><div>{displayTitle} <span>· {skuLabel}</span></div>
    <small>{o.buyer_name}{o.buyer_email ? ` · ${o.buyer_email}` : ''}{o.buyer_phone ? ` · ${o.buyer_phone}` : ''}</small>
    <small>Item {money(o.item_cents)}{orderFee(o) ? ` · Fees ${money(orderFee(o))}` : ''} · {o.fulfillment === 'ship' ? `Buyer ship ${money(o.shipping_cents)}` : 'Store pickup'}{o.fulfillment === 'ship' ? ` · Label ${o.label_cost_cents != null ? money(o.label_cost_cents) : '—'}` : ''} · Tax {money(o.tax_cents)}</small>
    <CommissionOverrideMark overridden={!!ov} />
    {canOverride && o.ticket_key && (
      <CommissionOverrideControls
        client={client}
        ticketKey={o.ticket_key}
        ticket={ticketLike}
        rules={rules}
        cfg={cfg}
        override={ov}
        personName={personName}
        stamp={stamp}
        money={money}
        busy={!!busy || parentBusy}
        onChanged={next => onCommissionChanged(o.ticket_key!, next)}
      />
    )}
    {otherStores(o).length > 0 && <div className="alert" role="status">Pull from other stores: still marked live on {otherStores(o).map(channelLabel).join(', ')}. End those listings in Vendoo / each app.</div>}
    {(o.match_status === 'unmatched' || o.match_status === 'already_sold') && <div className="alert" role="status">Needs SKU match — sale is in Orders but not linked to a Floor unit yet. <button className="secondary" disabled={!!busy} onClick={() => void matchSku(o)}>Link SKU…</button></div>}
  </div>;
  };

  function selectView(next: OrderView) {
    setView(next);
  }

  const renderTicket = (o: WebOrder) => {
    const isCanceled = o.status === 'canceled' || o.status === 'refunded';
    const isToShip = o.status === 'paid' && o.fulfillment === 'ship' && !o.shipped_at;
    const isShipped = o.status === 'paid' && o.fulfillment === 'ship' && !!o.shipped_at && !o.delivered_at;
    const isPickup = o.status === 'paid' && o.fulfillment === 'pickup' && !o.picked_up_at;
    const isDone = o.status === 'paid' && !!(o.delivered_at || o.picked_up_at);
    return (
      <div className="ticket order" key={o.id}>
        {head(o)}{item(o)}
        {isToShip && (
          <>
            <div className="order-address">{[o.buyer_name, o.ship_line1, o.ship_line2, [o.ship_city, o.ship_region, o.ship_postal].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}</div>
            {o.refund_requested_at ? <p className="hint">Cancel & refund in progress…</p> : <>
            <div className="actions">
              <span className="hint">Condition OK?</span>
              <button className={o.pack_condition === 'ok' ? '' : 'secondary'} disabled={!!busy} onClick={() => void setPackCondition(o, 'ok')}>{busy === o.id + 'pack' ? 'Saving…' : 'OK'}</button>
              <button className="secondary" disabled={!!busy} onClick={() => void setPackCondition(o, 'not_as_listed')}>Not as listed</button>
            </div>
            {o.pack_condition === 'not_as_listed' && <div className="alert" role="alert">Not as listed. The owner is alerted. Do not buy a label.</div>}
            {o.pack_condition !== 'ok' && o.pack_condition !== 'not_as_listed' && <p className="hint">Check the item against the listing before a label is bought.</p>}
            {((o.channel || '').toLowerCase() === 'amazon' || (o.channel || '').toLowerCase() === 'tiktok') && (
              <div className="actions">
                <span className="hint">Pack proof (required)</span>
                <label className="secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '10px 14px', border: '1px solid var(--btn-border)', borderRadius: 8, cursor: 'pointer' }}>
                  {busy === o.id + 'proof' ? 'Uploading…' : o.pack_proof_photo_path ? 'Replace unit photo' : 'Photo of unit'}
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    hidden
                    disabled={!!busy}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void uploadPackProof(o, f);
                      e.target.value = '';
                    }}
                  />
                </label>
                {o.pack_proof_at && <small className="ok-text">Proof saved {stamp(o.pack_proof_at)}{o.pack_proof_serial ? ` · S/N ${o.pack_proof_serial}` : ''}</small>}
              </div>
            )}
            <div className="actions">
              <button disabled={!!busy} onClick={() => void markShipped(o)}>{busy === o.id + 'ship' ? 'Saving…' : 'Mark shipped'}</button>
              <button className="secondary" disabled={!!busy} onClick={() => void markDelivered(o)}>{busy === o.id + 'deliver' ? 'Saving…' : 'Mark delivered'}</button>
              <button className="secondary" disabled={!!busy || (o.label_cost_cents == null && o.pack_condition !== 'ok')} onClick={() => void recordLabelCost(o)}>{busy === o.id + 'label' ? 'Saving…' : o.label_cost_cents != null ? 'Edit label cost' : 'Record label cost'}</button>
              {(!o.channel || o.channel === 'website') && <button className="text-button danger" disabled={!!busy} onClick={() => void cancel(o)}>Cancel & refund</button>}
              <button className="text-button danger" disabled={!!busy} onClick={() => void deleteOrder(o)}>{busy === o.id + 'delete' ? 'Deleting…' : 'Delete'}</button>
            </div></>}
          </>
        )}
        {isShipped && (
          <>
            <small>Shipped {stamp(o.shipped_at!)}</small>
            {o.refund_requested_at ? <p className="hint">Cancel & refund in progress…</p> : <div className="actions">
              <button disabled={!!busy} onClick={() => void markDelivered(o)}>{busy === o.id + 'deliver' ? 'Saving…' : 'Mark delivered'}</button>
              <button className="secondary" disabled={!!busy} onClick={() => void recordLabelCost(o)}>{busy === o.id + 'label' ? 'Saving…' : o.label_cost_cents != null ? 'Edit label cost' : 'Record label cost'}</button>
              {(!o.channel || o.channel === 'website') && <button className="text-button danger" disabled={!!busy} onClick={() => void cancel(o)}>Cancel & refund</button>}
              <button className="text-button danger" disabled={!!busy} onClick={() => void deleteOrder(o)}>{busy === o.id + 'delete' ? 'Deleting…' : 'Delete'}</button>
            </div>}
          </>
        )}
        {isPickup && (
          <>
            <div className={`countdown${o.pickup_deadline && new Date(o.pickup_deadline).getTime() - now < 86400000 ? ' urgent' : ''}`}>Pick up by {o.pickup_deadline ? stamp(o.pickup_deadline) : '—'} · {timeLeft(o.pickup_deadline, now)}</div>
            {o.refund_requested_at ? <p className="hint">Cancel & refund in progress…</p> : <div className="actions">
              <button disabled={!!busy} onClick={() => void pickedUp(o)}>Picked up</button>
              <button className="text-button danger" disabled={!!busy} onClick={() => void cancel(o)}>Cancel & refund</button>
              <button className="text-button danger" disabled={!!busy} onClick={() => void deleteOrder(o)}>{busy === o.id + 'delete' ? 'Deleting…' : 'Delete'}</button>
            </div>}
          </>
        )}
        {isDone && (
          <>
            <small>{o.picked_up_at ? `Picked up ${stamp(o.picked_up_at)} · ${o.picked_up_by || ''}` : `Delivered ${stamp(o.delivered_at!)}${o.shipped_at ? ` · shipped ${stamp(o.shipped_at)}` : ''}`}</small>
            <div className="actions">
              <button className="text-button danger" disabled={!!busy} onClick={() => void deleteOrder(o)}>{busy === o.id + 'delete' ? 'Deleting…' : 'Delete'}</button>
            </div>
          </>
        )}
        {isCanceled && (
          <>
            <small>{o.cancel_source === 'pickup_expired' ? 'Not picked up by the deadline' : o.cancel_source === 'admin' ? `Canceled in admin${o.cancel_reason ? `: ${o.cancel_reason}` : ''}` : o.cancel_source === 'ebay_api' ? `Canceled on eBay${o.cancel_reason ? `: ${o.cancel_reason}` : ''}` : o.status === 'refunded' ? 'Refunded' : o.status === 'canceled' ? `Canceled${o.cancel_reason ? `: ${o.cancel_reason}` : ''}` : 'Could not complete; refunded automatically'}{o.canceled_at ? ` · ${stamp(o.canceled_at)}` : ''}</small>
            <div className="actions">
              <button className="text-button danger" disabled={!!busy} onClick={() => void deleteOrder(o)}>{busy === o.id + 'delete' ? 'Deleting…' : 'Delete'}</button>
            </div>
          </>
        )}
        {!isToShip && !isShipped && !isPickup && !isDone && !isCanceled && (
          <div className="actions">
            <button className="text-button danger" disabled={!!busy} onClick={() => void deleteOrder(o)}>{busy === o.id + 'delete' ? 'Deleting…' : 'Delete'}</button>
          </div>
        )}
      </div>
    );
  };

  return <>
    <header><div><div className="eyebrow">WEBSITE AND MARKETPLACES</div><h1>Orders</h1><p>Every online order since day one. Returns live under this page for garage scan/inspect. No customer emails. Refreshes every 30 seconds.</p></div>
      <div className="actions"><button className="secondary" onClick={() => void load()}>Refresh</button></div></header>
    <div className="inventory-tabs" role="tablist" aria-label="Orders sections">
      <button type="button" className={section === 'orders' ? 'active' : ''} onClick={() => setSection('orders')}>Fulfillment</button>
      <button type="button" className={section === 'returns' ? 'active' : ''} onClick={() => setSection('returns')}>Returns</button>
    </div>
    {section === 'returns' && <ReturnsPage client={client} storeId={storeId} money={money} stamp={stamp} />}
    {section === 'orders' && <>
    {error && <div className="alert" role="alert">{error}<button onClick={() => setError('')}>Dismiss</button></div>}
    <div className="stats">
      {([
        ['all', groups.all.length],
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
    <div className="actions" style={{ marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
      <label>Status{' '}
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)} aria-label="Order status filter">
          <option value="all">All statuses</option>
          <option value="paid">Paid</option>
          <option value="canceled">Canceled</option>
          <option value="refunded">Refunded</option>
        </select>
      </label>
      <span className="hint">{rawCount} loaded (no cancelled hide; 400-day window)</span>
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

      {active.length === 0
        ? <div className="empty">{view === 'all' ? 'No orders match this filter.' : view === 'toShip' ? 'Nothing to ship.' : view === 'shipped' ? 'None in transit.' : view === 'pickup' ? 'No pickups waiting.' : view === 'done' ? 'No completed orders yet.' : 'None.'}</div>
        : <div className="ticket-list">{active.map(renderTicket)}</div>}
    </section>
    </>}
  </>;
}
