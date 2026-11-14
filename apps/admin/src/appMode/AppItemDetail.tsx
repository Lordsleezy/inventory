import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { SupabaseClient } from '@supabase/supabase-js';
import { displayProductTitle } from '@floor/store';
import { UnitEditDrawer } from '../UnitEditDrawer';
import { RestoreInventoryButton } from '../RestoreInventoryButton';
import { shortError } from './shortError';
import { DispositionButtons } from '../DispositionDialogs';
import { showDispositionButtons } from '../dispositions';
import { LocationPicker } from '../LocationPicker';
import { ReceiveWorkStatus } from '../ReceiveWorkStatus';
import { ChannelCheckboxes } from '../ChannelCheckboxes';
import { printUnitLabels } from '../ReceiveGroupRow';
import { listingLink } from '../listingLink';
import { profitAfterFeesCents } from '../scanPricing';
import { floorFunctionUrl } from '../floorApi';
import { locationParts } from '../locationOrder';
import { locationMenuLabel, type LocationChoice } from '../locationPlace';
import { errText } from '../errText';
import { scannerLifecycle } from '../scannerLifecycle';
import {
  hasUpcValue,
  normalizeUpc,
  upcValidationMessage,
  upcVariants,
  UPC_NOT_APPLICABLE,
} from '../upcValidate';

type Photo = { id: number; path: string; is_primary: boolean; sort_order?: number; source?: string };
type Listing = {
  channel: string;
  status: string;
  listing_id: string | null;
  price_cents?: number | null;
  listed_at?: string | null;
  delisted_at?: string | null;
};
type Sale = { sold_at?: string; receipt_no?: string; channel?: string; actor_name?: string; price_cents?: number };
type Detail = {
  unit: Record<string, unknown>;
  photos: Photo[];
  listings: Listing[];
  sales?: Sale[];
};
type EbayInfo = {
  path: string | null;
  category_id: string | null;
  auto_picked?: boolean;
  attributes: Record<string, string>;
  fields: { name: string; required?: boolean; recommended?: boolean }[];
  missing: string[];
  review_reason?: string | null;
};
type HistoryRow = { at: string; label: string };
type FillOffer = { labels: string[]; apply: () => Promise<void> };

type Props = {
  client: SupabaseClient;
  storeId: string;
  accessToken: string;
  sku: string;
  money: (n: number) => string;
  onBack: () => void;
  onChanged: () => void;
  onSellInStore: () => void;
  canDelete?: boolean;
  staffMode?: boolean;
  scannerInputReady?: boolean;
  missingFields?: string[];
};

const CHANNELS: { key: string; label: string; listable: boolean }[] = [
  { key: 'ebay', label: 'eBay', listable: true },
  { key: 'depop', label: 'Depop', listable: false },
  { key: 'website', label: 'Website', listable: false },
  { key: 'tiktok', label: 'TikTok Shop', listable: true },
  { key: 'amazon', label: 'Amazon', listable: true },
];

function titleOf(u: Record<string, unknown>) {
  return displayProductTitle({
    title: u.title == null ? '' : String(u.title),
    brand: u.brand == null ? '' : String(u.brand),
    model: u.model == null ? '' : String(u.model),
  });
}

function attrOf(attrs: Record<string, string>, ...names: string[]) {
  for (const name of names) {
    const hit = Object.entries(attrs).find(([k]) => k.toLowerCase() === name.toLowerCase());
    if (hit?.[1]?.trim()) return hit[1].trim();
  }
  return '';
}

function stamp(s: string) {
  try {
    return new Date(s).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return s;
  }
}

function statusPill(status: string, channel: string, hasRow: boolean): { label: string; kind: 'live' | 'delisted' | 'none' } {
  const s = String(status || '').toLowerCase();
  if (s === 'listed') return { label: 'Live', kind: 'live' };
  if (s === 'delisted' || s === 'pending_delist' || s === 'ended') return { label: 'Delisted', kind: 'delisted' };
  if (channel === 'amazon' && !hasRow) return { label: 'Not on Amazon', kind: 'none' };
  return { label: 'Not listed', kind: 'none' };
}

function formatLocation(code: string) {
  const parts = locationParts(code);
  return parts ? `Bay ${parts.bay} · ${parts.slot}` : code;
}

function blank(v: unknown) {
  return !String(v ?? '').trim();
}

export function AppItemDetail({
  client, storeId, accessToken, sku, money, onBack, onChanged, onSellInStore, canDelete = false, staffMode = false, scannerInputReady,
  missingFields = [],
}: Props) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(() => !staffMode && missingFields.length > 0);
  const [editJump, setEditJump] = useState<string | undefined>();
  const [reload, setReload] = useState(0);
  const [locationCodes, setLocationCodes] = useState<string[]>([]);
  const [locationChoices, setLocationChoices] = useState<LocationChoice[]>([]);
  const [photoIndex, setPhotoIndex] = useState(0);
  const [listSheet, setListSheet] = useState(false);
  const [dns, setDns] = useState<boolean | null>(null);
  const [ebay, setEbay] = useState<EbayInfo | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [actionMsg, setActionMsg] = useState('');
  const [locationOpen, setLocationOpen] = useState(false);
  const [upcEditing, setUpcEditing] = useState(false);
  const [upcDraft, setUpcDraft] = useState('');
  const [noUpc, setNoUpc] = useState(false);
  const [upcError, setUpcError] = useState('');
  const [upcBusy, setUpcBusy] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [fillOffer, setFillOffer] = useState<FillOffer | null>(null);
  const [zoomPhoto, setZoomPhoto] = useState<Photo | null>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const upcInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setPhotoIndex(0);
    setActionMsg('');
    setFillOffer(null);
    setUpcEditing(false);
    setUpcError('');
    void (async () => {
      try {
        const { data, error: e } = await client.rpc(staffMode ? 'staff_inventory_detail' : 'portal_inventory_detail', { p_sku: sku });
        if (e) throw e;
        if (!data) throw new Error('Unit not found');
        const next = data as Detail;
        const [stock, pick, dnsRow, ebayRow, hist, bayList] = await Promise.all([
          client.from('unit_location_stock').select('location_code').eq('store_id', storeId).eq('sku', sku),
          client.from('unit_pick_locations').select('location_code').eq('store_id', storeId).eq('sku', sku).maybeSingle(),
          canDelete && !staffMode ? client.rpc('portal_unit_dns', { p_sku: sku }) : Promise.resolve({ data: null, error: null }),
          canDelete && !staffMode
            ? fetchEbaySnapshot(client, accessToken, storeId, sku)
            : Promise.resolve(null as EbayInfo | null),
          canDelete && !staffMode
            ? client.rpc('portal_unit_history', { p_sku: sku })
            : Promise.resolve({ data: [], error: null }),
          client.rpc('portal_bay_list'),
        ]);
        const codes = (stock.data || []).map((row) => row.location_code as string);
        if (!codes.length && pick.data?.location_code) codes.push(pick.data.location_code as string);
        const paths = next.photos.map((p) => p.path);
        const keys = paths.filter((p) => /^[0-9a-f-]{36}\//i.test(p));
        let signed: Record<string, string> = {};
        if (keys.length) {
          const { data: s } = await client.storage.from('unit-photos').createSignedUrls(keys, 3600);
          signed = Object.fromEntries((s || []).map((x, i) => [keys[i], x.signedUrl || '']));
        }
        if (!alive) return;
        setDetail(next);
        setLocationCodes(codes);
        setLocationChoices(((bayList.data as { locations?: LocationChoice[] } | null)?.locations) || []);
        setUrls(signed);
        if (dnsRow.data && typeof dnsRow.data === 'object' && 'dns' in (dnsRow.data as object)) {
          setDns(Boolean((dnsRow.data as { dns: boolean }).dns));
        } else {
          setDns(null);
        }
        setEbay(ebayRow);
        const rows: HistoryRow[] = [];
        const unit = next.unit;
        if (unit.received_at) rows.push({ at: String(unit.received_at), label: 'Received' });
        for (const l of next.listings || []) {
          if (l.listed_at) rows.push({ at: String(l.listed_at), label: `Listed on ${channelLabel(l.channel)}` });
          if (l.delisted_at) rows.push({ at: String(l.delisted_at), label: `Delisted from ${channelLabel(l.channel)}` });
        }
        for (const s of next.sales || []) {
          if (s.sold_at) {
            const who = s.actor_name ? ` · ${s.actor_name}` : '';
            const ch = s.channel ? ` · ${s.channel}` : '';
            const rcpt = s.receipt_no ? ` #${s.receipt_no}` : '';
            rows.push({ at: String(s.sold_at), label: `Sold${rcpt}${ch}${who}` });
          }
        }
        const histRows = Array.isArray(hist.data) ? hist.data as { at: string; note?: string; kind?: string }[] : [];
        for (const h of histRows) {
          rows.push({ at: String(h.at), label: String(h.note || h.kind || 'Event') });
        }
        rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
        setHistory(rows);
      } catch (err) {
        if (alive) setError(shortError(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, [client, storeId, sku, reload, staffMode, canDelete, accessToken]);

  const unit = detail?.unit;
  const listingsBy = useMemo(() => {
    const map = new Map<string, Listing>();
    for (const l of detail?.listings || []) map.set(String(l.channel).toLowerCase(), l);
    return map;
  }, [detail]);

  const openEdit = (jump?: string) => {
    setEditJump(jump);
    setEditing(true);
  };
  const namedLocation = (code: string) => {
    const hit = locationChoices.find((row) => row.code === code);
    return hit ? locationMenuLabel(hit) : formatLocation(code);
  };

  if (editing && detail) {
    return (
      <div className="app-stack app-stack-edit">
        <UnitEditDrawer
          client={client}
          storeId={storeId}
          sku={sku}
          missingFields={missingFields}
          unit={detail.unit}
          photos={detail.photos}
          urls={urls}
          accessToken={accessToken}
          appMode
          initialSection={editJump}
          canDelete={canDelete}
          locationLabel={locationCodes.length ? locationCodes.map(namedLocation).join(', ') : 'Unassigned'}
          onReadinessChanged={() => { setReload((n) => n + 1); onChanged(); }}
          onClose={() => { setEditing(false); setEditJump(undefined); }}
          onSaved={() => {
            setEditing(false);
            setEditJump(undefined);
            setReload((n) => n + 1);
            onChanged();
          }}
          onPhotosChanged={() => setReload((n) => n + 1)}
          onDeleted={() => {
            onChanged();
            onBack();
          }}
        />
      </div>
    );
  }

  const weight = unit?.package_weight_lb != null ? Number(unit.package_weight_lb) : null;
  const L = unit?.package_length_in != null ? Number(unit.package_length_in) : null;
  const W = unit?.package_width_in != null ? Number(unit.package_width_in) : null;
  const H = unit?.package_height_in != null ? Number(unit.package_height_in) : null;
  const box = L != null && W != null && H != null && L > 0 && W > 0 && H > 0 ? `${L} × ${W} × ${H} in` : null;
  const ask = unit?.ask_cents != null ? Number(unit.ask_cents) : null;
  const cost = !staffMode && unit?.acquisition_cost_cents != null ? Number(unit.acquisition_cost_cents) : null;
  const photos = detail?.photos || [];
  const inStock = ['available', 'reserved', 'repair'].includes(String(unit?.state || ''));
  const moneyHidden = !canDelete && !!unit && !inStock;
  const qty = Math.max(0, Number(unit?.qty_on_hand ?? 1) || 0);
  const isStocked = Boolean(unit?.is_stocked) || qty > 1;
  const liveCount = !staffMode ? CHANNELS.filter((ch) => {
    const row = listingsBy.get(ch.key);
    return row && String(row.status).toLowerCase() === 'listed';
  }).length : 0;
  const locationText = locationCodes.length
    ? locationCodes.map(namedLocation).join(', ')
    : '';
  const hasLocation = Boolean(locationText.trim());
  const upcSet = unit ? hasUpcValue(unit as { upc?: unknown; upc_does_not_apply?: unknown; listing_specs?: unknown }) : false;
  const upcDisplay = String(unit?.upc || '').trim();
  const upcDna = Boolean(unit?.upc_does_not_apply) || (!upcDisplay && upcSet);
  const aspects = (() => {
    if (ebay?.attributes && Object.keys(ebay.attributes).length) return ebay.attributes;
    const raw = unit?.aspects;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (Array.isArray(v)) out[k] = String(v[0] ?? '');
        else if (v != null) out[k] = String(v);
      }
      return out;
    }
    return {} as Record<string, string>;
  })();
  const typeVal = attrOf(aspects, 'Type', 'Item Type', 'Style');
  const colorVal = attrOf(aspects, 'Color', 'Colour', 'Main Color');
  const sizeVal = attrOf(aspects, 'Size', 'Size Type', 'Dimensions');
  const categoryVal = ebay?.path || String(unit?.category || unit?.ebay_category || '').trim();
  const profit = !moneyHidden && !staffMode ? profitAfterFeesCents(ask, cost) : null;
  const shipMode = (() => {
    const o = String(unit?.fulfillment_override || '').toLowerCase();
    if (o === 'ship') return 'Always ship';
    if (o === 'pickup') return 'Pickup only';
    return 'Automatic (rules)';
  })();
  const ships = String(unit?.fulfillment_override || '').toLowerCase() !== 'pickup' && dns !== true;
  const brand = String(unit?.brand || '').trim();
  const description = String(unit?.listing_body || unit?.description || '').trim();
  const condition = String(unit?.condition || '').trim();
  const testStatus = String(unit?.test_status || '').trim();
  const currentPhoto = photos[photoIndex];
  const showAttention = inStock && !upcSet;
  const canSetLocation = inStock; // portal_move_location_stock + portal_bay_list work via current_store_id
  const canEditUpc = inStock;

  function onHeroScroll() {
    const el = heroRef.current;
    if (!el || !photos.length) return;
    const i = Math.round(el.scrollLeft / Math.max(el.clientWidth, 1));
    setPhotoIndex(Math.max(0, Math.min(photos.length - 1, i)));
  }

  async function enableChannel(channel: 'ebay' | 'amazon' | 'tiktok') {
    setActionMsg('');
    const { error: e } = await client.rpc('portal_set_unit_channel_selection', {
      p_sku: sku, p_channel: channel, p_selected: true,
    });
    if (e) setActionMsg(e.message);
    else {
      setActionMsg(`${channelLabel(channel)} queued to list.`);
      setReload((n) => n + 1);
      onChanged();
    }
  }

  function startUpcEdit() {
    setUpcEditing(true);
    setNoUpc(false);
    setUpcDraft('');
    setUpcError('');
    window.setTimeout(() => upcInputRef.current?.focus(), 50);
  }

  async function findDupSkus(variants: string[]) {
    if (!variants.length) return [] as string[];
    const table = staffMode ? 'units_pos' : 'units';
    const { data, error: e } = await client.from(table).select('sku')
      .eq('store_id', storeId).in('upc', variants).in('state', ['available', 'reserved', 'repair']).limit(20);
    if (e || !data) return [];
    return data.map((r) => String((r as { sku: string }).sku)).filter((s) => s !== sku);
  }

  async function offerFillFromLookup(upc: string) {
    if (!unit) return;
    try {
      const res = await fetch(floorFunctionUrl('upc-lookup'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'lookup', upc, compare_upcitemdb: true }),
      });
      if (!res.ok) return;
      const json = await res.json() as {
        merged?: {
          brand?: string; model?: string; title?: string; description?: string; category?: string;
          package?: { length_in?: number; width_in?: number; height_in?: number; weight_lb?: number };
          images?: string[];
        };
        stock_photos?: { url: string; source: string }[];
      };
      const m = json.merged || {};
      const pkg = m.package || {};
      const labels: string[] = [];
      const patch: Record<string, unknown> = {};
      if (blank(unit.brand) && m.brand) { patch.p_brand = m.brand; labels.push('brand'); }
      if (blank(unit.category) && m.category) { labels.push('category'); }
      if ((blank(unit.package_length_in) || Number(unit.package_length_in) <= 0) && pkg.length_in) {
        patch.p_length = pkg.length_in; labels.push('size');
      }
      if ((blank(unit.package_width_in) || Number(unit.package_width_in) <= 0) && pkg.width_in) patch.p_width = pkg.width_in;
      if ((blank(unit.package_height_in) || Number(unit.package_height_in) <= 0) && pkg.height_in) patch.p_height = pkg.height_in;
      if ((blank(unit.package_weight_lb) || Number(unit.package_weight_lb) <= 0) && pkg.weight_lb) {
        patch.p_weight = pkg.weight_lb;
        if (!labels.includes('size')) labels.push('size');
      }
      const stockUrl = (json.stock_photos?.[0]?.url || m.images?.[0] || '').trim();
      const needsPhoto = photos.length === 0 && !!stockUrl;
      if (needsPhoto) labels.push('stock photo');
      if (!labels.length) return;

      setFillOffer({
        labels,
        apply: async () => {
          const rpc = staffMode ? 'staff_update_unit' : 'portal_update_unit';
          const args: Record<string, unknown> = {
            p_sku: sku,
            p_upc: String(unit.upc || upc),
            p_brand: patch.p_brand != null ? patch.p_brand : String(unit.brand || ''),
            p_model: String(unit.model || ''),
            p_title: String(unit.title || titleOf(unit)),
            p_description: String(unit.listing_body || unit.description || ''),
            p_ask_cents: unit.ask_cents == null ? null : Number(unit.ask_cents),
            p_condition: String(unit.condition || ''),
            p_test_status: String(unit.test_status || ''),
            p_notes: String(unit.defect_notes || ''),
            p_length: patch.p_length ?? (unit.package_length_in == null ? null : Number(unit.package_length_in)),
            p_width: patch.p_width ?? (unit.package_width_in == null ? null : Number(unit.package_width_in)),
            p_height: patch.p_height ?? (unit.package_height_in == null ? null : Number(unit.package_height_in)),
            p_weight: patch.p_weight ?? (unit.package_weight_lb == null ? null : Number(unit.package_weight_lb)),
          };
          if (!staffMode) {
            args.p_cost_cents = unit.acquisition_cost_cents == null ? null : Number(unit.acquisition_cost_cents);
            args.p_shippable = (() => {
              const o = String(unit.fulfillment_override || '').toLowerCase();
              if (o === 'ship') return 'yes';
              if (o === 'pickup') return 'no';
              return 'auto';
            })();
          }
          const { error: updateError } = await client.rpc(rpc, args);
          if (updateError) throw updateError;
          if (needsPhoto && stockUrl) {
            await fetch(floorFunctionUrl('receive-photo-identify'), {
              method: 'POST',
              headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
              body: JSON.stringify({ action: 'add_more_stock_photo', sku, url: stockUrl, source: 'catalog' }),
              signal: AbortSignal.timeout(45000),
            }).catch(() => null);
          }
          setFillOffer(null);
          setReload((n) => n + 1);
          onChanged();
        },
      });
    } catch {
      /* lookup miss: stay quiet */
    }
  }

  async function saveUpc() {
    setUpcError('');
    if (noUpc) {
      setUpcBusy(true);
      try {
        const { error: e } = await client.rpc(staffMode ? 'staff_set_unit_upc' : 'portal_set_unit_upc', {
          p_sku: sku, p_upc: UPC_NOT_APPLICABLE,
        });
        if (e) throw e;
        setUpcEditing(false);
        setReload((n) => n + 1);
        onChanged();
      } catch (err) {
        setUpcError(errText(err));
      } finally {
        setUpcBusy(false);
      }
      return;
    }
    const msg = upcValidationMessage(upcDraft);
    if (msg) { setUpcError(msg); return; }
    const normalized = normalizeUpc(upcDraft);
    const upc = normalized.upcA || digitsOnlySafe(upcDraft);
    setUpcBusy(true);
    try {
      const dups = await findDupSkus(upcVariants(upc, normalized));
      if (dups.length) {
        const ok = window.confirm(
          `UPC ${upc} is already on SKU ${dups.slice(0, 5).join(', ')}${dups.length > 5 ? '…' : ''}. Save on this item anyway?`,
        );
        if (!ok) { setUpcBusy(false); return; }
      }
      const { error: e } = await client.rpc(staffMode ? 'staff_set_unit_upc' : 'portal_set_unit_upc', {
        p_sku: sku, p_upc: upc,
      });
      if (e) throw e;
      setUpcEditing(false);
      setReload((n) => n + 1);
      onChanged();
      void offerFillFromLookup(upc);
    } catch (err) {
      setUpcError(errText(err));
    } finally {
      setUpcBusy(false);
    }
  }

  return (
    <div className="app-stack app-item-detail">
      <div className="app-nav">
        <button type="button" onClick={onBack}>‹ Inventory</button>
        <div className="app-nav-title">Item</div>
        <button
          type="button"
          onClick={() => openEdit()}
          disabled={!detail}
          style={moneyHidden ? { visibility: 'hidden' } : undefined}
        >
          Edit
        </button>
      </div>

      {error && <p className="app-footer-count" style={{ color: '#ff453a' }}>{error}</p>}
      <div className="app-item-banner-slot">
        <ReceiveWorkStatus client={client} accessToken={accessToken} sku={sku} />
      </div>
      {!detail && !error && <p className="app-footer-count">Loading…</p>}
      {actionMsg && <p className="app-footer-count" role="status">{actionMsg}</p>}

      {detail && unit && (
        <>
          <div className="app-item-photo-block">
            <div className="app-item-hero" ref={heroRef} onScroll={onHeroScroll}>
              {photos.length === 0 && <div className="app-item-hero-empty">No photo</div>}
              {photos.map((p) => (
                <button
                  type="button"
                  key={p.id}
                  className="app-item-hero-slide"
                  onClick={() => urls[p.path] && setZoomPhoto(p)}
                  aria-label="View photo"
                >
                  {urls[p.path] ? <img src={urls[p.path]} alt="" /> : null}
                </button>
              ))}
              {currentPhoto?.source === 'stock' && photos.length > 0 && (
                <span className="app-item-stock-tag">Stock photo · {photoIndex + 1} / {photos.length}</span>
              )}
            </div>
            {photos.length > 1 && (
              <div className="app-item-photo-dots" role="tablist" aria-label="Photos">
                {photos.map((p, i) => (
                  <button
                    type="button"
                    key={p.id}
                    className={`app-item-photo-dot${i === photoIndex ? ' is-active' : ''}`}
                    aria-label={`Photo ${i + 1}`}
                    aria-selected={i === photoIndex}
                    onClick={() => {
                      setPhotoIndex(i);
                      const el = heroRef.current;
                      if (el) el.scrollTo({ left: i * el.clientWidth, behavior: 'smooth' });
                    }}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="app-item-head">
            <h1>{titleOf(unit)}</h1>
            <p className="app-item-sku"><span>SKU</span> <strong>{sku}</strong></p>
            {(brand || upcDisplay) && (
              <p className="app-item-meta">
                {[brand, upcDisplay ? `UPC ${upcDisplay}` : ''].filter(Boolean).join(' · ')}
              </p>
            )}
            <p className="app-item-price">
              {moneyHidden
                ? String(unit.state).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
                : ask == null ? 'No price' : money(ask)}
            </p>
            <p className="app-item-status">
              <span className="app-item-status-main">
                {inStock
                  ? `In stock · ${qty || 1}`
                  : String(unit.state || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) || 'Out of stock'}
              </span>
              {condition ? <span className="app-item-status-side">{condition}</span> : null}
            </p>
          </div>

          {showAttention && (
            <div className="app-item-attention" aria-label="Needs attention">
              {!upcSet && (
                <div className={`app-item-attention-row${upcEditing ? ' is-editing' : ''}`}>
                  {!upcEditing ? (
                    <>
                      <div className="app-item-attention-copy">
                        <span>UPC</span>
                        <strong>Missing</strong>
                      </div>
                      {canEditUpc && (
                        <button type="button" className="app-item-btn-solid" onClick={startUpcEdit}>
                          Add UPC
                        </button>
                      )}
                    </>
                  ) : (
                    <div className="app-item-upc-edit">
                      <label className="app-item-upc-field">
                        <span className="visually-hidden">UPC</span>
                        <input
                          ref={upcInputRef}
                          inputMode="numeric"
                          autoComplete="off"
                          placeholder="UPC / EAN"
                          value={noUpc ? UPC_NOT_APPLICABLE : upcDraft}
                          disabled={noUpc || upcBusy}
                          onChange={(e) => {
                            setUpcDraft(e.target.value.replace(/\s+/g, ''));
                            setUpcError('');
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              void saveUpc();
                            }
                          }}
                        />
                        <button type="button" className="app-item-upc-scan" disabled={upcBusy || noUpc} onClick={() => setScanOpen(true)}>
                          Scan
                        </button>
                      </label>
                      <label className="app-item-upc-na">
                        <input type="checkbox" checked={noUpc} disabled={upcBusy} onChange={(e) => {
                          setNoUpc(e.target.checked);
                          setUpcError('');
                          if (e.target.checked) setUpcDraft('');
                        }} />
                        No UPC
                      </label>
                      {upcError && <p className="app-item-upc-error">{upcError}</p>}
                      <div className="app-item-upc-actions">
                        <button type="button" className="app-item-btn-outline" disabled={upcBusy} onClick={() => { setUpcEditing(false); setUpcError(''); }}>
                          Cancel
                        </button>
                        <button type="button" className="app-item-btn-solid" disabled={upcBusy} onClick={() => void saveUpc()}>
                          Save UPC
                        </button>
                      </div>
                      <p className="app-item-upc-hint">On save we look it up and offer to fill empty fields (brand, size, stock photo). Nothing is overwritten.</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {fillOffer && (
            <div className="app-item-fill-offer" role="status">
              <p>Fill from UPC: {fillOffer.labels.join(', ')}</p>
              <div className="app-item-upc-actions">
                <button type="button" className="app-item-btn-outline" onClick={() => setFillOffer(null)}>Skip</button>
                <button type="button" className="app-item-btn-solid" onClick={() => void fillOffer.apply().catch((err) => setActionMsg(errText(err)))}>
                  Fill empty fields
                </button>
              </div>
            </div>
          )}

          {hasLocation && (
            <div className="app-item-location">
              <div className="app-item-location-copy">
                <span>Location</span>
                <strong>{locationText}</strong>
              </div>
              {canSetLocation && (
                <button type="button" className="app-item-btn-outline" onClick={() => setLocationOpen(true)}>
                  Change
                </button>
              )}
            </div>
          )}

          <Section title="Details">
            <Kv label="Brand" value={brand} />
            <Kv label="Condition" value={condition} />
            <Kv label="Test status" value={testStatus || undefined} empty="Not set" showEmpty />
            <Kv label="Category" value={categoryVal || undefined} />
            <Kv label="Type" value={typeVal || undefined} />
            <Kv label="Color" value={colorVal || undefined} />
            <Kv label="Size" value={sizeVal || undefined} />
          </Section>

          {(box || weight != null) && (
            <Section title="Size & weight">
              <Kv label="Box" value={box || undefined} />
              <Kv label="Weight" value={weight != null ? `${weight} lb` : undefined} />
            </Section>
          )}

          <Section title="Description">
            <p className="app-item-description">{description || 'No description yet.'}</p>
          </Section>

          <Section title="Record">
            <Kv label="Received" value={unit.received_at ? stamp(String(unit.received_at)) : undefined} />
            <Kv
              label="UPC"
              value={upcDna ? 'Does not apply' : (upcDisplay || undefined)}
              warn={!upcSet && !staffMode}
              empty={!staffMode ? 'Missing' : undefined}
              showEmpty={!staffMode}
            />
            <Kv
              label="Quantity"
              value={`${qty || 1} · ${isStocked ? 'stocked' : 'one of one'}`}
            />
          </Section>

          {!staffMode && (
            <>
              <Section title={`Selling on · ${liveCount} live of ${CHANNELS.length}`}>
                {CHANNELS.map((ch) => {
                  const row = listingsBy.get(ch.key);
                  const pill = statusPill(row?.status || '', ch.key, Boolean(row));
                  const price = row?.price_cents != null
                    ? Number(row.price_cents)
                    : ch.key === 'website' ? ask : null;
                  const url = pill.kind === 'live' ? listingLink(ch.key, row?.listing_id) : null;
                  return (
                    <div className="app-item-kv app-item-channel" key={ch.key}>
                      <span>{ch.label}</span>
                      <div className="app-item-channel-right">
                        <strong className={pill.kind === 'live' ? 'live' : 'muted'}>{pill.label}</strong>
                        {pill.kind === 'live' && price != null && !moneyHidden ? <strong>{money(price)}</strong> : null}
                        {pill.kind === 'live' && url ? <a href={url} target="_blank" rel="noreferrer">Open</a> : null}
                        {pill.kind !== 'live' && ch.listable && canDelete && inStock && (
                          <button type="button" className="app-text-link" onClick={() => void enableChannel(ch.key as 'ebay' | 'amazon' | 'tiktok')}>
                            {pill.kind === 'delisted' ? 'Relist' : 'List'}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </Section>

              {!moneyHidden && (
                <Section title="Pricing & cost">
                  <Kv label="Price" value={ask == null ? undefined : money(ask)} empty="—" showEmpty />
                  <div className="app-item-kv">
                    <span>Cost</span>
                    {cost == null
                      ? <button type="button" className="app-text-link warn" onClick={() => openEdit('price')}>Add cost</button>
                      : <strong>{money(cost)}</strong>}
                  </div>
                  <Kv
                    label="Est. profit"
                    value={profit != null ? money(profit) : undefined}
                    empty="Needs cost"
                    showEmpty
                    warn={profit == null}
                  />
                </Section>
              )}

              <Section title="Shipping">
                <Kv label="Ships?" value={ships ? shipMode : 'No · Pickup only'} />
                <Kv label="Box" value={box || undefined} empty="Missing" showEmpty warn={!box} />
                <Kv label="Package weight" value={weight != null ? `${weight} lb` : undefined} empty="Missing" showEmpty warn={weight == null} />
                {dns != null && <Kv label="Do not ship (DNS)" value={dns ? 'On' : 'Off'} />}
              </Section>

              {inStock && (
                <div className="app-item-admin-actions" role="group" aria-label="Quick actions">
                  {canDelete && (
                    <button type="button" className="app-item-btn-outline" onClick={() => setListSheet(true)}>List on…</button>
                  )}
                  <button
                    type="button"
                    className="app-item-btn-outline"
                    onClick={() => {
                      window.alert('Ring the sale in Register so tax, payment, and inventory stay correct.');
                      onSellInStore();
                    }}
                  >
                    Mark sold
                  </button>
                  <button
                    type="button"
                    className="app-item-btn-outline"
                    onClick={() => {
                      void printUnitLabels(
                        Array.from({ length: Math.min(Math.max(qty, 1), 1000) }, () => sku),
                        String(unit.title || `SKU ${sku}`),
                      ).catch((e) => setActionMsg(e instanceof Error ? e.message : String(e)));
                    }}
                  >
                    Print label
                  </button>
                </div>
              )}

              {history.length > 0 && (
                <Section title="History">
                  {history.slice(0, 20).map((h, i) => (
                    <div className="app-item-kv" key={`${h.at}-${i}`}>
                      <span>{h.label}</span>
                      <strong className="muted">{stamp(h.at)}</strong>
                    </div>
                  ))}
                </Section>
              )}

              {inStock && canDelete && showDispositionButtons({ isAdmin: true, unsold: true }) && (
                <div className="app-actions app-disposition-row">
                  <DispositionButtons
                    client={client}
                    sku={sku}
                    money={money}
                    stamp={(s) => new Date(s).toLocaleString()}
                    onDone={() => { onChanged(); onBack(); }}
                  />
                </div>
              )}

              {canDelete && unit.state === 'sold' && (
                <div className="app-item-bottom-actions">
                  <RestoreInventoryButton client={client} sku={sku} onDone={() => { onChanged(); onBack(); }} />
                </div>
              )}
            </>
          )}

          {listSheet && (
            <div className="app-sheet-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setListSheet(false); }}>
              <section className="app-sheet" role="dialog" aria-modal="true" aria-label="List on channels">
                <header>
                  <strong>List on…</strong>
                  <button type="button" onClick={() => setListSheet(false)}>Done</button>
                </header>
                <p className="hint">Turns on eBay, Amazon, or TikTok Shop for this SKU. Depop and Mercari stay manual.</p>
                <ChannelCheckboxes client={client} sku={sku} appMode />
              </section>
            </div>
          )}
        </>
      )}

      {locationOpen && inStock && (
        <LocationPicker
          client={client}
          storeId={storeId}
          sku={sku}
          onClose={() => setLocationOpen(false)}
          onSaved={() => { setLocationOpen(false); setReload((n) => n + 1); onChanged(); }}
        />
      )}

      {scanOpen && (
        <UpcCameraScan
          onDetect={(code) => {
            setScanOpen(false);
            setNoUpc(false);
            setUpcDraft(code.replace(/\s+/g, ''));
            setUpcError('');
            window.setTimeout(() => upcInputRef.current?.focus(), 50);
          }}
          onClose={() => setScanOpen(false)}
        />
      )}

      {zoomPhoto && urls[zoomPhoto.path] && createPortal(
        <div className="app-item-zoom" role="dialog" aria-modal="true" aria-label="Photo">
          <button type="button" className="app-item-zoom-close" onClick={() => setZoomPhoto(null)}>Close</button>
          <img src={urls[zoomPhoto.path]} alt="" />
        </div>,
        document.body,
      )}

      {scannerInputReady ? <span className="visually-hidden">Scanner input ready</span> : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="app-item-section">
      <h2>{title}</h2>
      <div className="app-item-section-body">{children}</div>
    </section>
  );
}

function Kv({
  label, value, warn, empty, showEmpty,
}: {
  label: string;
  value?: string;
  warn?: boolean;
  empty?: string;
  showEmpty?: boolean;
}) {
  const text = value?.trim();
  if (!text && !showEmpty) return null;
  return (
    <div className="app-item-kv">
      <span>{label}</span>
      <strong className={warn ? 'warn' : undefined}>{text || empty}</strong>
    </div>
  );
}

function channelLabel(channel: string) {
  const hit = CHANNELS.find((c) => c.key === channel.toLowerCase());
  if (hit) return hit.label;
  return channel.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

function digitsOnlySafe(raw: string) {
  return String(raw || '').replace(/\D/g, '');
}

function UpcCameraScan({ onDetect, onClose }: { onDetect: (code: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const detect = useRef(onDetect);
  detect.current = onDetect;
  const [err, setErr] = useState('');
  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer = 0;
    let stopped = false;
    type DetectorCtor = new (opts?: { formats?: string[] }) => { detect: (src: HTMLVideoElement) => Promise<{ rawValue: string }[]> };
    const Ctor = (typeof window !== 'undefined'
      ? (window as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector
      : undefined);
    const lifecycle = scannerLifecycle(document, window, video.current, () => {
      stopped = true; window.clearInterval(timer); onClose();
    });
    void (async () => {
      try {
        if (!Ctor) throw new Error('This browser cannot read barcodes from the camera.');
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera API unavailable.');
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        if (!lifecycle.attach(stream)) return;
        const el = video.current;
        if (!el) return;
        el.srcObject = stream;
        el.setAttribute('playsinline', 'true');
        el.muted = true;
        await el.play();
        if (stopped || lifecycle.stopped) return;
        const detector = new Ctor({ formats: ['upc_a', 'upc_e', 'ean_13', 'ean_8'] });
        timer = window.setInterval(() => {
          if (stopped || lifecycle.stopped) return;
          void detector.detect(el).then((codes) => {
            const raw = codes[0]?.rawValue;
            if (raw && !stopped && !lifecycle.stopped && !done.current) {
              done.current = true;
              detect.current(raw);
            }
          }).catch(() => undefined);
        }, 250);
      } catch (e) {
        setErr(errText(e) || 'Camera unavailable. Use a photo of the barcode instead.');
      }
    })();
    return () => { stopped = true; window.clearInterval(timer); lifecycle.stop(); };
  }, [onClose]);

  return createPortal(
    <div className="receive-modal receive-modal-portal" role="dialog" aria-modal="true" aria-label="Scan barcode with camera">
      <div className="receive-modal-card">
        <h3>Scan barcode</h3>
        {err ? <p className="error">{err}</p> : <video ref={video} className="receive-video" playsInline muted />}
        <div className="actions">
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              void (async () => {
                type DetectorCtor = new (opts?: { formats?: string[] }) => { detect: (src: ImageBitmap) => Promise<{ rawValue: string }[]> };
                const FileCtor = (window as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
                if (!FileCtor) { setErr('Could not read a barcode from that photo.'); return; }
                try {
                  const bitmap = await createImageBitmap(file);
                  try {
                    const codes = await new FileCtor({ formats: ['upc_a', 'upc_e', 'ean_13', 'ean_8'] }).detect(bitmap);
                    if (codes[0]?.rawValue) onDetect(codes[0].rawValue);
                    else setErr('Could not read a barcode from that photo.');
                  } finally { bitmap.close(); }
                } catch {
                  setErr('Could not read a barcode from that photo.');
                }
              })();
            }}
          />
          <button type="button" className="secondary" onClick={() => fileInput.current?.click()}>Take photo</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

async function fetchEbaySnapshot(
  client: SupabaseClient,
  accessToken: string,
  storeId: string,
  sku: string,
): Promise<EbayInfo | null> {
  try {
    const res = await fetch(floorFunctionUrl('ebay-specifics'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ store_id: storeId, sku, action: 'get' }),
    });
    if (!res.ok) {
      const { data } = await client.rpc('portal_unit_ebay_specifics', { p_sku: sku });
      if (!data) return null;
      const row = data as {
        path?: string; category_id?: string; attributes?: Record<string, string>;
        aspect_fields?: { name: string; required?: boolean; recommended?: boolean }[];
        gaps?: string[];
      };
      return {
        path: row.path || null,
        category_id: row.category_id || null,
        attributes: row.attributes || {},
        fields: row.aspect_fields || [],
        missing: row.gaps || [],
      };
    }
    const json = await res.json() as { form?: {
      path?: string | null; category_id?: string | null; auto_picked?: boolean;
      attributes?: Record<string, string>; fields?: { name: string; required?: boolean; recommended?: boolean }[];
      missing?: string[]; review_reason?: string | null;
    } };
    const form = json.form;
    if (!form) return null;
    return {
      path: form.path || null,
      category_id: form.category_id || null,
      auto_picked: form.auto_picked,
      attributes: form.attributes || {},
      fields: form.fields || [],
      missing: form.missing || [],
      review_reason: form.review_reason,
    };
  } catch {
    return null;
  }
}
