import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { type WebOrder } from '../OrdersPage';
import { hydratePhotoUrlCache, listThumbPhoto, listThumbPathsFromPhotoMap, loadUnitPhotos, persistPhotoUrlCache, signPhotoUrls, type UnitPhoto } from '../unitPhotos';
import { errText } from '../errText';
import { shortError } from './shortError';
import { loadOrderLocations, locationCompare } from '../locationOrder';
import { fileToBase64, labelFileUrl, orderAdmin } from '../orderLabel';
import { openShippingLabel } from '../labelPrint';
import { hasLabel, orderCanMarkPackaged, orderCanStepBack, orderNeedsLabel, orderStage, packagedStale, shippedStale, trackingTail, type OrderStage } from '../orderStage';
import { useVisibleInterval } from '../useVisibleInterval';
import { ScanOutPanel } from '../ScanOutPanel';
import { SEG_SHORT } from '../orderDisplay';
import { AppOrderDetail } from './AppOrderDetail';
import { AppOrderRow } from './AppOrderRow';
import { AppOrderShipVerifySheet } from './AppOrderShipVerifySheet';
import { floorFunctionUrl } from '../floorApi';
import { labelUploadUi, type LabelUploadResponse } from '../labelUploadFeedback';
import { LabelTrackingPicker, LabelTrackingResult } from '../LabelTrackingResult';

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
  /** Admin and owner see tracking digits. Staff do not. */
  seeTracking?: boolean;
  refreshKey?: number;
  onPullReady?: () => void;
};

type TrackEvent = { status?: string; status_detail?: string | null; location?: string | null; occurred_at?: string | null };

export function AppOrders({ client, storeId, accessToken, money, stamp, isAdmin = false, seeTracking = false, refreshKey = 0, onPullReady }: Props) {
  const [seg, setSeg] = useState<Seg>('toShip');
  const [shipTarget, setShipTarget] = useState<WebOrder | null>(null);
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
  const mergePhotoUrls = useCallback((extra: Record<string, string>) => {
    if (!Object.keys(extra).length) return;
    setPhotoUrls((prev) => {
      const next = { ...prev, ...extra };
      persistPhotoUrlCache(`${storeId}:orders`, next);
      return next;
    });
  }, [storeId]);
  const [locationOptions, setLocationOptions] = useState<{ code: string }[]>([]);
  const [busy, setBusy] = useState('');
  const [labelOpen, setLabelOpen] = useState(false);
  const [trackingDraft, setTrackingDraft] = useState('');
  const [labelHit, setLabelHit] = useState<{ number: string; carrier?: string | null; layer?: string | null } | null>(null);
  const [trackingPick, setTrackingPick] = useState<LabelUploadResponse['tracking_candidates']>();
  const packProofInput = useRef<HTMLInputElement>(null);
  const labelInput = useRef<HTMLInputElement>(null);
  const tabRowRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const { data, error: e } = await client.rpc('portal_web_orders', { p_days: 400 });
      if (e) throw e;
      const raw = Array.isArray(data) ? (data as WebOrder[]) : [];
      const list = raw.filter((o) => o.payment_env !== 'sandbox' && !(o.order_no || '').toLowerCase().startsWith('sandbox'));
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
  }, [client, mergePhotoUrls, storeId]);

  useVisibleInterval(load, 60_000);

  useEffect(() => {
    if (!refreshKey) return;
    void load().finally(() => onPullReady?.());
  }, [refreshKey, load, onPullReady]);

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

  useEffect(() => {
    const root = tabRowRef.current;
    if (!root) return;
    const active = root.querySelector('button.active');
    if (active instanceof HTMLElement) active.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [seg]);

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
    if (isAdmin) {
      const at = (a.order_no || '') === 'TEST-SHIP-FLOW' ? -1 : 0;
      const bt = (b.order_no || '') === 'TEST-SHIP-FLOW' ? -1 : 0;
      if (at !== bt) return at - bt;
    }
    if (seg !== 'needsLabel' && seg !== 'toShip' && seg !== 'packaged') return 0;
    return locationCompare(locations[a.sku]?.[0] || '99999', locations[b.sku]?.[0] || '99999');
  });

  const hasTestOrder = Boolean(orders?.some((o) => (o.order_no || '') === 'TEST-SHIP-FLOW'));

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

  async function markShipped(o: WebOrder, barcode: string, overrideReason?: string) {
    let ok = false;
    await runAction('shipped', async () => {
      const { error: e } = await client.rpc('portal_mark_order_shipped', {
        p_order: o.id,
        p_barcode: barcode || null,
        p_override_reason: overrideReason || null,
      });
      if (e) {
        const msg = e.message === 'order_not_packaged'
          ? 'Tap Packaged before marking it shipped.'
          : e.message === 'tracking_mismatch'
            ? "Doesn't match this order — check the package"
            : e.message === 'tracking_required'
              ? 'Scan or type the tracking number on the label.'
              : e.message === 'override_reason_required'
                ? 'An admin note is required when there is no tracking on file.'
                : e.message === 'portal_access_denied'
                  ? 'Only an admin can override a missing tracking number.'
                  : e.message;
        throw new Error(msg);
      }
      ok = true;
    });
    return ok;
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
    if (!isAdmin) return;
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

  async function ensureTestShipOrder() {
    if (!isAdmin) return;
    setError('');
    setBusy('test-order');
    try {
      const { error: e } = await client.rpc('portal_reset_test_ship_flow_order');
      if (e) throw e;
      setSeg('toShip');
      await load();
    } catch (e) {
      const msg = errText(e);
      setError(shortError(msg));
    } finally {
      setBusy('');
    }
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
      await openShippingLabel(url, download, client);
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
      }) as LabelUploadResponse;
      const ui = labelUploadUi(data);
      setLabelHit(null);
      setTrackingPick(undefined);
      setError('');
      if (ui.kind === 'manual') setError(ui.message);
      else if (ui.kind === 'mismatch') setError('');
      else if (ui.kind === 'picker') setTrackingPick(ui.candidates);
      else if (ui.kind === 'hit') {
        setLabelHit({ number: ui.number, carrier: ui.carrier, layer: ui.layer });
        setTrackingDraft(ui.number);
      }
    });
  }

  async function confirmPickedTracking(o: WebOrder, number: string, carrier?: string | null) {
    await runAction('tracking', async () => {
      await orderAdmin(accessToken, { action: 'set_tracking', id: o.id, tracking: number, carrier: carrier || o.carrier || 'USPS' });
      setTrackingPick(undefined);
      setLabelHit({ number, carrier: carrier || o.carrier });
      setTrackingDraft(number);
      setError('');
    });
  }

  async function saveTracking(o: WebOrder) {
    await runAction('tracking', async () => {
      await orderAdmin(accessToken, { action: 'set_tracking', id: o.id, tracking: trackingDraft, carrier: o.carrier || '' });
    });
  }

  async function useMarketplaceTracking(o: WebOrder) {
    await runAction('ebay-track', async () => {
      const data = await orderAdmin(accessToken, { action: 'accept_marketplace_tracking', id: o.id });
      const ord = data.order as WebOrder | undefined;
      if (ord?.tracking_number) {
        setTrackingDraft(ord.tracking_number);
        setLabelHit({ number: ord.tracking_number, carrier: ord.carrier });
      }
      setError('');
    });
  }

  async function useLabelTracking(o: WebOrder, number: string, carrier: string) {
    await runAction('label-track', async () => {
      const data = await orderAdmin(accessToken, { action: 'accept_label_tracking', id: o.id, tracking: number, carrier });
      const ord = data.order as WebOrder | undefined;
      if (ord?.tracking_number) setTrackingDraft(ord.tracking_number);
      setError('');
    });
  }

  async function retryLabelExtract(o: WebOrder) {
    await runAction('retry-extract', async () => {
      const data = await orderAdmin(accessToken, { action: 'retry_label_extract', id: o.id });
      if (data.tracking_number) {
        setLabelHit({ number: String(data.tracking_number), carrier: data.carrier as string, layer: data.layer as string });
        setTrackingDraft(String(data.tracking_number));
      }
      if (data.mismatch) setError('');
      else setError('');
    });
  }

  async function manualTracking(o: WebOrder, number: string, carrier: string) {
    await runAction('tracking', async () => {
      await orderAdmin(accessToken, { action: 'set_tracking', id: o.id, tracking: number, carrier });
      setTrackingDraft(number);
      setError('');
    });
  }

  async function voidLabel(o: WebOrder) {
    if (!window.confirm('Void this label with the carrier and reverse the Floor shipping expense?')) return;
    await runAction('void', async () => {
      await orderAdmin(accessToken, { action: 'void_label', id: o.id, force: true });
    });
  }

  async function setPackCondition(o: WebOrder, status: 'ok' | 'not_as_listed') {
    await runAction('pack', async () => {
      const res = await fetch(floorFunctionUrl('web-order-admin'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'pack_condition', id: o.id, status }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) {
        const { error: rpcErr } = await client.rpc('portal_set_pack_condition', { p_order: o.id, p_status: status });
        if (rpcErr) throw new Error(body.error || rpcErr.message);
      }
      if (status === 'not_as_listed') setError(`SKU ${o.sku} marked not as listed. The owner is alerted. Do not buy a label.`);
    });
  }

  async function recordLabelCost(o: WebOrder) {
    if (o.pack_condition !== 'ok') {
      setError('Confirm the item matches the listing before recording a label cost.');
      return;
    }
    const current = o.label_cost_cents != null ? (o.label_cost_cents / 100).toFixed(2) : '';
    const raw = window.prompt(
      `Label cost for ${CHANNEL[(o.channel || 'website').toLowerCase()] || o.channel} order ${o.order_no || o.id} (USD).`,
      current,
    );
    if (raw == null) return;
    const cents = Math.round(Number(String(raw).replace(/[$,\s]/g, '')) * 100);
    if (!Number.isFinite(cents) || cents < 0 || cents > 50000) {
      setError('Enter a valid label cost between $0 and $500.');
      return;
    }
    await runAction('label-cost', async () => {
      const { error: e } = await client.rpc('portal_set_order_label_cost', { p_order: o.id, p_label_cents: cents });
      if (e) throw e;
    });
  }

  if (open) {
    return (
      <AppOrderDetail
        client={client}
        storeId={storeId}
        accessToken={accessToken}
        order={open}
        money={money}
        stamp={stamp}
        isAdmin={isAdmin}
        busy={busy}
        error={error}
        locationCode={locations[open.sku]?.[0] || ''}
        locationOptions={locationOptions}
        photos={photoMap[open.sku] || []}
        photoUrls={photoUrls}
        sign={sign}
        events={events}
        trackingDraft={trackingDraft}
        onTrackingDraft={setTrackingDraft}
        onBack={() => setOpen(null)}
        onSetLocation={(code) => void setPickLocation(open, code)}
        onPrintLabel={(dl) => void printLabel(open, dl)}
        onMarkPackaged={() => void markPackaged(open)}
        onMarkShipped={(barcode, reason) => markShipped(open, barcode, reason)}
        showTracking={seeTracking}
        onMarkDelivered={() => void markDelivered(open)}
        onStepBack={() => void stepBack(open)}
        onFloorCancel={() => void floorCancel(open)}
        onSaveTracking={() => void saveTracking(open)}
        onUploadLabel={() => labelInput.current?.click()}
        onUploadPackProof={() => packProofInput.current?.click()}
        onVoidLabel={() => void voidLabel(open)}
        onRecordLabelCost={isAdmin ? () => void recordLabelCost(open) : undefined}
        labelInputRef={labelInput}
        packProofInputRef={packProofInput}
        onLabelOpen={() => setLabelOpen(true)}
        labelOpen={labelOpen}
        onLabelClose={() => setLabelOpen(false)}
        onReload={load}
        onUrl={(p, u) => mergePhotoUrls({ [p]: u })}
        onLabelFile={(f) => void uploadLabel(open, f)}
        onPackProofFile={(f) => void uploadPackProof(open, f)}
        labelHit={labelHit}
        trackingPick={trackingPick}
        onConfirmTrackingPick={(n, c) => void confirmPickedTracking(open, n, c)}
        onDismissLabelHit={() => setLabelHit(null)}
        onUseMarketplaceTracking={() => void useMarketplaceTracking(open)}
        onUseLabelTracking={(n, c) => void useLabelTracking(open, n, c)}
        onRetryLabelExtract={() => void retryLabelExtract(open)}
        onManualTracking={(n, c) => void manualTracking(open, n, c)}
      />
    );
  }

  const stale = buckets.packaged.filter((o) => packagedStale(o)).length;
  const late = buckets.shipped.filter((o) => shippedStale(o)).length;
  if (scanOut) {
    return <ScanOutPanel client={client} storeId={storeId} stamp={stamp} appMode onClose={() => setScanOut(false)} />;
  }
  return (
    <>
      <div className="orders-sticky-head">
      <p className="orders-screen-eyebrow">Orders · {SEG_SHORT[seg]}</p>
      <div className="app-segment app-segment-scroll orders-segment" role="tablist" ref={tabRowRef}>
        {((isAdmin ? [
          ['needsLabel', 'Needs label', buckets.needsLabel.length],
          ['toShip', 'To ship', buckets.toShip.length],
          ['packaged', 'Packaged', buckets.packaged.length],
          ['shipped', 'Shipped', buckets.shipped.length],
          ['delivered', 'Delivered', buckets.delivered.length],
          ['canceled', 'Canceled', buckets.canceled.length],
        ] : [
          ['toShip', 'To ship', buckets.toShip.length],
          ['packaged', 'Packaged', buckets.packaged.length],
        ]) as [Seg, string, number][]).map(([id, label, n]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={seg === id}
            className={seg === id ? 'active' : ''}
            onClick={() => setSeg(id)}
          >
            {label} {n}
          </button>
        ))}
      </div>
      </div>
      {seg === 'needsLabel' ? <p className="orders-seg-note subtle">{SEG_NOTE[seg]}</p> : <p className="orders-seg-note">{SEG_NOTE[seg]}</p>}
      {seg === 'packaged' && (
        <>
          <p className="app-flag">{stale > 0 ? `${stale} packaged over 2 days and not marked shipped.` : 'Flags anything packaged over 2 days and not marked shipped.'}</p>
          <button type="button" className="secondary orders-scan-out" onClick={() => setScanOut(true)}>Scan out</button>
        </>
      )}
      {seg === 'shipped' && (
        <p className="app-flag">{late > 0 ? `${late} shipped over 10 days and not marked delivered.` : 'Flags anything shipped over 10 days and not marked delivered.'}</p>
      )}
      {error && <p className="app-inline-error">{error}</p>}
      {isAdmin && seg === 'toShip' && !hasTestOrder && (
        <p className="app-flag">
          No <strong>TEST-SHIP-FLOW</strong> order in this store.
          {' '}
          <button type="button" className="secondary" disabled={!!busy} onClick={() => void ensureTestShipOrder()}>
            {busy === 'test-order' ? '…' : 'Add test To ship order'}
          </button>
        </p>
      )}
      {!isAdmin && seg === 'toShip' && orders && rows.length === 0 && (
        <p className="app-flag subtle">
          Nothing in <strong>To ship</strong> on the associate desk. eBay/Depop waiting on a label stay on the admin desk only.
          {hasTestOrder ? ' Pull down to refresh if you expect TEST-SHIP-FLOW.' : ' Ask an admin to add TEST-SHIP-FLOW or finish a labeled order.'}
        </p>
      )}
      <div className="app-group">
        {!orders && <div className="app-empty-row">Loading…</div>}
        {orders && rows.length === 0 && <div className="app-empty-row">None right now</div>}
        {rows.map((o) => {
          const chName = CHANNEL[(o.channel || 'website').toLowerCase()] || o.channel || 'Website';
          const tail = seeTracking && !orderNeedsLabel(o) ? trackingTail(o) : '';
          const thumbPhoto = listThumbPhoto(photoMap[o.sku] || []);
          const thumbPath = thumbPhoto?.path || null;
          const rowPackaged = seg === 'toShip' && orderCanMarkPackaged(o);
          return (
            <AppOrderRow
              key={o.id}
              order={o}
              client={client}
              thumbPath={thumbPath}
              photoUrls={photoUrls}
              locationCode={locations[o.sku]?.[0]}
              money={money}
              hideMoney={!isAdmin}
              channelName={chName}
              trackingTail={tail}
              onOpen={() => setOpen(o)}
              onPrint={hasLabel(o) ? () => void printLabel(o) : undefined}
              onUrl={(p, u) => mergePhotoUrls({ [p]: u })}
              showUpload={isAdmin && orderNeedsLabel(o)}
              onUpload={(f) => void uploadLabel(o, f)}
              showStepBack={isAdmin && orderCanStepBack(o)}
              onStepBack={isAdmin ? () => void stepBack(o) : undefined}
              showPackaged={rowPackaged}
              onPackaged={() => void markPackaged(o)}
              packagedBusy={busy === 'packaged'}
              showMarkShipped={seg === 'packaged'}
              onMarkShipped={() => { setError(''); setShipTarget(o); }}
            />
          );
        })}
      </div>
      {shipTarget && (
        <AppOrderShipVerifySheet
          order={shipTarget}
          isAdmin={isAdmin}
          busy={busy === 'shipped'}
          error={error}
          onClose={() => { setShipTarget(null); setError(''); }}
          onConfirm={async (barcode, reason) => {
            const ok = await markShipped(shipTarget, barcode, reason);
            if (ok) setShipTarget(null);
          }}
        />
      )}
    </>
  );
}
