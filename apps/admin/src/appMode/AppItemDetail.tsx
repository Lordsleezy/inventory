import { useEffect, useMemo, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { UnitEditDrawer } from '../UnitEditDrawer';
import { RestoreInventoryButton } from '../RestoreInventoryButton';
import { shortError } from './shortError';
import { DispositionButtons } from '../DispositionDialogs';
import { showDispositionButtons } from '../dispositions';
import { locationParts } from '../locationOrder';
import { ReceiveWorkStatus } from '../ReceiveWorkStatus';
import { ChannelCheckboxes } from '../ChannelCheckboxes';
import { printUnitLabels } from '../ReceiveGroupRow';
import { listingLink } from '../listingLink';
import { profitAfterFeesCents } from '../scanPricing';
import { categoryReview } from '../categoryReview';
import { floorFunctionUrl } from '../floorApi';

type Photo = { id: number; path: string; is_primary: boolean; sort_order?: number };
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
  { key: 'mercari', label: 'Mercari', listable: false },
  { key: 'website', label: 'Website', listable: false },
  { key: 'tiktok', label: 'TikTok Shop', listable: true },
  { key: 'amazon', label: 'Amazon', listable: true },
];

function titleOf(u: Record<string, unknown>) {
  return String(u.title || '').trim() || [u.brand, u.model].filter(Boolean).join(' ') || 'Untitled';
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
  const [photoIndex, setPhotoIndex] = useState(0);
  const [listSheet, setListSheet] = useState(false);
  const [dns, setDns] = useState<boolean | null>(null);
  const [ebay, setEbay] = useState<EbayInfo | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [actionMsg, setActionMsg] = useState('');
  const heroRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setPhotoIndex(0);
    setActionMsg('');
    void (async () => {
      try {
        const { data, error: e } = await client.rpc(staffMode ? 'staff_inventory_detail' : 'portal_inventory_detail', { p_sku: sku });
        if (e) throw e;
        if (!data) throw new Error('Unit not found');
        const next = data as Detail;
        const [stock, pick, dnsRow, ebayRow, hist] = await Promise.all([
          client.from('unit_location_stock').select('location_code').eq('store_id', storeId).eq('sku', sku),
          client.from('unit_pick_locations').select('location_code').eq('store_id', storeId).eq('sku', sku).maybeSingle(),
          canDelete && !staffMode ? client.rpc('portal_unit_dns', { p_sku: sku }) : Promise.resolve({ data: null, error: null }),
          canDelete && !staffMode
            ? fetchEbaySnapshot(client, accessToken, storeId, sku)
            : Promise.resolve(null as EbayInfo | null),
          canDelete && !staffMode
            ? client.rpc('portal_unit_history', { p_sku: sku })
            : Promise.resolve({ data: [], error: null }),
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
          locationLabel={locationCodes.length ? locationCodes.map((code) => {
            const parts = locationParts(code);
            return parts ? `${parts.display} · ${parts.slot}` : code;
          }).join(', ') : 'Unassigned'}
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
  const box = L != null && W != null && H != null ? `${L} × ${W} × ${H} in` : null;
  const ask = unit?.ask_cents != null ? Number(unit.ask_cents) : null;
  const cost = !staffMode && unit?.acquisition_cost_cents != null ? Number(unit.acquisition_cost_cents) : null;
  const photos = detail?.photos || [];
  const inStock = ['available', 'reserved', 'repair'].includes(String(unit?.state || ''));
  const moneyHidden = !canDelete && !!unit && !inStock;
  const qty = Math.max(0, Number(unit?.qty_on_hand ?? 1) || 0);
  const isStocked = Boolean(unit?.is_stocked) || qty > 1;
  const liveCount = CHANNELS.filter((ch) => {
    const row = listingsBy.get(ch.key);
    return row && String(row.status).toLowerCase() === 'listed';
  }).length;
  const locationText = locationCodes.length
    ? locationCodes.map((code) => {
      const parts = locationParts(code);
      return parts ? `${parts.display} · ${parts.slot}` : code;
    }).join(', ')
    : String(unit?.location || unit?.bin || '');
  const hasLocation = Boolean(locationText.trim());
  const attrs = ebay?.attributes || {};
  const typeVal = attrOf(attrs, 'Type', 'Item Type', 'Style');
  const colorVal = attrOf(attrs, 'Color', 'Colour', 'Main Color');
  const sizeVal = attrOf(attrs, 'Size', 'Size Type', 'Dimensions');
  const profit = !moneyHidden && !staffMode ? profitAfterFeesCents(ask, cost) : null;
  const shipMode = (() => {
    const o = String(unit?.fulfillment_override || '').toLowerCase();
    if (o === 'ship') return 'Yes · Always ship';
    if (o === 'pickup') return 'No · Pickup only';
    return 'Yes · Automatic (rules)';
  })();
  const ships = String(unit?.fulfillment_override || '').toLowerCase() !== 'pickup' && dns !== true;
  const requiredFields = (ebay?.fields || []).filter((f) => f.required);
  const recommendedFields = (ebay?.fields || []).filter((f) => !f.required && f.recommended);
  const requiredFilled = requiredFields.filter((f) => String(attrs[f.name] || '').trim()).length;
  const recommendedFilled = recommendedFields.filter((f) => String(attrs[f.name] || '').trim()).length;
  const autoUnconfirmed = Boolean(ebay?.auto_picked && ebay?.category_id);
  const review = categoryReview(ebay ? {
    category_id: ebay.category_id,
    auto_picked: ebay.auto_picked,
    review_reason: ebay.review_reason,
    missing: ebay.missing,
  } : null);

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

  return (
    <div className="app-stack app-item-detail">
      <div className="app-nav">
        <button type="button" onClick={onBack}>‹ Inventory</button>
        <div className="app-nav-title">SKU {sku}</div>
        <button
          type="button"
          onClick={() => openEdit()}
          disabled={!detail || staffMode}
          style={moneyHidden || staffMode ? { visibility: 'hidden' } : undefined}
        >
          Edit
        </button>
        {scannerInputReady && (
          <span className="app-scanner-status app-item-scanner-status ok" title="Bluetooth keyboard scanner status is not exposed to Floor.">
            <i />Scanner input ready
          </span>
        )}
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
            <div className="app-hero" ref={heroRef} onScroll={onHeroScroll}>
              {photos.length === 0 && <div className="app-hero-empty">+</div>}
              {photos.map((p) => (
                <img key={p.id} src={urls[p.path] || ''} alt="" />
              ))}
            </div>
            {photos.length > 0 && (
              <div className="app-photo-counter" aria-live="polite">{photoIndex + 1} / {photos.length}</div>
            )}
            <div className="app-photo-thumbs" role="list">
              {photos.map((p, i) => (
                <button
                  type="button"
                  key={p.id}
                  className={`app-photo-thumb${i === photoIndex ? ' is-active' : ''}`}
                  aria-label={`Photo ${i + 1}`}
                  onClick={() => {
                    setPhotoIndex(i);
                    const el = heroRef.current;
                    if (el) el.scrollTo({ left: i * el.clientWidth, behavior: 'smooth' });
                  }}
                >
                  {urls[p.path] ? <img src={urls[p.path]} alt="" /> : null}
                </button>
              ))}
              {!staffMode && !moneyHidden && (
                <button type="button" className="app-photo-thumb app-photo-thumb-add" onClick={() => openEdit('photos')} aria-label="Add photo">
                  +
                </button>
              )}
            </div>
          </div>

          <div className="app-item-head">
            <h1>{titleOf(unit)}</h1>
            <p className="meta app-item-identity">
              {[unit.brand, unit.model, unit.upc].map((v) => String(v || '').trim()).filter(Boolean).join(' · ') || '—'}
            </p>
            <div className="app-item-price-row">
              <p className="price">
                {moneyHidden
                  ? String(unit.state).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
                  : ask == null ? 'No price' : money(ask)}
              </p>
              {!moneyHidden && !staffMode && (
                profit != null
                  ? <span className="app-item-profit">{money(profit)} profit</span>
                  : <button type="button" className="app-text-link warn" onClick={() => openEdit('price')}>Add cost to see profit</button>
              )}
            </div>
          </div>

          <div className="app-status-chips" aria-label="Status">
            {inStock
              ? <span className="app-chip good">In stock · {qty || 1}</span>
              : <span className="app-chip muted">{String(unit.state || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) || 'Out of stock'}</span>}
            {unit.condition ? <span className="app-chip">{String(unit.condition)}</span> : null}
            {!hasLocation && inStock ? <span className="app-chip warn">No location</span> : null}
            {liveCount === 0 && inStock ? <span className="app-chip warn">Not live anywhere</span> : null}
            {dns ? <span className="app-chip warn">DNS</span> : null}
          </div>

          {inStock && !staffMode && (
            <div className="app-quick-actions" role="group" aria-label="Quick actions">
              {canDelete && (
                <button type="button" onClick={() => setListSheet(true)}>List on…</button>
              )}
              <button
                type="button"
                onClick={() => {
                  window.alert('Ring the sale in Register so tax, payment, and inventory stay correct.');
                  onSellInStore();
                }}
              >
                Mark sold
              </button>
              <button
                type="button"
                onClick={() => {
                  void printUnitLabels(
                    Array.from({ length: Math.min(Math.max(qty, 1), 1000) }, () => sku),
                    String(unit.title || `SKU ${sku}`),
                  ).catch((e) => setActionMsg(e instanceof Error ? e.message : String(e)));
                }}
              >
                Print label
              </button>
              {canDelete && (
                <button type="button" onClick={() => openEdit('stock')}>Move</button>
              )}
            </div>
          )}

          <div className="app-section-label">Selling on · {liveCount} live of {CHANNELS.length}</div>
          <div className="app-group app-selling-on">
            {CHANNELS.map((ch) => {
              const row = listingsBy.get(ch.key);
              const pill = statusPill(row?.status || '', ch.key, Boolean(row));
              const price = row?.price_cents != null
                ? Number(row.price_cents)
                : ch.key === 'website' ? ask : null;
              const url = pill.kind === 'live' ? listingLink(ch.key, row?.listing_id) : null;
              return (
                <div className="app-channel-row" key={ch.key}>
                  <span className="app-channel-name">{ch.label}</span>
                  <span className={`app-pill ${pill.kind}`}>{pill.label}</span>
                  <div className="app-channel-action">
                    {pill.kind === 'live' && (
                      <>
                        {price != null && !moneyHidden ? <strong>{money(price)}</strong> : null}
                        {url ? <a href={url} target="_blank" rel="noreferrer">Open</a> : null}
                      </>
                    )}
                    {pill.kind !== 'live' && ch.listable && canDelete && !staffMode && inStock && (
                      <button type="button" className="app-text-link" onClick={() => void enableChannel(ch.key as 'ebay' | 'amazon' | 'tiktok')}>
                        {pill.kind === 'delisted' ? 'Relist' : 'List'}
                      </button>
                    )}
                    {pill.kind !== 'live' && !ch.listable && ch.key !== 'amazon' && (
                      <span className="muted">—</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="app-section-label">Product</div>
          <div className="app-group">
            <Kv label="SKU" value={sku} />
            <Kv label="UPC" value={String(unit.upc || '—')} />
            <Kv label="Brand" value={String(unit.brand || '—')} />
            <Kv label="Model" value={String(unit.model || '—')} />
            <Kv label="Type" value={typeVal || '—'} />
            <Kv label="Color" value={colorVal || '—'} />
            <Kv label="Size" value={sizeVal || '—'} />
            <Kv label="Condition" value={String(unit.condition || '—')} />
            <Kv label="Test status" value={String(unit.test_status || 'Not set')} />
            <div className="app-kv app-kv-stack">
              <span>Category</span>
              <strong>
                {ebay?.path || String(unit.category || unit.ebay_category || '—')}
                {autoUnconfirmed || review?.action === 'confirm' ? (
                  <small className="app-chip warn inline">Auto-picked · not confirmed</small>
                ) : null}
              </strong>
            </div>
          </div>

          <div className="app-section-label">Description</div>
          <div className="app-group app-card-body">
            <p className="app-description-text">
              {String(unit.listing_body || unit.description || '').trim() || 'No description yet.'}
            </p>
          </div>

          {!moneyHidden && (
            <>
              <div className="app-section-label">Pricing</div>
              <div className="app-group">
                <Kv label="Price" value={ask == null ? '—' : money(ask)} />
                {!staffMode && (
                  <div className="app-kv">
                    <span>Cost</span>
                    {cost == null
                      ? <button type="button" className="app-text-link warn" onClick={() => openEdit('price')}>Add cost</button>
                      : <strong>{money(cost)}</strong>}
                  </div>
                )}
                {!staffMode && (
                  <Kv
                    label="Est. profit"
                    value={profit != null ? money(profit) : 'Needs cost'}
                    warn={profit == null}
                  />
                )}
              </div>
            </>
          )}

          <div className="app-section-label">Shipping</div>
          <div className="app-group">
            <Kv label="Ships?" value={ships ? shipMode : 'No · Pickup only'} />
            <Kv label="Box" value={box || '—'} warn={!box} />
            <Kv label="Package weight" value={weight != null ? `${weight} lb` : '—'} warn={weight == null} />
            {dns != null && <Kv label="Do not ship (DNS)" value={dns ? 'On' : 'Off'} />}
          </div>

          {canDelete && !staffMode && ebay && (
            <>
              <div className="app-section-label">eBay item specifics</div>
              <div className="app-group">
                <Kv
                  label="Required"
                  value={`${requiredFilled} of ${requiredFields.length || requiredFilled}`}
                  warn={requiredFields.length > 0 && requiredFilled < requiredFields.length}
                />
                <div className="app-kv">
                  <span>Recommended</span>
                  <button type="button" className="app-text-link" onClick={() => openEdit('ebay')}>
                    {recommendedFilled} of {recommendedFields.length || 13} · Fill in
                  </button>
                </div>
              </div>
            </>
          )}

          <div className="app-section-label">Stock & location</div>
          <div className="app-group">
            <Kv
              label="On hand"
              value={`${qty || 1}${isStocked ? ' · Stocked SKU' : ' · One-of-one'}`}
            />
            <div className="app-kv">
              <span>Location</span>
              {hasLocation
                ? <strong>{locationText}</strong>
                : canDelete && !staffMode
                  ? <button type="button" className="app-text-link warn" onClick={() => openEdit('stock')}>Unassigned · Assign</button>
                  : <strong className="warn">Unassigned</strong>}
            </div>
          </div>

          {history.length > 0 && (
            <>
              <div className="app-section-label">History</div>
              <div className="app-group">
                {history.slice(0, 20).map((h, i) => (
                  <div className="app-kv" key={`${h.at}-${i}`}>
                    <span>{h.label}</span>
                    <strong className="muted">{stamp(h.at)}</strong>
                  </div>
                ))}
              </div>
            </>
          )}

          {inStock && canDelete && !staffMode && showDispositionButtons({ isAdmin: true, unsold: true }) && (
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

          {canDelete && !staffMode && unit.state === 'sold' && (
            <div className="app-item-bottom-actions">
              <RestoreInventoryButton client={client} sku={sku} onDone={() => { onChanged(); onBack(); }} />
            </div>
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
    </div>
  );
}

function Kv({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="app-kv">
      <span>{label}</span>
      <strong className={warn ? 'warn' : undefined}>{value}</strong>
    </div>
  );
}

function channelLabel(channel: string) {
  const hit = CHANNELS.find((c) => c.key === channel.toLowerCase());
  if (hit) return hit.label;
  return channel.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
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
