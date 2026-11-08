import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { type WebOrder } from '../OrdersPage';
import { LabelDialog } from '../LabelDialog';
import { OrderStepper, OrderTimelineList } from '../OrderFulfillment';
import { OrderFacts, OrderFindRow, OrderPhotoCarousel, OrderTitle } from '../OrderPhotos';
import { derivativePath, hydratePhotoUrlCache, listThumbPhoto, listThumbPathsFromPhotoMap, loadUnitPhotos, persistPhotoUrlCache, signPhotoUrls, type UnitPhoto } from '../unitPhotos';
import { errText } from '../errText';
import { shortError } from './shortError';
import { loadOrderLocations, locationCompare, locationParts } from '../locationOrder';
import { fileToBase64, labelFileUrl, orderAdmin } from '../orderLabel';
import { openShippingLabel } from '../labelPrint';
import { canBuyLabel, hasLabel, orderChip, orderNeedsLabel, orderStage, orderTimeline, packagedStale, shippedStale, trackingTail, type OrderStage } from '../orderStage';
import { useVisibleInterval } from '../useVisibleInterval';
import { ScanOutPanel } from '../ScanOutPanel';
import { PackLabelScan } from '../PackLabelScan';

type Seg = 'needsLabel' | 'toShip' | 'packaged' | 'shipped' | 'delivered' | 'canceled';

const CHANNEL: Record<string, string> = {
  website: 'Website', ebay: 'eBay', amazon: 'Amazon', tiktok: 'TikTok', depop: 'Depop', mercari: 'Mercari',
};

const SEG_NOTE: Record<Seg, string> = {
  needsLabel: 'Buy the eBay label in eBay, or grab the Depop label, then upload the PDF. The warehouse sees it after that.',
  toShip: 'Pick it, print the label, then tap Packaged.',
  packaged: 'Boxed. Tap Mark shipped when it leaves.',
  shipped: 'On the way. An admin taps Mark delivered when it arrives.',
  delivered: 'Carrier confirmed, or picked up before the store closed.',
  canceled: 'Canceled in Floor. Marketplace refunds stay manual.',
};

type Props = {
  client: SupabaseClient;
  storeId: string;
  accessToken: string;
  money: (n: number) => string;
  stamp: (s: string) => string;
  isAdmin?: boolean;
};

type TrackEvent = { status?: string; status_detail?: string | null; location?: string | null; occurred_at?: string | null };

function when(iso?: string | null) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' });
}

export function AppOrders({ client, storeId, accessToken, money, stamp, isAdmin = false }: Props) {
  const [seg, setSeg] = useState<Seg>('toShip');
  const [scanOut, setScanOut] = useState(false);
  const [orders, setOrders] = useState<WebOrder[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<WebOrder | null>(null);
  const [events, setEvents] = useState<TrackEvent[]>([]);
  const [locations, setLocations] = useState<Record<string, string[]>>({});
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
  const [locationOptions, setLocationOptions] = useState<{ code: string }[]>([]);
  const [busy, setBusy] = useState('');
  const [labelOpen, setLabelOpen] = useState(false);
  const [trackingDraft, setTrackingDraft] = useState('');
  const packProofInput = useRef<HTMLInputElement>(null);
  const labelInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const { data, error: e } = await client.rpc('portal_web_orders', { p_days: 400 });
      if (e) throw e;
      const list = (data as WebOrder[]).filter((o) => o.payment_env !== 'sandbox' && !(o.order_no || '').toLowerCase().startsWith('sandbox'));
      setOrders(list);
      setOpen((prev) => (prev ? list.find((o) => o.id === prev.id) || prev : null));
      const skus = [...new Set(list.map((o) => o.sku).filter(Boolean))];
      setLocations(await loadOrderLocations(client, storeId, skus));
      const photos = await loadUnitPhotos(client, storeId, skus).catch(() => ({} as Record<string, UnitPhoto[]>));
      setPhotoMap(photos);
      mergePhotoUrls(await signPhotoUrls(client, listThumbPathsFromPhotoMap(photos)));
      const { data: bins } = await client.from('store_locations').select('code').eq('store_id', storeId).order('bay_no').order('row_no').order('bin_no');
      setLocationOptions((bins || []) as { code: string }[]);
    } catch (e) {
      setError(shortError(errText(e)));
    }
  }, [client, storeId]);

  useVisibleInterval(load, 60_000);
  const sign = useCallback((paths: string[]) => signPhotoUrls(client, paths), [client]);

  const loadEvents = useCallback(async (id: string) => {
    const { data, error: e } = await client.rpc('portal_order_timeline', { p_order: id });
    if (e) { setEvents([]); return; }
    setEvents((data || []) as TrackEvent[]);
  }, [client]);

  useEffect(() => {
    if (!open) { setEvents([]); return; }
    setTrackingDraft(open.tracking_number || '');
    void loadEvents(open.id);
  }, [open?.id, loadEvents]);

  const buckets = useMemo(() => {
    const list = orders || [];
    const put = (stage: OrderStage) => list.filter((o) => orderStage(o) === stage);
    return {
      needsLabel: put('needsLabel'),
      toShip: put('toShip'),
      packaged: put('packaged'),
      shipped: put('shipped'),
      delivered: put('delivered'),
      canceled: put('canceled'),
    };
  }, [orders]);

  const rows = (buckets[seg] || []).slice().sort((a, b) => {
    if (seg !== 'needsLabel' && seg !== 'toShip' && seg !== 'packaged') return 0;
    return locationCompare(locations[a.sku]?.[0] || '99999', locations[b.sku]?.[0] || '99999');
  });

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

  async function setPickLocation(order: WebOrder, code: string) {
    if (!code) return;
    await runAction('location', async () => {
      const { error: e } = await client.rpc('portal_set_unit_pick_location', { p_sku: order.sku, p_location: code });
      if (e) throw e;
    });
  }

  async function markShipped(o: WebOrder) {
    await runAction('shipped', async () => {
      const { error: e } = await client.rpc('portal_mark_order_shipped', { p_order: o.id });
      if (e) throw new Error(e.message === 'order_not_packaged' ? 'Tap Packaged before marking it shipped.' : e.message);
    });
  }

  async function markDelivered(o: WebOrder) {
    await runAction('delivered', async () => {
      const { error: e } = await client.rpc('portal_mark_order_delivered', { p_order: o.id });
      if (e) throw new Error(e.message === 'portal_access_denied' ? 'Only an admin can mark an order delivered.' : e.message);
    });
  }

  async function markPackaged(o: WebOrder) {
    await runAction('packaged', async () => {
      const { error: e } = await client.rpc('portal_mark_order_packaged', { p_order: o.id });
      if (e) {
        throw new Error(e.message === 'pack_proof_required'
          ? 'Upload a pack photo of the unit before marking it packaged.'
          : e.message);
      }
    });
  }

  async function stepBack(o: WebOrder) {
    const step = o.delivered_at ? 'Delivered → Shipped'
      : o.shipped_at ? (o.packaged_at ? 'Shipped → Packaged' : 'Shipped → To ship')
        : o.packaged_at ? 'Packaged → To ship'
          : o.picked_up_at ? 'Picked up → Awaiting pickup' : '';
    if (!step) { setError('There is no completed fulfillment step to undo.'); return; }
    if (!window.confirm(`Are you sure? Move this order back one step (${step}). The sale and money stay unchanged.`)) return;
    await runAction('step-back', async () => {
      const { error: e } = await client.rpc('portal_order_step_back', { p_order: o.id });
      if (e) throw new Error(e.message === 'portal_access_denied' ? 'Only an owner or manager can move an order back.' : e.message);
    });
  }

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

  async function printLabel(o: WebOrder, download = false) {
    setBusy(download ? 'save-label' : 'print');
    setError('');
    try {
      const url = await labelFileUrl(client, o);
      if (!url) { setError('No label file on this order yet.'); return; }
      await openShippingLabel(url, download);
    } catch (e) {
      setError(shortError(errText(e)));
    } finally {
      setBusy('');
    }
  }

  async function uploadLabel(o: WebOrder, file: File) {
    const okType = file.type === 'application/pdf' || file.type.startsWith('image/') || /\.(pdf|png|jpe?g|webp)$/i.test(file.name);
    if (!okType) { setError('Use a PDF or a screenshot.'); return; }
    await runAction('upload-label', async () => {
      const data = await orderAdmin(accessToken, {
        action: 'attach_label',
        id: o.id,
        file_base64: await fileToBase64(file),
        file_name: file.name,
        mime: file.type || (file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg'),
      });
      if (data.mismatch) setError(String(data.exception || 'That tracking number does not match eBay. The order stays in Needs label.'));
      else if (data.needs_tracking) setError('Label saved. Type the tracking number — it was not clear on the file.');
    });
  }

  async function saveTracking(o: WebOrder) {
    await runAction('tracking', async () => {
      await orderAdmin(accessToken, { action: 'set_tracking', id: o.id, tracking: trackingDraft, carrier: o.carrier || '' });
    });
  }

  async function voidLabel(o: WebOrder) {
    if (!window.confirm('Void this label with the carrier and reverse the Floor shipping expense?')) return;
    await runAction('void', async () => {
      await orderAdmin(accessToken, { action: 'void_label', id: o.id, force: true });
    });
  }

  if (open) {
    const stage = orderStage(open);
    const ch = (open.channel || 'website').toLowerCase();
    const paid = open.status === 'paid';
    const ship = open.fulfillment === 'ship';
    const buy = canBuyLabel(ch);
    const labeled = hasLabel(open);
    const timeline = orderTimeline(open, events);
    if (labelOpen && buy && ship && paid) {
      return (
        <LabelDialog
          order={open}
          accessToken={accessToken}
          money={money}
          appMode
          onClose={() => { setLabelOpen(false); void load(); }}
          onPurchased={() => { void load(); }}
          onDone={() => { setLabelOpen(false); void load(); }}
        />
      );
    }
    const labelText = open.label_origin === 'upload'
      ? `Uploaded · ${CHANNEL[ch] || open.channel || 'Label'}`
      : open.label_origin === 'bought' || open.label_purchased_at
        ? `Bought${open.label_cost_cents != null ? ` · ${money(open.label_cost_cents)}` : ''}`
        : orderNeedsLabel(open) ? 'Upload label' : buy ? 'Buy label' : '—';
    return (
      <div className="app-stack">
        <div className="app-nav">
          <button type="button" onClick={() => setOpen(null)}>‹ Orders</button>
          <div className="app-nav-title">Order</div>
          <button type="button" style={{ visibility: 'hidden' }}>·</button>
        </div>
        <OrderPhotoCarousel photos={photoMap[open.sku] || []} urls={photoUrls} sign={sign} />
        <div className="order-detail-copy">
          <OrderTitle title={open.title || 'Item'} />
          <p>{CHANNEL[ch] || open.channel} · {money(open.item_cents || 0)} · {when(open.paid_at || open.created_at)}</p>
        </div>
        <OrderFindRow sku={open.sku} code={locations[open.sku]?.[0] || ''} options={locationOptions} disabled={!!busy} onChange={(code) => void setPickLocation(open, code)} />
        {ship && stage !== 'canceled' && <OrderStepper stage={stage} />}
        <OrderFacts label={labelText} labeled={labeled} order={open} />
        {open.scanned_out_at && <p className="app-footer-count">Scanned out {stamp(open.scanned_out_at)}{open.scanned_out_by_name ? ` by ${open.scanned_out_by_name}` : ''}</p>}
        {open.tracking_exception && <p className="app-inline-error">Carrier exception: {open.tracking_exception}</p>}
        {open.tracking_needs_entry && (
          <form className="app-track-box" onSubmit={(e) => { e.preventDefault(); void saveTracking(open); }}>
            <label>Tracking number
              <input value={trackingDraft} onChange={(e) => setTrackingDraft(e.target.value)} placeholder="From the label" autoComplete="off" />
            </label>
            <button type="submit" disabled={!!busy || trackingDraft.trim().length < 8}>{busy === 'tracking' ? 'Saving…' : 'Save tracking'}</button>
          </form>
        )}
        {error && <p className="app-inline-error">{error}</p>}
        {paid && ship && stage !== 'canceled' && (
          <>
            {stage === 'toShip' && labeled && (
              <PackLabelScan client={client} disabled={!!busy} onDone={() => void load()} />
            )}
            <div className="order-actions">
              {labeled && <button type="button" disabled={!!busy} onClick={() => void printLabel(open)}>{busy === 'print' ? '…' : 'Print label'}</button>}
              {!labeled && buy && !orderNeedsLabel(open) && (
                <button type="button" disabled={!!busy || open.pack_condition === 'not_as_listed'} onClick={() => setLabelOpen(true)}>Buy label</button>
              )}
              {orderNeedsLabel(open) && (
                <button type="button" className="primary" disabled={!!busy} onClick={() => labelInput.current?.click()}>{busy === 'upload-label' ? '…' : open.label_storage_path ? 'Replace label' : 'Upload label'}</button>
              )}
              {stage === 'toShip' && (
                <button type="button" className="primary" disabled={!!busy} onClick={() => void markPackaged(open)}>
                  {busy === 'packaged' ? '…' : 'Packaged'}
                </button>
              )}
              {stage === 'packaged' && (
                <button type="button" className="primary" disabled={!!busy} onClick={() => void markShipped(open)}>
                  {busy === 'shipped' ? '…' : 'Mark shipped'}
                </button>
              )}
              {stage === 'shipped' && isAdmin && (
                <button type="button" className="primary" disabled={!!busy} onClick={() => void markDelivered(open)}>
                  {busy === 'delivered' ? '…' : 'Mark delivered'}
                </button>
              )}
            </div>
            <div className="order-actions more">
              {labeled && <button type="button" className="secondary" disabled={!!busy} onClick={() => void printLabel(open, true)}>Save PDF</button>}
              {open.label_origin === 'bought' && !open.delivered_at && (
                <button type="button" className="secondary" disabled={!!busy} onClick={() => void voidLabel(open)}>{busy === 'void' ? '…' : 'Void label'}</button>
              )}
              {(ch === 'amazon' || ch === 'tiktok') && !open.delivered_at && (
                <button type="button" className="secondary" disabled={!!busy} onClick={() => packProofInput.current?.click()}>
                  {open.pack_proof_photo_path ? 'Replace pack photo' : 'Add pack photo'}
                </button>
              )}
              {(open.delivered_at || open.shipped_at || open.packaged_at) && (
                <button type="button" className="secondary" disabled={!!busy} onClick={() => void stepBack(open)}>Move back one step</button>
              )}
              {!open.delivered_at && !open.picked_up_at && (
                <button type="button" className="secondary" disabled={!!busy} onClick={() => void floorCancel(open)}>Cancel in Floor</button>
              )}
            </div>
            <input ref={labelInput} className="sr-only" type="file" accept="application/pdf,image/*" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void uploadLabel(open, f); }} />
            <input ref={packProofInput} type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void uploadPackProof(open, f); }} />
          </>
        )}
        {timeline.length > 0 && (
          <div className="app-group order-timeline-wrap">
            <OrderTimelineList rows={timeline} stamp={stamp} />
          </div>
        )}
        {stage === 'toShip' && <p className="app-footer-count">Tap once it's boxed and labeled.</p>}
        {stage === 'packaged' && <p className="app-footer-count">Tap Mark shipped when it leaves. That records who and when.</p>}
        {stage === 'shipped' && <p className="app-footer-count">{isAdmin ? 'Tap Mark delivered when it arrives.' : 'An admin marks this delivered.'}</p>}
      </div>
    );
  }

  const stale = buckets.packaged.filter((o) => packagedStale(o)).length;
  const late = buckets.shipped.filter((o) => shippedStale(o)).length;
  if (scanOut) {
    return <ScanOutPanel client={client} storeId={storeId} stamp={stamp} appMode onClose={() => setScanOut(false)} />;
  }
  return (
    <>
      <div className="app-large-title orders-app-title"><h1>Orders</h1></div>
      <div className="app-segment app-segment-scroll orders-segment">
        {([
          ...(isAdmin ? [['needsLabel', 'Needs label', buckets.needsLabel.length] as const] : []),
          ['toShip', 'To ship', buckets.toShip.length],
          ['packaged', 'Packaged', buckets.packaged.length],
          ['shipped', 'Shipped', buckets.shipped.length],
          ['delivered', 'Delivered', buckets.delivered.length],
          ['canceled', 'Canceled', buckets.canceled.length],
        ] as const).map(([id, label, n]) => (
          <button key={id} type="button" className={seg === id ? 'active' : ''} onClick={() => setSeg(id)}>
            {label} {n}
          </button>
        ))}
      </div>
      <p className="app-footer-count orders-seg-note">{SEG_NOTE[seg]}</p>
      {seg === 'packaged' && (
        <>
          <p className="app-flag">{stale > 0 ? `${stale} packaged over 2 days and not marked shipped.` : 'Flags anything packaged over 2 days and not marked shipped.'}</p>
          <button type="button" className="secondary" onClick={() => setScanOut(true)}>Scan out pickup</button>
        </>
      )}
      {seg === 'shipped' && (
        <p className="app-flag">{late > 0 ? `${late} shipped over 10 days and not marked delivered.` : 'Flags anything shipped over 10 days and not marked delivered.'}</p>
      )}
      {error && <p className="app-inline-error">{error}</p>}
      <div className="app-group">
        {!orders && <div className="app-empty-row">Loading…</div>}
        {orders && rows.length === 0 && <div className="app-empty-row">None right now</div>}
        {rows.map((o) => {
          const chip = orderChip(o);
          const chName = CHANNEL[(o.channel || 'website').toLowerCase()] || o.channel || 'Website';
          const loc = locationParts(locations[o.sku]?.[0]);
          const tail = trackingTail(o);
          const thumbPhoto = listThumbPhoto(photoMap[o.sku] || []);
          const thumbPath = thumbPhoto ? derivativePath(thumbPhoto.path, 400) : null;
          const thumb = thumbPath ? photoUrls[thumbPath] : '';
          const problem = orderNeedsLabel(o) || chip.tone === 'warn';
          return (
            <div key={o.id} className="app-row app-order-row">
            <button type="button" className="app-order-open" onClick={() => setOpen(o)}>
              {thumb ? <img className="app-order-thumb" src={thumb} alt="" /> : <span className="app-order-thumb empty" aria-hidden="true" />}
              <span className="app-order-main">
                <strong>{o.title || 'Item'}</strong>
                <small>{chName} · {money(o.item_cents || 0)}{tail ? ` · ${tail}` : ''}</small>
                <strong className={loc ? 'app-order-bay' : 'app-order-bay missing'}>{loc ? `${loc.display} · ${loc.slot}` : 'NO LOCATION'}</strong>
                {problem && <small className="app-order-problem">{orderNeedsLabel(o) ? 'Needs label' : chip.text}</small>}
              </span>
            </button>
            {hasLabel(o) && (
              <button type="button" className="app-order-print" onClick={() => void printLabel(o)}>Print</button>
            )}
            {isAdmin && orderNeedsLabel(o) && (
              <label className="app-row-upload" onClick={(e) => e.stopPropagation()}>
                Upload
                <input type="file" accept="application/pdf,image/*" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void uploadLabel(o, f); }} />
              </label>
            )}
            </div>
          );
        })}
      </div>
    </>
  );
}
