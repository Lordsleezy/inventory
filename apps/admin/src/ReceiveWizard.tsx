import { useEffect, useMemo, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ReceiveBarcodeScanner } from './ReceiveBarcodeScanner';
import { ManifestReceiveReference, useManifestReceiveReference } from './ManifestReceiveReference';
import { ReceiveCategoryAspects, type ReceiveAspectState } from './ReceiveCategoryAspects';
import { locationMenuLabel, type LocationChoice } from './locationPlace';
import { manifestDefectWarnings } from './manifestReference';
import { adjacentReceiveStep, receiveStepPlan, type ReceiveStepId } from './receiveSteps';

const CONDITIONS: [string, string][] = [
  ['New', 'New'],
  ['Open box', 'Open box'],
  ['Used - Good', 'Used · Good'],
  ['Used - Fair', 'Used · Fair'],
  ['Defective', 'Defective'],
];

type FormSlice = {
  brand: string; title: string; ask: string; cost: string; quantity: string;
  length: string; width: string; height: string; weight: string; condition: string; unbranded: boolean;
};

type Stock = { sku: string; title: string; quantity: number; condition: string | null; is_stocked: boolean };

export function ReceiveWizard({
  client, storeId, accessToken, staffMode,
  lookupId, lookupStatus, miss, title, brand, details, source, stockUrl, onWrongPhoto, retailCents, manifestReference,
  form, update, doNotList, setDoNotList,
  hasPhoto, photoPreviews = [], onPhoto, onIdentify,
  locations, location, setLocation,
  stockMatches, onAddToStock, addingToStock,
  ebayAspects, setEbayAspects, needsSpecifics,
  busy, error, onSave, onCancel, onClear, onScan, onReject, onAccept,
  nextSku = '', upc = '', category = '', savedNotice = '',
  entry = 'scan', holdForLookup = false,
}: {
  client: SupabaseClient;
  storeId: string;
  accessToken: string;
  staffMode: boolean;
  lookupId: string | null;
  lookupStatus: string | null;
  miss: boolean;
  title: string;
  brand: string;
  details: string;
  source: string;
  stockUrl: string;
  onWrongPhoto?: () => void;
  retailCents: number | null;
  manifestReference: ReturnType<typeof useManifestReceiveReference>;
  form: FormSlice;
  update: (key: 'brand' | 'title' | 'ask' | 'cost' | 'quantity' | 'length' | 'width' | 'height' | 'weight' | 'condition', value: string) => void;
  doNotList: boolean;
  setDoNotList: (on: boolean) => void;
  hasPhoto: boolean;
  photoPreviews?: string[];
  onPhoto: (file: File) => void;
  onIdentify: (file: File) => void;
  locations: LocationChoice[];
  location: string;
  setLocation: (code: string) => void;
  stockMatches: Stock[];
  onAddToStock: (sku: string) => void;
  addingToStock: boolean;
  ebayAspects: ReceiveAspectState;
  setEbayAspects: (next: ReceiveAspectState) => void;
  needsSpecifics: boolean;
  busy: boolean;
  error: string;
  onSave: () => void;
  onCancel: () => void;
  onClear: () => void;
  onScan: (code: string) => void;
  onReject: () => void;
  onAccept: () => void | Promise<void>;
  entry?: 'scan' | 'identify';
  holdForLookup?: boolean;
  nextSku?: string;
  upc?: string;
  category?: string;
  savedNotice?: string;
}) {
  const [step, setStep] = useState<ReceiveStepId | 'scan' | 'lookup' | 'identify'>(
    entry === 'identify' ? 'identify' : (holdForLookup ? 'lookup' : 'scan'),
  );
  const [bay, setBay] = useState<number | null>(null);
  const [row, setRow] = useState<number | null>(null);
  const [noLocation, setNoLocation] = useState(false);
  const seen = useRef<string | null>(null);
  const returnToReview = useRef(false);

  const plan = useMemo(() => receiveStepPlan({
    doNotList,
    brand: form.unbranded ? 'Unbranded' : form.brand,
    title: form.title,
    hasCategory: Boolean(ebayAspects.categoryId),
    needsSpecifics,
    hasDims: [form.length, form.width, form.height, form.weight].every(value => Number(value) > 0),
    hasStockMatch: stockMatches.length > 0,
  }), [doNotList, form, ebayAspects.categoryId, needsSpecifics, stockMatches.length]);

  useEffect(() => {
    if (!lookupId) {
      seen.current = null;
      if (entry === 'identify') setStep('identify');
      else if (!holdForLookup) setStep('scan');
      return;
    }
    if (lookupStatus === 'loading') { setStep('lookup'); return; }
    if (seen.current === lookupId) return;
    seen.current = lookupId;
    setStep(miss && !title ? 'identify' : 'confirm');
  }, [lookupId, lookupStatus, miss, title, entry, holdForLookup]);

  function edit(next: ReceiveStepId) {
    returnToReview.current = true;
    setStep(next);
  }

  function go(delta: number) {
    if (returnToReview.current && step !== 'review') {
      returnToReview.current = false;
      setStep('review');
      return;
    }
    if (step === 'confirm' && delta < 0) { onClear(); return; }
    if (delta > 0 && step === 'brand' && !form.brand.trim()) return;
    if (delta > 0 && step === 'title' && !form.title.trim()) return;
    if (delta > 0 && step === 'category' && !ebayAspects.categoryId) return;
    if (delta > 0 && step === 'dims' && ![form.length, form.width, form.height, form.weight].every(value => Number(value) > 0)) return;
    const next = adjacentReceiveStep(plan, step as ReceiveStepId, delta > 0 ? 1 : -1);
    if (next) setStep(next);
  }

  const bays = [...new Map(locations.map(item => [item.bay_no, item])).values()];
  const baySpots = locations.filter(item => item.bay_no === bay);
  const rows = [...new Set(baySpots.map(item => item.row_no))].filter((value): value is number => value != null);
  const bins = baySpots.filter(item => item.row_no === row);
  const simpleBay = baySpots.length === 1;
  function pickBay(item: LocationChoice) {
    setNoLocation(false);
    setBay(item.bay_no ?? null);
    setRow(null);
    const spots = locations.filter(spot => spot.bay_no === item.bay_no);
    if (spots.length === 1) setLocation(spots[0].code);
    else setLocation('');
  }

  const retail = retailCents != null ? `$${(retailCents / 100).toFixed(2)}` : '';
  const nav = (
    <div className="receive-step-nav">
      <button type="button" onClick={() => go(-1)}>Back</button>
      <button type="button" onClick={() => go(1)}>Next</button>
    </div>
  );

  const reference = <ManifestReceiveReference result={manifestReference} />;
  if (step === 'scan') return <ReceiveBarcodeScanner onClose={onCancel} onDetect={onScan} />;
  if (step === 'identify') {
    return <ReceiveBarcodeScanner mode="photo" banner={<>{reference}{error && <p className="receive-scanner-error" role="alert">{error}</p>}</>} onClose={onCancel} onDetect={() => undefined} onPhoto={file => {
      void Promise.resolve(onIdentify(file)).then(() => setStep('confirm')).catch(() => undefined);
    }} />;
  }

  return (
    <div className="receive-steps">
      <div className="receive-step-top">
        <button type="button" onClick={onCancel}>Cancel</button>
        <strong>Receive</strong>
        <span />
      </div>
      {error && <p className="receive-step-error" role="alert">{error}</p>}
      {step === 'lookup' && <p>Looking up the barcode…</p>}
      {step === 'confirm' && (
        <div className="receive-step">
          <div className="receive-step-main">
            {stockUrl ? (
              <figure className="receive-stock-wrap">
                <img className="receive-stock" src={stockUrl} alt="Stock photo" />
                <button type="button" onClick={onWrongPhoto}>Wrong photo</button>
              </figure>
            ) : <p>No stock photo</p>}
            <h2>{title || 'Unknown item'}</h2>
            <p>{[brand, details].filter(Boolean).join(' · ')}</p>
            <p className={manifestReference?.reference ? 'manifest-receive-reference' : undefined}>
              {[source, manifestReference?.reference?.retail_cents != null && `Manifest retail: ${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(manifestReference.reference.retail_cents / 100)}`].filter(Boolean).join(' · ')}
              {(manifestReference?.reference ? manifestDefectWarnings(manifestReference.reference) : []).map(warning => <span key={warning} role="alert">{warning}</span>)}
            </p>
            <p className="receive-step-q"><strong>Is this it?</strong></p>
          </div>
          <div className="receive-step-nav">
            <button type="button" onClick={() => { void Promise.resolve(onAccept()).then(() => setStep('photo')); }}>Yes, that's it</button>
            <button type="button" onClick={() => { onReject(); seen.current = lookupId; setStep('identify'); }}>No</button>
          </div>
        </div>
      )}
      {step === 'photo' && (
        <div className="receive-step">
          <div className="receive-step-main">
            <h2>Take a real photo <span className="receive-step-req">*</span></h2>
            {stockUrl && (
              <figure className="receive-stock-wrap">
                <img className="receive-stock" src={stockUrl} alt="Stock photo" />
                <button type="button" onClick={onWrongPhoto}>Wrong photo</button>
              </figure>
            )}
            {stockUrl && <p>Stock photo saved. You still need your own photo.</p>}
            {photoPreviews.map(url => <img key={url} className="receive-stock" src={url} alt="Your photo" />)}
            <label className="receive-photo-take">
              <input type="file" accept="image/*" capture="environment" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) onPhoto(file); }} />
              <span>{hasPhoto ? 'Take another' : 'Take photo'}</span>
            </label>
            <label className="receive-photo-library">
              <input type="file" accept="image/*" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) onPhoto(file); }} />
              <span>Choose from library</span>
            </label>
          </div>
          <div className="receive-step-nav">
            <button type="button" onClick={() => setStep('confirm')}>Back</button>
            <button type="button" disabled={!hasPhoto} onClick={() => go(1)}>Next</button>
          </div>
        </div>
      )}
      {step === 'brand' && (
        <div className="receive-step">
          <h2>Brand <span className="receive-step-req">*</span></h2>
          <input value={form.brand} onChange={event => update('brand', event.target.value)} />
          {nav}
        </div>
      )}
      {step === 'title' && (
        <div className="receive-step">
          <h2>Title <span className="receive-step-req">*</span></h2>
          <input value={form.title} onChange={event => update('title', event.target.value)} />
          {nav}
        </div>
      )}
      {step === 'category' && (
        <div className="receive-step">
          <h2>{ebayAspects.categoryId && needsSpecifics ? 'Item specifics' : 'Category'} <span className="receive-step-req">*</span></h2>
          <ReceiveCategoryAspects
            client={client} storeId={storeId} accessToken={accessToken} doNotList={doNotList}
            channels={staffMode ? [] : ['ebay']} disabled={busy} showErrors
            identity={{ brand: form.brand, model: '', title: form.title, condition: form.condition, upc: '' }}
            value={ebayAspects} onChange={setEbayAspects}
          />
          {nav}
        </div>
      )}
      {step === 'condition' && (
        <div className="receive-step">
          <h2>Condition <span className="receive-step-req">*</span></h2>
          <div role="radiogroup" aria-label="Condition">
            {CONDITIONS.map(([value, label]) => (
              <label key={value} className="receive-step-choice">
                <input type="radio" name="condition" checked={form.condition === value} onChange={() => update('condition', value)} />
                {label}
              </label>
            ))}
          </div>
          <label className="receive-step-choice"><input type="checkbox" checked={doNotList} onChange={event => setDoNotList(event.target.checked)} /> Do not list</label>
          <div className="receive-step-nav">
            <button type="button" onClick={() => go(-1)}>Back</button>
            <button type="button" disabled={!form.condition} onClick={() => go(1)}>Next</button>
          </div>
        </div>
      )}
      {step === 'price' && (
        <div className="receive-step">
          <h2>Your price <span className="receive-step-req">*</span></h2>
          {retail && <p>Manifest retail {retail}</p>}
          <input inputMode="decimal" value={form.ask} placeholder="0.00" onChange={event => update('ask', event.target.value)} />
          <label>Quantity<input inputMode="numeric" value={form.quantity} onChange={event => update('quantity', event.target.value)} /></label>
          {stockMatches[0] && <p>You already have {stockMatches[0].quantity} in stock.</p>}
          {!staffMode && <label>Cost, optional<input inputMode="decimal" value={form.cost} onChange={event => update('cost', event.target.value)} /></label>}
          <div className="receive-step-nav">
            <button type="button" onClick={() => go(-1)}>Back</button>
            <button type="button" disabled={!form.ask.trim()} onClick={() => go(1)}>Next</button>
          </div>
        </div>
      )}
      {step === 'dims' && (
        <div className="receive-step">
          <h2>Box size & weight <span className="receive-step-req">*</span></h2>
          <label>Length<input inputMode="decimal" value={form.length} onChange={event => update('length', event.target.value)} /></label>
          <label>Width<input inputMode="decimal" value={form.width} onChange={event => update('width', event.target.value)} /></label>
          <label>Height<input inputMode="decimal" value={form.height} onChange={event => update('height', event.target.value)} /></label>
          <label>Weight, lb<input inputMode="decimal" value={form.weight} onChange={event => update('weight', event.target.value)} /></label>
          {nav}
        </div>
      )}
      {step === 'stock' && (
        <div className="receive-step">
          <h2>You already have {stockMatches[0]?.quantity || 0} of these</h2>
          <p>{stockMatches[0]?.title} · SKU {stockMatches[0]?.sku}</p>
          <label>Add how many?<input inputMode="numeric" value={form.quantity} onChange={event => update('quantity', event.target.value)} /></label>
          <div className="receive-step-nav is-stack">
            <button type="button" disabled={busy || addingToStock || !stockMatches[0]} onClick={() => stockMatches[0] && onAddToStock(stockMatches[0].sku)}>{addingToStock ? 'Adding…' : 'Add to stock'}</button>
            <button type="button" onClick={() => go(1)}>Receive as a separate item</button>
          </div>
        </div>
      )}
      {step === 'location' && (
        <div className="receive-step">
          <h2>Location</h2>
          <div className="receive-step-main">
            <p className="receive-step-label">Bay</p>
            <div className="receive-step-picks">
              <button type="button" className={noLocation ? 'is-on' : ''} onClick={() => { setNoLocation(true); setBay(null); setRow(null); setLocation(''); }}>No location</button>
              {bays.map(item => (
                <button type="button" key={item.bay_no} className={!noLocation && bay === item.bay_no ? 'is-on' : ''} onClick={() => pickBay(item)}>{item.bay_name || `Bay ${item.bay_no}`}</button>
              ))}
            </div>
            {bay != null && !simpleBay && (
              <>
                <p className="receive-step-label">Row</p>
                <div className="receive-step-picks">
                  {rows.map(value => <button type="button" key={value} className={row === value ? 'is-on' : ''} onClick={() => { setRow(value); setLocation(''); }}>R{value}</button>)}
                </div>
              </>
            )}
            {row != null && (
              <>
                <p className="receive-step-label">Bin</p>
                <div className="receive-step-picks">
                  {bins.map(item => (
                    <button type="button" key={item.code} className={location === item.code ? 'is-on' : ''} onClick={() => setLocation(item.code)}>{item.bin_no == null ? 'No bin' : `B${item.bin_no}`}</button>
                  ))}
                </div>
              </>
            )}
            <p><strong>{noLocation ? 'No location' : location ? locationMenuLabel(locations.find(item => item.code === location) || { code: location }) : 'Pick a bay'}</strong></p>
          </div>
          <div className="receive-step-nav">
            <button type="button" onClick={() => go(-1)}>Back</button>
            <button type="button" disabled={!noLocation && !location} onClick={() => setStep('review')}>Next</button>
          </div>
        </div>
      )}
      {step === 'review' && (
        <div className="receive-step">
          <div className="receive-step-main">
            <p className="receive-review-sku"><span>SKU</span><strong>{nextSku || '…'}</strong></p>
            <div className="receive-review-photos">
              {photoPreviews.map(url => <button type="button" key={url} onClick={() => edit('photo')}><img src={url} alt="Your photo" /></button>)}
              {stockUrl && <button type="button" onClick={() => edit('photo')}><img src={stockUrl} alt="Stock photo" /></button>}
            </div>
            {([
              ['UPC', upc || '—', 'confirm'],
              ['Brand', form.unbranded ? 'Unbranded' : (form.brand || brand || '—'), 'brand'],
              ['Category', doNotList ? '' : (category || '—'), 'category'],
              ['Condition', `${form.condition || '—'}${doNotList ? ' · Do not list' : ''}`, 'condition'],
              ['Price', doNotList ? '' : (form.ask ? `$${form.ask}` : '—'), 'price'],
              ['Quantity', doNotList ? '' : (form.quantity || '1'), 'price'],
              ['Box', doNotList ? '' : ([form.length, form.width, form.height].every(value => Number(value) > 0) ? `${form.length} × ${form.width} × ${form.height} in` : '—'), 'dims'],
              ['Weight', doNotList ? '' : (Number(form.weight) > 0 ? `${form.weight} lb` : '—'), 'dims'],
              ['Location', noLocation || !location ? 'No location' : locationMenuLabel(locations.find(item => item.code === location) || { code: location }), 'location'],
              ['Photos', hasPhoto ? String(photoPreviews.length || 1) : '—', 'photo'],
            ] as [string, string, ReceiveStepId][]).filter(([, value]) => value).map(([label, value, target]) => (
              <button type="button" key={label} className="receive-review-row" onClick={() => edit(target)}>
                <span>{label}</span><strong>{value}</strong>
              </button>
            ))}
          </div>
          <div className="receive-step-nav">
            <button type="button" onClick={() => setStep('location')}>Back</button>
            <button type="button" disabled={busy || !hasPhoto || (!doNotList && !form.ask.trim())} onClick={onSave}>{busy ? 'Saving…' : 'Save & scan next'}</button>
          </div>
          {savedNotice && <p className="receive-saved" role="status">Saved · SKU {savedNotice}</p>}
        </div>
      )}
    </div>
  );
}
