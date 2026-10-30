import { inventoryMissingText } from './inventoryMissing';
import { DnsCheckbox } from './DnsCheckbox';
import { ReceiveWorkStatus } from './ReceiveWorkStatus';
﻿import { useEffect, useRef, useState } from 'react';
import { ChannelCheckboxes } from './ChannelCheckboxes';
import { RestoreInventoryButton } from './RestoreInventoryButton';
import { UnitDispositionHistory } from './DispositionDialogs';
import { EbaySpecificsPanel } from './EbaySpecificsPanel';
import type { SupabaseClient } from '@supabase/supabase-js';
import { floorFunctionUrl } from './floorApi';
import { scannerInputMode } from './kiosk';
import { reportClientError } from './clientLog';
import { errText } from './errText';
import { reviewReasonLabel } from './inventoryReview';
import { DispositionButtons } from './DispositionDialogs';

type Photo = { id: number; path: string; is_primary: boolean; sort_order?: number; source?: string };
type Unit = Record<string, unknown>;
type Options = { conditions: unknown; test_statuses: unknown };

type Form = {
  upc: string; brand: string; model: string; title: string; description: string;
  price: string; cost: string; condition: string; testStatus: string;
  shippable: string; notes: string; length: string; width: string; height: string; weight: string;
};

function choices(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string') {
    try { return choices(JSON.parse(value)); } catch { return []; }
  }
  return [];
}

function cents(input: string): number | null | undefined {
  const text = input.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!text) return null;
  if (!/^\d+(\.\d{0,2})?$/.test(text)) return undefined;
  const [whole, fraction = ''] = text.split('.');
  const value = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(value) ? value : undefined;
}

function moneyText(centsVal: unknown): string {
  if (centsVal == null || centsVal === '') return '';
  const n = Number(centsVal);
  if (!Number.isFinite(n)) return '';
  return (n / 100).toFixed(2);
}

function dimText(v: unknown): string {
  if (v == null || v === '') return '';
  return String(v);
}

function shipMode(unit: Unit): string {
  const o = String(unit.fulfillment_override || '').toLowerCase();
  if (o === 'ship') return 'ship';
  if (o === 'pickup') return 'pickup';
  return 'auto';
}

function fromUnit(unit: Unit): Form {
  return {
    upc: String(unit.upc || ''),
    brand: String(unit.brand || ''),
    model: String(unit.model || ''),
    title: String(unit.title || ''),
    description: String(unit.listing_body || unit.description || ''),
    price: moneyText(unit.ask_cents),
    cost: moneyText(unit.acquisition_cost_cents),
    condition: String(unit.condition || ''),
    testStatus: String(unit.test_status || ''),
    shippable: shipMode(unit),
    notes: String(unit.defect_notes || unit.notes || ''),
    length: dimText(unit.package_length_in),
    width: dimText(unit.package_width_in),
    height: dimText(unit.package_height_in),
    weight: dimText(unit.package_weight_lb),
  };
}

function blank(v: string) { return !v.trim(); }

function featuresText(features?: string[]) {
  const list = (features || []).map(f => f.trim()).filter(Boolean);
  return list.map(f => `• ${f}`).join('\n');
}

type LookupMerged = {
  title?: string | null; brand?: string | null; model?: string | null; description?: string | null;
  features?: string[]; asin?: string | null; msrp_cents?: number | null;
  retail_cents?: number | null; retail_source?: string | null; retail_as_of?: string | null;
  package?: { length_in?: number | null; width_in?: number | null; height_in?: number | null; weight_lb?: number | null };
};

export function UnitEditDrawer({
  client, storeId, sku, unit, photos, urls, accessToken, onClose, onSaved, onPhotosChanged,
  canDelete = false, onDeleted, appMode = false, missingFields = [], locationLabel, onReadinessChanged,
}: {
  client: SupabaseClient;
  storeId: string;
  sku: string;
  unit: Unit;
  photos: Photo[];
  urls: Record<string, string>;
  accessToken: string;
  onClose: () => void;
  onSaved: (unit: Unit) => void;
  onPhotosChanged: () => void;
  /** Portal admins / managers only — hides Delete for register associates. */
  canDelete?: boolean;
  onDeleted?: () => void;
  /** Standalone Floor app: clear the bottom tab bar; use app chrome. */
  appMode?: boolean;
  missingFields?: string[];
  locationLabel?: string;
  onReadinessChanged?: (gaps?: string[]) => void;
}) {
  const [form, setForm] = useState<Form>(() => fromUnit(unit));
  const [options, setOptions] = useState<Options | null>(null);
  const [busy, setBusy] = useState(false);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const specificsPersist = useRef<null | (() => Promise<void>)>(null);
  // The panel can change the description during Save; read it from here, not from the render's stale form.
  const latestDescription = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const [viewPhoto, setViewPhoto] = useState<Photo | null>(null);
  const upcInput = useRef<HTMLInputElement>(null);
  const onlineDetails = useRef<HTMLDetailsElement>(null);
  const [currentMissing, setCurrentMissing] = useState(missingFields);
  const set = (key: keyof Form, value: string) => setForm(prev => ({ ...prev, [key]: value }));
  const jumpToGap = (gap: string) => {
    if (gap === 'category' || gap === 'category_review' || gap === 'specifics' || gap.startsWith('review_')) {
      if (onlineDetails.current) onlineDetails.current.open = true;
      window.setTimeout(() => document.querySelector('.unit-edit-online .ebay-specifics')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 80);
      return;
    }
    const target = gap === 'spec' ? 'unit-package-size' : document.querySelector(`[data-gap-target="${gap}"]`)?.id;
    if (target) document.getElementById(target)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  const gapLabel: Record<string,string> = { photo:'photos', price:'price', brand:'brand', condition:'condition', category:'eBay category', category_review:'eBay category review', specifics:'eBay item specifics', spec:'package size for shipping', upc:'UPC', model:'model', title:'title', description:'description' };
  const cancel = () => {
    const initial = fromUnit(unit);
    const hasChanges = JSON.stringify(form) !== JSON.stringify(initial) || latestDescription.current != null;
    if (hasChanges && !window.confirm('Discard unsaved changes?')) return;
    onClose();
  };

  useEffect(() => { setForm(fromUnit(unit)); setMsg(''); setError(''); setCurrentMissing(missingFields); }, [sku]);
  useEffect(() => { setCurrentMissing(missingFields); }, [missingFields.join('|')]);
  useEffect(() => {
    void client.rpc('portal_receive_options').then(({ data, error: e }) => {
      if (!e && data) setOptions(data as Options);
    });
  }, [client]);

  /** Fill only blank fields from a UPC lookup; never overwrite typed values. */
  async function attachUpc(raw: string) {
    const upc = raw.replace(/\s+/g, '');
    if (!/^\d{8,14}$/.test(upc)) {
      setError(`"${raw.trim()}" does not look like a UPC/EAN (8–14 digits).`);
      return;
    }
    setLookupBusy(true); setError(''); setMsg('');
    try {
      const res = await fetch(floorFunctionUrl('upc-lookup'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'lookup', upc, compare_upcitemdb: true }),
      });
      const json = await res.json().catch(() => ({} as { error?: string; message?: string; merged?: LookupMerged; gtin?: { upcA?: string } }));
      if (!res.ok) {
        const errMsg = json.error || json.message || `Lookup failed (${res.status})`;
        reportClientError(accessToken, { message: `upc_lookup failed: ${errMsg}`, page: 'inventory/unit', action_name: 'upc_attach', sku: upc });
        throw new Error(errMsg);
      }
      const m = json.merged || {};
      const pkg = m.package || {};
      const filled: string[] = [];
      setForm(prev => {
        const next = { ...prev };
        const put = (key: keyof Form, value: string | null | undefined, label: string) => {
          if (!value || !String(value).trim()) return;
          if (!blank(prev[key])) return;
          next[key] = String(value).trim();
          filled.push(label);
        };
        next.upc = upc;
        if (!prev.upc.trim()) filled.push('UPC');
        put('brand', m.brand, 'brand');
        put('model', m.model, 'model');
        put('title', m.title, 'title');
        const desc = (m.description || '').trim() || featuresText(m.features);
        put('description', desc, 'description');
        put('length', pkg.length_in != null ? String(pkg.length_in) : '', 'length');
        put('width', pkg.width_in != null ? String(pkg.width_in) : '', 'width');
        put('height', pkg.height_in != null ? String(pkg.height_in) : '', 'height');
        put('weight', pkg.weight_lb != null ? String(pkg.weight_lb) : '', 'weight');
        if (blank(prev.price) && m.retail_cents && m.retail_cents > 0) {
          // Suggest under retail; user still confirms via Save.
          const suggest = Math.ceil((Math.round(m.retail_cents * 0.55) + 1) / 100) * 100 - 1;
          if (suggest > 0 && suggest < m.retail_cents) {
            next.price = (suggest / 100).toFixed(2);
            filled.push('price');
          }
        }
        return next;
      });

      // Persist UPC + blank fills via enrich (never overwrites non-blank) then update UPC/cost fields.
      const specs: Record<string, unknown> = {
        upc,
        gtin: json.gtin?.upcA || upc,
        asin: m.asin || undefined,
        retail_cents: m.retail_cents || undefined,
        retail_source: m.retail_source || undefined,
        retail_as_of: m.retail_as_of || undefined,
        features: (m.features || []).filter(Boolean),
      };
      await client.rpc('portal_enrich_received_unit', {
        p_sku: sku,
        p_specs: specs,
        p_msrp_cents: m.msrp_cents ?? null,
        p_brand: blank(form.brand) ? (m.brand || null) : null,
        p_model: blank(form.model) ? (m.model || null) : null,
        p_title: blank(form.title) ? (m.title || null) : null,
        p_description: blank(form.description) ? ((m.description || '').trim() || featuresText(m.features) || null) : null,
      });

      setMsg(filled.length
        ? `Attached UPC ${upc}. Filled blank: ${filled.join(', ')}. Review and Save if price/cost look right.`
        : `Attached UPC ${upc}. Existing fields were kept (nothing overwritten).`);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLookupBusy(false);
    }
  }

  async function save() {
    // Specifics typed or a generated description ticked in the panel below are saved first, so Save changes never drops them.
    try { await specificsPersist.current?.(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); return; }
    const ask = cents(form.price);
    const cost = cents(form.cost);
    if (ask === undefined) { setError('Price must look like 24.99 (blank = no price).'); return; }
    if (cost === undefined) { setError('Cost must look like 9.00 (blank = unknown).'); return; }
    const dims = [form.length, form.width, form.height, form.weight].map(v => {
      const t = v.trim();
      if (!t) return null;
      const n = Number(t);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    });
    if (dims.some(v => v === undefined)) {
      setError('Dimensions and weight must be positive numbers (or blank).');
      return;
    }
    // units.title is NOT NULL — never send blank/null. Prefer typed title, else brand + model, else SKU.
    const title = form.title.trim()
      || [form.brand, form.model].map((s) => s.trim()).filter(Boolean).join(' ')
      || `SKU ${sku}`;
    if (title !== form.title.trim()) {
      setForm((prev) => ({ ...prev, title }));
    }
    setBusy(true); setError(''); setMsg('');
    // brand/model/title are NOT NULL — always send strings ('' ok), never null/undefined.
    const { data, error: e } = await client.rpc('portal_update_unit', {
      p_sku: sku,
      p_upc: form.upc.trim(),
      p_brand: form.brand.trim(),
      p_model: form.model.trim(),
      p_title: title,
      p_description: latestDescription.current ?? form.description,
      p_ask_cents: ask,
      p_cost_cents: canDelete ? cost : (unit.acquisition_cost_cents == null ? null : Number(unit.acquisition_cost_cents)),
      p_condition: form.condition,
      p_test_status: form.testStatus,
      p_shippable: form.shippable,
      p_notes: form.notes,
      p_length: dims[0],
      p_width: dims[1],
      p_height: dims[2],
      p_weight: dims[3],
    });
    setBusy(false);
    if (e) { setError(e.message); return; }
    const saved = data as Record<string, unknown>;
    const { data: gaps, error: readinessError } = await client.rpc('portal_unit_readiness_gaps', { p_sku: sku });
    if (readinessError) {
      reportClientError(accessToken, { message: `Readiness refresh failed: ${readinessError.message}`, page: 'inventory/unit', action_name: 'readiness_refresh', sku });
    } else if (Array.isArray(gaps)) {
      setCurrentMissing(gaps as string[]);
      onReadinessChanged?.(gaps as string[]);
    }
    if (String(saved.title || '').trim() !== String(unit.title || '').trim()) {
      // A new title may now get an eBay category suggestion / generated description if those are still blank (never overwrites).
      void fetch(floorFunctionUrl('ebay-specifics'), { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ store_id: storeId, sku, action: 'auto-fill' }) }).catch(() => {});
    }
    onSaved({
      ...unit,
      upc: saved.upc,
      brand: saved.brand,
      model: saved.model,
      title: saved.title,
      listing_body: saved.description,
      ask_cents: saved.ask_cents,
      acquisition_cost_cents: saved.cost_cents,
      condition: saved.condition,
      test_status: saved.test_status,
      defect_notes: saved.notes,
      package_length_in: saved.package_length_in,
      package_width_in: saved.package_width_in,
      package_height_in: saved.package_height_in,
      package_weight_lb: saved.package_weight_lb,
      fulfillment_override: saved.fulfillment_override,
      shippable: saved.shippable,
    });
    setMsg('Saved.');
  }

  async function clearEbayReview() {
    if (!canDelete) return;
    setBusy(true); setError(''); setMsg('');
    const { data, error: e } = await client.rpc('portal_clear_ebay_review', { p_sku: sku });
    setBusy(false);
    if (e) { setError(e.message); return; }
    const saved = data as { listing_specs?: unknown };
    onSaved({ ...unit, listing_specs: saved.listing_specs || {} });
    setMsg('eBay review cleared. Recheck the listing details before publishing.');
  }

  async function removeUnit() {
    if (!canDelete) return;
    if (!window.confirm(`Delete SKU ${sku} permanently?\n\nThis removes it from inventory. Sales history stays. If the unit still has an open sale, void that first.`)) {
      return;
    }
    setBusy(true);
    setError('');
    setMsg('');
    try {
      const { error: e } = await client.rpc('delete_unit', { p_sku: sku, p_approval_id: null });
      if (e) throw e;
      onDeleted?.();
      onClose();
    } catch (err) {
      const text = errText(err);
      if (/void_the_sale_first/i.test(text)) {
        setError('This item has an open sale. Void the sale first, then delete.');
      } else if (/manager_approval_required/i.test(text)) {
        setError('Only store admins can delete inventory.');
      } else {
        setError(text);
      }
    } finally {
      setBusy(false);
    }
  }

  async function addPhotos(files: FileList | null) {
    if (!files?.length) return;
    // Snapshot before any await — FileList is live on the input.
    const picked = Array.from(files);
    setBusy(true); setError(''); setMsg('');
    let failed = 0;
    for (const file of picked) {
      const typeOk = !file.type || file.type.startsWith('image/');
      if (!typeOk || file.size > 15 * 1024 * 1024 || file.size < 1) { failed++; continue; }
      let body: Blob = file;
      try {
        // Detach from the <input> so clearing value cannot empty the blob (Android PWA).
        body = new Blob([await file.arrayBuffer()], { type: file.type || 'image/jpeg' });
      } catch { failed++; continue; }
      const safe = (file.name || 'photo.jpg').replace(/[^a-zA-Z0-9._-]/g, '_') || 'photo.jpg';
      const path = `${storeId}/${sku}/${Date.now()}-${crypto.randomUUID()}-${safe}`;
      try {
        const upload = await client.storage.from('unit-photos').upload(path, body, {
          contentType: file.type || 'image/jpeg',
          upsert: false,
        });
        if (upload.error) throw upload.error;
        const linked = await client.rpc('portal_add_unit_photo', { p_sku: sku, p_path: path });
        if (linked.error) throw linked.error;
      } catch { failed++; }
    }
    setBusy(false);
    if (fileInput.current) fileInput.current.value = '';
    if (cameraInput.current) cameraInput.current.value = '';
    if (failed) setError(`${failed} photo(s) failed to upload.`);
    else setMsg('Photo(s) added.');
    onPhotosChanged();
  }

  const conditions = choices(options?.conditions);
  const tests = choices(options?.test_statuses);
  const specs = typeof unit.listing_specs === 'object' && unit.listing_specs !== null
    ? unit.listing_specs as Record<string, unknown> : {};
  const reviewReason = reviewReasonLabel(specs.ebay_review_reason);
  const notForSale = String(specs.do_not_list || '').toLowerCase() === 'true' || String(specs.hold_reason || '') === 'do_not_list';
  const unsold = ['available', 'reserved', 'repair'].includes(String(unit.state || ''));
  const orderedPhotos = [...photos].sort((a, b) => Number(b.is_primary) - Number(a.is_primary) || (a.sort_order ?? a.id) - (b.sort_order ?? b.id));
  const statusLabel = notForSale ? 'Not for sale' : /^\s*(defective|scratch)/i.test(String(unit.condition||'')) ? 'Defective' : String(unit.state || '').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());

  return (
    <div
      className={`inventory-backdrop${appMode ? ' app-unit-edit' : ''}`}
      onMouseDown={e => { if (!appMode && e.target === e.currentTarget) cancel(); }}
    >
      <section className="inventory-detail" role="dialog" aria-modal="true" aria-label={`Edit unit ${sku}`}>
        {appMode ? (
          <div className="app-nav app-unit-edit-nav">
            <button type="button" onClick={cancel}>Cancel</button>
            <div className="app-nav-title">SKU {sku}</div>
            <button type="button" disabled={busy || lookupBusy} onClick={() => void save()}>
              {busy ? '…' : 'Save'}
            </button>
          </div>
        ) : (
          <div className="app-nav app-unit-edit-nav"><button type="button" onClick={cancel}>Cancel</button><div className="app-nav-title">SKU {sku}</div><button type="button" disabled={busy || lookupBusy} onClick={() => void save()}>{busy ? '…' : 'Save'}</button></div>
        )}
        {error && <div className="alert" role="alert">{error}</div>}
        <ReceiveWorkStatus client={client} accessToken={accessToken} sku={sku} />
        {msg && <p className="hint">{msg}</p>}
        {canDelete && unit.state === 'sold' && <RestoreInventoryButton client={client} sku={sku} onDone={() => { onSaved({ ...unit, state: 'available' }); onClose(); }} />}
        {currentMissing.length > 0 && <div className="inventory-missing" role="status"><p>{inventoryMissingText(currentMissing)}. Fill in the named fields and save.</p><div className="unit-edit-gap-links">{currentMissing.map(gap=><button type="button" className="text-button" key={gap} onClick={()=>jumpToGap(gap)}>Go to {gapLabel[gap] || reviewReasonLabel(gap) || gap}</button>)}</div></div>}
        {currentMissing.length === 0 && reviewReason && <p className="hint">eBay listing needs review: {reviewReason}.</p>}
        {reviewReason && canDelete ? <button type="button" className="secondary" disabled={busy} onClick={() => void clearEbayReview()}>I verified this issue · Clear eBay review</button> : null}

        <div className="unit-edit-status"><strong>{statusLabel}</strong><span>{locationLabel || String(unit.location || unit.bin || 'Unassigned')}</span></div>
        {canDelete && unsold && <DispositionButtons client={client} sku={sku} money={n => `$${(n / 100).toFixed(2)}`} stamp={s => new Date(s).toLocaleDateString()} className="secondary" onDone={() => { onReadinessChanged?.(); onDeleted?.(); onClose(); }} />}
        <h3 id="unit-edit-photos" className={currentMissing.includes('photo') ? 'unit-edit-required' : ''}>Photos{currentMissing.includes('photo') ? ' · Required' : ''}</h3>
        <div className="unit-edit-photo-strip">
          {orderedPhotos.map((p, i) => <button type="button" className="unit-edit-photo-open" key={p.id} onClick={() => setViewPhoto(p)} aria-label={`View photo ${i + 1}`}>
            {urls[p.path] ? <img src={urls[p.path]} alt={`Unit ${sku}, photo ${i + 1}`} loading="lazy" /> : <span>Photo unavailable</span>}{(p.is_primary || p.source === 'stock') && <small>{p.source === 'stock' ? 'STOCK' : 'Primary'}</small>}
          </button>)}
          <button type="button" className="unit-edit-photo-add" onClick={() => cameraInput.current?.click()} disabled={busy}>＋<small>Camera</small></button>
          <button type="button" className="unit-edit-photo-add" onClick={() => fileInput.current?.click()} disabled={busy}>▧<small>Library</small></button>
        </div>
        <input ref={cameraInput} type="file" accept="image/*" capture="environment" multiple hidden disabled={busy} onChange={e => void addPhotos(e.target.files)} />
        <input ref={fileInput} type="file" accept="image/*" multiple hidden disabled={busy} onChange={e => void addPhotos(e.target.files)} />

        <h3>Product</h3>
        <div className="unit-edit-grid">
          <label>SKU<input value={sku} readOnly /></label>
          <label>UPC
            <input
              ref={upcInput}
              value={form.upc}
              onChange={e => set('upc', e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void attachUpc(form.upc);
                }
              }}
              inputMode={scannerInputMode()}
              autoComplete="off"
              placeholder="Scan to attach & fill blanks"
              disabled={lookupBusy}
            />
          </label>
          <div className="unit-edit-wide actions" style={{ marginTop: 0 }}>
            <button type="button" className="secondary" disabled={lookupBusy || !form.upc.trim()} onClick={() => void attachUpc(form.upc)}>
              {lookupBusy ? 'Looking up…' : 'Look up UPC & fill blanks'}
            </button>
          </div>
          <label data-gap-target="brand" id="unit-edit-brand" className={currentMissing.includes('brand') ? 'unit-edit-required' : ''}>Brand<input value={form.brand} onChange={e => set('brand', e.target.value)} />{currentMissing.includes('brand') && <small>Required</small>}{form.brand.trim() && form.brand.trim().toLowerCase() === form.title.trim().toLowerCase() && <small className="unit-edit-brand-hint">Looks like a product name, not a brand · <button type="button" onClick={() => set('brand', 'Unbranded')}>No brand</button></small>}</label>
          <label data-gap-target="model" id="unit-edit-model" className={currentMissing.includes('model') ? 'unit-edit-required' : ''}>Model<input value={form.model} onChange={e => set('model', e.target.value)} />{currentMissing.includes('model') && <small>Required</small>}</label>
          <label data-gap-target="title" id="unit-edit-title" className={`unit-edit-wide${currentMissing.includes('title') ? ' unit-edit-required' : ''}`}>Title<input value={form.title} onChange={e => set('title', e.target.value)} />{currentMissing.includes('title') && <small>Required</small>}</label>
          <label data-gap-target="description" id="unit-edit-description" className={`unit-edit-wide${currentMissing.includes('description') ? ' unit-edit-required' : ''}`}>Description<textarea rows={3} value={form.description} onChange={e => set('description', e.target.value)} />{currentMissing.includes('description') && <small>Required</small>}</label>
        </div>
        <h3>Pricing</h3>
        <div className="unit-edit-grid">
          <label data-gap-target="price" id="unit-edit-price" className={currentMissing.includes('price') ? 'unit-edit-required' : ''}>Price<input inputMode="decimal" placeholder="24.99" value={form.price} onChange={e => set('price', e.target.value)} />{currentMissing.includes('price') && <small>Required</small>}</label>
          {canDelete && <label>Cost<input inputMode="decimal" placeholder="Add actual cost" value={form.cost} onChange={e => set('cost', e.target.value)} /></label>}
        </div>
        <h3>Condition</h3>
        <div className="unit-edit-grid">
          <label data-gap-target="condition" id="unit-edit-condition" className={currentMissing.includes('condition') ? 'unit-edit-required' : ''}>Condition
            <select value={form.condition} onChange={e => set('condition', e.target.value)}>
              <option value="">—</option>
              {conditions.map(c => <option key={c} value={c}>{c}</option>)}
              {form.condition && !conditions.includes(form.condition) && <option value={form.condition}>{form.condition}</option>}
            </select>
            {currentMissing.includes('condition') && <small>Required</small>}
          </label>
          <label>Test status
            <select value={form.testStatus} onChange={e => set('testStatus', e.target.value)}>
              <option value="">—</option>
              {tests.map(c => <option key={c} value={c}>{c}</option>)}
              {form.testStatus && !tests.includes(form.testStatus) && <option value={form.testStatus}>{form.testStatus}</option>}
            </select>
          </label>
        </div>
        <h3 id="unit-package-size">Package size for shipping</h3>
        <div className="unit-edit-grid">
          <label>Shippable
            <select value={form.shippable} onChange={e => set('shippable', e.target.value)}>
              <option value="auto">Automatic (rules)</option>
              <option value="ship">Yes — can ship</option>
              <option value="pickup">No — pickup only</option>
            </select>
          </label>
          <div className="unit-edit-wide unit-edit-grid unit-edit-dimensions"><label>Package length (in)<input inputMode="decimal" value={form.length} onChange={e => set('length', e.target.value)} /></label>
          <label>Package width (in)<input inputMode="decimal" value={form.width} onChange={e => set('width', e.target.value)} /></label>
          <label>Package height (in)<input inputMode="decimal" value={form.height} onChange={e => set('height', e.target.value)} /></label>
          <label>Package weight (lb)<input inputMode="decimal" value={form.weight} onChange={e => set('weight', e.target.value)} /></label></div>
        </div>
        <label className="unit-edit-wide unit-edit-notes">Notes<textarea rows={3} value={form.notes} onChange={e => set('notes', e.target.value)} /></label>
        {!notForSale && <details ref={onlineDetails} className="unit-edit-online"><summary>Selling online</summary><EbaySpecificsPanel client={client} sku={sku} storeId={storeId} appMode={appMode} hideSaveButton onDescription={(t) => { latestDescription.current = t; set('description', t); }} onJumpToCondition={() => jumpToGap('condition')} persistRef={specificsPersist} onSaved={onReadinessChanged} />{canDelete&&<><DnsCheckbox client={client} sku={sku} onChanged={() => onReadinessChanged?.()} /><ChannelCheckboxes key={JSON.stringify(specs.do_not_ship)} client={client} sku={sku} appMode={appMode} /></>}</details>}
        {canDelete && <UnitDispositionHistory client={client} sku={sku} stamp={s => new Date(s).toLocaleString()} />}
        {canDelete && <button type="button" className="text-button danger unit-edit-delete" disabled={busy || lookupBusy} onClick={() => void removeUnit()}>Delete item</button>}
        {viewPhoto && <div className="unit-photo-lightbox" role="dialog" aria-modal="true" aria-label="Photo controls"><button type="button" className="unit-photo-lightbox-close" onClick={() => setViewPhoto(null)}>Close</button>{urls[viewPhoto.path] && <img src={urls[viewPhoto.path]} alt={`Unit ${sku}`} />}<div><button type="button" disabled={busy} onClick={async () => { const { error: e } = await client.rpc('set_primary_photo', { p_id: viewPhoto.id }); if (e) setError(e.message); else { setViewPhoto(null); onPhotosChanged(); } }}>Make primary</button><button type="button" disabled={busy} onClick={async () => { const { error: e } = await client.rpc('delete_unit_photo', { p_id: viewPhoto.id }); if (e) setError(e.message); else { await client.storage.from('unit-photos').remove([viewPhoto.path]); setViewPhoto(null); onPhotosChanged(); } }}>Delete photo</button><button type="button" className="secondary" disabled={busy} onClick={async () => { const ordered = [...orderedPhotos]; const i = ordered.findIndex(p => p.id === viewPhoto.id); if (i > 0) { [ordered[i - 1], ordered[i]] = [ordered[i], ordered[i - 1]]; const { error: e } = await client.rpc('reorder_unit_photos', { p_sku: sku, p_ids: ordered.map(p => p.id) }); if (e) setError(e.message); else onPhotosChanged(); } }}>Move earlier</button></div></div>}
      </section>
    </div>
  );
}
