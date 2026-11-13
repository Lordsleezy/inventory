import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { type WebOrder } from '../OrdersPage';
import { hydratePhotoUrlCache, listThumbOriginalPaths, listThumbPhoto, loadUnitPhotos, persistPhotoUrlCache, signListThumbs, signPhotoUrls, type UnitPhoto } from '../unitPhotos';
import { errText } from '../errText';
import { shortError } from './shortError';
import { loadOrderLocations, locationCompare } from '../locationOrder';
import { sortLocationChoices, type LocationChoice } from '../locationPlace';
import { fileToBase64, labelFileUrl, orderAdmin } from '../orderLabel';
import { openShippingLabel } from '../labelPrint';
import { hasLabel, orderCanMarkPackaged, orderNeedsLabel, orderStage, packagedStale, shippedStale, trackingTail, type OrderStage } from '../orderStage';
import { useVisibleInterval } from '../useVisibleInterval';
import { ScanOutPanel } from '../ScanOutPanel';
import { SEG_SHORT } from '../orderDisplay';
import { AppOrderDetail } from './AppOrderDetail';
import { AppOrderRow } from './AppOrderRow';
import { AppShipmentCard, type ShipmentView } from './AppShipmentCard';
import { AppShipmentDetail } from './AppShipmentDetail';
import { AppOrderShipVerifySheet } from './AppOrderShipVerifySheet';
import { floorFunctionUrl } from '../floorApi';
import { shipBundleRest } from '../bundleShip';
import { labelUploadUi, type LabelUploadResponse } from '../labelUploadFeedback';
import { LabelTrackingPicker, LabelTrackingResult } from '../LabelTrackingResult';
import {
  BundleShipToForm,
  emptyShipTo,
  shipToReady,
  type ShipToDraft,
} from '../BundleShipToForm';
import {
  canManualBundle,
  canUnbundle,
  dedupeOrders,
  listShipments,
  suggestBundleGroups,
} from '../orderShipments';

type Seg = 'verifyWeight' | 'needsLabel' | 'toShip' | 'packaged' | 'shipped' | 'delivered' | 'canceled';

const CHANNEL: Record<string, string> = {
  website: 'Website', ebay: 'eBay', amazon: 'Amazon', tiktok: 'TikTok', depop: 'Depop', mercari: 'Mercari',
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
  const [seg, setSeg] = useState<Seg>('verifyWeight');
  const [shipTarget, setShipTarget] = useState<WebOrder | null>(null);
  const [scanOut, setScanOut] = useState(false);
  const [orders, setOrders] = useState<WebOrder[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<WebOrder | null>(null);
  const [openShipmentId, setOpenShipmentId] = useState<string | null>(null);
  const [events, setEvents] = useState<TrackEvent[]>([]);
  const [locations, setLocations] = useState<Record<string, string[]>>({});
  const [bundleNote, setBundleNote] = useState('');
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
  const [locationOptions, setLocationOptions] = useState<LocationChoice[]>([]);
  const [busy, setBusy] = useState('');
  const [labelOpen, setLabelOpen] = useState(false);
  const [trackingDraft, setTrackingDraft] = useState('');
  const [labelHit, setLabelHit] = useState<{ number: string; carrier?: string | null; layer?: string | null } | null>(null);
  const [trackingPick, setTrackingPick] = useState<LabelUploadResponse['tracking_candidates']>();
  const [bundleLinks, setBundleLinks] = useState<{ order_id: string; peer_id: string }[]>([]);
  const [bundleSplits, setBundleSplits] = useState<string[]>([]);
  const [bundleRates, setBundleRates] = useState<unknown[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [expandedIds, setExpandedIds] = useState<string[]>([]);
  const [shipToDraft, setShipToDraft] = useState<ShipToDraft>(() => emptyShipTo());
  const packProofInput = useRef<HTMLInputElement>(null);
  const labelInput = useRef<HTMLInputElement>(null);
  const tabRowRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const { data, error: e } = await client.rpc('portal_web_orders', { p_days: 400 });
      if (e) throw e;
      const raw = Array.isArray(data) ? (data as WebOrder[]) : [];
      const list = dedupeOrders(raw.filter((o) => o.payment_env !== 'sandbox' && !(o.order_no || '').toLowerCase().startsWith('sandbox'))) as WebOrder[];
      setOrders(list);
      setOpen((prev) => (prev ? list.find((o) => o.id === prev.id) || prev : null));
      // Keep shipment detail open across reload when the bundle still exists.
      const skus = [...new Set(list.map((o) => o.sku).filter(Boolean))];
      setLocations(await loadOrderLocations(client, storeId, skus));
      const photos = await loadUnitPhotos(client, storeId, skus).catch(() => ({} as Record<string, UnitPhoto[]>));
      setPhotoMap(photos);
      mergePhotoUrls(await signListThumbs(client, listThumbOriginalPaths(photos)));
      const { data: bayList } = await client.rpc('portal_bay_list');
      const spots = sortLocationChoices(((bayList as { locations?: LocationChoice[] } | null)?.locations) || []);
      if (spots.length) setLocationOptions(spots);
      else {
        const { data: bins } = await client.from('store_locations').select('code,bay_no,row_no,bin_no').eq('store_id', storeId).order('bay_no').order('row_no').order('bin_no');
        setLocationOptions((bins || []) as LocationChoice[]);
      }
      const { data: bundleState } = await client.rpc('portal_bundle_state');
      const state = (bundleState || {}) as { links?: { order_id: string; peer_id: string }[]; splits?: string[]; rates?: unknown[] };
      setBundleLinks(Array.isArray(state.links) ? state.links : []);
      setBundleSplits((state.splits || []).map(String));
      setBundleRates(Array.isArray(state.rates) ? state.rates : []);
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
      verifyWeight: put('verifyWeight'),
      needsLabel: put('needsLabel'),
      toShip: put('toShip'),
      packaged: put('packaged'),
      shipped: put('shipped'),
      delivered: put('delivered'),
      canceled: put('canceled'),
    };
  }, [orders]);

  const bundleOpts = useMemo(() => ({
    links: bundleLinks,
    splitIds: bundleSplits,
    rates: bundleRates,
  }), [bundleLinks, bundleSplits, bundleRates]);

  const shipmentBuckets = useMemo(() => {
    const groupSegs: Seg[] = ['verifyWeight', 'needsLabel', 'toShip', 'packaged'];
    const out: Record<Seg, ShipmentView[]> = {
      verifyWeight: [], needsLabel: [], toShip: [], packaged: [], shipped: [], delivered: [], canceled: [],
    };
    for (const key of Object.keys(buckets) as Seg[]) {
      const lines = buckets[key];
      if (groupSegs.includes(key)) {
        const ships = listShipments(lines, bundleOpts) as ShipmentView[];
        ships.sort((a, b) => {
          if (isAdmin) {
            const at = a.items.some((o) => o.order_no === 'TEST-SHIP-FLOW') ? -1 : 0;
            const bt = b.items.some((o) => o.order_no === 'TEST-SHIP-FLOW') ? -1 : 0;
            if (at !== bt) return at - bt;
          }
          return locationCompare(
            locations[a.lead.sku]?.[0] || '99999',
            locations[b.lead.sku]?.[0] || '99999',
          );
        });
        out[key] = ships;
      } else {
        out[key] = lines.map((o) => ({
          id: o.id, bundled: false, itemCount: 1, items: [o], lead: o, package: null,
        }));
      }
    }
    return out;
  }, [buckets, bundleOpts, isAdmin, locations]);

  const shipments = shipmentBuckets[seg] || [];
  const openShipment = useMemo(() => {
    if (!openShipmentId) return null;
    for (const key of Object.keys(shipmentBuckets) as Seg[]) {
      const hit = shipmentBuckets[key].find((row) => row.id === openShipmentId);
      if (hit) return hit;
    }
    return null;
  }, [openShipmentId, shipmentBuckets]);
  useEffect(() => {
    if (openShipmentId && !openShipment) setOpenShipmentId(null);
  }, [openShipmentId, openShipment]);
  const selectMode = isAdmin && (seg === 'needsLabel' || seg === 'toShip');
  const selectedOrders = useMemo(() => {
    const ids = new Set(selectedIds);
    return (orders || []).filter((o) => ids.has(o.id));
  }, [orders, selectedIds]);
  const bundleReady = canManualBundle(selectedOrders);
  useEffect(() => {
    if (selectedOrders.length < 2) return;
    setShipToDraft((prev) => {
      if (prev.ship_line1 || prev.ship_city || prev.ship_postal) return prev;
      const buyer = selectedOrders.find((o) => o.buyer_name && !/^depop buyer$/i.test(o.buyer_name))?.buyer_name
        || selectedOrders[0]?.buyer_name
        || '';
      return emptyShipTo(buyer);
    });
  }, [selectedIds.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps -- reset draft when selection set changes
  const suggestions = useMemo(() => {
    if (!selectMode) return [] as { id: string; buyer: string; itemCount: number; ids: string[] }[];
    const lines = (seg === 'needsLabel' ? buckets.needsLabel : buckets.toShip) || [];
    return suggestBundleGroups(lines, bundleOpts) as { id: string; buyer: string; itemCount: number; ids: string[] }[];
  }, [selectMode, seg, buckets, bundleOpts]);
  const suggestById = useMemo(() => {
    const map = new Map<string, string>();
    for (const group of suggestions) {
      const hint = `Same buyer: Bundle? (${group.itemCount})`;
      for (const id of group.ids) map.set(id, hint);
    }
    return map;
  }, [suggestions]);

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
        p_barcode: barcode.trim() || null,
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
      const extra = await shipBundleRest(client, o.id, barcode);
      if (extra) setBundleNote(extra);
    });
    return ok;
  }

  async function markDelivered(o: WebOrder) {
    await runAction('delivered', async () => {
      const { error: e } = await client.rpc('portal_mark_order_delivered', { p_order: o.id });
      if (e) throw new Error(e.message === 'portal_access_denied' ? 'Only an admin can mark an order delivered.' : e.message);
    });
  }

  async function markShipmentDelivered(shipment: ShipmentView) {
    await runAction('delivered', async () => {
      for (const order of shipment.items) {
        if (order.delivered_at) continue;
        const { error: e } = await client.rpc('portal_mark_order_delivered', { p_order: order.id });
        if (e) throw new Error(e.message === 'portal_access_denied' ? 'Only an admin can mark an order delivered.' : e.message);
      }
    });
  }

  async function markPackaged(o: WebOrder) {
    await runAction('packaged', async () => {
      const { error: e } = await client.rpc('portal_mark_order_packaged', { p_order: o.id });
      if (e) {
        throw new Error(e.message === 'pack_proof_required'
          ? 'Upload a pack photo of the unit before marking it packaged.'
          : e.message === 'weight_required'
            ? 'Verify the item weight before packaging.'
            : e.message);
      }
    });
  }

  async function verifyOrderWeight(o: WebOrder, weightLb: number, confirmed = false) {
    await runAction('weight', async () => {
      const { error: e } = await client.rpc('portal_verify_order_weight', {
        p_order: o.id, p_weight_lb: weightLb, p_confirmed: confirmed,
      });
      if (e) {
        throw new Error(e.message === 'invalid_weight'
          ? 'Enter a weight greater than 0 and under 200 lb.'
          : e.message);
      }
    });
  }

  async function markShipmentPackaged(shipment: ShipmentView) {
    await runAction('packaged', async () => {
      for (const order of shipment.items) {
        if (!orderCanMarkPackaged(order) && order.packaged_at) continue;
        const { error: e } = await client.rpc('portal_mark_order_packaged', { p_order: order.id });
        if (e) {
          throw new Error(e.message === 'pack_proof_required'
            ? `Upload a pack photo for SKU ${order.sku} before marking the box packaged.`
            : e.message);
        }
      }
    });
  }

  async function bundleSelected() {
    let check = canManualBundle(selectedOrders);
    const needsShipTo = !check.ok && check.reason === 'missing_address';
    if (!check.ok && !needsShipTo) {
      setError(check.message || 'Cannot bundle those orders.');
      return;
    }
    if (needsShipTo && !shipToReady(shipToDraft)) {
      setError(check.message || 'Enter the ship-to address, then Bundle.');
      return;
    }
    const buyerLabel = (needsShipTo ? shipToDraft.buyer_name : selectedOrders[0].buyer_name) || 'this buyer';
    const clearNote = check.clearsLabels || (needsShipTo && selectedOrders.some((o) => o.tracking_number || o.label_uploaded_at))
      ? '\n\nAny existing labels/tracking on these lines will be cleared so you can upload ONE shared label for the box.'
      : '\n\nNext: upload one shipping label for the whole box.';
    if (!window.confirm(
      `Bundle ${selectedOrders.length} items for ${buyerLabel} into one shipment?${clearNote}`,
    )) return;
    await runAction('bundle', async () => {
      const ids = selectedOrders.map((o) => o.id);
      if (needsShipTo) {
        const { error: shipErr } = await client.rpc('portal_set_order_ship_to', {
          p_ids: ids,
          p_buyer_name: shipToDraft.buyer_name.trim() || null,
          p_line1: shipToDraft.ship_line1.trim(),
          p_line2: shipToDraft.ship_line2.trim() || null,
          p_city: shipToDraft.ship_city.trim(),
          p_region: shipToDraft.ship_region.trim(),
          p_postal: shipToDraft.ship_postal.trim(),
          p_country: 'US',
        });
        if (shipErr) {
          throw new Error(shipErr.message === 'missing_address'
            ? 'Enter street, city, state, and ZIP.'
            : shipErr.message);
        }
      }
      const { error: e } = await client.rpc('portal_bundle_orders', { p_ids: ids });
      if (e) {
        const msg = e.message === 'different_buyer' ? 'Different buyers — cannot bundle.'
          : e.message === 'different_address' ? 'Ship-to addresses do not match — cannot bundle.'
            : e.message === 'not_open' ? 'One of those is already packaged or shipped.'
              : e.message === 'different_channel' ? 'Those orders are on different channels.'
                : e.message;
        throw new Error(msg);
      }
      setSelectedIds([]);
      setShipToDraft(emptyShipTo());
    });
  }

  async function unbundleShipment(shipment: ShipmentView) {
    const check = canUnbundle(shipment.items);
    if (!check.ok) {
      setError(check.message || 'Cannot unbundle.');
      return;
    }
    if (!window.confirm(`Split these ${shipment.itemCount} items back into separate rows?`)) return;
    await runAction('unbundle', async () => {
      const { error: e } = await client.rpc('portal_unbundle_orders', { p_ids: shipment.items.map((o) => o.id) });
      if (e) {
        throw new Error(e.message === 'label_exists'
          ? 'Unbundle is blocked while a label is on the shipment. Void the label first.'
          : e.message);
      }
    });
  }

  function toggleSelectOrder(order: WebOrder) {
    setSelectedIds((prev) => (
      prev.includes(order.id) ? prev.filter((id) => id !== order.id) : [...prev, order.id]
    ));
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

  async function stepBackShipment(shipment: ShipmentView) {
    if (!isAdmin) return;
    const lead = shipment.lead;
    const step = lead.delivered_at ? 'Delivered → Shipped'
      : lead.shipped_at ? (lead.packaged_at ? 'Shipped → Packaged' : 'Shipped → To ship')
        : lead.packaged_at ? 'Packaged → To ship'
          : '';
    if (!step) { setError('There is no completed fulfillment step to undo.'); return; }
    if (!window.confirm(`Are you sure? Move this whole shipment back one step (${step}). The sale and money stay unchanged.`)) return;
    await runAction('step-back', async () => {
      for (const order of shipment.items) {
        const { error: e } = await client.rpc('portal_order_step_back', { p_order: order.id });
        if (e) throw new Error(e.message === 'portal_access_denied' ? 'Only an owner or manager can move an order back.' : e.message);
      }
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
      if (!url) {
        setError('No label file on this order yet.');
        return;
      }
      await openShippingLabel(url, download, client);
    } catch (e) {
      setError(shortError(errText(e)));
    } finally {
      setBusy('');
    }
  }

  function openOrderOrShipment(o: WebOrder) {
    const ship = listShipments(orders || [], { links: bundleLinks, splitIds: bundleSplits, rates: bundleRates as never[] })
      .find((row) => row.items.some((item: WebOrder) => item.id === o.id));
    if (ship?.bundled) {
      setOpen(null);
      setOpenShipmentId(ship.id);
    } else {
      setOpenShipmentId(null);
      setOpen(o);
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
      if (ui.kind === 'manual') {
        // Open the detail page so the tracking field is actually on screen.
        openOrderOrShipment(o);
        setError('');
      } else if (ui.kind === 'mismatch') {
        openOrderOrShipment(o);
        setError('');
      } else if (ui.kind === 'picker') {
        openOrderOrShipment(o);
        setTrackingPick(ui.candidates);
      } else if (ui.kind === 'hit') {
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

  if (openShipment) {
    const lead = openShipment.lead;
    const unbundleOk = canUnbundle(openShipment.items).ok;
    return (
      <AppShipmentDetail
        client={client}
        shipment={openShipment}
        money={money}
        isAdmin={isAdmin}
        showTracking={seeTracking}
        busy={busy}
        error={error}
        locations={locations}
        locationOptions={locationOptions}
        photoMap={photoMap}
        photoUrls={photoUrls}
        trackingDraft={trackingDraft}
        onTrackingDraft={setTrackingDraft}
        onBack={() => setOpenShipmentId(null)}
        onSetLocation={(order, code) => void setPickLocation(order, code)}
        onPrintLabel={(dl) => void printLabel(lead, dl)}
        onMarkPackaged={() => void markShipmentPackaged(openShipment)}
        onMarkShipped={(barcode, reason) => markShipped(lead, barcode, reason)}
        onMarkDelivered={() => void markShipmentDelivered(openShipment)}
        onStepBack={() => void stepBackShipment(openShipment)}
        onSaveTracking={() => void saveTracking(lead)}
        onUploadLabel={() => labelInput.current?.click()}
        onVoidLabel={() => void voidLabel(lead)}
        labelInputRef={labelInput}
        onUrl={(p, u) => mergePhotoUrls({ [p]: u })}
        onLabelFile={(f) => void uploadLabel(lead, f)}
        labelHit={labelHit}
        trackingPick={trackingPick}
        onConfirmTrackingPick={(n, c) => void confirmPickedTracking(lead, n, c)}
        onDismissLabelHit={() => setLabelHit(null)}
        onUseMarketplaceTracking={() => void useMarketplaceTracking(lead)}
        onUseLabelTracking={(n, c) => void useLabelTracking(lead, n, c)}
        onRetryLabelExtract={() => void retryLabelExtract(lead)}
        onManualTracking={(n, c) => void manualTracking(lead, n, c)}
        showUnbundle={isAdmin && unbundleOk}
        onUnbundle={() => void unbundleShipment(openShipment).then(() => setOpenShipmentId(null))}
        unbundleBusy={busy === 'unbundle'}
      />
    );
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
        onVerifyWeight={(lb, confirmed) => void verifyOrderWeight(open, lb, confirmed)}
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
          ['verifyWeight', 'Verify weight', shipmentBuckets.verifyWeight.length],
          ['needsLabel', 'Needs label', shipmentBuckets.needsLabel.length],
          ['toShip', 'To ship', shipmentBuckets.toShip.length],
          ['packaged', 'Packaged', shipmentBuckets.packaged.length],
          ['shipped', 'Shipped', buckets.shipped.length],
          ['delivered', 'Delivered', buckets.delivered.length],
          ['canceled', 'Canceled', buckets.canceled.length],
        ] : [
          ['verifyWeight', 'Verify weight', shipmentBuckets.verifyWeight.length],
          ['toShip', 'To ship', shipmentBuckets.toShip.length],
          ['packaged', 'Packaged', shipmentBuckets.packaged.length],
        ]) as [Seg, string, number][]).map(([id, label, n]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={seg === id}
            className={seg === id ? 'active' : ''}
            onClick={() => { setSeg(id); setSelectedIds([]); }}
          >
            {label} {n}
          </button>
        ))}
      </div>
      </div>
      {seg === 'packaged' && (
        <>
          {stale > 0 ? <p className="app-flag">{stale} packaged over 2 days and not marked shipped.</p> : null}
          <button type="button" className="secondary orders-scan-out" onClick={() => setScanOut(true)}>Scan out</button>
        </>
      )}
      {seg === 'shipped' && late > 0 && (
        <p className="app-flag">{late} shipped over 10 days and not marked delivered.</p>
      )}
      {error && <p className="app-inline-error">{error}</p>}
      {bundleNote && <p className="app-flag">{bundleNote}</p>}
      <div className={`app-group${selectMode && selectedIds.length >= 2 ? ' has-bundle-bar' : ''}${selectMode && selectedIds.length >= 2 && bundleReady.reason === 'missing_address' ? ' has-ship-to' : ''}`}>
        {!orders && <div className="app-empty-row">Loading…</div>}
        {orders && shipments.length === 0 && <div className="app-empty-row">None right now</div>}
        {shipments.map((shipment) => {
          const lead = shipment.lead;
          const chName = CHANNEL[(lead.channel || 'website').toLowerCase()] || lead.channel || 'Website';
          const tail = seeTracking && !orderNeedsLabel(lead) ? trackingTail(lead) : '';
          if (shipment.bundled) {
            const rowPackaged = seg === 'toShip' && shipment.items.every((o) => orderCanMarkPackaged(o) || o.packaged_at);
            const unbundleOk = canUnbundle(shipment.items).ok;
            return (
              <AppShipmentCard
                key={shipment.id}
                shipment={shipment}
                client={client}
                photoMap={photoMap}
                photoUrls={photoUrls}
                locations={locations}
                money={money}
                hideMoney={!isAdmin}
                channelName={chName}
                trackingTail={tail}
                onOpen={(o) => { setOpenShipmentId(null); setOpen(o); }}
                onOpenShipment={() => { setOpen(null); setOpenShipmentId(shipment.id); }}
                onUrl={(p, u) => mergePhotoUrls({ [p]: u })}
                showAddWeight={seg === 'verifyWeight'}
                onAddWeight={() => { setOpenShipmentId(null); setOpen(lead); }}
                showUpload={seg === 'needsLabel' && isAdmin && orderNeedsLabel(lead)}
                onUpload={(f) => void uploadLabel(lead, f)}
                onPrint={hasLabel(lead) ? () => void printLabel(lead) : undefined}
                showPackaged={rowPackaged && shipment.items.some((o) => orderCanMarkPackaged(o))}
                onPackaged={() => void markShipmentPackaged(shipment)}
                packagedBusy={busy === 'packaged'}
                showMarkShipped={seg === 'packaged'}
                onMarkShipped={() => { setError(''); setShipTarget(lead); }}
                showUnbundle={isAdmin && unbundleOk}
                onUnbundle={() => void unbundleShipment(shipment)}
                unbundleBusy={busy === 'unbundle'}
                expanded={expandedIds.includes(shipment.id)}
                onToggleExpand={() => setExpandedIds((prev) => (
                  prev.includes(shipment.id) ? prev.filter((id) => id !== shipment.id) : [...prev, shipment.id]
                ))}
              />
            );
          }
          const o = lead;
          const thumbPhoto = listThumbPhoto(photoMap[o.sku] || []);
          return (
            <AppOrderRow
              key={o.id}
              order={o}
              client={client}
              thumbPath={thumbPhoto?.path || null}
              photoUrls={photoUrls}
              locationCode={locations[o.sku]?.[0]}
              money={money}
              hideMoney={!isAdmin}
              channelName={chName}
              trackingTail={tail}
              onOpen={() => setOpen(o)}
              onPrint={hasLabel(o) ? () => void printLabel(o) : undefined}
              onUrl={(p, u) => mergePhotoUrls({ [p]: u })}
              showAddWeight={seg === 'verifyWeight'}
              onAddWeight={() => setOpen(o)}
              showUpload={seg === 'needsLabel' && isAdmin && orderNeedsLabel(o)}
              onUpload={(f) => void uploadLabel(o, f)}
              showPackaged={seg === 'toShip' && orderCanMarkPackaged(o)}
              onPackaged={() => void markPackaged(o)}
              packagedBusy={busy === 'packaged'}
              showMarkShipped={seg === 'packaged'}
              onMarkShipped={() => { setError(''); setShipTarget(o); }}
              selectMode={selectMode}
              selected={selectedIds.includes(o.id)}
              onToggleSelect={() => toggleSelectOrder(o)}
              suggestHint={suggestById.get(o.id)}
            />
          );
        })}
      </div>
      {selectMode && selectedIds.length >= 2 && (
        <div className="orders-bundle-bar">
          {bundleReady.reason === 'missing_address' && (
            <BundleShipToForm
              draft={shipToDraft}
              onChange={setShipToDraft}
              hint={bundleReady.message}
            />
          )}
          <button
            type="button"
            className="orders-bundle-btn"
            disabled={
              busy === 'bundle'
              || (!bundleReady.ok && bundleReady.reason !== 'missing_address')
              || (bundleReady.reason === 'missing_address' && !shipToReady(shipToDraft))
            }
            onClick={() => void bundleSelected()}
          >
            {busy === 'bundle'
              ? 'Bundling…'
              : bundleReady.reason === 'missing_address'
                ? `Save address & Bundle ${selectedIds.length}`
                : `Bundle ${selectedIds.length}`}
          </button>
          {bundleReady.message && bundleReady.reason !== 'missing_address' && (
            <p className="orders-bundle-hint">{bundleReady.message}</p>
          )}
        </div>
      )}
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
