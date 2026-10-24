import { useEffect, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { floorFunctionUrl } from './floorApi';
import { scannerInputMode } from './kiosk';
import { reportClientError } from './clientLog';
import { errText } from './errText';

type Photo = { id: number; path: string; is_primary: boolean };
type Unit = Record<string, unknown>;
type Options = { conditions: unknown; test_statuses: unknown };

const UPC_NOT_APPLICABLE = 'Does not apply';

type Form = {
  upc: string; brand: string; model: string; title: string; description: string;
  price: string; cost: string; condition: string; testStatus: string;
  shippable: string; notes: string; length: string; width: string; height: string; weight: string;
};

type ListingFlags = {
  unbranded: boolean;
  noUpc: boolean;
  readyToList: boolean;
  readyAmazonTiktok: boolean;
  doNotList: boolean;
  bundle: boolean;
  bundleParentSku: string;
};

function specsOf(unit: Unit): Record<string, unknown> {
  const s = unit.listing_specs;
  return s && typeof s === 'object' ? { ...(s as Record<string, unknown>) } : {};
}

function flagsFromUnit(unit: Unit): ListingFlags {
  const specs = specsOf(unit);
  const parent = String(specs.bundle_parent_sku || '').trim();
  const upc = String(unit.upc || '').trim();
  const brand = String(unit.brand || '').trim();
  return {
    unbranded: brand.toLowerCase() === 'unbranded',
    noUpc: !upc || upc === UPC_NOT_APPLICABLE || String(specs.upc || '') === UPC_NOT_APPLICABLE,
    readyToList: specs.ready_to_list === true,
    readyAmazonTiktok: specs.ready_amazon_tiktok === true,
    doNotList: specs.do_not_list === true || specs.hold_reason === 'do_not_list',
    bundle: Boolean(parent),
    bundleParentSku: parent,
  };
}

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
  const flags = flagsFromUnit(unit);
  const upcRaw = String(unit.upc || '');
  return {
    upc: flags.noUpc || upcRaw === UPC_NOT_APPLICABLE ? '' : upcRaw,
    brand: flags.unbranded ? '' : String(unit.brand || ''),
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

function composeListingTitle(brand: string, model: string, unbranded: boolean): string {
  const b = unbranded ? 'Unbranded' : brand.trim();
  const m = model.trim();
  return [b, m].filter(Boolean).join(' ');
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
  const [flags, setFlags] = useState<ListingFlags>(() => flagsFromUnit(unit));
  const [options, setOptions] = useState<Options | null>(null);
  const [busy, setBusy] = useState(false);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const upcInput = useRef<HTMLInputElement>(null);
  const set = (key: keyof Form, value: string) => setForm(prev => ({ ...prev, [key]: value }));
  const setFlag = <K extends keyof ListingFlags>(key: K, value: ListingFlags[K]) => {
    setFlags(prev => ({ ...prev, [key]: value }));
  };

  useEffect(() => {
    setForm(fromUnit(unit));
    setFlags(flagsFromUnit(unit));
    setMsg('');
    setError('');
  }, [unit, sku]);
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

  async function removeChildFromParent(parentSku: string, childSku: string): Promise<void> {
    const cur = await client.from('units').select('listing_specs')
      .eq('store_id', storeId).eq('sku', parentSku).maybeSingle();
    if (cur.error || !cur.data) return;
    const prev = (cur.data.listing_specs as Record<string, unknown> | null) || {};
    const existing = Array.isArray(prev.bundle_child_skus) ? prev.bundle_child_skus.map(String) : [];
    const next = existing.filter((s) => s !== childSku);
    if (next.length === existing.length) return;
    await client.rpc('portal_enrich_received_unit', {
      p_sku: parentSku,
      p_specs: { bundle_child_skus: next },
      p_msrp_cents: null,
      p_show: null,
      p_brand: null,
      p_model: null,
      p_title: null,
      p_description: null,
    });
  }

  async function addChildToParent(parentSku: string, childSku: string): Promise<string | null> {
    const cur = await client.from('units').select('listing_specs')
      .eq('store_id', storeId).eq('sku', parentSku).maybeSingle();
    if (cur.error || !cur.data) return `No unit with SKU ${parentSku}.`;
    const prev = (cur.data.listing_specs as Record<string, unknown> | null) || {};
    const existing = Array.isArray(prev.bundle_child_skus) ? prev.bundle_child_skus.map(String) : [];
    const merged = [...new Set([...existing, childSku])];
    const rpc = await client.rpc('portal_enrich_received_unit', {
      p_sku: parentSku,
      p_specs: { bundle_child_skus: merged },
      p_msrp_cents: null,
      p_show: null,
      p_brand: null,
      p_model: null,
      p_title: null,
      p_description: null,
    });
    if (rpc.error) return errText(rpc.error);
    return null;
  }

  async function save() {
    const ask = cents(form.price);
    const cost = cents(form.cost);
    if (!flags.doNotList && ask === undefined) { setError('Price must look like 24.99 (blank = no price).'); return; }
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

    const bundleParent = flags.bundle ? flags.bundleParentSku.trim() : '';
    if (flags.bundle) {
      if (!bundleParent) {
        setError('Bundle is checked — enter the Floor SKU this item belongs with.');
        return;
      }
      if (bundleParent === sku) {
        setError('Bundle parent SKU cannot be this unit.');
        return;
      }
      const parent = await client.from('units').select('sku').eq('store_id', storeId).eq('sku', bundleParent).maybeSingle();
      if (parent.error) { setError(errText(parent.error)); return; }
      if (!parent.data) {
        setError(`No unit with SKU ${bundleParent}.`);
        return;
      }
    }

    if (flags.readyToList && !flags.doNotList) {
      const gaps: string[] = [];
      if (blank(form.title) && blank(form.brand) && blank(form.model) && !flags.unbranded) gaps.push('title');
      if (blank(form.model)) gaps.push('item specifics');
      if (!(ask && ask > 0)) gaps.push('price');
      if (blank(form.description)) gaps.push('description');
      if (dims.some((d) => d == null)) gaps.push('package L/W/H/weight');
      if (!photos.length) gaps.push('photo');
      if (gaps.length) {
        setError(`Ready to list needs: ${gaps.join(', ')}. Uncheck Ready to list to save anyway.`);
        return;
      }
    }

    const brandValue = flags.unbranded ? 'Unbranded' : form.brand.trim();
    // units.title is NOT NULL — never send blank/null. Prefer typed title, else brand + model, else SKU.
    const title = form.title.trim()
      || composeListingTitle(form.brand, form.model, flags.unbranded)
      || `SKU ${sku}`;
    if (title !== form.title.trim()) {
      setForm((prev) => ({ ...prev, title }));
    }

    const prevSpecs = specsOf(unit);
    const prevParent = String(prevSpecs.bundle_parent_sku || '').trim();
    const nextParent = bundleParent || '';
    const wasDoNotList = prevSpecs.do_not_list === true || prevSpecs.hold_reason === 'do_not_list';

    setBusy(true); setError(''); setMsg('');
    try {
      // brand/model/title are NOT NULL — always send strings ('' ok), never null/undefined.
      const { data, error: e } = await client.rpc('portal_update_unit', {
        p_sku: sku,
        p_upc: flags.noUpc ? '' : form.upc.trim(),
        p_brand: brandValue,
        p_model: form.model.trim(),
        p_title: title,
        p_description: form.description,
        p_ask_cents: flags.doNotList ? null : ask,
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
      if (e) throw e;
      const saved = data as Record<string, unknown>;

      const specs: Record<string, unknown> = {
        ready_to_list: flags.readyToList && !flags.doNotList,
        ready_amazon_tiktok: flags.readyAmazonTiktok && !flags.doNotList,
        do_not_list: flags.doNotList,
        hold_reason: flags.doNotList ? 'do_not_list' : (wasDoNotList ? '' : (prevSpecs.hold_reason ?? '')),
        hold_note: flags.doNotList ? "Marked don't list for sale" : (wasDoNotList ? '' : (prevSpecs.hold_note ?? '')),
        bundle_parent_sku: nextParent,
        bundle_role: nextParent ? 'child' : '',
      };
      if (flags.noUpc) {
        const existingAspects = prevSpecs.ebay_aspects;
        const aspects = existingAspects && typeof existingAspects === 'object'
          ? { ...(existingAspects as Record<string, unknown>) }
          : {};
        specs.ebay_aspects = { ...aspects, UPC: UPC_NOT_APPLICABLE };
        specs.upc = UPC_NOT_APPLICABLE;
      }

      // Only flip website visibility when Don't-list is toggled — don't un-hide other holds.
      const showPatch = flags.doNotList ? false : (wasDoNotList ? true : null);

      const enrich = await client.rpc('portal_enrich_received_unit', {
        p_sku: sku,
        p_specs: specs,
        p_msrp_cents: null,
        p_show: showPatch,
        p_brand: null,
        p_model: null,
        p_title: null,
        p_description: null,
      });
      if (enrich.error) throw enrich.error;

      if (prevParent && prevParent !== nextParent) {
        await removeChildFromParent(prevParent, sku);
      }
      if (nextParent) {
        const linkErr = await addChildToParent(nextParent, sku);
        if (linkErr) throw new Error(linkErr);
      }

      const nextSpecs = {
        ...prevSpecs,
        ...specs,
      };
      onSaved({
        ...unit,
        upc: flags.noUpc ? null : saved.upc,
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
        show_on_website: showPatch == null ? unit.show_on_website : showPatch,
        listing_specs: nextSpecs,
      });
      setMsg('Saved.');
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
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
              value={flags.noUpc ? UPC_NOT_APPLICABLE : form.upc}
              onChange={e => {
                set('upc', e.target.value);
                if (flags.noUpc) setFlag('noUpc', false);
              }}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void attachUpc(form.upc);
                }
              }}
              inputMode={scannerInputMode()}
              autoComplete="off"
              placeholder="Scan to attach & fill blanks"
              disabled={lookupBusy || flags.noUpc}
            />
          </label>
          <label className="mboard-inline unit-edit-wide">
            <input
              type="checkbox"
              checked={flags.noUpc}
              onChange={e => {
                const on = e.target.checked;
                setFlag('noUpc', on);
                if (on) set('upc', '');
              }}
            />
            No UPC / doesn&apos;t have a barcode — marketplaces get “Does not apply”
          </label>
          <div className="unit-edit-wide actions" style={{ marginTop: 0 }}>
            <button type="button" className="secondary" disabled={lookupBusy || flags.noUpc || !form.upc.trim()} onClick={() => void attachUpc(form.upc)}>
              {lookupBusy ? 'Looking up…' : 'Look up UPC & fill blanks'}
            </button>
          </div>
          <label>Brand
            <input
              value={flags.unbranded ? 'Unbranded' : form.brand}
              disabled={flags.unbranded}
              onChange={e => set('brand', e.target.value)}
            />
          </label>
          <label className="mboard-inline unit-edit-wide">
            <input
              type="checkbox"
              checked={flags.unbranded}
              onChange={e => {
                const unbranded = e.target.checked;
                setFlag('unbranded', unbranded);
                setForm(prev => ({
                  ...prev,
                  title: composeListingTitle(prev.brand, prev.model, unbranded) || prev.title,
                }));
              }}
            />
            Unbranded
          </label>
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

          <label className="mboard-inline unit-edit-wide">
            <input
              type="checkbox"
              checked={flags.readyToList}
              onChange={e => {
                const on = e.target.checked;
                setFlag('readyToList', on);
                if (on) setFlag('doNotList', false);
              }}
            />
            Ready to list
          </label>
          <label className="mboard-inline unit-edit-wide">
            <input
              type="checkbox"
              checked={flags.readyAmazonTiktok}
              onChange={e => {
                const on = e.target.checked;
                setFlag('readyAmazonTiktok', on);
                if (on) setFlag('doNotList', false);
              }}
            />
            Ready to list Amazon/TikTok
          </label>
          <label className="mboard-inline unit-edit-wide">
            <input
              type="checkbox"
              checked={flags.doNotList}
              onChange={e => {
                const on = e.target.checked;
                setFlag('doNotList', on);
                if (on) {
                  setFlag('readyToList', false);
                  setFlag('readyAmazonTiktok', false);
                }
              }}
            />
            Don&apos;t list for sale
          </label>
          <label className="mboard-inline unit-edit-wide">
            <input
              type="checkbox"
              checked={flags.bundle}
              onChange={e => {
                const on = e.target.checked;
                setFlag('bundle', on);
                if (!on) setFlag('bundleParentSku', '');
              }}
            />
            Bundle
          </label>
          {flags.bundle ? (
            <label className="unit-edit-wide receive-bundle-sku">
              Bundle with SKU
              <input
                value={flags.bundleParentSku}
                onChange={e => setFlag('bundleParentSku', e.target.value.replace(/[^\dA-Za-z\-]/g, ''))}
                inputMode="numeric"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="Existing Floor SKU"
                aria-label="Bundle parent SKU"
              />
              <span className="hint">This unit lists online with that SKU (not by itself).</span>
            </label>
          ) : null}
        </div>
        <p className="hint receive-check">
          {flags.doNotList
            ? "Won't list online — save clears ask price and hides from the website."
            : missing.length === 0
              ? (flags.readyToList ? 'Looks complete — will save as ready to list.' : 'Looks complete for listing.')
              : flags.readyToList
                ? `Ready to list still needs: ${missing.join(', ')}.`
                : `Still missing: ${missing.join(', ')}. Scan a UPC to fill blanks.`}
        </p>
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
