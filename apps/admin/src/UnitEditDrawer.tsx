import { useEffect, useRef, useState } from 'react';
import { ChannelCheckboxes } from './ChannelCheckboxes';
import { UnitDispositionHistory } from './DispositionDialogs';
import { EbaySpecificsPanel } from './EbaySpecificsPanel';
import type { SupabaseClient } from '@supabase/supabase-js';
import { floorFunctionUrl } from './floorApi';
import { scannerInputMode } from './kiosk';
import { reportClientError } from './clientLog';
import { errText } from './errText';
import { reviewReasonLabel } from './inventoryReview';

type Photo = { id: number; path: string; is_primary: boolean };
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
  canDelete = false, onDeleted, appMode = false,
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
}) {
  const [form, setForm] = useState<Form>(() => fromUnit(unit));
  const [options, setOptions] = useState<Options | null>(null);
  const [busy, setBusy] = useState(false);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const upcInput = useRef<HTMLInputElement>(null);
  const set = (key: keyof Form, value: string) => setForm(prev => ({ ...prev, [key]: value }));

  useEffect(() => { setForm(fromUnit(unit)); setMsg(''); setError(''); }, [unit, sku]);
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
      p_description: form.description,
      p_ask_cents: ask,
      p_cost_cents: cost,
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
    if (failed) setError(`${failed} photo(s) failed to upload.`);
    else setMsg('Photo(s) added.');
    onPhotosChanged();
  }

  const conditions = choices(options?.conditions);
  const tests = choices(options?.test_statuses);
  const specs = typeof unit.listing_specs === 'object' && unit.listing_specs !== null
    ? unit.listing_specs as Record<string, unknown> : {};
  const reviewReason = reviewReasonLabel(specs.ebay_review_reason);
  const missing: string[] = [];
  if (blank(form.title)) missing.push('title');
  if (blank(form.model)) missing.push('model');
  if (!cents(form.price)) missing.push('price');
  if (blank(form.description)) missing.push('description');
  if ([form.length, form.width, form.height, form.weight].some(blank)) missing.push('package L/W/H/weight');
  if (!photos.length) missing.push('photo');

  return (
    <div
      className={`inventory-backdrop${appMode ? ' app-unit-edit' : ''}`}
      onMouseDown={e => { if (!appMode && e.target === e.currentTarget) onClose(); }}
    >
      <section className="inventory-detail" role="dialog" aria-modal="true" aria-label={`Edit unit ${sku}`}>
        {appMode ? (
          <div className="app-nav app-unit-edit-nav">
            <button type="button" onClick={onClose}>Cancel</button>
            <div className="app-nav-title">Edit · {sku}</div>
            <button type="button" disabled={busy || lookupBusy} onClick={() => void save()}>
              {busy ? '…' : 'Save'}
            </button>
          </div>
        ) : (
          <div className="section-head">
            <div><div className="eyebrow">EDIT UNIT</div><h2>SKU {sku}</h2></div>
            <button type="button" className="secondary" onClick={onClose}>Close</button>
          </div>
        )}
        {error && <div className="alert" role="alert">{error}</div>}
        {msg && <p className="hint">{msg}</p>}
        <p className="hint">{reviewReason ? `eBay listing needs review: ${reviewReason}.` : missing.length === 0 ? 'Looks complete for listing.' : `Still missing: ${missing.join(', ')}. Scan a UPC to fill blanks.`}</p>
        {reviewReason && canDelete ? <button type="button" className="secondary" disabled={busy} onClick={() => void clearEbayReview()}>I verified this issue · Clear eBay review</button> : null}

        <h3>Photos</h3>
        {photos.length ? (
          <div className="inventory-gallery">
            {photos.map(p => urls[p.path]
              ? <img src={urls[p.path]} alt={`Unit ${sku}`} key={p.id} loading="lazy" />
              : <div className="inventory-photo" key={p.id}>Photo unavailable</div>)}
          </div>
        ) : <p className="hint">No photos yet.</p>}
        <label className="unit-edit-photo">Add photos
          <input ref={fileInput} type="file" accept="image/*" multiple disabled={busy}
            onChange={e => void addPhotos(e.target.files)} />
        </label>

        <h3>Details</h3>
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
          <label>Brand<input value={form.brand} onChange={e => set('brand', e.target.value)} /></label>
          <label>Model<input value={form.model} onChange={e => set('model', e.target.value)} /></label>
          <label className="unit-edit-wide">Title<input value={form.title} onChange={e => set('title', e.target.value)} /></label>
          <label className="unit-edit-wide">Description<textarea rows={3} value={form.description} onChange={e => set('description', e.target.value)} /></label>
          <label>Price<input inputMode="decimal" placeholder="24.99" value={form.price} onChange={e => set('price', e.target.value)} /></label>
          <label>Cost<input inputMode="decimal" placeholder="9.00" value={form.cost} onChange={e => set('cost', e.target.value)} /></label>
          <label>Condition
            <select value={form.condition} onChange={e => set('condition', e.target.value)}>
              <option value="">—</option>
              {conditions.map(c => <option key={c} value={c}>{c}</option>)}
              {form.condition && !conditions.includes(form.condition) && <option value={form.condition}>{form.condition}</option>}
            </select>
          </label>
          <label>Test status
            <select value={form.testStatus} onChange={e => set('testStatus', e.target.value)}>
              <option value="">—</option>
              {tests.map(c => <option key={c} value={c}>{c}</option>)}
              {form.testStatus && !tests.includes(form.testStatus) && <option value={form.testStatus}>{form.testStatus}</option>}
            </select>
          </label>
          <label>Shippable
            <select value={form.shippable} onChange={e => set('shippable', e.target.value)}>
              <option value="auto">Automatic (rules)</option>
              <option value="ship">Yes — can ship</option>
              <option value="pickup">No — pickup only</option>
            </select>
          </label>
          <label>Length (in)<input inputMode="decimal" value={form.length} onChange={e => set('length', e.target.value)} /></label>
          <label>Width (in)<input inputMode="decimal" value={form.width} onChange={e => set('width', e.target.value)} /></label>
          <label>Height (in)<input inputMode="decimal" value={form.height} onChange={e => set('height', e.target.value)} /></label>
          <label>Weight (lb)<input inputMode="decimal" value={form.weight} onChange={e => set('weight', e.target.value)} /></label>
          <label className="unit-edit-wide">Notes<textarea rows={3} value={form.notes} onChange={e => set('notes', e.target.value)} /></label>
        </div>
        <EbaySpecificsPanel client={client} sku={sku} storeId={storeId} appMode={appMode} />
        <ChannelCheckboxes client={client} sku={sku} appMode={appMode} />
        {canDelete && <UnitDispositionHistory client={client} sku={sku} stamp={s => new Date(s).toLocaleString()} />}
        <div className={`actions unit-edit-actions${appMode ? ' app-unit-edit-actions' : ''}`} style={{ marginTop: 16 }}>
          <button type="button" disabled={busy || lookupBusy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save changes'}</button>
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>Cancel</button>
          {canDelete ? (
            <button
              type="button"
              className="danger"
              disabled={busy || lookupBusy}
              onClick={() => void removeUnit()}
            >
              {busy ? 'Working…' : 'Delete'}
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}
