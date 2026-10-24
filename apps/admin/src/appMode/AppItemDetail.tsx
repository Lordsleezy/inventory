import { useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { UnitEditDrawer } from '../UnitEditDrawer';

type Photo = { id: number; path: string; is_primary: boolean };
type Listing = { channel: string; status: string; listing_id: string | null; price_cents?: number | null };
type Detail = {
  unit: Record<string, unknown>;
  photos: Photo[];
  listings: Listing[];
};

type Props = {
  client: SupabaseClient;
  storeId: string;
  accessToken: string;
  sku: string;
  money: (n: number) => string;
  onBack: () => void;
  onChanged: () => void;
  onSellInStore: () => void;
  /** Portal admin / manager — show Delete on edit. */
  canDelete?: boolean;
};

const CHANNELS: { key: string; label: string }[] = [
  { key: 'ebay', label: 'eBay' },
  { key: 'website', label: 'Website' },
  { key: 'amazon', label: 'Amazon' },
  { key: 'tiktok', label: 'TikTok' },
  { key: 'depop', label: 'Depop' },
];

function titleOf(u: Record<string, unknown>) {
  return [u.brand, u.model].filter(Boolean).join(' ') || String(u.title || 'Untitled');
}

export function AppItemDetail({
  client, storeId, accessToken, sku, money, onBack, onChanged, onSellInStore, canDelete = false,
}: Props) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    void (async () => {
      try {
        const { data, error: e } = await client.rpc('portal_inventory_detail', { p_sku: sku });
        if (e) throw e;
        if (!data) throw new Error('Unit not found');
        const next = data as Detail;
        const paths = next.photos.map((p) => p.path);
        const keys = paths.filter((p) => /^[0-9a-f-]{36}\//i.test(p));
        let signed: Record<string, string> = {};
        if (keys.length) {
          const { data: s } = await client.storage.from('unit-photos').createSignedUrls(keys, 3600);
          signed = Object.fromEntries((s || []).map((x, i) => [keys[i], x.signedUrl || '']));
        }
        if (!alive) return;
        setDetail(next);
        setUrls(signed);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, [client, sku, reload]);

  const unit = detail?.unit;
  const listingsBy = useMemo(() => {
    const map = new Map<string, Listing>();
    for (const l of detail?.listings || []) map.set(String(l.channel).toLowerCase(), l);
    return map;
  }, [detail]);

  if (editing && detail) {
    return (
      <div className="app-stack app-stack-edit">
        <UnitEditDrawer
          client={client}
          storeId={storeId}
          sku={sku}
          unit={detail.unit}
          photos={detail.photos}
          urls={urls}
          accessToken={accessToken}
          appMode
          canDelete={canDelete}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
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
  const box = L != null && W != null && H != null ? `${L}×${W}×${H} in` : null;
  const ask = unit?.ask_cents != null ? Number(unit.ask_cents) : null;
  const cost = unit?.acquisition_cost_cents != null ? Number(unit.acquisition_cost_cents) : null;
  const photos = detail?.photos || [];

  return (
    <div className="app-stack">
      <div className="app-nav">
        <button type="button" onClick={onBack}>‹ Inventory</button>
        <div className="app-nav-title">{sku}</div>
        <button type="button" onClick={() => setEditing(true)} disabled={!detail}>Edit</button>
      </div>

      {error && <p className="app-footer-count" style={{ color: '#ff453a' }}>{error}</p>}
      {!detail && !error && <p className="app-footer-count">Loading…</p>}

      {detail && unit && (
        <>
          <div className="app-hero">
            {photos.length === 0 && <div className="app-hero-empty">+</div>}
            {photos.map((p) => (
              <img key={p.id} src={urls[p.path] || ''} alt="" />
            ))}
          </div>

          <div className="app-item-head">
            <h1>{titleOf(unit)}</h1>
            <p className="meta">
              {sku} · {String(unit.condition || 'No grade')} · {String(unit.category || 'Uncategorized')}
            </p>
            <p className="price">{ask == null ? 'No price' : money(ask)}</p>
          </div>

          <div className="app-section-label">Selling on</div>
          <div className="app-group">
            {CHANNELS.map((ch) => {
              const row = listingsBy.get(ch.key);
              const live = row && String(row.status).toLowerCase() === 'listed';
              const price = row?.price_cents != null
                ? Number(row.price_cents)
                : ch.key === 'website'
                  ? ask
                  : null;
              let value = 'Not listed';
              let cls = 'muted';
              if (live) {
                value = price != null ? `Live · ${money(price)}` : 'Live';
                cls = 'live';
              } else if (ch.key === 'amazon' && !row) {
                value = 'Not on Amazon';
              } else if (row) {
                value = String(row.status).replace(/_/g, ' ');
              }
              return (
                <div className="app-kv" key={ch.key}>
                  <span>{ch.label}</span>
                  <strong className={cls}>{value}</strong>
                </div>
              );
            })}
          </div>

          <div className="app-section-label">Details</div>
          <div className="app-group">
            <div className="app-kv">
              <span>Cost</span>
              <strong className={cost == null ? 'warn' : undefined}>{cost == null ? 'Add cost' : money(cost)}</strong>
            </div>
            <div className="app-kv">
              <span>Weight · box</span>
              <strong className={weight == null || !box ? 'warn' : undefined}>
                {weight == null && !box
                  ? 'Add weight'
                  : `${weight != null ? `${weight} lb` : '—'} · ${box || '—'}`}
              </strong>
            </div>
            <div className="app-kv">
              <span>Location</span>
              <strong className="muted">{String(unit.location || unit.bin || '—')}</strong>
            </div>
          </div>

          <div className="app-actions">
            <button type="button" onClick={onSellInStore}>Sell in store</button>
            <button
              type="button"
              className="danger"
              onClick={() => {
                window.alert('Ring the sale in Register so tax, payment, and inventory stay correct.');
                onSellInStore();
              }}
            >
              Mark sold
            </button>
          </div>
        </>
      )}
    </div>
  );
}
