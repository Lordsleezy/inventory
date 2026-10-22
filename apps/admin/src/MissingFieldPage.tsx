import { useCallback, useEffect, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { errText } from './errText';

type Kind = 'photo' | 'price' | 'spec' | 'model' | 'description' | 'brand' | 'category' | 'upc' | 'condition' | 'specifics';
type Row = {
  sku: string;
  title: string;
  state: string;
  ask_cents: number | null;
  received_at: string;
  photo_count: number;
  package_weight_lb: number | null;
  package_length_in: number | null;
  package_width_in: number | null;
  package_height_in: number | null;
  blocks?: string | null;
  missing_aspects?: string | null;
};

const COPY: Record<Kind, { title: string; hint: string; empty: string }> = {
  photo: {
    title: 'Missing photo',
    hint: 'Tap the camera on a card to take or choose a photo. It uploads to Floor and shows everywhere.',
    empty: 'Every in-stock unit has a photo.',
  },
  price: {
    title: 'Missing price',
    hint: 'Enter Floor ask price and Save. It updates inventory, storefront, and reports.',
    empty: 'Every in-stock unit has a price.',
  },
  model: {
    title: 'Missing model',
    hint: 'Type the manufacturer model number (from the box or label) and Save. Leave it alone if you do not know it.',
    empty: 'Every in-stock unit has a model.',
  },
  description: {
    title: 'Missing description',
    hint: 'Write or paste the listing description and Save. It is used for marketplace listings.',
    empty: 'Every in-stock unit has a description.',
  },
  spec: {
    title: 'Missing weight & dimensions',
    hint: 'Enter package weight (lb) and L × W × H (in), then Save. Blocks eBay, Amazon, and TikTok.',
    empty: 'Every in-stock unit has package weight and dimensions.',
  },
  brand: {
    title: 'Missing brand',
    hint: 'Type the brand printed on the product or the packaging. Unbranded is only for a product that truly has no brand anywhere on it. Blocks eBay, Amazon, and TikTok.',
    empty: 'Every in-stock unit has a brand.',
  },
  category: {
    title: 'Missing category',
    hint: 'Enter the product category. Blocks eBay and TikTok until a category is set.',
    empty: 'Every in-stock unit has a category.',
  },
  upc: {
    title: 'Missing UPC',
    hint: 'Enter the 8–14 digit barcode. Blocks eBay and Amazon.',
    empty: 'Every in-stock unit has a UPC.',
  },
  condition: {
    title: 'Missing condition',
    hint: 'Enter the condition (New, Open box, Scratch & dent). Blocks eBay, Amazon, and TikTok.',
    empty: 'Every in-stock unit has a condition.',
  },
  specifics: {
    title: 'Missing item specifics',
    hint: 'These are required eBay item specifics for the unit’s category. Fill the named field. Nothing is guessed.',
    empty: 'No stored eBay category is waiting on a required item specific.',
  },
};

const TEXT_KINDS = new Set<Kind>(['model', 'description', 'brand', 'category', 'upc', 'condition']);
const TEXT_FIELD: Partial<Record<Kind, string>> = {
  model: 'model',
  description: 'description',
  brand: 'brand',
  category: 'category',
  upc: 'upc',
  condition: 'condition',
};

type Props = {
  client: SupabaseClient;
  storeId: string;
  kind: Kind;
  money: (n: number) => string;
  stamp: (s: string) => string;
};

const PAGE = 100;
const moneyEntry = /^\d*(?:\.\d{0,2})?$/;
const numEntry = /^\d*(?:\.\d{0,2})?$/;

function cents(input: string): number | null {
  const text = input.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!text) return null;
  if (!/^\d+(\.\d{0,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const value = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(value) ? value : null;
}

export function MissingFieldPage({ client, storeId, kind, money, stamp }: Props) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState<string | null>(null);
  const [busySku, setBusySku] = useState<string | null>(null);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [specs, setSpecs] = useState<Record<string, { lb: string; l: string; w: string; h: string }>>({});
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bulkBrand, setBulkBrand] = useState('');
  const [bulkUnbranded, setBulkUnbranded] = useState(false);
  const fileRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const copy = COPY[kind];

  const load = useCallback(async () => {
    const { data, error: e } = await client.rpc('portal_units_missing_field', {
      p_kind: kind,
      p_limit: PAGE,
      p_offset: 0,
    });
    if (e) {
      setError(e.message);
      return;
    }
    const d = data as { total: number; rows: Row[] };
    const list = d.rows || [];
    setRows(list);
    setTotal(d.total || 0);
    if (kind === 'spec') {
      setSpecs((prev) => {
        const next = { ...prev };
        for (const r of list) {
          if (!next[r.sku]) {
            next[r.sku] = {
              lb: r.package_weight_lb != null && Number(r.package_weight_lb) > 0 ? String(r.package_weight_lb) : '',
              l: r.package_length_in != null && Number(r.package_length_in) > 0 ? String(r.package_length_in) : '',
              w: r.package_width_in != null && Number(r.package_width_in) > 0 ? String(r.package_width_in) : '',
              h: r.package_height_in != null && Number(r.package_height_in) > 0 ? String(r.package_height_in) : '',
            };
          }
        }
        return next;
      });
    }
  }, [client, kind]);

  useEffect(() => {
    setRows(null);
    setPrices({});
    setTexts({});
    setSpecs({});
    setPicked(new Set());
    setBulkBrand('');
    setBulkUnbranded(false);
    setFlash(null);
    void load();
  }, [load]);

  async function uploadPhoto(sku: string, file: File) {
    if (!file.type.startsWith('image/')) {
      setError('Choose an image file.');
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      setError('Photo must be under 15 MB.');
      return;
    }
    setBusySku(sku);
    setError('');
    setFlash(null);
    try {
      const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_') || 'photo.jpg';
      const path = `${storeId}/${sku}/${Date.now()}-${crypto.randomUUID()}-${safe}`;
      const upload = await client.storage.from('unit-photos').upload(path, file, {
        contentType: file.type || 'image/jpeg',
        upsert: false,
      });
      if (upload.error) throw upload.error;
      const linked = await client.rpc('portal_add_unit_photo', { p_sku: sku, p_path: path });
      if (linked.error) throw linked.error;
      setFlash(`Photo added for SKU ${sku}.`);
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusySku(null);
    }
  }

  async function savePrice(sku: string) {
    const value = cents(prices[sku] || '');
    if (value == null || value < 0) {
      setError('Enter a price like 24.99 (0 is allowed).');
      return;
    }
    setBusySku(sku);
    setError('');
    setFlash(null);
    const { error: e } = await client.rpc('portal_set_unit_ask', { p_sku: sku, p_ask_cents: value });
    setBusySku(null);
    if (e) {
      setError(e.message);
      return;
    }
    setPrices((p) => {
      const n = { ...p };
      delete n[sku];
      return n;
    });
    setFlash(`Price saved for SKU ${sku}.`);
    await load();
  }

  async function saveText(sku: string) {
    const field = TEXT_FIELD[kind];
    if (!field) return;
    const value = (texts[sku] || '').trim();
    if (!value) {
      setError(`Enter a ${kind}.`);
      return;
    }
    if (kind === 'brand' && /^unbranded$/i.test(value)) {
      setError('Use the Unbranded checkbox on a batch only when the product has no brand on it or the packaging.');
      return;
    }
    setBusySku(sku);
    setError('');
    setFlash(null);
    const { error: e } = await client.rpc('portal_set_unit_text', { p_sku: sku, p_field: field, p_value: value });
    setBusySku(null);
    if (e) {
      setError(e.message);
      return;
    }
    setTexts((p) => {
      const n = { ...p };
      delete n[sku];
      return n;
    });
    setFlash(`${kind[0].toUpperCase()}${kind.slice(1)} saved for SKU ${sku}.`);
    await load();
  }

  async function saveSpec(sku: string) {
    const s = specs[sku] || { lb: '', l: '', w: '', h: '' };
    const vals = [s.l, s.w, s.h, s.lb].map((raw) => {
      const t = raw.trim();
      if (!t) return null;
      const n = Number(t);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    });
    if (vals.some((v) => v === undefined)) {
      setError('Dimensions and weight must be positive numbers.');
      return;
    }
    if (vals.some((v) => v == null)) {
      setError('Fill length, width, height, and weight.');
      return;
    }
    setBusySku(sku);
    setError('');
    setFlash(null);
    const { error: e } = await client.rpc('portal_set_unit_shipping', {
      p_sku: sku,
      p_override: '',
      p_length: vals[0],
      p_width: vals[1],
      p_height: vals[2],
      p_weight: vals[3],
    });
    setBusySku(null);
    if (e) {
      setError(e.message);
      return;
    }
    setSpecs((prev) => {
      const n = { ...prev };
      delete n[sku];
      return n;
    });
    setFlash(`Package specs saved for SKU ${sku}.`);
    await load();
  }

  async function saveAspect(sku: string, name: string) {
    const value = (texts[`${sku}:${name}`] || '').trim();
    if (!value) {
      setError(`Enter ${name}.`);
      return;
    }
    setBusySku(sku);
    setError('');
    setFlash(null);
    const { error: e } = await client.rpc('portal_set_unit_aspect', { p_sku: sku, p_name: name, p_value: value });
    setBusySku(null);
    if (e) {
      setError(e.message);
      return;
    }
    setFlash(`${name} saved for SKU ${sku}.`);
    await load();
  }

  async function saveBulkBrand() {
    const value = bulkUnbranded ? 'Unbranded' : bulkBrand.trim();
    if (!value) {
      setError('Enter a brand, or check Unbranded when the products have no brand.');
      return;
    }
    if (!bulkUnbranded && /^unbranded$/i.test(value)) {
      setError('Check Unbranded only when the product has no brand on it or the packaging.');
      return;
    }
    const skus = [...picked];
    if (!skus.length) {
      setError('Select at least one unit.');
      return;
    }
    setBusySku('*');
    setError('');
    setFlash(null);
    const { data, error: e } = await client.rpc('portal_bulk_set_unit_text', {
      p_skus: skus,
      p_field: 'brand',
      p_value: value,
    });
    setBusySku(null);
    if (e) {
      setError(e.message);
      return;
    }
    const count = (data as { updated?: number } | null)?.updated ?? skus.length;
    setPicked(new Set());
    setBulkBrand('');
    setBulkUnbranded(false);
    setFlash(`Brand saved on ${count} unit${count === 1 ? '' : 's'}.`);
    await load();
  }

  return (
    <>
      <div className="section-head fix-section-head">
        <div>
          <h2>{copy.title}</h2>
          <p className="hint" style={{ margin: 0 }}>
            {copy.hint}
          </p>
        </div>
      </div>
      {error && (
        <div className="alert" role="alert">
          {error}
          <button type="button" onClick={() => setError('')}>
            Dismiss
          </button>
        </div>
      )}
      {flash && (
        <div className="hint">
          {flash}{' '}
          <button type="button" className="text-button" onClick={() => setFlash(null)}>
            Dismiss
          </button>
        </div>
      )}
      {kind === 'brand' && rows && rows.length > 0 && (
        <div className="actions" style={{ margin: '12px 0' }}>
          <label className="fix-task-field">
            <span>Brand for selected</span>
            <input
              value={bulkBrand}
              disabled={bulkUnbranded || busySku === '*'}
              aria-label="Brand for selected units"
              onChange={(e) => setBulkBrand(e.target.value)}
            />
          </label>
          <label className="mboard-inline">
            <input type="checkbox" checked={bulkUnbranded} onChange={(e) => setBulkUnbranded(e.target.checked)} />
            Unbranded — no brand on the product or packaging
          </label>
          <button type="button" disabled={busySku === '*' || picked.size === 0} onClick={() => void saveBulkBrand()}>
            {busySku === '*' ? 'Saving…' : `Set brand on ${picked.size || 0}`}
          </button>
        </div>
      )}
      <div className="stats fix-stats">
        <div className="stat">
          <span>Units</span>
          <strong>{total}</strong>
        </div>
      </div>
      <section className="panel fix-panel">
        {rows === null ? (
          <p className="hint">Loading…</p>
        ) : rows.length === 0 ? (
          <div className="empty">{copy.empty}</div>
        ) : (
          <ul className="fix-task-list">
            {rows.map((r) => (
              <li className="fix-task" key={r.sku}>
                <div className="fix-task-head">
                  <strong className="fix-task-sku">{r.sku}</strong>
                  <span className="tag">{r.state === 'available' ? 'in stock' : r.state}</span>
                </div>
                <div className="fix-task-title">{r.title}</div>
                {r.blocks && <div className="fix-task-meta"><span>Blocks {r.blocks}</span></div>}
                {kind !== 'price' && (
                  <div className="fix-task-meta">
                    <span>Ask {r.ask_cents != null ? money(r.ask_cents) : '—'}</span>
                    <span className="fix-task-muted">Received {stamp(r.received_at)}</span>
                  </div>
                )}
                {kind === 'price' && (
                  <div className="fix-task-meta">
                    <span className="fix-task-muted">Received {stamp(r.received_at)}</span>
                  </div>
                )}
                <div className={`fix-task-action${kind === 'photo' ? ' fix-task-action-photo' : ''}${kind === 'spec' ? ' fix-task-action-spec' : ''}`}>
                  {kind === 'photo' && (
                    <>
                      <input
                        ref={(el) => {
                          fileRefs.current[r.sku] = el;
                        }}
                        type="file"
                        accept="image/*"
                        capture="environment"
                        className="sr-only"
                        aria-label={`Take photo for SKU ${r.sku}`}
                        disabled={busySku === r.sku}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          e.target.value = '';
                          if (file) void uploadPhoto(r.sku, file);
                        }}
                      />
                      <button
                        type="button"
                        className="camera-btn fix-camera-btn"
                        disabled={busySku === r.sku}
                        title="Take or choose photo"
                        aria-label={`Camera for SKU ${r.sku}`}
                        onClick={() => fileRefs.current[r.sku]?.click()}
                      >
                        {busySku === r.sku ? (
                          'Uploading…'
                        ) : (
                          <>
                            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                              <path
                                d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.2l1.1-1.6A1.5 1.5 0 0 1 10 3.5h4a1.5 1.5 0 0 1 1.2.9L16.3 6h1.2A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5v-8Z"
                                stroke="currentColor"
                                strokeWidth="1.7"
                              />
                              <circle cx="12" cy="12.5" r="3.2" stroke="currentColor" strokeWidth="1.7" />
                            </svg>
                            Add photo
                          </>
                        )}
                      </button>
                    </>
                  )}
                  {kind === 'price' && (
                    <>
                      <label className="fix-task-field">
                        <span>Ask ($)</span>
                        <input
                          inputMode="decimal"
                          placeholder="24.99"
                          aria-label={`Ask price for SKU ${r.sku}`}
                          value={prices[r.sku] || ''}
                          disabled={busySku === r.sku}
                          onChange={(e) => {
                            if (moneyEntry.test(e.target.value)) setPrices({ ...prices, [r.sku]: e.target.value });
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void savePrice(r.sku);
                          }}
                        />
                      </label>
                      <button
                        type="button"
                        disabled={busySku === r.sku || !(prices[r.sku] || '').trim()}
                        onClick={() => void savePrice(r.sku)}
                      >
                        {busySku === r.sku ? 'Saving…' : 'Save'}
                      </button>
                    </>
                  )}
                  {kind === 'brand' && (
                    <label className="mboard-inline">
                      <input
                        type="checkbox"
                        checked={picked.has(r.sku)}
                        onChange={() => setPicked((prev) => {
                          const next = new Set(prev);
                          if (next.has(r.sku)) next.delete(r.sku);
                          else next.add(r.sku);
                          return next;
                        })}
                      />
                      Select
                    </label>
                  )}
                  {TEXT_KINDS.has(kind) && (
                    <>
                      <label className="fix-task-field">
                        <span>{kind === 'model' ? 'Model' : kind === 'description' ? 'Description' : kind[0].toUpperCase() + kind.slice(1)}</span>
                        {kind === 'description' ? (
                          <textarea
                            rows={3}
                            aria-label={`Description for SKU ${r.sku}`}
                            value={texts[r.sku] || ''}
                            disabled={busySku === r.sku}
                            onChange={(e) => setTexts({ ...texts, [r.sku]: e.target.value })}
                          />
                        ) : (
                          <input
                            placeholder={kind === 'upc' ? '012345678905' : kind === 'brand' ? 'Brand on the product' : kind === 'model' ? 'e.g. WH-1000XM4' : ''}
                            aria-label={`${kind} for SKU ${r.sku}`}
                            value={texts[r.sku] || ''}
                            disabled={busySku === r.sku}
                            onChange={(e) => setTexts({ ...texts, [r.sku]: e.target.value })}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void saveText(r.sku);
                            }}
                          />
                        )}
                      </label>
                      <button
                        type="button"
                        disabled={busySku === r.sku || !(texts[r.sku] || '').trim()}
                        onClick={() => void saveText(r.sku)}
                      >
                        {busySku === r.sku ? 'Saving…' : 'Save'}
                      </button>
                    </>
                  )}
                  {kind === 'specifics' && (r.missing_aspects || '').split(',').map((name) => name.trim()).filter(Boolean).map((name) => (
                    <label className="fix-task-field" key={name}>
                      <span>{name}</span>
                      <input
                        aria-label={`${name} for SKU ${r.sku}`}
                        value={texts[`${r.sku}:${name}`] || ''}
                        disabled={busySku === r.sku}
                        onChange={(e) => setTexts({ ...texts, [`${r.sku}:${name}`]: e.target.value })}
                      />
                      <button type="button" disabled={busySku === r.sku || !(texts[`${r.sku}:${name}`] || '').trim()} onClick={() => void saveAspect(r.sku, name)}>
                        {busySku === r.sku ? 'Saving…' : 'Save'}
                      </button>
                    </label>
                  ))}
                  {kind === 'spec' && (
                    <>
                      <div className="fix-spec-grid">
                        {(
                          [
                            ['l', 'L (in)'],
                            ['w', 'W (in)'],
                            ['h', 'H (in)'],
                            ['lb', 'Weight (lb)'],
                          ] as const
                        ).map(([key, label]) => (
                          <label key={key} className="fix-task-field">
                            <span>{label}</span>
                            <input
                              inputMode="decimal"
                              aria-label={`${label} for SKU ${r.sku}`}
                              value={(specs[r.sku] || { lb: '', l: '', w: '', h: '' })[key]}
                              disabled={busySku === r.sku}
                              onChange={(e) => {
                                if (!numEntry.test(e.target.value)) return;
                                setSpecs({
                                  ...specs,
                                  [r.sku]: { ...(specs[r.sku] || { lb: '', l: '', w: '', h: '' }), [key]: e.target.value },
                                });
                              }}
                            />
                          </label>
                        ))}
                      </div>
                      <button
                        type="button"
                        className="fix-spec-save"
                        disabled={busySku === r.sku}
                        onClick={() => void saveSpec(r.sku)}
                      >
                        {busySku === r.sku ? 'Saving…' : 'Save'}
                      </button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {kind !== 'photo' && total > PAGE && (
          <p className="hint">Showing the first {PAGE}. Fill some in and the rest move up.</p>
        )}
        {kind === 'photo' && total > PAGE && (
          <p className="hint">Showing the first {PAGE}. Add photos and the rest move up.</p>
        )}
      </section>
    </>
  );
}
