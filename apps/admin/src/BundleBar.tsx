import { useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { WebOrder } from './OrdersPage';
import { listThumbPhoto, type UnitPhoto } from './unitPhotos';
import { errText } from './errText';
import { floorFunctionUrl } from './floorApi';
import { DEFAULT_RATES, groupOpenOrders, type BundleGroup, type BundleItem, type BundleRate } from '../../../shared/bundle-shipping.mjs';

type Link = { order_id: string; peer_id: string };

function toItem(order: WebOrder): BundleItem {
  return {
    id: order.id,
    sku: order.sku,
    title: order.title || order.marketplace_title || order.sku,
    channel: order.channel,
    buyer_name: order.buyer_name,
    buyer_email: order.buyer_email,
    ship_line1: order.ship_line1,
    ship_line2: order.ship_line2,
    ship_city: order.ship_city,
    ship_region: order.ship_region,
    ship_postal: order.ship_postal,
    shipping_cents: order.shipping_cents || 0,
    item_cents: order.item_cents || 0,
    weight_lb: order.package?.weight_lb,
    length_in: order.package?.length_in,
    width_in: order.package?.width_in,
    height_in: order.package?.height_in,
    paid_at: order.paid_at,
    status: order.status,
    shipped_at: order.shipped_at,
    canceled_at: order.canceled_at,
    delivered_at: order.delivered_at,
    fulfillment: order.fulfillment,
    order_no: order.order_no,
    label_cost_cents: order.label_cost_cents,
  };
}

const rowStyle = { borderBottom: '1px solid #2a2a2a', padding: '12px 0', color: '#fff' } as const;
const button = { background: '#fff', color: '#000', border: 0, width: '100%', padding: '14px', fontWeight: 600, marginTop: 12 } as const;
const outline = { background: 'transparent', color: '#fff', border: '1px solid #4a4a4a', padding: '10px 12px', marginTop: 8 } as const;

type Props = {
  client: SupabaseClient;
  accessToken: string;
  orders: WebOrder[];
  segmentIds: string[];
  locations: Record<string, string[]>;
  photoUrls: Record<string, string>;
  photoMap: Record<string, UnitPhoto[]>;
  money: (n: number) => string;
  isAdmin: boolean;
  onRefresh: () => void;
  onMembers: (ids: string[]) => void;
};

export function BundleBar({ client, accessToken, orders, segmentIds, locations, photoUrls, photoMap, money, isAdmin, onRefresh, onMembers }: Props) {
  const [rates, setRates] = useState<BundleRate[]>(DEFAULT_RATES);
  const [splits, setSplits] = useState<string[]>([]);
  const [links, setLinks] = useState<Link[]>([]);
  const [open, setOpen] = useState<BundleGroup | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  async function loadState() {
    const { data, error } = await client.rpc('portal_bundle_state');
    if (error || !data) return;
    const body = data as { rates?: BundleRate[]; splits?: string[]; links?: Link[] };
    if (body.rates?.length) setRates(body.rates);
    setSplits((body.splits || []).map(String));
    setLinks(body.links || []);
  }

  useEffect(() => { void loadState(); }, [client]);

  const items = useMemo(() => orders.map(toItem), [orders]);
  const groups = useMemo(
    () => groupOpenOrders(items, { splitIds: splits, links, rates }),
    [items, splits, links, rates],
  );
  const visible = groups.filter((group) => group.items.some((item) => segmentIds.includes(item.id)));
  const memberIds = groups.flatMap((group) => group.items.map((item) => item.id)).join(',');

  useEffect(() => { onMembers(memberIds ? memberIds.split(',') : []); }, [memberIds]);

  async function call(body: Record<string, unknown>) {
    setBusy(true);
    setNote('');
    try {
      const res = await fetch(floorFunctionUrl('bundle-apply'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.ok === false) {
        setNote(json.error || 'eBay did not take that. Nothing else was changed.');
        return json;
      }
      setNote(json.note || json.rollback || 'Saved.');
      await onRefresh();
      await loadState();
      return json;
    } catch (err) {
      setNote(errText(err));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function apply(group: BundleGroup) {
    const amount = group.money.action === 'invoice' ? group.money.invoice_cents : group.money.refund_cents;
    const json = await call({
      action: 'apply',
      confirm: true,
      confirm_cents: amount,
      order_ids: group.items.map((item) => item.id),
    });
    if (json?.needs_confirm && json.preview?.money) {
      const next = json.preview.money.action === 'invoice' ? json.preview.money.invoice_cents : json.preview.money.refund_cents;
      setNote(`The price changed to ${money(next)}. Tap Apply bundle price again to send that amount.`);
    }
  }

  if (!visible.length && !open) return null;

  return (
    <div>
      {visible.map((group) => {
        const box = group.quote.package;
        return (
          <button key={group.id} type="button" onClick={() => { setOpen(group); setNote(''); }} style={{ ...rowStyle, display: 'block', width: '100%', textAlign: 'left', background: '#000' }}>
            <strong>{group.items.length} items · one box</strong>
            <div style={{ color: '#9a9a9a', marginTop: 4 }}>{group.buyer} · {group.channel}</div>
            <div style={{ color: group.quote.flag ? '#FF453A' : '#9a9a9a', marginTop: 4 }}>
              {group.quote.flag
                ? 'Ships separately. The box is over the Ground Advantage limit or a size is missing.'
                : `${box?.length_in} × ${box?.width_in} × ${box?.height_in} in · ${box?.weight_lb} lb · ${money(group.quote.price_cents)}`}
            </div>
          </button>
        );
      })}
      {open && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.72)', zIndex: 80, display: 'flex', alignItems: 'flex-end' }}>
          <div style={{ background: '#000', color: '#fff', width: '100%', maxHeight: '90vh', overflow: 'auto', padding: 16, borderTop: '1px solid #2a2a2a' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <strong>{open.buyer}</strong>
              <button type="button" style={outline} onClick={() => setOpen(null)}>Close</button>
            </div>
            <p style={{ color: '#9a9a9a' }}>{open.items.length} items in one box. Separate shipping {money(open.money.separate_cents)}. One-box price {money(open.quote.price_cents)}.</p>
            {open.quote.flag && <p style={{ color: '#FF453A' }}>These stay as separate shipments.</p>}
            {open.items.map((item) => {
              const order = orders.find((row) => row.id === item.id);
              const thumb = order ? listThumbPhoto(photoMap[order.sku] || []) : null;
              const src = thumb ? photoUrls[thumb.path] : '';
              return (
                <div key={item.id} style={rowStyle}>
                  <div style={{ display: 'flex', gap: 12 }}>
                    {src ? <img src={src} alt="" style={{ width: 48, height: 48, objectFit: 'cover', background: '#000' }} /> : <div style={{ width: 48, height: 48, background: '#111' }} />}
                    <div>
                      <div>{item.title}</div>
                      <div style={{ color: '#9a9a9a' }}>SKU {item.sku} · {locations[item.sku || '']?.[0] || 'No location'} · {item.order_no}</div>
                      <div style={{ color: '#9a9a9a' }}>Shipping {money(item.shipping_cents || 0)}</div>
                    </div>
                  </div>
                  {isAdmin && <button type="button" style={outline} disabled={busy} onClick={async () => {
                    const { error } = await client.rpc('portal_bundle_split', { p_order: item.id, p_split: true });
                    if (error) setNote(error.message);
                    else { setOpen(null); await loadState(); onRefresh(); }
                  }}>Split out</button>}
                </div>
              );
            })}
            {isAdmin && open.money.action === 'refund' && <p>Refund {money(open.money.refund_cents)}. This does not send until you tap the button.</p>}
            {isAdmin && open.money.action === 'invoice' && <p>Unpaid. Combined invoice shipping {money(open.money.invoice_cents)}.</p>}
            {isAdmin && open.money.action === 'mixed' && <p style={{ color: '#FF453A' }}>Some are paid and some are not. Nothing will be sent.</p>}
            {isAdmin && !open.quote.flag && open.money.action !== 'mixed' && (
              <button type="button" style={button} disabled={busy} onClick={() => void apply(open)}>
                {busy ? '…' : 'Apply bundle price'}
              </button>
            )}
            {isAdmin && (
              <button type="button" style={outline} disabled={busy} onClick={() => void call({ action: 'enable', confirm: true })}>
                Turn on eBay combined weight
              </button>
            )}
            {isAdmin && (
              <details style={{ marginTop: 16 }}>
                <summary>Shipping rate table</summary>
                <p style={{ color: '#9a9a9a' }}>Filled from the website tiers: $20, $32, and $50. The 50 lb and 70 lb rows continue the $18 step. Every size starts at the same price.</p>
                {rates.map((rate) => {
                  const key = `${rate.size_class}-${rate.max_lb}`;
                  return (
                    <label key={key} style={{ display: 'block', marginTop: 8, color: '#9a9a9a' }}>
                      {rate.size_class} up to {rate.max_lb} lb
                      <input
                        value={drafts[key] ?? (rate.price_cents / 100).toFixed(2)}
                        onChange={(event) => setDrafts((prev) => ({ ...prev, [key]: event.target.value }))}
                        style={{ display: 'block', width: '100%', background: '#000', color: '#fff', border: '1px solid #4a4a4a', padding: 8, marginTop: 4 }}
                      />
                      <button type="button" style={outline} disabled={busy} onClick={async () => {
                        const cents = Math.round(Number(drafts[key] ?? rate.price_cents / 100) * 100);
                        const { error } = await client.rpc('portal_bundle_rate_set', { p_max_lb: rate.max_lb, p_size_class: rate.size_class, p_price_cents: cents });
                        setNote(error ? error.message : 'Rate saved.');
                        if (!error) await loadState();
                      }}>Save</button>
                    </label>
                  );
                })}
              </details>
            )}
            {note && <p style={{ color: note.startsWith('eBay') || note.includes('Nothing') ? '#FF453A' : '#fff' }}>{note}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
