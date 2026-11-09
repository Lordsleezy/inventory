import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { floorFunctionUrl } from './floorApi';
import { CommissionOverrideControls, CommissionOverrideMark } from './CommissionOverride';
import { frozenCutsForTicket, type CommissionOverride, type OnlineCfg, type Rule } from './payouts';
import { LabelDialog } from './LabelDialog';
import { OrderStepper, OrderTimelineList } from './OrderFulfillment';
import { OrderFacts, OrderFindRow, OrderPhotoCarousel, OrderTitle } from './OrderPhotos';
import { derivativePath, hydratePhotoUrlCache, listThumbPhoto, listThumbPathsFromPhotoMap, loadUnitPhotos, persistPhotoUrlCache, signPhotoUrls, type UnitPhoto } from './unitPhotos';
import { errText } from './errText';
import { fileToBase64, labelFileUrl, orderAdmin } from './orderLabel';
import { openShippingLabel } from './labelPrint';
import { canBuyLabel, hasLabel, orderChip, orderNeedsLabel, orderStage, orderTimeline, packagedStale, shippedStale } from './orderStage';
import { loadOrderLocations, locationCompare } from './locationOrder';
import { useVisibleInterval } from './useVisibleInterval';
import { ScanOutPanel } from './ScanOutPanel';
import { PackLabelScan } from './PackLabelScan';
import { labelUploadUi, type LabelUploadResponse } from './labelUploadFeedback';
import { LabelTrackingPicker, LabelTrackingResult } from './LabelTrackingResult';
import { LabelTrackingProblem } from './LabelTrackingProblem';

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
  packaged_at?: string | null; packaged_by?: string | null; packaged_by_name?: string | null;
  shipped_by_name?: string | null; delivered_by_name?: string | null;
  scanned_out_at?: string | null; scanned_out_by_name?: string | null;
  tracking_number: string | null; tracking_url: string | null; carrier: string | null; service: string | null;
  label_url: string | null; label_purchased_at: string | null; label_cost_cents: number | null;
  label_storage_path?: string | null; label_file_name?: string | null; label_mime?: string | null;
  label_uploaded_at?: string | null; label_origin?: 'bought' | 'upload' | null;
  tracking_status?: string | null; tracking_exception?: string | null; tracking_needs_entry?: boolean | null;
  marketplace_tracking_number?: string | null; label_tracking_mismatch?: boolean | null; ebay_seller_username?: string | null;
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
  /** `${ticket_key}|${employee_id}` → frozen commission cents from sale_commissions. */
  frozen?: Map<string, number | null>;
  personName: (id: string) => string; busy: boolean;
  onCommissionChanged: (ticketKey: string, next: CommissionOverride | null) => void;
  /** Staff desk: To ship and Packaged only. Mark packaged, print a label, scan out. */
  packOnly?: boolean;
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

type OrderView = 'all' | 'needsLabel' | 'toShip' | 'packaged' | 'shipped' | 'delivered' | 'canceled';
type StatusFilter = 'all' | 'paid' | 'canceled' | 'refunded';

const VIEW_LABEL: Record<OrderView, string> = {
  all: 'All orders',
  needsLabel: 'Needs label',
  toShip: 'To ship',
  packaged: 'Packaged',
  shipped: 'Shipped',
  delivered: 'Delivered',
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

export function OrdersPage({ client, accessToken, storeId, money, stamp, rules, cfg, commissionOverrides, frozen, personName, busy: parentBusy, onCommissionChanged, packOnly = false }: Props) {
  const [orders, setOrders] = useState<WebOrder[] | null>(null);
  const [photoMap, setPhotoMap] = useState<Record<string, UnitPhoto[]>>({});
  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>(() => {
    hydratePhotoUrlCache(`${storeId}:orders`);
    return {};
  });
  const mergePhotoUrls = (extra: Record<string, string>) => {
    if (!Object.keys(extra).length) return;
    setPhotoUrls((prev) => {
      const next = { ...prev, ...extra };
      persistPhotoUrlCache(`${storeId}:orders`, next);
      return next;
    });
  };
  const [locations, setLocations] = useState<Record<string, string[]>>({});
  const [locationOptions, setLocationOptions] = useState<{ code: string }[]>([]);
  const [error, setError] = useState('');
  const [labelHit, setLabelHit] = useState<{ orderId: string; number: string; carrier?: string | null } | null>(null);
  const [trackingPick, setTrackingPick] = useState<{ orderId: string; candidates: NonNullable<LabelUploadResponse['tracking_candidates']> } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [view, setView] = useState<OrderView>(packOnly ? 'toShip' : 'all');
  const [openId, setOpenId] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [labelOrder, setLabelOrder] = useState<WebOrder | null>(null);
  const [trackEvents, setTrackEvents] = useState<Record<string, { status?: string; status_detail?: string | null; location?: string | null; occurred_at?: string | null }[]>>({});
  const [scanOut, setScanOut] = useState(false);

  const load = useCallback(async () => {
    // No practical date hide: cover store day-one history (portal still clamps to p_days).
    const { data, error: e } = await client.rpc('portal_web_orders', { p_days: 400 });
    if (e) { setError(e.message); return; }
    setOrders(data as WebOrder[]);
    const skus = [...new Set((data as WebOrder[]).map(o => o.sku).filter(Boolean))];
    setLocations(await loadOrderLocations(client, storeId, skus));
    const { data: bins } = await client.from('store_locations').select('code').eq('store_id',storeId).order('bay_no').order('row_no').order('bin_no');
    setLocationOptions((bins || []) as {code:string}[]);
    if (skus.length) {
      const photos = await loadUnitPhotos(client, storeId, skus).catch(() => ({} as Record<string, UnitPhoto[]>));
      setPhotoMap(photos);
      mergePhotoUrls(await signPhotoUrls(client, listThumbPathsFromPhotoMap(photos)));
    }
  }, [client, storeId]);
  const sign = useCallback((paths: string[]) => signPhotoUrls(client, paths), [client]);
  useEffect(() => {
    if (packOnly && view !== 'toShip' && view !== 'packaged') setView('toShip');
  }, [packOnly, view]);
  useVisibleInterval(load, 60_000);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(t); }, []);

  async function markPackaged(o: WebOrder) {
    const ch = (o.channel || '').toLowerCase();
    if ((ch === 'amazon' || ch === 'tiktok') && !o.pack_proof_photo_path) {
      setError('Amazon/TikTok orders need a pack photo before Packaged.');
      return;
    }
    setBusy(o.id + 'packaged'); setError('');
    const { error: e } = await client.rpc('portal_mark_order_packaged', { p_order: o.id });
    if (e) setError(e.message === 'pack_proof_required' ? 'Upload a pack photo of the unit before marking it packaged.' : e.message);
    await load(); setBusy(null);
  }

  async function markShipped(o: WebOrder) {
    setBusy(o.id + 'shipped'); setError('');
    const { error: e } = await client.rpc('portal_mark_order_shipped', { p_order: o.id });
    if (e) setError(e.message === 'order_not_packaged' ? 'Tap Packaged before marking it shipped.' : e.message);
    await load(); setBusy(null);
  }

  async function markDelivered(o: WebOrder) {
    setBusy(o.id + 'delivered'); setError('');
    const { error: e } = await client.rpc('portal_mark_order_delivered', { p_order: o.id });
    if (e) setError(e.message === 'portal_access_denied' ? 'Only an admin can mark an order delivered.' : e.message);
    await load(); setBusy(null);
  }

  async function printOrderLabel(o: WebOrder) {
    setBusy(o.id + 'print');
    setError('');
    try {
      const url = await labelFileUrl(client, o);
      if (!url) { setError('No label file on this order yet.'); return; }
      await openShippingLabel(url);
    } catch (e) { setError(errText(e)); }
    finally { setBusy(''); }
  }

  async function uploadOrderLabel(o: WebOrder, file: File) {
    setBusy(o.id + 'upload'); setError('');
    try {
      const data = await orderAdmin(accessToken, {
        action: 'attach_label', id: o.id,
        file_base64: await fileToBase64(file), file_name: file.name,
        mime: file.type || (file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg'),
      }) as LabelUploadResponse;
      const ui = labelUploadUi(data);
      setLabelHit(null);
      setTrackingPick(null);
      setError('');
      if (ui.kind === 'manual') setError(ui.message);
      else if (ui.kind === 'picker') setTrackingPick({ orderId: o.id, candidates: ui.candidates });
      else if (ui.kind === 'hit') setLabelHit({ orderId: o.id, number: ui.number, carrier: ui.carrier });
      await load();
    } catch (e) { setError(errText(e)); }
    setBusy(null);
  }

  async function setPickLocation(o: WebOrder, code: string) {
    if (!code) return;
    setBusy(`${o.id}location`); setError('');
    const { error: e } = await client.rpc('portal_set_unit_pick_location', { p_sku: o.sku, p_location: code });
    if (e) setError(e.message);
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
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  }
  async function stepBack(o: WebOrder) {
    const step = o.delivered_at ? 'Delivered → Shipped'
      : o.shipped_at ? (o.packaged_at ? 'Shipped → Packaged' : 'Shipped → To ship')
        : o.packaged_at ? 'Packaged → To ship'
          : o.picked_up_at ? 'Picked up → Awaiting pickup' : '';
    if (!step) { setError('There is no completed fulfillment step to undo.'); return; }
    if (!window.confirm(`Are you sure? Move this order back one step (${step}). The sale and money stay unchanged.`)) return;
    setBusy(o.id + 'step-back'); setError('');
    const { error: e } = await client.rpc('portal_order_step_back', { p_order: o.id });
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
    } catch (e) { setError(errText(e)); }
    finally { setBusy(null); }
  }
  async function deleteOrder(o: WebOrder) {
    const live = o.status === 'paid';
    const ok = window.confirm(
      `Delete ${channelLabel(o.channel)} order ${o.order_no || o.id} (SKU ${o.sku}) from Orders?\n\n` +
      (live
        ? 'This removes it from Orders and reverses the Floor sale (unit goes available again).\nIt does NOT refund the buyer on eBay / Amazon / Depop / TikTok / Square.'
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
    } catch (e) { setError(errText(e)); }
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
    } catch (e) { setError(errText(e)); }
    finally { setBusy(null); }
  }
  async function recordLabelCost(o: WebOrder) {
    if (o.pack_condition !== 'ok') {
      setError('Confirm the item matches the listing before recording a label cost.');
      return;
    }
    const current = o.label_cost_cents != null ? (o.label_cost_cents / 100).toFixed(2) : '';
    const raw = window.prompt(
      (o.channel || '').toLowerCase() === 'mercari'
        ? `Label cost for Mercari order ${o.order_no || o.id} (USD).\n\nThis is reimbursed to you. It is not deducted from the sale or from payouts.`
        : `Label cost for ${channelLabel(o.channel)} order ${o.order_no || o.id} (USD).\n\nUse this for Pirate Ship, USPS, eBay labels, Depop, Amazon, TikTok — whatever you paid to ship.`,
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
        needsLabel: byStatus.filter(o => orderStage(o) === 'needsLabel'),
        toShip: byStatus.filter(o => orderStage(o) === 'toShip'),
        packaged: byStatus.filter(o => orderStage(o) === 'packaged'),
        shipped: byStatus.filter(o => orderStage(o) === 'shipped'),
        delivered: byStatus.filter(o => orderStage(o) === 'delivered'),
        canceled: byStatus.filter(o => orderStage(o) === 'canceled'),
      } as Record<OrderView, WebOrder[]>,
    };
  }, [orders, statusFilter]);

  const active = groups[view].slice().sort((a,b) => {
    if (view !== 'needsLabel' && view !== 'toShip' && view !== 'packaged') return 0;
    return locationCompare(locations[a.sku]?.[0] || '99999', locations[b.sku]?.[0] || '99999');
  });
  const summary = useMemo(() => breakdown(groups[view]), [groups, view]);

  useEffect(() => {
    const ids = active.filter((o) => o.packaged_at || o.shipped_at || o.delivered_at).slice(0, 25).map((o) => o.id);
    if (!ids.length) return;
    let alive = true;
    void (async () => {
      const next: typeof trackEvents = {};
      await Promise.all(ids.map(async (id) => {
        const { data } = await client.rpc('portal_order_timeline', { p_order: id });
        next[id] = (data || []) as typeof trackEvents[string];
      }));
      if (alive) setTrackEvents(next);
    })();
    return () => { alive = false; };
  }, [client, view, orders]);

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
    const skuLabel = linked ? `SKU ${o.sku}` : 'Needs SKU match';
    return <div className="ticket-items">
    <small>{skuLabel}</small>
    <small>{o.buyer_name || 'Buyer'}</small>
    {(o.buyer_email || o.buyer_phone) && (revealed.has(o.id)
      ? <small>{[o.buyer_email, o.buyer_phone].filter(Boolean).join(' · ')}</small>
      : <button type="button" className="text-button" onClick={() => setRevealed((prev) => new Set(prev).add(o.id))}>Reveal</button>)}
    <small>Item {money(o.item_cents)}{orderFee(o) ? ` · Fees ${money(orderFee(o))}` : ''} · {o.fulfillment === 'ship' ? `Buyer ship ${money(o.shipping_cents)}` : 'Store pickup'}{o.fulfillment === 'ship' ? ` · Label ${o.label_cost_cents != null ? money(o.label_cost_cents) : '—'}` : ''} · Tax {money(o.tax_cents)}</small>
    <CommissionOverrideMark overridden={!!ov} />
    {!packOnly && canOverride && o.ticket_key && (
      <details>
        <summary>Commission split</summary>
        <CommissionOverrideControls
          client={client}
          ticketKey={o.ticket_key}
          ticket={ticketLike}
          rules={rules}
          cfg={cfg}
          override={ov}
          frozenCuts={frozenCutsForTicket(frozen, o.ticket_key, cfg)}
          personName={personName}
          stamp={stamp}
          money={money}
          busy={!!busy || parentBusy}
          onChanged={next => onCommissionChanged(o.ticket_key!, next)}
        />
      </details>
    )}
    {otherStores(o).length > 0 && <div className="alert" role="status">Pull from other stores: still marked live on {otherStores(o).map(channelLabel).join(', ')}. End those listings in each marketplace app (eBay / Depop / Amazon / TikTok).</div>}
    {(o.match_status === 'unmatched' || o.match_status === 'already_sold') && <div className="alert" role="status">Needs SKU match — sale is in Orders but not linked to a Floor unit yet. <button className="secondary" disabled={!!busy} onClick={() => void matchSku(o)}>Link SKU…</button></div>}
  </div>;
  };

  function selectView(next: OrderView) {
    setView(next);
  }

  const renderTicket = (o: WebOrder) => {
    const stage = orderStage(o);
    const chip = orderChip(o);
    const isCanceled = stage === 'canceled';
    const isNeeds = stage === 'needsLabel';
    const isToShip = stage === 'toShip';
    const isPackaged = stage === 'packaged';
    const isShipped = stage === 'shipped';
    const isPickup = stage === 'pickup';
    const isDone = stage === 'delivered';
    const labeled = hasLabel(o);
    const buy = canBuyLabel(o.channel);
    const cardStatus = chip.text;
    const displayTitle = o.match_status === 'matched' || (!!o.sku && o.sku !== 'UNMATCHED' && !!o.sale_id)
      ? (o.title || o.marketplace_title || 'Item') : (o.marketplace_title || o.title || 'Marketplace sale');
    const thumbPhoto = listThumbPhoto(photoMap[o.sku] || []);
    const thumbPath = thumbPhoto ? derivativePath(thumbPhoto.path, 400) : null;
    const thumb = thumbPath ? photoUrls[thumbPath] : '';
    const labelText = o.label_origin === 'upload'
      ? `Uploaded · ${channelLabel(o.channel)}`
      : o.label_origin === 'bought' || o.label_purchased_at
        ? `Bought${o.label_cost_cents != null ? ` · ${money(o.label_cost_cents)}` : ''}`
        : orderNeedsLabel(o) ? 'Upload label' : buy ? 'Buy label' : '—';
    return (
      <div className="ticket order" key={o.id}>
        <OrderPhotoCarousel photos={photoMap[o.sku] || []} urls={photoUrls} sign={sign} />
        <div className="order-detail-copy">
          <OrderTitle title={displayTitle} />
          <p>{channelLabel(o.channel)} · {money(o.item_cents)} · {o.paid_at ? stamp(o.paid_at) : stamp(o.created_at)}</p>
        </div>
        <OrderFindRow picker="button" sku={o.sku} code={locations[o.sku]?.[0] || ''} options={locationOptions} disabled={!!busy || packOnly} onChange={(code) => void setPickLocation(o, code)} />
        <div className="order-card-summary">{thumb && <img className="app-order-thumb" src={thumb} alt="" />}<div className="order-card-info"><small>{channelLabel(o.channel)} · {money(o.item_cents)} · SKU {o.sku}</small><div className="order-card-tags"><b className={chip.tone === 'warn' ? 'badge-warn' : ''}>{cardStatus}</b></div></div></div>
        {o.fulfillment === 'ship' && !isCanceled && <OrderStepper stage={stage} />}
        <OrderFacts label={labelText} labeled={labeled} order={o} />
        {labelHit?.orderId === o.id && <LabelTrackingResult hit={labelHit} onDismiss={() => setLabelHit(null)} />}
        {trackingPick?.orderId === o.id && (
          <LabelTrackingPicker
            candidates={trackingPick.candidates}
            busy={!!busy}
            onPick={async (number, carrier) => {
              setBusy(o.id + 'tracking');
              try {
                await orderAdmin(accessToken, { action: 'set_tracking', id: o.id, tracking: number, carrier: carrier || o.carrier || 'USPS' });
                setTrackingPick(null);
                setLabelHit({ orderId: o.id, number, carrier });
                setError('');
                await load();
              } catch (e) { setError(errText(e)); } finally { setBusy(null); }
            }}
            onManual={() => setTrackingPick(null)}
          />
        )}
        {(o.label_tracking_mismatch || o.tracking_exception || (o.tracking_needs_entry && !o.tracking_number)) && (
          <LabelTrackingProblem
            order={o}
            busy={!!busy}
            onUseMarketplace={async () => {
              setBusy(o.id + 'ebay-track');
              try {
                await orderAdmin(accessToken, { action: 'accept_marketplace_tracking', id: o.id });
                setError('');
                await load();
              } catch (e) { setError(errText(e)); } finally { setBusy(null); }
            }}
            onUseLabel={async (number, carrier) => {
              setBusy(o.id + 'label-track');
              try {
                await orderAdmin(accessToken, { action: 'accept_label_tracking', id: o.id, tracking: number, carrier });
                setError('');
                await load();
              } catch (e) { setError(errText(e)); } finally { setBusy(null); }
            }}
            onManual={async (number, carrier) => {
              setBusy(o.id + 'tracking');
              try {
                await orderAdmin(accessToken, { action: 'set_tracking', id: o.id, tracking: number, carrier });
                setError('');
                await load();
              } catch (e) { setError(errText(e)); } finally { setBusy(null); }
            }}
            onRetry={async () => {
              setBusy(o.id + 'retry');
              try {
                await orderAdmin(accessToken, { action: 'retry_label_extract', id: o.id });
                setError('');
                await load();
              } catch (e) { setError(errText(e)); } finally { setBusy(null); }
            }}
            onReplace={() => {
              const input = document.getElementById(`order-label-${o.id}`) as HTMLInputElement | null;
              input?.click();
            }}
          />
        )}
        {(isPackaged || isShipped || isDone) && <OrderTimelineList rows={orderTimeline(o, trackEvents[o.id])} stamp={stamp} />}
        {head(o)}{item(o)}
        {isToShip && packOnly && (
          <>
            <div className="order-address">{[o.buyer_name, o.ship_line1, o.ship_line2, [o.ship_city, o.ship_region, o.ship_postal].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}</div>
            {((o.channel || '').toLowerCase() === 'amazon' || (o.channel || '').toLowerCase() === 'tiktok') && (
              <div className="actions">
                <span className="hint">Pack proof (required)</span>
                <label className="secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '10px 14px', border: '1px solid var(--btn-border)', borderRadius: 8, cursor: 'pointer' }}>
                  {busy === o.id + 'proof' ? 'Uploading…' : o.pack_proof_photo_path ? 'Replace unit photo' : 'Photo of unit'}
                  <input type="file" accept="image/*" capture="environment" hidden disabled={!!busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadPackProof(o, f); e.target.value = ''; }} />
                </label>
              </div>
            )}
            <div className="actions">
              {labeled && <button type="button" disabled={!!busy} onClick={() => void printOrderLabel(o)}>Print 4×6</button>}
              <button className="primary" disabled={!!busy} onClick={() => void markPackaged(o)}>{busy === o.id + 'packaged' ? 'Saving…' : 'Packaged'}</button>
            </div>
            <p className="hint">Print the label, then mark it packaged. Scan it out from Packaged when it is picked up.</p>
          </>
        )}
        {isToShip && !packOnly && (
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
            {labeled && <PackLabelScan client={client} disabled={!!busy} onDone={() => void load()} />}
            <div className="actions">
              {labeled && <button type="button" disabled={!!busy} onClick={() => void printOrderLabel(o)}>Print 4×6</button>}
              {!labeled && buy && <button type="button" disabled={!!busy || o.pack_condition === 'not_as_listed'} onClick={() => setLabelOrder(o)}>Buy label</button>}
              {!labeled && !buy && <label className="secondary" style={{ display: 'inline-flex', alignItems: 'center', padding: '10px 14px', border: '1px solid var(--btn-border)', borderRadius: 8 }}>
                {busy === o.id + 'upload' ? 'Uploading…' : 'Add label'}
                <input id={`order-label-${o.id}`} type="file" accept="application/pdf,image/*" hidden disabled={!!busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void uploadOrderLabel(o, f); }} />
              </label>}
              <button className="primary" disabled={!!busy} onClick={() => void markPackaged(o)}>{busy === o.id + 'packaged' ? 'Saving…' : 'Packaged'}</button>
              {(o.channel || '').toLowerCase() !== 'depop' && <button className="secondary" disabled={!!busy || (o.label_cost_cents == null && o.pack_condition !== 'ok')} onClick={() => void recordLabelCost(o)}>{busy === o.id + 'label' ? 'Saving…' : o.label_cost_cents != null ? 'Edit label cost' : 'Record label cost'}</button>}
              {(!o.channel || o.channel === 'website') && <button className="text-button danger" disabled={!!busy} onClick={() => void cancel(o)}>Cancel & refund</button>}
              <button className="text-button danger" disabled={!!busy} onClick={() => void deleteOrder(o)}>{busy === o.id + 'delete' ? 'Deleting…' : 'Delete'}</button>
            </div>
            <p className="hint">Tap Packaged once it's boxed and labeled. Then tap Mark shipped when it leaves.</p></>}
          </>
        )}
        {isPackaged && packOnly && (
          <>
            <small>Packaged {o.packaged_at ? stamp(o.packaged_at) : ''}{o.packaged_by_name ? ` · ${o.packaged_by_name}` : ''}</small>
            <div className="actions">
              {labeled && <button type="button" disabled={!!busy} onClick={() => void printOrderLabel(o)}>Print 4×6</button>}
            </div>
            <p className="hint">Use Scan out pickup when someone picks the packages up.</p>
          </>
        )}
        {isPackaged && !packOnly && (
          <>
            <small>Packaged {o.packaged_at ? stamp(o.packaged_at) : ''}{o.packaged_by_name ? ` · ${o.packaged_by_name}` : ''}{packagedStale(o) ? ' · not marked shipped for 2 days' : ''}</small>
            <div className="actions">
              {labeled && <button type="button" disabled={!!busy} onClick={() => void printOrderLabel(o)}>Print 4×6</button>}
              <button type="button" className="primary" disabled={!!busy} onClick={() => void markShipped(o)}>{busy === o.id + 'shipped' ? 'Saving…' : 'Mark shipped'}</button>
              <button type="button" className="secondary" disabled={!!busy} onClick={() => void stepBack(o)}>Move back one step</button>
            </div>
            <p className="hint">Mark shipped when it leaves the building. That records who tapped it.</p>
          </>
        )}
        {!packOnly && isShipped && (
          <>
            <small>Shipped {stamp(o.shipped_at!)}{o.shipped_by_name ? ` · ${o.shipped_by_name}` : ''}{shippedStale(o) ? ' · not marked delivered for 10 days' : ''}</small>
            {o.scanned_out_at && <small>Scanned out {stamp(o.scanned_out_at)}{o.scanned_out_by_name ? ` by ${o.scanned_out_by_name}` : ''}</small>}
            {o.refund_requested_at ? <p className="hint">Cancel & refund in progress…</p> : <div className="actions">
              <button type="button" className="primary" disabled={!!busy} onClick={() => void markDelivered(o)}>{busy === o.id + 'delivered' ? 'Saving…' : 'Mark delivered'}</button>
              <button type="button" className="secondary" disabled={!!busy} onClick={() => void stepBack(o)}>{busy === o.id + 'step-back' ? 'Saving…' : 'Move back one step'}</button>
              {labeled && <button type="button" disabled={!!busy} onClick={() => void printOrderLabel(o)}>Print 4×6</button>}
              {(!o.channel || o.channel === 'website') && <button className="text-button danger" disabled={!!busy} onClick={() => void cancel(o)}>Cancel & refund</button>}
              <button className="text-button danger" disabled={!!busy} onClick={() => void deleteOrder(o)}>{busy === o.id + 'delete' ? 'Deleting…' : 'Delete'}</button>
            </div>}
          </>
        )}
        {!packOnly && isPickup && (
          <>
            <div className={`countdown${o.pickup_deadline && new Date(o.pickup_deadline).getTime() - now < 86400000 ? ' urgent' : ''}`}>Pick up by {o.pickup_deadline ? stamp(o.pickup_deadline) : '—'} · {timeLeft(o.pickup_deadline, now)}</div>
            {o.refund_requested_at ? <p className="hint">Cancel & refund in progress…</p> : <div className="actions">
              <button disabled={!!busy} onClick={() => void pickedUp(o)}>Picked up</button>
              <button className="text-button danger" disabled={!!busy} onClick={() => void cancel(o)}>Cancel & refund</button>
              <button className="text-button danger" disabled={!!busy} onClick={() => void deleteOrder(o)}>{busy === o.id + 'delete' ? 'Deleting…' : 'Delete'}</button>
            </div>}
          </>
        )}
        {!packOnly && isDone && (
          <>
            <small>{o.picked_up_at ? `Picked up ${stamp(o.picked_up_at)} · ${o.picked_up_by || ''}` : `Delivered ${stamp(o.delivered_at!)}${o.delivered_by_name ? ` · ${o.delivered_by_name}` : ''}${o.shipped_at ? ` · shipped ${stamp(o.shipped_at)}` : ''}`}</small>
            <div className="actions">
              <button type="button" className="secondary" disabled={!!busy} onClick={() => void stepBack(o)}>{busy === o.id + 'step-back' ? 'Saving…' : 'Move back one step'}</button>
              <button className="text-button danger" disabled={!!busy} onClick={() => void deleteOrder(o)}>{busy === o.id + 'delete' ? 'Deleting…' : 'Delete'}</button>
            </div>
          </>
        )}
        {!packOnly && isCanceled && (
          <>
            <small>{o.cancel_source === 'pickup_expired' ? 'Not picked up by the deadline' : o.cancel_source === 'admin' ? `Canceled in admin${o.cancel_reason ? `: ${o.cancel_reason}` : ''}` : o.cancel_source === 'ebay_api' ? `Canceled on eBay${o.cancel_reason ? `: ${o.cancel_reason}` : ''}` : o.status === 'refunded' ? 'Refunded' : o.status === 'canceled' ? `Canceled${o.cancel_reason ? `: ${o.cancel_reason}` : ''}` : 'Could not complete; refunded automatically'}{o.canceled_at ? ` · ${stamp(o.canceled_at)}` : ''}</small>
            <div className="actions">
              <button className="text-button danger" disabled={!!busy} onClick={() => void deleteOrder(o)}>{busy === o.id + 'delete' ? 'Deleting…' : 'Delete'}</button>
            </div>
          </>
        )}
        {!packOnly && isNeeds && (
          <div className="actions">
            <label className="primary" style={{ display: 'inline-flex', alignItems: 'center', padding: '10px 14px', borderRadius: 8, cursor: 'pointer' }}>
              {busy === o.id + 'upload' ? 'Uploading…' : o.label_storage_path ? 'Replace label' : 'Upload label'}
              <input id={`order-label-${o.id}`} type="file" accept="application/pdf,image/*" hidden disabled={!!busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void uploadOrderLabel(o, f); }} />
            </label>
            {o.label_tracking_mismatch && <span className="hint">This PDF does not match the tracking number on eBay.</span>}
            {o.marketplace_tracking_number && !o.label_storage_path && <span className="hint">eBay already has tracking {o.marketplace_tracking_number}. Upload the PDF.</span>}
          </div>
        )}
        {!packOnly && !isNeeds && !isToShip && !isPackaged && !isShipped && !isPickup && !isDone && !isCanceled && (
          <div className="actions">
            <button className="text-button danger" disabled={!!busy} onClick={() => void deleteOrder(o)}>{busy === o.id + 'delete' ? 'Deleting…' : 'Delete'}</button>
          </div>
        )}
      </div>
    );
  };

  if (scanOut) {
    return <ScanOutPanel client={client} storeId={storeId} stamp={stamp} onClose={() => setScanOut(false)} />;
  }

  return <>
    <header><div><div className="eyebrow">WEBSITE AND MARKETPLACES</div><h1>Orders</h1><p>{packOnly ? 'To ship and packaged only. Mark packaged, print the label, then scan out when the packages are picked up.' : 'Every online order since day one. Returns, refunds, and replacements are on the Returns tab. No customer emails. Refreshes every 30 seconds.'}</p></div>
      <div className="actions"><button className="secondary" onClick={() => void load()}>Refresh</button></div></header>
    {error && <div className="alert" role="alert">{error}<button onClick={() => setError('')}>Dismiss</button></div>}
    <div className="inventory-tabs" role="tablist" aria-label="Order status">
      {(packOnly ? [
        ['toShip', groups.toShip.length],
        ['packaged', groups.packaged.length],
      ] as const : [
        ['all', groups.all.length],
        ['needsLabel', groups.needsLabel.length],
        ['toShip', groups.toShip.length],
        ['packaged', groups.packaged.length],
        ['shipped', groups.shipped.length],
        ['delivered', groups.delivered.length],
        ['canceled', groups.canceled.length],
      ] as const).map(([key, count]) => (
        <button key={key} type="button" role="tab" aria-selected={view === key} className={view === key ? 'active' : ''} onClick={() => selectView(key)}>
          {VIEW_LABEL[key]} {count}
        </button>
      ))}
    </div>
    {!packOnly && <div className="actions" style={{ marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
      <label>Status{' '}
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)} aria-label="Order status filter">
          <option value="all">All statuses</option>
          <option value="paid">Paid</option>
          <option value="canceled">Canceled</option>
          <option value="refunded">Refunded</option>
        </select>
      </label>
      <span className="hint">{rawCount} loaded (no cancelled hide; 400-day window)</span>
    </div>}
    {orders === null && <p className="hint">Loading orders…</p>}

    {view === 'packaged' && (
      <div className="actions" style={{ marginBottom: 12 }}>
        <button type="button" className="secondary" onClick={() => setScanOut(true)}>Scan out pickup</button>
      </div>
    )}
    {view==='toShip' && <button type="button" className="desktop-pick-list" disabled={!active.length} onClick={()=>document.querySelector('.ticket.order')?.scrollIntoView({behavior:'smooth',block:'start'})}>
      <span><strong>Pick list</strong><small>sorted by bay · row · bin</small></span><b>Start ›</b>
    </button>}

    <section className="panel drilldown" aria-live="polite">
      <div className="section-head">
        <div>
          <div className="eyebrow">BREAKDOWN</div>
          <h2>{VIEW_LABEL[view]} · {summary.totals.count} order{summary.totals.count === 1 ? '' : 's'} · {money(summary.totals.total)}</h2>
        </div>
      </div>
      {summary.totals.count > 0 && (
        <p className="hint">{summary.channels.map((row) => `${channelLabel(row.channel)} ${row.count}`).join(' · ')} · {money(summary.totals.total)}</p>
      )}

      {active.length === 0
        ? <div className="empty">{view === 'all' ? 'No orders match this filter.' : view === 'needsLabel' ? 'No orders are waiting on a label.' : view === 'toShip' ? 'Nothing to ship.' : view === 'packaged' ? 'Nothing is waiting on a carrier scan.' : view === 'shipped' ? 'None in transit.' : view === 'delivered' ? 'No delivered orders yet.' : 'None.'}</div>
        : <table className="desk-table">
            <thead><tr><th>Order</th><th>Item</th><th>Channel</th><th>Status</th><th>Total</th></tr></thead>
            <tbody>
              {active.map((o) => {
                const linked = o.match_status === 'matched' || (!!o.sku && o.sku !== 'UNMATCHED' && !!o.sale_id);
                const title = linked ? (o.title || o.marketplace_title || 'Item') : (o.marketplace_title || o.title || 'Marketplace sale');
                const where = locations[o.sku]?.[0] || 'No location';
                return <tr key={o.id}>
                  <td><button type="button" className="linkish" onClick={() => setOpenId(o.id)}>{o.order_no || 'Order'}</button></td>
                  <td>{title}<br /><small>{where}</small></td>
                  <td>{channelLabel(o.channel)}</td>
                  <td>{orderChip(o).text}</td>
                  <td className="desk-num">{money(o.total_cents)}</td>
                </tr>;
              })}
            </tbody>
          </table>}
      {openId && active.some((o) => o.id === openId) && (
        <>
          <button type="button" className="desk-drawer-scrim" aria-label="Close order" onClick={() => setOpenId(null)} />
          <aside className="desk-drawer" role="dialog" aria-label="Order details">
            <button type="button" className="text-button" onClick={() => setOpenId(null)}>Close</button>
            {renderTicket(active.find((o) => o.id === openId)!)}
          </aside>
        </>
      )}
    </section>
    {labelOrder && (
      <LabelDialog
        order={labelOrder}
        accessToken={accessToken}
        money={money}
        onClose={() => setLabelOrder(null)}
        onPurchased={() => { void load(); }}
        onDone={() => { setLabelOrder(null); void load(); }}
      />
    )}
  </>;
}
