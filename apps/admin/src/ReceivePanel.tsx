import { ReceiveQuantity } from './ReceiveQuantity';
import { ReceiveWorkStatus } from './ReceiveWorkStatus';
import { scannerLifecycle } from './scannerLifecycle';
import { commitReceive } from './receiveCommit';
import { isDnsType } from './dns';
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FocusEvent } from 'react';
import { ChannelPicker, type ChannelId } from './ChannelCheckboxes';
import { createPortal } from 'react-dom';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isKioskShell, scannerInputMode } from './kiosk';
import { floorFunctionUrl } from './floorApi';
import { reportClientError } from './clientLog';
import { priceFloorCents } from './scanPricing';
import { errText } from './errText';
import { locationMenuLabel, sortLocationChoices } from './locationPlace';
import { ManifestReceiveReference, useManifestReceiveReference } from './ManifestReceiveReference';
import { ManifestSearchBox } from './ManifestSearchBox';
import type { ManifestSearchLine } from './manifestReference';
import { BundleReceive } from './BundleReceive';
const MeasureOnMat = lazy(() => import('./MeasureOnMat').then(module => ({ default: module.MeasureOnMat })));
import { receiveSpecifics, receiveVariant } from '../../../shared/receive-specifics.mjs';
import { ebayDetailsStatus } from '../../../shared/ebay-category-present.mjs';
import { filterCategoryOptions, isMattressAccessory, matchReceiveCategory } from '../../../shared/receive-category.mjs';
import { notForSaleBrandError, receiveMissingFields, missingEbayAspects, upcRequired, receiveFieldMessage, receiveSectionForGap, type ReceiveFieldKey } from './receive-validation';
import { ReceiveSection } from './ReceiveSection';
import { ReceiveCategoryAspects, type ReceiveAspectState } from './ReceiveCategoryAspects';
import { CategoryPanel } from './CategoryPanel';
import { EbaySpecificsPanel } from './EbaySpecificsPanel';
import { isCompleteReceiveTitle, isStoreLabelBarcode, storeLabelWarning } from '../../../shared/store-barcode.mjs';
import { cleanProductIdentity, withoutBrand } from '@floor/store';

/** iOS/Android PWA: prefer native capture over getUserMedia (more reliable in standalone). */
function preferNativeCapture() {
  if (typeof navigator === 'undefined') return false;
  return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
    || window.matchMedia('(display-mode: standalone)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

const PHOTO_MAX_BYTES = 15 * 1024 * 1024;
const PHOTO_MIN_BYTES = 2048;
const PENDING_PHOTO_DB = 'floor-receive-photos';
const PENDING_PHOTO_STORE = 'files';

/**
 * Camera capture on Android/iOS PWAs often returns File with empty type, a generic name,
 * or a blob that is invalidated when the <input> value is cleared. Copy bytes into a
 * fresh File before clearing the input.
 */
async function copyImageFile(file: File): Promise<File | null> {
  if (file.size > PHOTO_MAX_BYTES) return null;
  let buf: ArrayBuffer;
  try {
    buf = await file.arrayBuffer();
  } catch {
    return null;
  }
  if (buf.byteLength < PHOTO_MIN_BYTES) return null;
  const type = file.type && file.type.startsWith('image/') ? file.type : 'image/jpeg';
  const rawName = (file.name || '').trim();
  const hasExt = /\.[a-z0-9]{2,5}$/i.test(rawName);
  const name = (hasExt ? rawName : `photo-${Date.now()}.jpg`).replace(/[^a-zA-Z0-9._-]/g, '_') || 'photo.jpg';
  return new File([buf], name, { type, lastModified: file.lastModified || Date.now() });
}

function pendingPhotoKey(storeId: string, scanKey: string) {
  return `${storeId}:${scanKey}`;
}

function manualPhotoSession(storeId: string, rotate = false) {
  const key = `floor-receive-manual-photo-session:${storeId}`;
  try {
    const existing = !rotate ? sessionStorage.getItem(key) : null;
    if (existing) return existing;
    const next = `manual-${storeId}-${crypto.randomUUID()}`;
    sessionStorage.setItem(key, next);
    return next;
  } catch {
    // Without session storage, prefer losing crash recovery over reusing a prior entry's photo.
    return `manual-${storeId}-${crypto.randomUUID()}`;
  }
}

function openPendingPhotoDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PENDING_PHOTO_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PENDING_PHOTO_STORE)) db.createObjectStore(PENDING_PHOTO_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('indexedDB open failed'));
  });
}

async function savePendingPhotos(key: string, files: File[]): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  try {
    const db = await openPendingPhotoDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(PENDING_PHOTO_STORE, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('indexedDB write failed'));
      const store = tx.objectStore(PENDING_PHOTO_STORE);
      if (!files.length) store.delete(key);
      else store.put(files, key);
    });
    db.close();
  } catch { /* best-effort; receive still works without persistence */ }
}

async function loadPendingPhotos(key: string): Promise<File[]> {
  if (typeof indexedDB === 'undefined') return [];
  try {
    const db = await openPendingPhotoDb();
    const blobs = await new Promise<Blob[]>((resolve, reject) => {
      const tx = db.transaction(PENDING_PHOTO_STORE, 'readonly');
      const req = tx.objectStore(PENDING_PHOTO_STORE).get(key);
      req.onsuccess = () => {
        const v = req.result;
        resolve(Array.isArray(v) ? v.filter((f): f is Blob => f instanceof Blob) : []);
      };
      req.onerror = () => reject(req.error || new Error('indexedDB read failed'));
    });
    db.close();
    return blobs.map((f, i) => (f instanceof File
      ? f
      : new File([f], `photo-${i + 1}.jpg`, { type: f.type || 'image/jpeg' })));
  } catch {
    return [];
  }
}

async function clearPendingPhotos(key: string): Promise<void> {
  await savePendingPhotos(key, []);
}

/* ------------------------------------------------------------------------------------------------
 * Receive = scan-to-list.
 *   scan UPC -> lookup fills listing fields -> edit requirements (price, condition, category,
 *   brand, UPC, weight+dims, item specifics) + photo -> channel checkboxes (eBay / Amazon / TikTok Shop) ->
 *   receive (portal_receive_unit) -> photo upload -> merge lookup into listing_specs.
 * "Enter manually" uses the same requirements (plus title/description helpers).
 * ---------------------------------------------------------------------------------------------- */

type Options = { next_sku: string | null; categories?: unknown; conditions: unknown; test_statuses: unknown };
type ReceiveLocation = { code: string; bay_no: number; row_no: number; bin_no: number | null; bay_name?: string | null };
type Props = {
  client: SupabaseClient;
  storeId: string;
  accessToken: string;
  onSaved: () => void;
  /** App-mode chrome: Cancel / Receive · SKU / Save nav, no instruction paragraphs. */
  appChrome?: boolean;
  /** Use store staff RPCs and omit portal-only controls. */
  staffMode?: boolean;
  /** Phone-only presentation for the Android Chrome-installed clerk app. */
  storePhoneMode?: boolean;
  initialManual?: boolean;
  /** Prefill / enqueue a UPC from an earlier camera capture. */
  initialUpc?: string | null;
  onAppCancel?: () => void;
};

type Pkg = { length_in?: number | null; width_in?: number | null; height_in?: number | null; weight_lb?: number | null };
type Source = {
  found?: boolean;
  skipped?: string;
  asin?: string | null;
  title?: string | null;
  brand?: string | null;
  model?: string | null;
  description?: string | null;
  features?: string[];
  aspects?: Record<string, string>;
  images?: string[];
  package?: Pkg;
  price_cents?: number | null;
  price_source?: string | null;
  price_as_of?: string | null;
  price_pending?: boolean;
  price_error?: string | null;
  msrp_cents?: number | null;
  raw_error?: string | null;
};
type Disagreement = { field: string; amazon?: string | number | null; upcitemdb?: string | number | null };
type Lookup = {
  gtin?: { gtin14?: string; upcA?: string; ean13?: string };
  cached?: boolean;
  floor_product?: boolean;
  store_label?: boolean;
  true_miss?: boolean;
  miss_id?: string | null;
  stock_photos?: { url: string; source: string }[];
  amazon?: Source;
  upcitemdb?: Source;
  merged?: {
    title?: string | null; brand?: string | null; model?: string | null; description?: string | null;
    category?: string | null;
    features?: string[]; aspects?: Record<string, string>; images?: string[]; package?: Pkg; asin?: string | null; msrp_cents?: number | null;
    retail_cents?: number | null; retail_source?: string | null; retail_as_of?: string | null;
    disagreements?: Disagreement[]; never_list_reason?: string | null;
    not_found?: boolean;
  };
  fieldCoverage?: { package?: string | null; price?: string | null };
  prewarmed?: boolean;
  receive?: {
    bucket?: 'ready' | 'picker' | 'manifest' | 'search';
    item_number?: string;
    pack_count?: number | null;
    condition_hint?: string;
    manifest_retail_cents?: number | null;
    conflict?: { field: string; note: string; values?: string[]; saved?: string | null } | null;
    candidates?: { title: string; color?: string; size?: string; photo?: string | null }[];
    matches?: { item_number: string; title: string; brand: string; code: string }[];
    photo?: boolean;
    internal?: boolean;
    ebay_category_id?: string | null;
  };
};

type PhotoPriceInfo = {
  kind: string;
  median_cents: number | null;
  low_cents: number | null;
  high_cents: number | null;
  count: number;
  listings?: { store: string; price_cents: number; url: string; product_name: string }[];
  highest_retail?: { store: string; price_cents: number; url: string; product_name: string } | null;
};
type PhotoFill = { aspects: Record<string, string> };
type PhotoCandidate = {
  brand?: string;
  model?: string;
  title?: string;
  item_type?: string;
  category?: string;
  description?: string;
  variant?: string;
  size?: string;
  color?: string;
  [key: string]: unknown;
};

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function postIdentifyPhoto(accessToken: string, body: Record<string, unknown>): Promise<{
  status: number; data: Record<string, any>; uploadMs: number; requestMs: number }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const started = performance.now();
    let uploadMs = 0;
    xhr.open('POST', floorFunctionUrl('receive-photo-identify'));
    xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`);
    xhr.setRequestHeader('content-type', 'application/json');
    xhr.timeout = 12000;
    xhr.upload.onload = () => { uploadMs = performance.now() - started; };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText || '{}'); } catch { /* plain-English fallback below */ }
      resolve({ status: xhr.status, data, uploadMs, requestMs: performance.now() - started });
    };
    xhr.onerror = () => reject(new Error('Photo upload failed. Retry or fill fields by hand.'));
    xhr.ontimeout = () => reject(new Error('Photo identification took too long. Retry or fill fields by hand.'));
    xhr.send(JSON.stringify(body));
  });
}

/** Send a small JPEG to identification; keep the original for the unit photo. */
async function identificationJpeg(file: File): Promise<File> {
  try {
    let source: ImageBitmap | HTMLImageElement;
    let objectUrl: string | null = null;
    try { source = await createImageBitmap(file); }
    catch {
      objectUrl = URL.createObjectURL(file);
      const img = new Image();
      img.src = objectUrl;
      await img.decode();
      source = img;
    }
    const scale = Math.min(1, 1024 / Math.max(source.width, source.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(source.width * scale));
    canvas.height = Math.max(1, Math.round(source.height * scale));
    canvas.getContext('2d')?.drawImage(source, 0, 0, canvas.width, canvas.height);
    if (source instanceof ImageBitmap) source.close();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.7));
    return blob && blob.size > PHOTO_MIN_BYTES
      ? new File([blob], 'identify.jpg', { type: 'image/jpeg' }) : file;
  } catch { return file; }
}

/** "Flavor: Berry · Item Form: Gummy" from Amazon catalog aspects. */
function formatAspectsLine(aspects?: Record<string, string> | null): string {
  if (!aspects) return '';
  return Object.entries(aspects)
    .filter(([k, v]) => !/^product_(height|width|depth|weight)_/i.test(k) && typeof v === 'string' && v.trim())
    .map(([k, v]) => `${k}: ${v.trim()}`)
    .join(' · ');
}

function itemSpecificsFromLookup(m?: Lookup['merged']): string {
  return receiveSpecifics(m || {});
}

/**
 * Floor listing title = brand + item specifics (model).
 * Used for scans and manual — never Amazon's long catalog title or bare retailer digit codes.
 * Example: brand "Oral-B" + model "Replacement Brush Heads 10 Pack" → title.
 */
function composeListingTitle(brand: string, model: string, unbranded: boolean): string {
  const b = unbranded ? '' : brand.trim();
  const m = withoutBrand(model.trim(), b).replace(/\s+/g, ' ').trim();
  return [b, m].filter(Boolean).join(' ');
}

/** Transient lookup failure (retry), not a clean catalog miss. */
function catalogLookupFailed(r?: Lookup): string | null {
  if (!r) return null;
  const m = r.merged;
  const hasCatalog = Boolean(text(m?.title) || text(m?.brand) || text(m?.model) || text(m?.asin));
  if (hasCatalog || r.floor_product) return null;
  const amazonErr = r.amazon?.raw_error || '';
  const upcErr = r.upcitemdb?.raw_error || '';
  if (/rate.?limit/i.test(upcErr) && !r.amazon?.found) {
    return 'Lookup hit a rate limit — retrying in a moment usually works. Or fill fields by hand.';
  }
  if (amazonErr && !r.amazon?.found && !r.upcitemdb?.found) {
    return `Lookup failed (${amazonErr.slice(0, 80)}${upcErr ? `; ${upcErr.slice(0, 60)}` : ''}). Retry, or fill by hand.`;
  }
  return null;
}

/** Clean miss (both sources found nothing) — offer photo identify. */
function isTrueCatalogMiss(r?: Lookup): boolean {
  if (!r || r.floor_product) return false;
  if (r.true_miss) return true;
  const m = r.merged;
  const hasCatalog = Boolean(text(m?.title) || text(m?.brand) || text(m?.model) || text(m?.asin));
  if (hasCatalog) return false;
  if (catalogLookupFailed(r)) return false;
  return Boolean(m?.not_found || (!r.amazon?.found && !r.upcitemdb?.found));
}

function missingIdentityFields(r?: Lookup): string[] {
  if (!r || isTrueCatalogMiss(r) || catalogLookupFailed(r)) return [];
  const brand = text(r.merged?.brand).toLowerCase();
  const title = text(r.merged?.title).toLowerCase();
  const model = text(r.merged?.model);
  if (!title || title === brand || (!model && title.split(/\s+/).length < 3)) return ['specific product name', 'model'];
  return [];
}

function catalogMissMessage(r?: Lookup): string | null {
  if (!r) return null;
  if (r.store_label) return storeLabelWarning();
  const fail = catalogLookupFailed(r);
  if (fail) return fail;
  if (isTrueCatalogMiss(r)) {
    return 'No match in Amazon or UPCitemdb for this UPC — try a product photo, or fill the fields by hand.';
  }
  const m = r.merged;
  const hasCatalog = Boolean(text(m?.title) || text(m?.brand) || text(m?.model) || text(m?.asin));
  if (hasCatalog) return null;
  return 'Lookup returned no title/brand — fill the fields by hand, or retry.';
}

  type Form = {
  brand: string; unbranded: boolean; noUpc: boolean; model: string; variant: string; size: string; title: string; category: string; description: string;
  condition: string; conditionNote: string; testStatus: string; ask: string; cost: string;
  notes: string; upc: string; quantity: string; shippable: string;
  length: string; width: string; height: string; weight: string;
  productHeight: string; productWidth: string; productDepth: string; productWeight: string;
  costEstimate: boolean;
};
const blank: Form = {
  brand: '', unbranded: false, noUpc: false, model: '', variant: '', size: '', title: '', category: '', description: '', condition: '', conditionNote: '', testStatus: '',
  ask: '', cost: '', notes: '', upc: '', quantity: '1', shippable: 'auto',
  length: '', width: '', height: '', weight: '', costEstimate: false,
  productHeight: '', productWidth: '', productDepth: '', productWeight: '',
};
const UPC_NOT_APPLICABLE = 'Does not apply';

type Scan = {
  id: string;
  upc: string;
  status: 'loading' | 'ready' | 'error';
  result?: Lookup;
  error?: string;
  seed?: Partial<Form>; // "Add another unit": product data carried over
  again?: boolean;
};
type Dups = { count: number; skus: string[] };
type StockMatch = { sku: string; title: string; quantity: number; price_cents: number | null; condition: string | null; is_stocked: boolean; can_convert: boolean; fields?: Record<string, unknown> };
type LastReceived = { upc: string; result?: Lookup; seed: Partial<Form> };

const NEW = 'New';
const OPEN = 'Open box';
const USED_GOOD = 'Used - Good';
const USED_FAIR = 'Used - Fair';
const SCRATCH = 'Defective/non-sellable';
/** Legacy condition value — still needs a defect note if somehow selected. */
const SCRATCH_LEGACY = 'Scratch & dent';
const isDefectiveCondition = (value: string) => value === SCRATCH || value === SCRATCH_LEGACY;
const CONDITIONS: [string, string][] = [[NEW, 'New (sealed)'], [OPEN, 'Open box'], [USED_GOOD, 'Used · Good'], [USED_FAIR, 'Used · Fair'], [SCRATCH, 'Defective/non-sellable']];
const HOLD_REASONS: [string, string][] = [
  ['damaged', 'Damaged'], ['needs_testing', 'Needs testing'], ['keep_in_store', 'Keep in store'], ['other', 'Other'],
];
const NEVER_LIST_SKU = '11284'; // permanent stop — never list (see workspace rule)
const IN_STOCK = ['available', 'reserved', 'repair'];

function choices(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string') { try { return choices(JSON.parse(value)); } catch { return []; } }
  return [];
}

function CategoryField({ label, needed, value, options, hint, onChange, onFocus }: {
  label: string; needed?: boolean; value: string; options: string[]; hint?: string;
  onChange: (value: string) => void;
  onFocus?: (event: FocusEvent<HTMLInputElement>) => void;
}) {
  const [open, setOpen] = useState(false);
  const matches = filterCategoryOptions(options, value);
  return (
    <label className={`receive-category-field${needed ? ' receive-need' : ''}`}>
      {label}
      <input
        value={value}
        autoComplete="off"
        onChange={e => onChange(e.target.value)}
        onFocus={e => { onFocus?.(e); setOpen(true); }}
        onBlur={() => { window.setTimeout(() => setOpen(false), 180); }}
      />
      {open && options.length > 0 && (
        <div className="receive-category-options" role="listbox">
          {matches.length > 0
            ? matches.slice(0, 20).map(name => (
              <button
                type="button"
                key={name}
                role="option"
                onPointerDown={e => { e.preventDefault(); onChange(name); setOpen(false); }}
              >{name}</button>
            ))
            : <span className="hint">No matching category</span>}
        </div>
      )}
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

function cents(input: string): number | null | undefined {
  const text = input.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!text) return null;
  if (!/^\d+(\.\d{0,2})?$/.test(text)) return undefined;
  const [whole, fraction = ''] = text.split('.');
  const value = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(value) ? value : undefined;
}

const money = (c: number | null | undefined) => (c == null ? '—' : `$${(c / 100).toFixed(2)}`);
const dollars = (c: number) => (c / 100).toFixed(2);
const pos = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
const text = (v: string | null | undefined) => (v || '').trim();
const num = (n: number | null | undefined) => (pos(n) ? String(n) : '');

/* ----- retail / price suggestion ----- */

type Retail = { cents: number; source: string; asOf: string | null };

/** Prefer Amazon's price, else UPCitemdb's. Never guessed. */
function retailOf(r?: Lookup): Retail | null {
  const a = r?.amazon;
  const u = r?.upcitemdb;
  if (a?.found && pos(a.price_cents)) return { cents: a.price_cents, source: a.price_source || 'amazon', asOf: a.price_as_of || null };
  if (u?.found && pos(u.price_cents)) return { cents: u.price_cents, source: u.price_source || 'upcitemdb', asOf: u.price_as_of || null };
  const m = r?.merged;
  if (pos(m?.retail_cents)) return { cents: m.retail_cents, source: m.retail_source || 'lookup', asOf: m.retail_as_of || null };
  return null;
}
function msrpOf(r?: Lookup): number | null {
  const m = r?.merged?.msrp_cents ?? r?.amazon?.msrp_cents ?? r?.upcitemdb?.msrp_cents;
  return pos(m) ? m : null;
}

function explainLookupError(err: unknown, status?: number, body?: { error?: string; message?: string }): string {
  const raw = errText(body?.error || body?.message || err || '');
  const lower = raw.toLowerCase();
  if (err instanceof DOMException && err.name === 'AbortError') return 'Lookup timed out — the server took too long. Retry or enter manually.';
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(raw)) {
    return "Couldn't reach the lookup server (network/CORS). Retry once; if it keeps failing, enter manually.";
  }
  if (status === 401 || /not_logged_in|sign in required|not_signed_in/i.test(lower)) return 'Not logged in — sign in again, then retry the scan.';
  if (status === 403 || /not_authorized|staff access|not_owner|not_staff/i.test(lower)) return 'Not authorized for lookup — ask an admin to check your staff access.';
  if (status === 429 || /rate.?limit|quota/i.test(lower)) return 'Amazon rate-limited pricing — catalog may still show; retry in a moment for the price.';
  if (/invalid_gtin|upc_required|valid upc/i.test(lower)) return 'That barcode does not look like a valid UPC/EAN.';
  if (/not found|no source|upcitemdb/i.test(lower) && status === 404) return 'UPC not found in Amazon or UPCitemdb — fill the fields by hand.';
  if (raw && raw !== 'Failed to fetch' && raw !== 'Something went wrong') return raw;
  return 'Lookup failed — retry or enter manually.';
}

/* ----- lookup ----- */

async function lookupUpcOnce(token: string, upc: string, signal: AbortSignal): Promise<Lookup> {
  const res = await fetch(floorFunctionUrl('upc-lookup'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'lookup', upc, compare_upcitemdb: true }),
    signal,
  });
  const json = await res.json().catch(() => ({} as { error?: string; message?: string }));
  if (!res.ok) {
    const err = new Error(explainLookupError(null, res.status, json));
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  return json as Lookup;
}

async function lookupUpc(token: string, upc: string): Promise<Lookup> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 45000);
  try {
    try {
      return await lookupUpcOnce(token, upc, ctl.signal);
    } catch (first) {
      // Auto-retry once for network / transient failures (not auth or bad UPC).
      const status = (first as { status?: number })?.status;
      if (status === 401 || status === 403 || status === 400) throw first;
      await new Promise(r => setTimeout(r, 600));
      return await lookupUpcOnce(token, upc, ctl.signal);
    }
  } catch (e) {
    throw new Error(explainLookupError(e, (e as { status?: number })?.status));
  } finally { clearTimeout(timer); }
}

function upcVariants(upc: string, r?: Lookup): string[] {
  const g = r?.gtin;
  return [...new Set([upc, g?.upcA, g?.ean13, g?.gtin14].map(v => (v || '').trim()).filter(Boolean))];
}

function featuresText(features?: string[]) {
  const list = (features || []).map(f => f.trim()).filter(Boolean);
  return list.map(f => `• ${f}`).join('\n');
}

/* ----- camera barcode fallback ----- */

type Detector = { detect: (src: ImageBitmap | HTMLVideoElement) => Promise<{ rawValue: string }[]> };
type DetectorCtor = new (opts?: { formats?: string[] }) => Detector;
const FORMATS = ['upc_a', 'upc_e', 'ean_13', 'ean_8'];
const detectorCtor = (): DetectorCtor | undefined =>
  (typeof window !== 'undefined' ? (window as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector : undefined);

export async function decodeBarcodeFile(file: File): Promise<string | null> {
  const Ctor = detectorCtor();
  if (!Ctor) return null;
  try {
    const bitmap = await createImageBitmap(file);
    try { const codes = await new Ctor({ formats: FORMATS }).detect(bitmap); return codes[0]?.rawValue || null; }
    finally { bitmap.close(); }
  } catch { return null; }
}

async function decodeFile(file: File): Promise<string | null> {
  return decodeBarcodeFile(file);
}

function CameraScanner({ onDetect, onFile, onClose }: {
  onDetect: (code: string) => void; onFile: (file: File) => void; onClose: () => void;
}) {
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
    const lifecycle = scannerLifecycle(document, window, video.current, () => {
      stopped = true; window.clearInterval(timer); onClose();
    });
    void (async () => {
      try {
        const Ctor = detectorCtor();
        if (!Ctor) throw new Error('This browser cannot read barcodes from the camera.');
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera API unavailable.');
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        if (!lifecycle.attach(stream)) return;
        if (stopped) { stream.getTracks().forEach(t => t.stop()); return; }
        const el = video.current;
        if (!el) return;
        el.srcObject = stream;
        el.setAttribute('playsinline', 'true');
        el.muted = true;
        await el.play();
        if (stopped || lifecycle.stopped) return;
        const detector = new Ctor({ formats: FORMATS });
        timer = window.setInterval(() => {
          if (stopped || lifecycle.stopped) return;
          void detector.detect(el).then(codes => {
            const raw = codes[0]?.rawValue;
            if (raw && !stopped && !lifecycle.stopped && !done.current) { done.current = true; detect.current(raw); }
          }).catch(() => undefined);
        }, 250);
      } catch (e) { setErr(errText(e) || 'Camera unavailable. Use Take photo instead.'); }
    })();
    return () => { stopped = true; window.clearInterval(timer); lifecycle.stop(); };
  }, []);
  // Portal to body — app-mode uses position:fixed + overflow which clips nested fixed modals on iOS.
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
            className="sr-only"
            aria-hidden
            tabIndex={-1}
            onChange={e => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) onFile(f);
            }}
          />
          <button type="button" className="secondary receive-file-btn" onClick={() => fileInput.current?.click()}>
            Take photo of barcode
          </button>
          <button type="button" className="secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ================================================================================================ */

export function ReceivePanel({ client, storeId, accessToken, onSaved, appChrome, staffMode = false, storePhoneMode = false, initialManual, initialUpc, onAppCancel }: Props) {
  const [options, setOptions] = useState<Options | null>(null);
  const [receiveLocations, setReceiveLocations] = useState<ReceiveLocation[]>([]);
  const [selectedLocation, setSelectedLocation] = useState(() => {
    try { return localStorage.getItem(`floor:last-receive-location:${storeId}`) || ''; } catch { return ''; }
  });
  const [locationScan, setLocationScan] = useState('');
  const [locationEditOpen, setLocationEditOpen] = useState(false);
  const [stagedPhotoPaths, setStagedPhotoPaths] = useState<string[]>([]);
  const [stockPhotoPath, setStockPhotoPath] = useState('');
  const [stockPhotoSourceUrl, setStockPhotoSourceUrl] = useState('');
  const [stockPhotoUrls, setStockPhotoUrls] = useState<{ url: string; source: string }[]>([]);
  const [stockPhotoBusy, setStockPhotoBusy] = useState(false);
  const [stockPhotoError, setStockPhotoError] = useState('');
  const [stockPhotoBroken, setStockPhotoBroken] = useState(false);
  const [manual, setManual] = useState(!!initialManual);
  const [draft, setDraft] = useState('');
  const [queue, setQueue] = useState<Scan[]>([]);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(blank);
  const [files, setFiles] = useState<File[]>([]);
  const [saved, setSaved] = useState<string[]>([]);
  const [manifestId, setManifestId] = useState('');
  const [stockMatches, setStockMatches] = useState<StockMatch[]>([]);
  const [selectedStockMatch, setSelectedStockMatch] = useState<StockMatch | null>(null);
  const [manifests, setManifests] = useState<{ id: string; name: string; manifest_on: string }[]>([]);
  const [last, setLast] = useState<LastReceived | null>(null);
  const [warning, setWarning] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const receiveRequest = useRef(crypto.randomUUID());
  const saveTappedAt = useRef(0);
  const [dups, setDups] = useState<Dups | null>(null);
  const [dupAck, setDupAck] = useState(false);
  const [dialog, setDialog] = useState<null | 'ready' | 'reason' | 'miss-photo'>(null);
  const [reason, setReason] = useState('damaged');
  const [reasonNote, setReasonNote] = useState('');
  const [camera, setCamera] = useState(false);
  const [channels, setChannels] = useState<ChannelId[]>([]);
  /** Store-only / not selling online — photo not required to receive. */
  const [doNotList, setDoNotList] = useState(false);
  const [showSaveValidation, setShowSaveValidation] = useState(false);
  const [openSec, setOpenSec] = useState('photos');
  const toggleSection = (id: string) => setOpenSec(current => current === id ? '' : id);
  const [ebayAspects, setEbayAspects] = useState<ReceiveAspectState>({
    categoryId: null, path: null, fields: [], attributes: {}, na: {},
  });
  const fieldRefs = useRef<Partial<Record<ReceiveFieldKey, HTMLElement | null>>>({});
  const channelAttrs = useRef<Record<string, string>>({});
  const [channelMissing, setChannelMissing] = useState(0);
  const [dns, setDns] = useState(false);
  const dnsRequired = isDnsType(form);
  const doNotShip = dns || dnsRequired;
  const [photoIdBusy, setPhotoIdBusy] = useState(false);
  const [photoIdStatus, setPhotoIdStatus] = useState('');
  const [photoIdError, setPhotoIdError] = useState('');
  const [photoNeed, setPhotoNeed] = useState('');
  const [pickerBusy, setPickerBusy] = useState(false);
  const [boxCheck, setBoxCheck] = useState('');
  const [photoPrice, setPhotoPrice] = useState<PhotoPriceInfo | null>(null);
  const [photoPriceError, setPhotoPriceError] = useState('');
  const [photoPriceBusy, setPhotoPriceBusy] = useState(false);
  const [matOpen, setMatOpen] = useState(false);
  const [dimensionsBusy, setDimensionsBusy] = useState(false);
  const [dimensionsError, setDimensionsError] = useState('');
  const [dimensionSources, setDimensionSources] = useState<Record<string, string>>({});
  const [photoIdentity, setPhotoIdentity] = useState<PhotoCandidate | null>(null);
  const [photoFill, setPhotoFill] = useState<PhotoFill | null>(null);
  const [photoCandidate, setPhotoCandidate] = useState<PhotoCandidate | null>(null);
  const [photoConflictText, setPhotoConflictText] = useState('');
  const [photoTitleConfirmed, setPhotoTitleConfirmed] = useState(false);
  const [photoVerifyPending, setPhotoVerifyPending] = useState(false);
  const missPhotoFile = useRef<HTMLInputElement>(null);
  const titleField = useRef<HTMLTextAreaElement>(null);
  const missChooseFile = useRef<HTMLInputElement>(null);
  const missPromptedFor = useRef<string | null>(null);
  const photoIdentifyRequest = useRef(0);
  const typingTarget = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const [typingOpen, setTypingOpen] = useState(false);
  const [typingShift, setTypingShift] = useState(false);
  const photoCheckedFor = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    if (staffMode) return;
    void client.from('store_manifests').select('id,name,manifest_on')
      .eq('store_id', storeId).order('manifest_on', { ascending: false })
      .then(({ data }) => { if (active) setManifests(data || []); });
    return () => { active = false; };
  }, [client, storeId, staffMode]);

  const upcInput = useRef<HTMLInputElement>(null);
  const cameraFile = useRef<HTMLInputElement>(null);
  const takePhotoFile = useRef<HTMLInputElement>(null);
  const confirmPhotoFile = useRef<HTMLInputElement>(null);
  const choosePhotoFile = useRef<HTMLInputElement>(null);
  const consumedInitialUpc = useRef(false);
  /** Stable key for IndexedDB photo stash (survives camera-app process death on store phones). */
  const photoSessionKey = useRef(manualPhotoSession(storeId));
  const [photoBusy, setPhotoBusy] = useState(false);

  useEffect(() => {
    if (!dialog) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (dialog === 'miss-photo') dismissPhotoCheck();
      else setDialog(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dialog]);

  function openBarcodeCamera() {
    // Phones / installed PWA: native capture is far more reliable than getUserMedia + BarcodeDetector.
    if (preferNativeCapture() || appChrome || !detectorCtor()) {
      cameraFile.current?.click();
      return;
    }
    setCamera(true);
  }
  const chain = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(true);
  const askTouched = useRef(false);
  const titleTouched = useRef(false);
  const categoryTouched = useRef(false);
  const priceRequest = useRef(0);
  const dimensionTouched = useRef(new Set<string>());
  const activeScan = useRef<string | null>(null);
  const categoryRequest = useRef(0);
  const modalOpen = useRef(false);
  modalOpen.current = camera || dialog !== null;

  const current = manual ? undefined : queue[0];
  const formOpen = Boolean(manual || (current && current.status !== 'loading' && loadedId === current.id));
  useEffect(() => {
    let active = true;
    setStockMatches([]); setSelectedStockMatch(null);
    const upc = manual ? (form.noUpc ? '' : form.upc.trim()) : current?.upc || '';
    const title = form.title.trim() || [form.brand, form.model].filter(Boolean).join(' ');
    const price = cents(form.ask);
    if (!formOpen || doNotList || price == null || price === undefined) return () => { active = false; };
    void Promise.resolve(client.rpc('portal_receive_stock_match', { p_upc: upc || null, p_title: title || null, p_price_cents: price, p_condition: form.condition || null }))
      .then(({ data, error: e }) => { if (active && !e) setStockMatches(Array.isArray(data) ? data as StockMatch[] : []); })
      .catch(() => {});
    return () => { active = false; };
  }, [client, manual, formOpen, form.upc, form.noUpc, form.title, form.brand, form.model, form.ask, form.condition, doNotList, current?.upc]);
  const manifestReference = useManifestReceiveReference(client, manual ? form.upc : current?.upc || '');

  /* Manifest is IDENTITY only. Prefill brand/title/category when catalog lookup is thin — never ask/cost. */
  useEffect(() => {
    const reference = manifestReference?.reference;
    if (!reference || !formOpen) return;
    const brand = String(reference.brand || '').trim();
    const description = String(reference.description || '').trim();
    const category = String(reference.category || '').trim();
    if (!brand && !description && !category) return;
    setForm(prev => {
      const next = { ...prev };
      let changed = false;
      if (brand && !prev.brand.trim() && !prev.unbranded) {
        next.brand = brand;
        changed = true;
      }
      if (description && !prev.title.trim()) {
        next.title = next.brand ? `${next.brand} ${description}` : description;
        if (!prev.description.trim()) next.description = description;
        changed = true;
      } else if (description && !prev.description.trim()) {
        next.description = description;
        changed = true;
      }
      if (category && !prev.category.trim() && !categoryTouched.current) {
        next.category = category;
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [manifestReference, formOpen, loadedId]);
  const result = current?.result;
  const merged = result?.merged;
  const A = result?.amazon;
  const retail = useMemo(() => retailOf(result), [result]);
  const msrp = useMemo(() => msrpOf(result), [result]);
  const costParsed = cents(form.cost);
  const costKnown = typeof costParsed === 'number' ? costParsed : null;
  const weightNum = (() => { const n = Number(form.weight.trim()); return Number.isFinite(n) && n > 0 ? n : null; })();
  const floor = useMemo(
    () => priceFloorCents({
      // Treat category-default cost as "unknown" for floor labeling, but still use the dollars.
      costCents: form.costEstimate ? null : costKnown,
      weightLb: weightNum ?? (result?.merged?.package?.weight_lb ?? null),
      title: form.title || result?.merged?.title,
      brand: form.brand || result?.merged?.brand,
      model: form.model || result?.merged?.model,
      category: result?.merged?.category ?? null,
    }),
    [costKnown, form.costEstimate, weightNum, form.title, form.brand, form.model, result],
  );

  // Only keep the scan box focused when idle. Refocusing during form edit pops the
  // mobile keyboard every time the user scrolls (body briefly becomes activeElement).
  const focusUpc = () => {
    if (manual || formOpen || modalOpen.current || document.visibilityState !== 'visible') return;
    requestAnimationFrame(() => { if (document.visibilityState === 'visible' && mounted.current) upcInput.current?.focus(); });
  };
  function chooseNoBrand() {
    setForm(prev => ({ ...prev, brand: '', unbranded: true,
      title: prev.title && prev.title !== composeListingTitle(prev.brand, prev.model, false) ? prev.title : prev.model }));
    setPhotoTitleConfirmed(false);
  }
  function suppressPhotoPrompt(upc = current?.upc) {
    if (!upc) return;
    try { sessionStorage.setItem(`floor:receive-photo-dismissed:${storeId}:${upc}`, '1'); } catch { /* suppression is best-effort */ }
  }
  function typeReceiveKey(key: string) {
    const target = typingTarget.current;
    if (!target) return;
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? start;
    const insertion = key === 'SPACE' ? ' ' : key;
    const next = key === 'BACKSPACE'
      ? (start === end ? target.value.slice(0, Math.max(0, start - 1)) + target.value.slice(end) : target.value.slice(0, start) + target.value.slice(end))
      : target.value.slice(0, start) + insertion + target.value.slice(end);
    const caret = key === 'BACKSPACE' ? Math.max(0, start - (start === end ? 1 : 0)) : start + insertion.length;
    const prototype = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(target, next);
    target.dispatchEvent(new Event('input', { bubbles: true }));
    requestAnimationFrame(() => { target.focus(); target.setSelectionRange(caret, caret); });
  }
  const update = (key: keyof Form, value: string) => {
    const dimensionField = ({length:'package_length_in',width:'package_width_in',height:'package_height_in',weight:'package_weight_lb',
      productHeight:'product_height_in',productWidth:'product_width_in',productDepth:'product_depth_in',productWeight:'product_weight_lb'} as Record<string,string>)[key];
    if (dimensionField) {
      dimensionTouched.current.add(key);
      setDimensionSources(prev => ({...prev,[dimensionField]:'staff'}));
    }
    if (key === 'ask') askTouched.current = true;
    if (key === 'title') titleTouched.current = true;
    if (key === 'category') categoryTouched.current = true;
    setForm(prev => {
      const next = { ...prev, [key]: value };
      if (key === 'cost') next.costEstimate = false;
      // Title is always brand + item specifics (scans and manual).
      if ((key === 'brand' || key === 'model') && !titleTouched.current) {
        next.title = composeListingTitle(
          key === 'brand' ? value : next.brand,
          key === 'model' ? value : next.model,
          next.unbranded,
        );
      }
      return next;
    });
  };

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!storePhoneMode || !titleField.current) return;
    titleField.current.style.height = 'auto';
    titleField.current.style.height = `${titleField.current.scrollHeight}px`;
  }, [form.title, storePhoneMode]);
  useEffect(() => { focusUpc(); }, []);
  useEffect(() => {
    const releaseUi = () => {
      if (document.visibilityState === 'visible') return;
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
      setCamera(false);
    };
    const releaseOnPageHide = () => {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
      setCamera(false);
    };
    document.addEventListener('visibilitychange', releaseUi);
    window.addEventListener('pagehide', releaseOnPageHide);
    return () => {
      document.removeEventListener('visibilitychange', releaseUi);
      window.removeEventListener('pagehide', releaseOnPageHide);
    };
  }, []);
  useEffect(() => {
    if (formOpen) upcInput.current?.blur();
  }, [formOpen, loadedId]);

  async function loadOptions() {
    const { data, error: e } = await client.rpc(staffMode ? 'staff_receive_options' : 'portal_receive_options');
    if (e) throw e;
    setOptions(data as Options);
  }
  useEffect(() => { void loadOptions().catch(e => setError(errText(e))); }, [client, staffMode]);
  useEffect(() => {
    let alive = true;
    void Promise.resolve(client.rpc('portal_bay_list')).then(({ data, error: e }) => {
      if (e) throw e;
      if (!alive) return;
      const locations = sortLocationChoices((data?.locations || []) as ReceiveLocation[]);
      setReceiveLocations(locations);
      setSelectedLocation(previous => locations.some(location => location.code === previous)
        ? previous : '');
    }).catch(e => { if (alive) setWarning(`Locations unavailable: ${errText(e)}`); });
    return () => { alive = false; };
  }, [client]);

  async function stageStockPhoto(url: string, upc: string, scanId: string): Promise<string | null> {
    setStockPhotoBusy(true);
    setStockPhotoError('');
    try {
      const response = await fetch(floorFunctionUrl('receive-photo-identify'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'stage_stock_photo', upc, url, request_id: receiveRequest.current }),
        signal: AbortSignal.timeout(20000),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || typeof data.path !== 'string') throw new Error(data.message || 'Stock photo unavailable');
      if (activeScan.current === scanId) { setStockPhotoPath(data.path); setStockPhotoSourceUrl(url); setStockPhotoBroken(false); }
      return data.path;
    } catch {
      if (activeScan.current === scanId) setStockPhotoError('Stock photo could not be saved. Tap the save button to retry, or add a unit photo.');
      return null;
    } finally {
      if (activeScan.current === scanId) setStockPhotoBusy(false);
    }
  }

  async function attachStockPhotoSources(skus: string[], upc: string, firstPath: string, firstUrl: string, rest: { url: string; source: string }[]) {
    if (!skus.length || !upc || !firstPath || !firstUrl) return;
    try {
      const response = await fetch(floorFunctionUrl('receive-photo-identify'), {
        method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'attach_stock_photos', skus, upc, first_path: firstPath,
          photos: [{ url: firstUrl, source: 'catalog' }, ...rest].slice(0, 6) }),
        signal: AbortSignal.timeout(55000),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        console.warn('receive_stock_photo_background_failed', { sku: skus[0], message: data.message || data.error || response.status });
      }
    } catch (error) {
      console.warn('receive_stock_photo_background_failed', { sku: skus[0], message: errText(error) });
    }
  }

  async function stageUnitPhotos(nextFiles: File[]) {
    const started=performance.now();
    const actor = JSON.parse(atob(accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub;
    if (!actor) throw new Error('Sign in again before taking a photo.');
    const paths: string[] = [];
    try {
      for (const file of nextFiles) {
        const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_') || 'unit.jpg';
        const path = `${storeId}/receive/${actor}/${receiveRequest.current}/${Date.now()}-${crypto.randomUUID()}-${safe}`;
        const upload = await client.storage.from('unit-photos').upload(path, file, {
          contentType: file.type && file.type.startsWith('image/') ? file.type : 'image/jpeg', upsert: false,
        });
        if (upload.error) throw upload.error;
        paths.push(path);
      }
    } catch (error) {
      if (paths.length) await client.storage.from('unit-photos').remove(paths);
      throw error;
    }
    console.info('receive_photo_stage_timing',{upload_ms:Math.round(performance.now()-started),photos:paths.length});
    return paths;
  }

  /* ----- photo previews ----- */
  const previews = useMemo(() => files.map(f => URL.createObjectURL(f)), [files]);
  useEffect(() => () => { previews.forEach(u => URL.revokeObjectURL(u)); }, [previews]);

  /* ----- duplicate check ----- */
  async function findDups(variants: string[]): Promise<Dups | null> {
    if (!variants.length) return null;
    const { data, error: e } = await client.from(staffMode ? 'units_pos' : 'units').select('sku')
      .eq('store_id', storeId).in('upc', variants).in('state', IN_STOCK).limit(100);
    if (e || !data) return null;
    return { count: data.length, skus: data.map(r => String((r as { sku: string }).sku)) };
  }

  /* ----- lookup queue ----- */
  function runLookup(id: string, upc: string) {
    chain.current = chain.current.then(async () => {
      try {
        const res = await lookupUpc(accessToken, upc);
        if (mounted.current) setQueue(q => q.map(s => (s.id === id ? { ...s, status: 'ready', result: res, error: undefined } : s)));
      } catch (e) {
        const msg = errText(e);
        reportClientError(accessToken, { message: `upc_lookup failed: ${msg}`, page: 'inventory/receive', action_name: 'upc_lookup', sku: upc });
        if (mounted.current) setQueue(q => q.map(s => (s.id === id ? { ...s, status: 'error', error: msg } : s)));
      }
    });
  }

  function enqueue(raw: string, seed?: Partial<Form>) {
    const upc = raw.replace(/[\s,-]/g, '');
    if (!upc) return;
    setDraft('');
    if (!/^\d{4,14}$/.test(upc)) { setError(`"${raw.trim()}" is not a barcode or Costco item number. Scan again, or search the manifest.`); focusUpc(); return; }
    setError('');
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setQueue(q => [...q, { id, upc, status: 'loading', seed }]);
    runLookup(id, upc);
    focusUpc();
  }

  function replaceScan(code: string) {
    setManual(false);
    setLoadedId(null);
    setQueue([]);
    enqueue(code);
  }

  async function chooseVariant(title: string) {
    if (!current || pickerBusy) return;
    setPickerBusy(true);
    setError('');
    try {
      const response = await fetch(floorFunctionUrl('upc-lookup'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'pin_variant',
          upc: current.upc,
          title,
          item_number: current.result?.receive?.item_number || '',
        }),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json.error || json.message || 'That variant could not be saved');
      setLoadedId(null);
      setQueue(q => q.map(s => (s.id === current.id ? { ...s, status: 'ready', result: json as Lookup } : s)));
    } catch (error) {
      setError(errText(error) || 'That variant could not be saved. Choose none of these and photograph the box.');
    } finally {
      setPickerBusy(false);
    }
  }

  function noneOfThese() {
    if (!current?.result) return;
    const next: Lookup = {
      ...current.result,
      receive: { ...current.result.receive, bucket: 'manifest', photo: true, candidates: [] },
    };
    setLoadedId(null);
    setQueue(q => q.map(s => (s.id === current.id ? { ...s, result: next } : s)));
  }

  async function saveBoxCheck(field: string, value: string) {
    const entered = value.trim();
    if (!current || !field || !entered) return;
    setForm(prev => ({
      ...prev,
      notes: prev.notes.toLowerCase().includes(entered.toLowerCase()) ? prev.notes : [prev.notes, `${field}: ${entered}`].filter(Boolean).join('\n'),
    }));
    try {
      await fetch(floorFunctionUrl('upc-lookup'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'save_correction',
          upc: current.upc,
          item_number: current.result?.receive?.item_number || '',
          field,
          value: entered,
        }),
      });
    } catch { /* The note is still on this unit if the catalog write fails. */ }
  }

  function pickManifestLine(line: ManifestSearchLine) {
    const upc = String(line.upc_normalized || line.item_number || '').replace(/[\s,-]/g, '');
    if (dialog === 'miss-photo') setDialog(null);
    if (!upc) return;
    replaceScan(upc);
  }

  useEffect(() => {
    if (!initialUpc || consumedInitialUpc.current || manual) return;
    consumedInitialUpc.current = true;
    enqueue(initialUpc);
  }, [initialUpc, manual]);

  function retry(scan: Scan) {
    setQueue(q => q.map(s => (s.id === scan.id ? { ...s, status: 'loading', error: undefined } : s)));
    setLoadedId(null);
    runLookup(scan.id, scan.upc);
  }

  function resetEntry(keepProduct?: Partial<Form>, cleanupPhotos = true) {
    askTouched.current = false;
    titleTouched.current = false;
    categoryTouched.current = false;
    categoryRequest.current += 1;
    setEbayAspects({ categoryId: null, path: null, fields: [], attributes: {}, na: {} });
    setForm({ ...blank, ...keepProduct });
    setFiles([]);
    setStockPhotoPath('');
    setStockPhotoError('');
    const oldPhotoPaths = stagedPhotoPaths.slice();
    setStagedPhotoPaths([]);
    if (cleanupPhotos) receiveRequest.current = crypto.randomUUID();
    void oldPhotoPaths;
    void clearPendingPhotos(pendingPhotoKey(storeId, photoSessionKey.current));
    setDups(null);
    setDupAck(false);
    setDialog(null);
    setReason('damaged');
    setReasonNote('');
    setChannels([]);
    setDoNotList(false); setDns(false);
    setPhotoFill(null);
    setPhotoIdentity(null);
    setPhotoCandidate(null);
    setPhotoConflictText('');
    setPhotoTitleConfirmed(false);
    setPhotoVerifyPending(false);
    priceRequest.current++;
    setPhotoPriceBusy(false);
    setMatOpen(false);
    setPhotoPriceError('');
    setPhotoPrice(null);
    setBoxCheck('');
    setDimensionSources({});
    dimensionTouched.current.clear();
    setDimensionsError('');
  }

  /* Suggested eBay category, started with the scan so Item does not have to be opened. */
  async function fillSuggestedCategory(scanId: string, identity: { brand: string; model: string; title: string; condition: string; upc: string }) {
    const q = [identity.title, identity.brand].filter(Boolean).join(' ').trim();
    if (q.length < 3) return;
    const token = ++categoryRequest.current;
    try {
      const suggested = await fetch(floorFunctionUrl('ebay-specifics'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ store_id: storeId, action: 'suggest-for-title', title: q }),
      });
      const suggestion = await suggested.json().catch(() => ({}));
      if (token !== categoryRequest.current || activeScan.current !== scanId) return;
      if (!suggested.ok || suggestion.ok === false) return;
      const list = (suggestion.suggestions || []) as { category_id: string; path: string; best_match?: boolean }[];
      const choice = suggestion.preselect || list.find(item => item.best_match) || list[0];
      if (!choice?.category_id) return;
      const looked = await client.rpc('portal_ebay_category_form', { p_category_id: choice.category_id });
      const row = looked.error ? null : looked.data as { path?: string; fields?: ReceiveAspectState['fields'] } | null;
      const preview = await fetch(floorFunctionUrl('ebay-specifics'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          store_id: storeId,
          action: 'preview-receive',
          category_id: choice.category_id,
          path: choice.path,
          identity,
          attributes: {},
        }),
      });
      const picked = await preview.json().catch(() => ({}));
      if (token !== categoryRequest.current || activeScan.current !== scanId) return;
      if (!preview.ok || picked.ok === false) return;
      const path = String(picked.path || row?.path || choice.path || '');
      const fields = (picked.fields || row?.fields || []) as ReceiveAspectState['fields'];
      setEbayAspects({
        categoryId: String(choice.category_id),
        path,
        fields,
        attributes: (picked.attributes || {}) as Record<string, string>,
        na: {},
        allowedGrades: picked.conditions || [],
        conditionNote: String(picked.conditionNote || ''),
      });
      if (categoryTouched.current) return;
      setForm(prev => {
        if (prev.category.trim()) return prev;
        const names = choices(options?.categories);
        let next = matchReceiveCategory(names, {
          category: prev.category,
          title: [prev.title, path].filter(Boolean).join(' '),
          brand: prev.brand,
          model: prev.model,
        });
        if (!next) {
          const leaf = path.split('>').pop()?.trim().toLowerCase() || '';
          next = names.find(name => name.toLowerCase() === leaf) || '';
        }
        return next ? { ...prev, category: next } : prev;
      });
    } catch {
      /* Opening Item still runs the same suggestion. */
    }
  }

  /* Load the head of the queue into the form once its lookup has settled. */
  useEffect(() => {
    if (manual) return;
    if (!current) { if (loadedId !== null) { setLoadedId(null); resetEntry(); } return; }
    if (current.status === 'loading' || loadedId === current.id) return;
    dimensionTouched.current = new Set(Object.keys(current.seed || {}).filter(key =>
      ['length','width','height','weight','productHeight','productWidth','productDepth','productWeight'].includes(key)));
    priceRequest.current++;
    setPhotoPrice(null);
    setPhotoPriceBusy(false);
    setPhotoPriceError('');
    const r = current.result;
    const m = r?.merged;
    const p = m?.package;
    const retailNow = retailOf(r);
    // The stored model field is a human type/variant with count, not a manufacturer MPN.
    const specifics = itemSpecificsFromLookup(m);
    const brand = text(m?.brand);
    const initial: Form = {
      ...blank,
      upc: current.upc,
      brand,
      unbranded: false,
      model: specifics,
      variant: receiveVariant(m || {}),
      size: text(m?.aspects?.Size),
      title: text(m?.title) || composeListingTitle(brand, specifics, false),
      category: matchReceiveCategory(choices(options?.categories), {
        category: m?.category, title: m?.title, brand, model: specifics,
      }),
      // description falls back to the real feature bullets from the lookup; never invented text
      description: text(m?.description) || featuresText(m?.features),
      length: num(p?.length_in), width: num(p?.width_in), height: num(p?.height_in), weight: num(p?.weight_lb),
      productHeight: num(Number(m?.aspects?.product_height_in) || null),
      productWidth: num(Number(m?.aspects?.product_width_in) || null),
      productDepth: num(Number(m?.aspects?.product_depth_in) || null),
      productWeight: num(Number(m?.aspects?.product_weight_lb) || null),
      ask: current.seed?.ask || '',
      cost: '',
      ...(current.seed || {}),
      costEstimate: false,
    };
    if (r?.receive?.internal) {
      initial.upc = '';
      initial.noUpc = true;
      if (r.receive.item_number) initial.notes = `Costco item ${r.receive.item_number}`;
    }
    if (r?.receive?.condition_hint && !initial.condition) initial.condition = r.receive.condition_hint;
    if (r?.receive?.pack_count && !/pack|count|\bct\b/i.test(`${initial.title} ${initial.model} ${initial.variant}`)) {
      initial.variant = [initial.variant, `${r.receive.pack_count} pack`].filter(Boolean).join(' ');
    }
    setBoxCheck(r?.receive?.conflict?.saved || '');
    // Seed may override brand/model — keep title in sync.
    if (!initial.title) initial.title = composeListingTitle(initial.brand, initial.model, initial.unbranded);
    askTouched.current = Boolean(current.seed && 'ask' in current.seed);
    titleTouched.current = Boolean(initial.title);
    categoryTouched.current = Boolean(text(current.seed?.category));
    setDimensionSources(Object.fromEntries([
      ...(['length_in', 'width_in', 'height_in', 'weight_lb'] as const).map((key, i) => [
        ['package_length_in', 'package_width_in', 'package_height_in', 'package_weight_lb'][i],
        p?.[key] != null ? (r?.fieldCoverage?.package || 'Floor') : '',
      ]),
      ...(['product_height_in', 'product_width_in', 'product_depth_in', 'product_weight_lb'] as const)
        .map(key => [key, m?.aspects?.[key] ? (r?.floor_product ? 'Floor' : 'Amazon') : '']),
    ].filter(([, source]) => source)));
    setForm(initial);
    setEbayAspects({ categoryId: null, path: null, fields: [], attributes: {}, na: {} });
    const miss = current.status === 'ready' || current.status === 'error'
      ? (current.status === 'error' ? null : catalogMissMessage(r))
      : null;
    if (miss && !isTrueCatalogMiss(r)) setWarning(miss);
    else if (A?.price_pending && !retailNow) setWarning('Amazon catalog found, but pricing was rate-limited — enter price by hand or retry for a suggested retail.');
    else if (!retailNow && (r?.amazon?.found || r?.upcitemdb?.found)) setWarning('No retail price from Amazon/UPCitemdb — enter price by hand.');
    else setWarning('');
    photoSessionKey.current = current.id;
    setFiles([]);
    setStagedPhotoPaths([]);
    setStockPhotoPath('');
    setStockPhotoSourceUrl('');
    setStockPhotoBroken(false);
    setStockPhotoUrls((r?.stock_photos || m?.images?.map(url => ({ url: String(url), source: 'catalog' })) || []).slice(0, 6));
    setStockPhotoError('');
    // Instant miss popup (photo fallback). Do not re-prompt the same scan id.
    const identityNeeds = missingIdentityFields(r);
    setPhotoPrice(null);
    const prewarmed = Boolean(r?.prewarmed);
    const picking = r?.receive?.bucket === 'picker' || r?.receive?.bucket === 'search';
    if (!staffMode && !prewarmed && !identityNeeds.length && m?.title && m?.brand) {
      const priceIdentity = { title: m.title, brand: m.brand, model: m.model || '',
        variant: initial.variant, size: initial.size, unit_count: 1 };
      setPhotoIdentity(priceIdentity);
      void findPhotoPrices(priceIdentity);
    }
    const photoDismissed = (() => {
      try { return sessionStorage.getItem(`floor:receive-photo-dismissed:${storeId}:${current.upc}`) === '1'; }
      catch { return false; }
    })();
    if (!picking && (r?.receive?.photo || isTrueCatalogMiss(r) || identityNeeds.length > 0) && missPromptedFor.current !== current.id && !photoDismissed) {
      missPromptedFor.current = current.id;
      setPhotoNeed(r?.store_label ? storeLabelWarning()
        : identityNeeds.length ? `Need: ${identityNeeds.join(', ')}. Take a photo of the product label.`
          : 'No catalog match. Take a clear photo of the box or label.');
      setPhotoIdError('');
      setDialog('miss-photo');
    } else {
      setDialog(null);
    }
    setDupAck(Boolean(current.again));
    setDups(null);
    if (!current.again) setLast(null);
    setLoadedId(current.id);
    activeScan.current = current.id;
    const scanId = current.id;
    if (!r?.store_label && !r?.receive?.internal && m?.images?.[0]) void stageStockPhoto(String(m.images[0]), current.upc, scanId);
    if (!prewarmed && !r?.store_label && !isTrueCatalogMiss(r) && [initial.length, initial.width, initial.height, initial.weight,
      initial.productHeight, initial.productWidth, initial.productDepth, initial.productWeight].some(v => !v))
      void findPhotoDimensions(current.upc, scanId, {title:m?.title,brand:m?.brand,model:m?.model,size:initial.size});
    void findDups(upcVariants(current.upc, r)).then(d => { if (mounted.current && activeScan.current === scanId) setDups(d); });
    // Restore photos if the camera app killed the PWA mid-capture for this scan.
    void loadPendingPhotos(pendingPhotoKey(storeId, scanId)).then(restored => {
      if (!mounted.current || activeScan.current !== scanId || !restored.length) return;
      setFiles(restored);
    });
    setChannels([]);
    setDoNotList(false); setDns(false);
    void fillSuggestedCategory(scanId, {
      brand,
      model: specifics,
      title: initial.title,
      condition: initial.condition,
      upc: current.upc,
    });
    upcInput.current?.blur();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, current?.status, manual, loadedId]);

  /* Store categories arrive with receive options. Fill a matching one if the person has not typed a category. */
  useEffect(() => {
    const list = choices(options?.categories);
    if (!list.length || categoryTouched.current) return;
    const m = manual ? undefined : current?.result?.merged;
    if (!manual && !current) return;
    setForm(prev => {
      const accessory = isMattressAccessory(`${m?.category || ''} ${prev.title} ${prev.brand} ${prev.model}`);
      const already = list.some(name => name.toLowerCase() === prev.category.trim().toLowerCase());
      if (already && !(accessory && /^mattress(?:es)?$/i.test(prev.category.trim()))) return prev;
      let next = matchReceiveCategory(list, {
        category: m?.category || prev.category,
        title: [prev.title, ebayAspects.path].filter(Boolean).join(' '),
        brand: prev.brand,
        model: prev.model,
      });
      if (!next && ebayAspects.path) {
        const leaf = ebayAspects.path.split('>').pop()?.trim().toLowerCase() || '';
        next = list.find(name => name.toLowerCase() === leaf) || '';
      }
      return next !== prev.category ? { ...prev, category: next } : prev;
    });
  }, [options, loadedId, manual, current?.id, current?.status, ebayAspects.path]);

  /* Suggestions are displayed for reference; only the person receiving enters an ask price. */

  function toggleManual() {
    setError(''); setWarning('');
    if (!manual) {
      photoSessionKey.current = manualPhotoSession(storeId);
      setManual(true);
      return;
    }
    setManual(false);
    setLoadedId(null);
    resetEntry();
    photoSessionKey.current = manualPhotoSession(storeId, true);
  }

  /* ----- validation / completeness ----- */
  type Parsed = { ask: number | null; cost: number | null; dims: (number | null)[] };
  function parse(): Parsed | null {
    if (doNotList) {
      const dims = [form.length, form.width, form.height, form.weight].map(v => {
        const t = v.trim();
        if (!t) return null;
        const n = Number(t);
        return Number.isFinite(n) && n > 0 ? n : null;
      });
      return { ask: null, cost: null, dims: dims as (number | null)[] };
    }
    const ask = cents(form.ask);
    const cost = cents(form.cost);
    if (ask === undefined) { setError('Price must look like 24.99.'); return null; }
    if (cost === undefined) { setError('Cost must look like 9.00 (blank = unknown).'); return null; }
    const dims = [form.length, form.width, form.height, form.weight].map(v => {
      const t = v.trim();
      if (!t) return null;
      const n = Number(t);
      return Number.isFinite(n) && n > 0 ? n : null;
    });
    return { ask, cost, dims: dims as (number | null)[] };
  }
  function brandReady() {
    if (form.unbranded) return true;
    const value = form.brand.trim();
    if (!value) return false;
    return !/^(generic|unknown|n\/?a|does not apply)$/i.test(value);
  }
  function upcReady() {
    if (form.noUpc) return true;
    return Boolean((form.upc.trim() || current?.upc || '').trim());
  }
  function personPhotoReady() {
    return files.length > 0 || stagedPhotoPaths.length > 0;
  }
  function dimensionsReady() {
    return [form.length, form.width, form.height, form.weight].every(v => {
      const n = Number(String(v).trim());
      return Number.isFinite(n) && n > 0;
    });
  }
  const mediaWaived = doNotList || isDefectiveCondition(form.condition);
  function listingGaps(p: Parsed | null): ReceiveFieldKey[] {
    if (doNotList || doNotShip) return [];
    const out: ReceiveFieldKey[] = [];
    if (!pos(p?.ask ?? null)) out.push('price');
    if (!form.condition) out.push('condition');
    if (!brandReady()) out.push('brand');
    if (!ebayAspects.categoryId) out.push('ebay_category');
    else if (missingEbayAspects(ebayAspects.fields, ebayAspects.attributes, ebayAspects.na).length) out.push('ebay_aspects');
    if (upcRequired(channels) && !upcReady()) out.push('upc');
    else if (channels.includes('ebay') && !upcReady() && !form.noUpc) out.push('upc');
    return out;
  }
  /** Listing requirements only (price, condition, category, brand, UPC, weight+dims, item specifics, photo). */
  function missingFor(p: Parsed): string[] {
    const photo = personPhotoReady();
    const quantityOk = Number(form.quantity) >= 1;
    const hasDimensions = dimensionsReady();
    const hasLocation = Boolean(selectedLocation.trim());
    if (doNotList) {
      return receiveMissingFields({
        doNotList: true,
        brandReady: brandReady(),
        hasPhoto: photo,
        quantityOk,
        defective: mediaWaived,
        hasDimensions,
        hasLocation: true,
        titleOnly: staffMode,
        titleReady: form.title.trim().length > 0,
      });
    }
    const gaps = listingGaps(p);
    const out: string[] = [...gaps.map(g => (g === 'ebay_category' ? 'category' : g === 'ebay_aspects' ? 'item specifics' : g))];
    if (!form.category.trim() && !out.includes('store category')) out.push('store category');
    return receiveMissingFields({ doNotList: false, brandReady: brandReady(), otherGaps: out, hasPhoto: photo, quantityOk, defective: mediaWaived, hasDimensions, hasLocation });
  }
  const liveMissing = missingFor(parse() || { ask: null, cost: null, dims: [null, null, null, null] });
  const ebayCheck = ebayDetailsStatus({
    categoryId: ebayAspects.categoryId || '',
    fields: ebayAspects.fields,
    attributes: ebayAspects.attributes,
    conditionAllowed: Boolean(form.condition) && (ebayAspects.allowedGrades || []).some(grade => grade.grade === form.condition || (isDefectiveCondition(form.condition) && grade.grade === 'For parts')),
  });
  const formValid = liveMissing.length === 0 && (doNotList || channelMissing === 0);

  /* ----- finish ----- */
  async function finish(event?: React.FormEvent) {
    saveTappedAt.current = performance.now();
    event?.preventDefault();
    setError(''); setWarning(''); setSaved([]);
    if (!manual && !current) { setError('Scan a UPC first, or use Enter manually.'); return; }
    if (!manual && current?.result?.receive?.bucket === 'picker') { setError('Tap the variant on the box, or none of these.'); return; }
    if (!manual && current?.result?.receive?.bucket === 'search') { setError('Tap the manifest line that matches the box.'); return; }
    const brandError = notForSaleBrandError(doNotList, brandReady());
    if (brandError) { setError(brandError); return; }
    if (!doNotList && photoVerifyPending) { setError('Choose whether the photo or barcode product is correct before saving.'); setDialog('miss-photo'); return; }
    if (!doNotList && photoTitleConfirmed && !isCompleteReceiveTitle(form.title, form.brand)) {
      setError('Enter a descriptive product title with the item type and visible size, color, or material before saving.'); return;
    }
    if (!manual && current?.status === 'loading') { setError('Lookup still running…'); return; }
    const quantity = Number(form.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) { setError('Quantity must be 1–100.'); return; }
    let acceptedStockPhotoPath = doNotList ? '' : stockPhotoPath;
    if (!doNotList && !acceptedStockPhotoPath && !manual && merged?.images?.[0] && current?.upc) {
      acceptedStockPhotoPath = await stageStockPhoto(String(merged.images[0]), current.upc, current.id) || '';
    }
    if (photoBusy && files.length) { setError('Wait for the unit photo to finish uploading.'); return; }
    if (files.some(file => (file.type && !file.type.startsWith('image/')) || file.size > PHOTO_MAX_BYTES)) {
      setError('Photos must be images under 15 MB each.'); return;
    }
    if (files.some(f => f.size < PHOTO_MIN_BYTES)) { setError('One of the photos looks empty or too small. Retake it.'); return; }
    const parsed = parse();
    if (!parsed) return;
    const gaps = missingFor(parsed);
    if (gaps.length || (!doNotList && channelMissing > 0)) {
      setShowSaveValidation(true);
      const names = [...gaps, ...(!doNotList && channelMissing > 0 ? ['channel specifics'] : [])];
      setOpenSec(receiveSectionForGap(gaps[0] || 'item'));
      setError(`Still needed: ${names.join(', ')}.`);
      return;
    }
    if (!doNotList && !dupAck && dups && dups.count > 0) { setError('Tap Add another unit to confirm this is a new physical item.'); return; }
    if (doNotList) setWarning('Saving without listing — hidden from the website and marketplaces.');
    await receive(parsed, null, acceptedStockPhotoPath);
  }

  async function receive(parsed: Parsed, hold: { reason: string; note: string } | null, acceptedStockPhotoPath = stockPhotoPath) {
    setDialog(null);
    setBusy(true);
    setError('');
    const receiveStarted = performance.now();
    try {
      const quantity = Number(form.quantity);
      if (!mediaWaived && !files.length && !stagedPhotoPaths.length) throw new Error('Add a photo you took or chose before saving. A stock photo does not count.');
      if (files.length && !stagedPhotoPaths.length) throw new Error('The unit photo did not finish uploading. Retry the photo.');
      const unitPhotoPaths = [...(acceptedStockPhotoPath ? [acceptedStockPhotoPath] : []), ...stagedPhotoPaths];
      const holdLabel = hold ? (HOLD_REASONS.find(([k]) => k === hold.reason)?.[1] || hold.reason) : '';
      const notes = [
        isDefectiveCondition(form.condition) ? `Defective/non-sellable: ${form.conditionNote.trim()}` : '',
        hold ? `Not listing — ${holdLabel}${hold.note.trim() ? `: ${hold.note.trim()}` : ''}` : '',
        form.notes.trim(),
      ].filter(Boolean).join('\n');
      // Every lookup path (UPC, Floor catalog and AI photo identity) passes the
      // same conservative cleanup before persistence. Uncertain identities carry
      // a review flag rather than silently asserting a seller name as a brand.
      const staffDnl = staffMode && doNotList;
      const rawBrand = staffDnl || form.unbranded ? '' : form.brand.trim();
      const rawTitle = form.title.trim() || composeListingTitle(form.brand, form.model, form.unbranded);
      const productIdentity = cleanProductIdentity({ brand: rawBrand, model: form.model, title: rawTitle, description: form.description });
      const brandValue = form.unbranded ? 'Unbranded' : productIdentity.brand || 'No brand';
      const modelValue = productIdentity.model;
      const titleValue = staffDnl ? form.title.trim() : productIdentity.title;
      const fields = {
        p_quantity: quantity,
        p_brand: staffMode && doNotList ? '' : brandValue,
        p_model: modelValue,
        p_title: titleValue,
        p_category: form.category.trim() || null,
        p_description: form.description.trim() || null,
        p_condition: staffMode && doNotList ? SCRATCH : (form.condition || null),
        p_test_status: form.testStatus || null,
        p_ask_cents: hold || doNotList ? null : parsed.ask, // held and store-only units never get an ask
        p_cost_cents: staffMode || doNotList ? null : parsed.cost,
        p_notes: notes || null,
        p_upc: form.noUpc ? null : (form.upc.trim() || current?.upc || null),
        p_shippable: form.shippable || 'auto',
        p_length: parsed.dims[0],
        p_width: parsed.dims[1],
        p_height: parsed.dims[2],
        p_weight: parsed.dims[3],
      };
      const enrichment = buildReceiveEnrichment(parsed, hold, doNotList);
      if (productIdentity.review) {
        enrichment.specs.product_name_review = true;
        enrichment.specs.product_name_review_reasons = productIdentity.reasons;
      }
      enrichment.brand = brandValue; enrichment.model = modelValue; enrichment.title = titleValue;
      const data = await commitReceive(client, storeId, {
        p_request: receiveRequest.current, p_fields: fields, p_photos: unitPhotoPaths,
        p_extras: { location: selectedLocation || null, manifest: staffMode ? null : manifestId || null,
          dns: !staffMode && doNotShip, do_not_list: doNotList, defective: isDefectiveCondition(form.condition),
          channels: staffMode ? [] : channels, enrichment,
          stock_photo_paths: acceptedStockPhotoPath ? [acceptedStockPhotoPath] : [],
          ebay_category_id: doNotList ? null : ebayAspects.categoryId,
          ebay_attributes: doNotList ? {} : ebayAspects.attributes,
          ebay_condition_id: doNotList ? null : (ebayAspects.allowedGrades || []).find(grade => grade.grade === form.condition)?.conditionId || null,
          photo_identity_confirmed: photoTitleConfirmed,
          photo_identity_type: photoTitleConfirmed ? text(photoIdentity?.item_type) : '' },
      });
      const skus = data.skus as string[];
      if (ebayAspects.categoryId && skus[0] && !doNotList) {
        try {
          await client.rpc('portal_set_unit_ebay_category', { p_sku: skus[0], p_category_id: ebayAspects.categoryId });
          await fetch(floorFunctionUrl('ebay-specifics'), {
            method: 'POST',
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              store_id: storeId, sku: skus[0], action: 'category-selected',
              attributes: ebayAspects.attributes,
            }),
          });
        } catch (categoryError) {
          setWarning(`Item saved, but the eBay category did not stick: ${errText(categoryError)}`);
        }
      }
      if (acceptedStockPhotoPath && stockPhotoSourceUrl) {
        void attachStockPhotoSources(skus, String(form.upc || current?.upc || ''), acceptedStockPhotoPath,
          stockPhotoSourceUrl, stockPhotoUrls.filter(photo => photo.url !== stockPhotoSourceUrl).slice(0, 5));
      }
      console.info('receive_save_timing', { commit_roundtrip_ms: Math.round(performance.now()-receiveStarted),
        validation_ms: Math.round(receiveStarted-saveTappedAt.current), rpc_ms:data.client_rpc_ms, recovery_snapshot_ms:data.snapshot_ms,
        server_ms: data.server_ms, server_steps:data.server_steps, tap_to_commit_ms: Math.round(performance.now()-saveTappedAt.current), sku: skus[0] });
      try { sessionStorage.setItem('floor:last-receive-timing', JSON.stringify({ tappedAt: saveTappedAt.current, committedAt: performance.now(), server_ms: data.server_ms })); } catch { /* diagnostics cannot interrupt a saved item */ }
      receiveRequest.current = crypto.randomUUID();
      await clearPendingPhotos(pendingPhotoKey(storeId, photoSessionKey.current));
      if (!doNotList) void fetch(floorFunctionUrl('receive-finish'), { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` } }).catch(() => {});
      // Remember product data for "Add another unit".
      const seed: Partial<Form> = {
        brand: brandValue, unbranded: form.unbranded, noUpc: form.noUpc,
        model: modelValue, variant: form.variant, size: form.size,
        title: titleValue, category: form.category, description: form.description,
        ask: hold ? '' : form.ask, testStatus: '', shippable: form.shippable,
        length: form.length, width: form.width, height: form.height, weight: form.weight,
        productHeight: form.productHeight, productWidth: form.productWidth,
        productDepth: form.productDepth, productWeight: form.productWeight,
        upc: form.noUpc ? '' : (form.upc || current?.upc || ''),
      };
      if (hold) delete seed.ask;
      setLast({ upc: (form.upc || current?.upc || '').trim(), result, seed });

      if (manual) {
        askTouched.current = false;
        // Keep brand/condition for the next unit; title stays brand (+ empty model) until specifics are typed.
        setForm(prev => {
          const brand = prev.brand;
          const unbranded = prev.unbranded;
          return {
            ...blank,
            brand,
            unbranded,
            condition: prev.condition,
            testStatus: prev.testStatus,
            shippable: prev.shippable,
            title: composeListingTitle(brand, '', unbranded),
          };
        });
        setFiles([]); setStockPhotoPath(''); setStockPhotoError(''); setStagedPhotoPaths([]);
        setPhotoFill(null); setPhotoIdentity(null); setPhotoCandidate(null); setPhotoConflictText('');
        setPhotoTitleConfirmed(false); setPhotoVerifyPending(false); setPhotoIdError(''); setPhotoNeed('');
        setPhotoPrice(null); setPhotoPriceError(''); setPhotoPriceBusy(false); priceRequest.current++;
        setDups(null); setDupAck(false);
        photoSessionKey.current = manualPhotoSession(storeId, true);
        setChannels([]);
        setDoNotList(false); setDns(false);
      } else {
        const doneId = current?.id;
        setQueue(q => q.filter(s => s.id !== doneId));
        setLoadedId(null);
        resetEntry(undefined, false);
      }
      if (selectedLocation) {
        try { localStorage.setItem(`floor:last-receive-location:${storeId}`, selectedLocation); } catch { /* optional device preference */ }
      }
      setSaved(skus);
      onSaved();
      void loadOptions().catch(() => setWarning(w => `${w} Refresh Receive to see the next suggested SKU.`.trim()));
      focusUpc();
    } catch (e) { setError(errText(e)); }
    finally { setBusy(false); }
  }

  async function addToExistingStock(match: StockMatch) {
    const quantity = Number(form.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) { setError('Enter a valid quantity.'); return; }
    setBusy(true); setError('');
    try {
      const { data, error: e } = await client.rpc(match.is_stocked ? 'portal_stock_receive_add' : 'portal_stock_convert_and_add', { p_request: receiveRequest.current, p_sku: match.sku, p_quantity: quantity, p_location: selectedLocation || null });
      if (e) throw e;
      receiveRequest.current = crypto.randomUUID();
      setSaved([match.sku]); setSelectedStockMatch(null); setStockMatches([]); setLast(null);
      setForm(prev => ({ ...prev, quantity: '1' }));
      onSaved();
    } catch (e) { setError(errText(e)); }
    finally { setBusy(false); }
  }

  /** Build listing_specs from the lookup (only real values) and merge into each new unit. */
  function buildReceiveEnrichment(parsed: Parsed, hold: { reason: string; note: string } | null, forceHide: boolean) {
    const specs: Record<string, unknown> = {};
    const put = (k: string, v: unknown) => {
      if (v == null || v === '' || (Array.isArray(v) && !v.length)) return;
      specs[k] = v;
    };
    if (result && !manual) {
      const m = result.merged;
      put('asin', text(m?.asin));
      put('gtin', text(result.gtin?.gtin14));
      put('upc', text(result.gtin?.upcA) || current?.upc);
      put('msrp_cents', msrp);
      put('retail_cents', retail?.cents);
      put('retail_source', retail?.source);
      put('retail_as_of', retail?.asOf);
      put('features', (m?.features || []).map(f => f.trim()).filter(Boolean));
      if (m?.aspects && Object.keys(m.aspects).length) {
        const listingAspects = Object.fromEntries(Object.entries(m.aspects).filter(([key]) => !/^product_(height|width|depth|weight)_/i.test(key)));
        if (Object.keys(listingAspects).length) {
          put('amazon_aspects', listingAspects);
          put('ebay_aspects', listingAspects);
        }
      }
      const editedAspects = { ...(photoFill?.aspects || {}),
        ...(form.variant.trim() ? { Variant: form.variant.trim() } : {}),
        ...(form.size.trim() ? { Size: form.size.trim() } : {}) };
      const filledChannelAttrs = Object.fromEntries(Object.entries(channelAttrs.current).filter(([, v]) => v.trim()));
      if (Object.keys(filledChannelAttrs).length) put('channel_attributes', filledChannelAttrs);
      if (Object.keys(editedAspects).length) put('ebay_aspects', {
        ...Object.fromEntries(Object.entries(m?.aspects || {}).filter(([key]) => !/^product_(height|width|depth|weight)_/i.test(key))),
        ...editedAspects,
      });
      for (const [field, value] of [
        ['product_height_in', form.productHeight], ['product_width_in', form.productWidth],
        ['product_depth_in', form.productDepth], ['product_weight_lb', form.productWeight],
      ] as const) {
        const n = Number(value);
        if (value.trim() && Number.isFinite(n) && n > 0) put(field, n);
      }
      if (parsed.dims.some(pos)) put('package_source',
        [...new Set(['package_length_in','package_width_in','package_height_in','package_weight_lb']
          .map(key => dimensionSources[key]).filter(Boolean))].join(', ') || packageSource(parsed));
      if (channels.includes('ebay') && parsed.dims.some(value => !pos(value))) put('needs_box_size_for_ebay', true);
      if (form.costEstimate || parsed.cost == null) {
        put('cost_estimate', true);
        put('cost_source', floor.costLabel);
      }
      if (A?.price_pending) put('amazon_price_pending', true);
    } else if (manual && form.upc.trim() && !form.noUpc) {
      put('upc', form.upc.trim());
    }
    if (form.noUpc) {
      const existing = (specs.ebay_aspects && typeof specs.ebay_aspects === 'object')
        ? (specs.ebay_aspects as Record<string, unknown>)
        : {};
      put('ebay_aspects', { ...existing, UPC: UPC_NOT_APPLICABLE });
      put('upc', UPC_NOT_APPLICABLE);
    }
    if (doNotList) put('do_not_list', true);
    if (!staffMode && doNotShip) put('do_not_ship', true); // Server derives automatic appliance DNS for clerks.
    if (hold) { put('hold_reason', hold.reason); put('hold_note', hold.note.trim()); }
    const hide = Boolean(hold) || forceHide || doNotList;

    const patch = {
      specs, msrp: msrp, show: hide ? false : null,
      brand: form.unbranded ? 'Unbranded' : form.brand.trim(),
      model: form.model.trim(),
      title: form.title.trim() || composeListingTitle(form.brand, form.model, form.unbranded),
      description: form.description.trim(),
    };
    return patch;
  }

  function packageSource(parsed: Parsed): string {
    const m = merged?.package;
    const cov = result?.fieldCoverage?.package;
    if (!m || !cov) return 'manual';
    const keys: (keyof Pkg)[] = ['length_in', 'width_in', 'height_in', 'weight_lb'];
    const entered = parsed.dims;
    const matches = keys.every((k, i) => (m[k] == null ? entered[i] == null : Number(m[k]) === entered[i]));
    return matches ? cov : 'manual';
  }

  /** Duplicate banner button: this really is another physical unit. */
  function confirmDup() { setError(''); setDupAck(true); }

  /** Success-card button: keep the product data, new SKU; photo + condition must be entered again. */
  function addAnother() {
    if (!last) return;
    setError(''); setWarning('');
    const seed = last.seed;
    if (manual) {
      askTouched.current = true;
      setForm({ ...blank, ...seed });
      setFiles([]); setDupAck(true);
      void findDups(upcVariants((seed.upc || '').trim())).then(d => { if (mounted.current) setDups(d); });
      setLast(null);
      return;
    }
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setQueue(q => [{ id, upc: last.upc, status: 'ready', result: last.result, seed, again: true }, ...q]);
    setLoadedId(null);
    setLast(null);
  }

  function skipCurrent() {
    if (!current) return;
    const id = current.id;
    setQueue(q => q.filter(s => s.id !== id));
    setLoadedId(null);
    resetEntry();
    focusUpc();
  }

  async function ingestFiles(list: FileList | null) {
    if (!list || !list.length) return;
    // Snapshot the list before any await — FileList is live and clears with the input.
    const raw = Array.from(list);
    setPhotoBusy(true);
    setError('');
    try {
      const copied: File[] = [];
      let rejected = 0;
      for (const file of raw) {
        const next = await copyImageFile(file);
        if (next) copied.push(next);
        else rejected++;
      }
      if (!copied.length) {
        setError(rejected
          ? 'Camera photo could not be saved. Try Take photo again, or use Choose photos.'
          : 'No photo was returned. Try Take photo again.');
        return;
      }
      const request = receiveRequest.current;
      const upload = stageUnitPhotos(copied);
      setFiles(prev => {
        const next = [...prev, ...copied];
        void savePendingPhotos(pendingPhotoKey(storeId, photoSessionKey.current), next);
        return next;
      });
      const staged = await upload;
      if (receiveRequest.current === request) setStagedPhotoPaths(prev => [...prev, ...staged]);
      if (rejected) setWarning(`${rejected} photo(s) looked empty or too large and were skipped.`);
      if (!manual && current && photoCheckedFor.current !== current.id) {
        photoCheckedFor.current = current.id;
        setPhotoVerifyPending(true);
        setPhotoNeed('Checking the barcode against your actual-unit photo.');
        setDialog('miss-photo');
        void identifyMissPhoto(copied[0], true);
      }
    } catch (e) {
      setError(`Photo upload failed. Your photo is kept on this device. Retry the photo upload. ${errText(e)}`);
    } finally {
      setPhotoBusy(false);
    }
  }

  async function findPhotoPrices(identity: Record<string, unknown>) {
    const request = ++priceRequest.current;
    const started = performance.now();
    setPhotoPriceBusy(true);
    setPhotoPriceError('');
    try {
      const failures: string[] = [];
      for (const source of ['upcitemdb', 'ebay', 'gemini']) {
        if (request !== priceRequest.current) return;
        try {
          const response = await fetch(floorFunctionUrl('receive-photo-identify'), {
            method: 'POST',
            headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'prices', source, identity: { ...identity, upc: current?.upc || '' } }),
            signal: AbortSignal.timeout(source === 'gemini' ? 45000 : 15000),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.message || `${source} unavailable`);
          if (request !== priceRequest.current) return;
          if (data.price?.count) {
            setPhotoPrice(data.price as PhotoPriceInfo);
            console.info('receive_price_timing', { source, price_ms: Math.round(performance.now() - started), listings: data.price.count });
            return;
          }
        } catch {
          failures.push(source);
        }
      }
      if (request !== priceRequest.current) return;
      setPhotoPrice(null);
      if (failures.length) setPhotoPriceError(`Price search incomplete (${failures.join(', ')} unavailable). Retry prices.`);
    } catch (e) {
      if (request === priceRequest.current) {
        setPhotoPrice(null);
        setPhotoPriceError(`${errText(e)} You can enter your price by hand or retry prices.`);
      }
    } finally {
      if (request === priceRequest.current) setPhotoPriceBusy(false);
    }
  }

  async function findPhotoDimensions(upc: string, scanId: string, identity?: Record<string, unknown>) {
    setDimensionsBusy(true);
    setDimensionsError('');
    const started = performance.now();
    const resolved = new Set<string>();
    const notices: string[] = [];
    const map = { product_height_in: 'productHeight', product_width_in: 'productWidth',
      product_depth_in: 'productDepth', product_weight_lb: 'productWeight',
      package_length_in: 'length', package_width_in: 'width',
      package_height_in: 'height', package_weight_lb: 'weight' } as const;
    try {
      for (const source of ['amazon', 'upcitemdb']) {
        if (activeScan.current !== scanId) return;
        try {
          const response = await fetch(floorFunctionUrl('receive-photo-identify'), {
            method: 'POST',
            headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'dimensions', source, upc, identity }),
            signal: AbortSignal.timeout(15000),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.message || `${source} dimensions unavailable`);
          if (activeScan.current !== scanId) return;
          notices.push(...(data.dimensions?.warnings || []));
          const values = (data.dimensions?.values || {}) as Record<string, number | null>;
          const sources = (data.dimensions?.sources || {}) as Record<string, string>;
          const eligible = Object.entries(map).filter(([field]) => !resolved.has(field));
          setForm(prev => {
            const next = { ...prev };
            for (const [field, formKey] of eligible as [keyof typeof map, typeof map[keyof typeof map]][]) {
              if (dimensionTouched.current.has(formKey)) continue;
              if (values[field] != null && !Number(next[formKey].trim())) next[formKey] = String(values[field]);
            }
            return next;
          });
          const acceptedSources = Object.fromEntries(eligible.filter(([field]) => sources[field]).map(([field]) => [field, sources[field]]));
          setDimensionSources(prev => ({...prev, ...acceptedSources, ...Object.fromEntries(Object.entries(prev)
            .filter(([, value]) => value === 'staff' || value.includes('staff reviewed')))}));
          for (const [field] of eligible) if (values[field] != null) resolved.add(field);
          console.info('receive_dimensions_timing', { source, dims_ms: Math.round(performance.now() - started), fields: resolved.size });
          if (resolved.size === Object.keys(map).length) break;
        } catch (error) { notices.push(errText(error)); }
      }
      if (activeScan.current === scanId && resolved.size === 0) setDimensionsError('No size found. Measure on mat.');
    } finally {
      if (activeScan.current === scanId) setDimensionsBusy(false);
    }
  }

  /** Verify barcode identity against the actual unit photo. */
  async function identifyMissPhoto(raw: File | null, alreadyStaged = false) {
    if (!current) return;
    const identifyRequest = ++photoIdentifyRequest.current;
    if (!raw) {
      setPhotoIdError('Camera returned no photo. Try again, or choose a photo from your phone.');
      return;
    }
    setPhotoIdBusy(true);
    const photoStarted = performance.now();
    setPhotoIdStatus('Identifying product…');
    setPhotoIdError('');
    setPhotoPrice(null);
    setPhotoPriceError('');
    if (!alreadyStaged) setFiles([raw]);
    const file = await copyImageFile(raw);
    if (identifyRequest !== photoIdentifyRequest.current) return;
    if (!file) {
      setPhotoIdError('Could not read that photo. Try one clear picture of the box or label.');
      setPhotoIdBusy(false);
      return;
    }
    setError('');
    try {
      if (!alreadyStaged) setFiles([file]);
      if (!alreadyStaged) void savePendingPhotos(pendingPhotoKey(storeId, photoSessionKey.current), [file]);
      if (!alreadyStaged) {
        const staged = await stageUnitPhotos([file]);
        if (identifyRequest !== photoIdentifyRequest.current) return;
        setStagedPhotoPaths(staged);
      }
      const upload = await identificationJpeg(file);
      const compressedMs = performance.now() - photoStarted;
      const image_base64 = await fileToBase64(upload);
      const photoResponse = await postIdentifyPhoto(accessToken, {
          action: 'identify_only',
          upc: current.upc,
          miss_id: current.result?.miss_id || null,
          image_base64,
          mime_type: upload.type || 'image/jpeg',
      });
      if (identifyRequest !== photoIdentifyRequest.current) return;
      const json = photoResponse.data;
      if (photoResponse.status < 200 || photoResponse.status >= 300) {
        setPhotoIdError(json.message || json.error || 'Photo identify failed. Retry or fill fields by hand.');
        setWarning(catalogMissMessage(current.result) || '');
        return;
      }
      const brand = text(json.fill?.brand || json.identity?.brand);
      const model = text(json.fill?.model || json.identity?.model);
      const identity = (json.identity || {}) as Record<string, unknown>;
      const title = text(json.fill?.title) || composeListingTitle(brand, model, false);
    if (identity.title_complete === false || !isCompleteReceiveTitle(title, brand)) {
      setPhotoIdError('Photo identification returned only a partial title. Enter the item type and visible details before saving.');
      setWarning('A short AI title cannot be saved. Add the item type and key size, color, or pattern.');
        return;
      }
      const barcode = current.result?.merged;
      const barcodeBrand = text(barcode?.brand);
      const barcodeTitle = text(barcode?.title);
      const conflict = Boolean(!current.result?.store_label && barcodeBrand && brand
        && barcodeBrand.toLocaleLowerCase() !== brand.toLocaleLowerCase());
      setPhotoConflictText(conflict
        ? `Photo shows ${title}, but the barcode says ${barcodeTitle || `${barcodeBrand} product`}. Which is it?`
        : current.result?.store_label
          ? `Photo identifies ${title}. Confirm this is the right product for the store sticker.`
          : `Photo identifies ${title}. Confirm the product details before saving.`);
      setPhotoCandidate({ ...identity, brand, model, title,
        category: text(json.fill?.category || identity.category),
        description: text(json.fill?.description || identity.description),
        aspects: json.fill?.aspects || {},
      });
      setPhotoIdStatus(title || 'Product found');
      setPhotoFill({ aspects: json.fill?.aspects || {} });
      setPhotoIdentity(identity);
      if (brand) void findPhotoPrices(identity);
      else { setPhotoPrice(null); setPhotoPriceBusy(false); setPhotoPriceError('No brand was visible; set the selling price from the item itself.'); }
      photoCheckedFor.current = current.id;
      setDialog('miss-photo');
      console.info('receive_photo_timing', { compressed_ms: Math.round(compressedMs), upload_ms: Math.round(photoResponse.uploadMs),
        photo_bytes: upload.size, photo_to_filled_ms: Math.round(performance.now() - photoStarted),
        identify_server_ms: json.timing?.identify_ms || null, request_ms: Math.round(photoResponse.requestMs) });
    } catch (e) {
      setPhotoIdError(errText(e) || 'Photo identify failed. Retry or fill fields by hand.');
    } finally {
      if (identifyRequest === photoIdentifyRequest.current) {
        setPhotoIdBusy(false);
        setPhotoIdStatus('');
      }
    }
  }

  async function choosePhotoIdentity(usePhoto: boolean, chooseUnbranded = false) {
    if (!usePhoto) {
      suppressPhotoPrompt();
      setPhotoCandidate(null);
      setPhotoConflictText('');
      setPhotoVerifyPending(false);
      setDialog(null);
      setWarning('Kept the barcode product details.');
      return;
    }
    if (!current || !photoCandidate) return;
    suppressPhotoPrompt(current.upc);
    const unbranded = chooseUnbranded || !text(photoCandidate.brand);
    setPhotoIdBusy(true);
    setPhotoIdError('');
    setPhotoIdStatus(unbranded ? 'Using unbranded product details…' : 'Saving confirmed barcode match…');
    try {
      let product: Record<string, unknown> = {};
      const brand = unbranded ? '' : text(photoCandidate.brand);
      if (!unbranded) {
        const response = await fetch(floorFunctionUrl('receive-photo-identify'), {
          method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'confirm_identity', upc: current.upc, fields: photoCandidate }),
          signal: AbortSignal.timeout(25000),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) throw new Error(data.message || 'Could not save the confirmed product match.');
        product = data.product || {};
      }
      const title = text(photoCandidate.title);
      const model = text(photoCandidate.model);
      const dimFields = ['length','width','height','weight','productHeight','productWidth','productDepth','productWeight'] as const;
      setForm(prev => {
        const next = { ...prev, brand, unbranded, model,
        variant: text(photoCandidate.variant) || prev.variant, size: text(photoCandidate.size) || prev.size,
        category: categoryTouched.current ? prev.category : (matchReceiveCategory(choices(options?.categories), {
          category: text(photoCandidate.category), title, brand, model,
        }) || prev.category),
        description: text(photoCandidate.description) || prev.description, title };
        for (const key of dimFields) if (!dimensionTouched.current.has(key)) next[key] = '';
        return next;
      });
      setDimensionSources(prev => Object.fromEntries(Object.entries(prev).filter(([, value]) => /staff/i.test(value))));
      setPhotoTitleConfirmed(!unbranded);
      setPhotoVerifyPending(false);
      setStockPhotoPath('');
      if (Array.isArray(product.images) && product.images[0]) {
        const productPhotos = Array.isArray(product.stock_photos) ? product.stock_photos as { url: string; source: string }[]
          : product.images.map((url: string) => ({ url, source: 'amazon' }));
        setStockPhotoUrls(productPhotos.slice(0, 6));
        const staged = await stageStockPhoto(String(product.images[0]), current.upc, current.id);
        if (!staged) setWarning('Product confirmed and saved to the UPC catalog, but its matching stock photo could not be saved. Your actual photo will be used.');
        else setWarning('Product confirmed. Its matching stock photo will be photo #1, followed by your unit photo.');
      } else setWarning(unbranded
        ? 'Using the descriptive unbranded photo details. Your actual unit photo will be used.'
        : 'Product confirmed and saved to the UPC catalog. No matching stock photo was found; your unit photo will be used.');
      setPhotoCandidate(null);
      setPhotoConflictText('');
      setDialog(null);
      setPhotoIdentity({ ...photoCandidate, asin: product.asin || null, upc: current.upc });
      void findPhotoDimensions(current.upc, current.id, photoCandidate);
    } catch (error) {
      setPhotoIdError(errText(error) || 'Could not save the confirmed product match.');
    } finally {
      setPhotoIdBusy(false);
      setPhotoIdStatus('');
    }
  }

  function dismissPhotoCheck() {
    photoIdentifyRequest.current++;
    suppressPhotoPrompt();
    if (photoVerifyPending) setPhotoTitleConfirmed(false);
    setPhotoVerifyPending(false);
    setPhotoCandidate(null);
    setPhotoConflictText('');
    setPhotoIdBusy(false);
    setPhotoIdStatus('');
    setDialog(null);
    setWarning('Photo help closed. You can enter details yourself or reopen photo help from this scan.');
  }

  // Manual entry: restore any stashed photos after a camera-app kill.
  useEffect(() => {
    if (!manual) return;
    const sessionKey = manualPhotoSession(storeId);
    photoSessionKey.current = sessionKey;
    let alive = true;
    void loadPendingPhotos(pendingPhotoKey(storeId, sessionKey)).then(restored => {
      if (!alive || photoSessionKey.current !== sessionKey || !restored.length) return;
      setFiles(prev => (prev.length ? prev : restored));
    });
    return () => { alive = false; };
  }, [manual, storeId]);

  const showForm = manual || (current && current.status !== 'loading' && loadedId === current.id);
  useEffect(() => {
    if (!showForm) return;
    const first = liveMissing[0];
    setOpenSec(first ? receiveSectionForGap(first) : 'photos');
    if (!manual) requestAnimationFrame(() => upcInput.current?.focus());
  }, [showForm, manual, current?.id]);
  const unifiedV2 = true;
  const waiting = queue.length - (current ? 1 : 0);
  const hasFiles = files.length > 0;
  const needNoteForScratch = !doNotList && isDefectiveCondition(form.condition);
  const needsEbayBox = channels.includes('ebay') && [form.length,form.width,form.height,form.weight].some(value => !pos(Number(value.trim())));
  const holdReady = reason !== 'other' || reasonNote.trim().length > 0;
  const catalogMiss = !manual && current?.status === 'ready' ? catalogMissMessage(result) : null;
  const trueMiss = !manual && current?.status === 'ready' && isTrueCatalogMiss(result);

  const hasCatalogPhoto = Boolean(!manual && merged?.images?.[0]);
  const hasAnyPhoto = Boolean(files.length || stagedPhotoPaths.length || stockPhotoPath || hasCatalogPhoto);
  const invalid = (key: ReceiveFieldKey) => showSaveValidation && liveMissing.includes(
    key === 'ebay_category' ? 'category' : key === 'ebay_aspects' ? 'item specifics' : key === 'upc' ? 'UPC' : key,
  );
  return <section className={`panel receive-panel receive-v2${appChrome ? ' receive-app' : ''}`}>
    {(appChrome || storePhoneMode) && <button type="button" className="receive-keyboard-trigger" onClick={() => setTypingOpen(open => !open)} aria-expanded={typingOpen}>
      {typingOpen ? 'Hide Floor keyboard' : '⌨ Floor keyboard'}
    </button>}
    {typingOpen && <div className="receive-typing-pad" role="group" aria-label="Floor typing pad">
      <div className="receive-typing-row">{'1234567890'.split('').map(key => <button type="button" key={key} onPointerDown={e => e.preventDefault()} onClick={() => typeReceiveKey(key)}>{key}</button>)}</div>
      <div className="receive-typing-row">{'qwertyuiop'.split('').map(key => <button type="button" key={key} onPointerDown={e => e.preventDefault()} onClick={() => { typeReceiveKey(typingShift ? key.toUpperCase() : key); setTypingShift(false); }}>{typingShift ? key.toUpperCase() : key}</button>)}</div>
      <div className="receive-typing-row">{'asdfghjkl'.split('').map(key => <button type="button" key={key} onPointerDown={e => e.preventDefault()} onClick={() => { typeReceiveKey(typingShift ? key.toUpperCase() : key); setTypingShift(false); }}>{typingShift ? key.toUpperCase() : key}</button>)}</div>
      <div className="receive-typing-row"><button type="button" onPointerDown={e => e.preventDefault()} onClick={() => setTypingShift(value => !value)}>⇧</button>{'zxcvbnm'.split('').map(key => <button type="button" key={key} onPointerDown={e => e.preventDefault()} onClick={() => { typeReceiveKey(typingShift ? key.toUpperCase() : key); setTypingShift(false); }}>{typingShift ? key.toUpperCase() : key}</button>)}<button type="button" onPointerDown={e => e.preventDefault()} onClick={() => typeReceiveKey('BACKSPACE')}>⌫</button></div>
      <div className="receive-typing-row">{[',', '.', '&', '/'].map(key => <button type="button" key={key} onPointerDown={e => e.preventDefault()} onClick={() => typeReceiveKey(key)}>{key}</button>)}<button type="button" className="receive-typing-space" onPointerDown={e => e.preventDefault()} onClick={() => typeReceiveKey('SPACE')}>Space</button><button type="button" onPointerDown={e => e.preventDefault()} onClick={() => { setTypingOpen(false); requestAnimationFrame(() => { upcInput.current?.focus(); }); }}>Done · scan</button></div>
    </div>}
    {appChrome && (
      <div className="app-nav receive-app-nav">
        <button type="button" onClick={() => { onAppCancel?.(); }}>Cancel</button>
        <div className="app-nav-title">Receive<small>Unit {options?.next_sku || '…'} · {manual ? 'manual' : 'scanned'}</small></div>
        <button type="button" className={formValid ? '' : 'is-dim'} disabled={busy || !formValid} onClick={() => {
          const formEl = document.getElementById('receive-app-form') as HTMLFormElement | null;
          formEl?.requestSubmit();
        }}>Save</button>
      </div>
    )}
    <div className="receive-next">
      <div className="receive-sku-block">
        <div><div className="eyebrow">NEXT AVAILABLE SKU</div><strong>{options?.next_sku || 'Loading…'}</strong></div>
        {!manual && !showForm && <label className="receive-upc">Scan UPC
          <input
            ref={upcInput}
            value={draft || (!manual && showForm && current?.upc) || ''}
            onFocus={e => { typingTarget.current = e.currentTarget; }}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); enqueue(draft); } }}
            onBlur={() => {
              // Do not steal focus while the unit form is open (scroll would re-open the keyboard).
              if (formOpen || manual || modalOpen.current) return;
              setTimeout(() => {
                if (modalOpen.current || formOpen || document.visibilityState !== 'visible') return;
                if (!document.activeElement || document.activeElement === document.body) upcInput.current?.focus();
              }, 0);
            }}
            autoFocus={!formOpen}
            inputMode={scannerInputMode()}
            autoComplete="off"
            enterKeyHint="done"
            placeholder={isKioskShell() ? 'Scan barcode' : 'Scan barcode or item #'}
            disabled={!accessToken || formOpen}
          />
        </label>}
        {!manual && !formOpen && <div className="actions">
          <button type="button" disabled={!draft.trim()} onClick={() => enqueue(draft)}>Look up</button>
          <button type="button" className="secondary" onClick={openBarcodeCamera}>Camera</button>
          <input ref={cameraFile} type="file" accept="image/*" capture="environment" className="sr-only" aria-label="Photo of barcode" onChange={e => {
            const f = e.target.files?.[0]; e.target.value = '';
            if (f) void decodeFile(f).then(code => { if (code) enqueue(code); else { setError('This browser cannot read barcodes from photos. Type the digits under the barcode instead.'); focusUpc(); } });
          }} />
        </div>}
        {(!formOpen || manual) && <ManifestSearchBox client={client} onPick={pickManifestLine} disabled={busy} />}
      </div>
      {!appChrome && (
        <div>
          <p>{staffMode && doNotList ? 'DNL: condition is defective. Only a title is required.' : doNotList ? 'Store-only: brand is required; all other fields and the photo are optional.' : manual ? 'Manual entry: fill listing fields, add a photo, then receive.' : 'Scan a UPC, edit the listing fields, add a photo, then receive.'}</p>
          <button type="button" className="text-button" onClick={toggleManual}>{manual ? '← Back to scan' : 'Enter manually'}</button>
        </div>
      )}
    </div>

    {saved.length > 0 && <EbaySpecificsPanel key={saved[0]} client={client} sku={saved[0]} storeId={storeId} appMode={Boolean(appChrome)} />}
    {saved.length > 0 && !staffMode && <details className="receive-category-details" open><summary>Categories for received items</summary>
      <CategoryPanel client={client} storeId={storeId} initialSku={saved[0]} onSaved={onSaved} />
    </details>}

    {!manual && queue.length > 0 && !showForm && <p className="hint" role="status">
      {current?.status === 'loading' ? `Looking up ${current.upc}…` : current ? `Working on ${current.upc}` : ''}
      {waiting > 0 ? ` · ${waiting} more scan${waiting === 1 ? '' : 's'} queued` : ''}
    </p>}

    {saved.length > 0 && <div className="receive-success">
      <strong>Received {saved.length === 1 ? 'SKU' : 'SKUs'}: {saved.join(', ')}</strong>
      <p>Write {saved.length === 1 ? 'this number' : 'these numbers'} on the unit{saved.length === 1 ? '' : 's'}. Ready for the next scan.</p>
      {last && <button type="button" className="secondary" onClick={addAnother}>Add another unit</button>}
    </div>}
    <ReceiveWorkStatus client={client} accessToken={accessToken} />
    {warning && <p className="hint">{warning}</p>}
    {error && <div className="alert" role="alert">{error}<button type="button" onClick={() => setError('')}>Dismiss</button></div>}

    {!appChrome && !manual && !current && <div className="empty">Scan a UPC to start. Rapid scans are queued.</div>}
    {!manual && current?.status === 'loading' && <div className="empty">Looking up {current.upc}…</div>}

    {showForm && <form id={appChrome ? 'receive-app-form' : undefined} onSubmit={e => void finish(e)}>
      {result?.receive?.bucket === 'picker' && <div className="receive-picker" role="listbox" aria-label="Which variant is on the box">
        <p><strong>Which one is on the box?</strong></p>
        {(result.receive.candidates || []).map(candidate => {
          const detail = [candidate.color, candidate.size].filter(Boolean).join(' · ');
          return <button type="button" key={candidate.title} className="receive-picker-row" disabled={pickerBusy} onClick={() => void chooseVariant(candidate.title)}>
            {candidate.photo ? <img src={candidate.photo} alt="" /> : null}
            <span><strong>{candidate.title}</strong>{detail ? <small>{detail}</small> : null}</span>
          </button>;
        })}
        <button type="button" className="receive-picker-none" disabled={pickerBusy} onClick={noneOfThese}>{pickerBusy ? 'Saving that one…' : 'None of these'}</button>
      </div>}
      {result?.receive?.bucket === 'search' && <div className="receive-picker" role="listbox" aria-label="Manifest matches">
        <p><strong>Which manifest line?</strong></p>
        {(result.receive.matches || []).map(match => <button type="button" key={`${match.item_number}-${match.code}`} className="receive-picker-row" onClick={() => replaceScan(match.code || match.item_number)}>
          <span><strong>{[match.brand, match.title].filter(Boolean).join(' ')}</strong><small>#{match.item_number}</small></span>
        </button>)}
      </div>}
      {result?.receive?.conflict && <div className="receive-v2-banner" role="alert">
        <strong>{result.receive.conflict.note}</strong>
        <label>{result.receive.conflict.field}
          <input value={boxCheck} onChange={e => setBoxCheck(e.target.value)} onBlur={() => void saveBoxCheck(result.receive?.conflict?.field || '', boxCheck)} />
        </label>
      </div>}
      {!unifiedV2 && <ReceiveQuantity value={form.quantity} onChange={value=>update('quantity',value)} disabled={busy} />}
      {stockMatches.length > 0 && <div className="receive-dup" role="status"><strong>Matching inventory</strong>{stockMatches.map(match => <p key={match.sku}>{match.title} · SKU {match.sku} · {match.quantity} on hand · {match.condition || 'condition unset'}{match.is_stocked
        ? <> <button type="button" disabled={busy} onClick={() => setSelectedStockMatch(match)}>{selectedStockMatch?.sku === match.sku ? 'Selected' : 'Add to this SKU'}</button></>
        : match.can_convert && !staffMode ? <> <button type="button" disabled={busy} onClick={() => setSelectedStockMatch(match)}>Convert to stocked SKU and add</button></>
          : <> <button type="button" disabled={busy} onClick={() => setSelectedStockMatch(match)}>Different item, new SKU</button></>}</p>)}
        {selectedStockMatch && <div><p>SKU {selectedStockMatch.sku} goes to {selectedStockMatch.quantity + Number(form.quantity || 0)} on hand.</p><button type="button" disabled={busy} onClick={() => void addToExistingStock(selectedStockMatch)}>Add {Number(form.quantity || 0)} to SKU {selectedStockMatch.sku}</button><button type="button" className="secondary" onClick={() => setSelectedStockMatch(null)}>Different item, new SKU</button></div>}
        <small>Matches require the same UPC (or exact no-UPC title), price and condition.</small></div>}
      {dups && dups.count > 0 && <div className="receive-dup" role="status">
        <strong>You have {dups.count} of these</strong>{dups.skus.length ? <> (SKU {dups.skus.slice(0, 8).join(', ')}{dups.skus.length > 8 ? '…' : ''})</> : null}
        {!dupAck ? <> <button type="button" className="secondary" onClick={confirmDup}>Add another unit</button></> : <span className="tag on">confirmed — new unit</span>}
        <p>Check the exact UPC, price and condition above. Matching items can be added to the existing stocked SKU; confirm only if this is a different item.</p>
      </div>}

      {!manual && current?.status === 'error' && <div className="alert" role="alert">
        <span>Lookup failed: {current.error}. Fill the fields by hand, or retry.</span>
        <button type="button" onClick={() => retry(current)}>Retry</button>
      </div>}

      {catalogMiss && current && !unifiedV2 && <div className="alert" role="alert">
        <span>{catalogMiss}</span>
        {trueMiss && (
          <button type="button" disabled={photoIdBusy} onClick={() => {
            try { if (current) sessionStorage.removeItem(`floor:receive-photo-dismissed:${storeId}:${current.upc}`); } catch { /* manual reopen still works */ }
            setDialog('miss-photo');
          }}>
            Scan with camera
          </button>
        )}
        <button type="button" onClick={() => retry(current)}>Retry lookup</button>
      </div>}
      {photoIdBusy && <p className="hint" role="status">{photoIdStatus || 'Identifying from photo…'}</p>}

      {!manual && merged?.never_list_reason && <p className="hint">Amazon will not list this: {merged.never_list_reason}</p>}

      {!unifiedV2 && !storePhoneMode && <div className="receive-channel-card">
        {!staffMode && <ChannelPicker value={channels} onChange={setChannels} disabled={doNotList || doNotShip} upc={form.noUpc ? '' : (form.upc || current?.upc || '')} />}
        {!staffMode && <label className="mboard-inline"><input type="checkbox" checked={doNotShip} disabled={dnsRequired} onChange={e => { setDns(e.target.checked); if (e.target.checked) setChannels([]); }} /> DNS — Do not ship</label>}
        <label className="mboard-inline"><input type="checkbox" checked={doNotList} onChange={e => { setDoNotList(e.target.checked); if (e.target.checked) setChannels([]); }} /> Do not list for sale</label>
        {doNotShip && <small>Store / website pickup only. No marketplace listings.</small>}
      </div>}
      {!unifiedV2 && !manual && <div className="receive-confirm">
        <div className="receive-found-bar"><strong>✓ Found</strong><code>UPC {current?.upc}</code>
          <button type="button" className="text-button" disabled={photoBusy} onClick={() => current && retry(current)}>Rescan</button>
        </div>
        <div className={`receive-photo-first${storePhoneMode && stockPhotoPath ? ' has-stock-photo' : ''}`}>
          <input ref={confirmPhotoFile} type="file" accept="image/*" capture="environment" className="sr-only" aria-hidden tabIndex={-1}
            onChange={e => { const input=e.currentTarget; void ingestFiles(input.files).finally(() => {input.value='';}); }} />
          {storePhoneMode ? <>
            <div className={`receive-stock-photo${stockPhotoPath ? ' stock-photo-ready' : ''}`}>
              {merged?.images?.[0] ? <img src={merged.images[0]} alt="Catalog stock photo" /> : <div aria-hidden="true">▯</div>}
              <span>{stockPhotoBusy ? 'Saving stock photo…' : stockPhotoPath ? '✓ Stock photo · ready' : merged?.images?.[0] ? stockPhotoError ? 'Stock photo · tap save to retry' : 'Stock photo available' : 'Stock photo unavailable'}</span>
            </div>
            <button type="button" className={`receive-unit-photo-tile${files.length ? ' has-photo' : ''}`} disabled={photoBusy || busy} onClick={() => confirmPhotoFile.current?.click()}>
              {previews[0] ? <img src={previews[0]} alt="Actual unit photo" /> : <><strong>📷 Add photo</strong><span>{doNotList ? 'optional for store-only' : stockPhotoPath ? 'optional' : merged?.images?.[0] ? 'stock photo can save this unit' : 'required to save'}</span></>}
              {photoBusy && <span>Uploading…</span>}
            </button>
          </> : <>
            <button type="button" className={`receive-unit-photo-tile${files.length ? ' has-photo' : ''}`} disabled={photoBusy || busy} onClick={() => confirmPhotoFile.current?.click()}>
              {previews[0] ? <img src={previews[0]} alt="Actual unit photo" /> : <><strong>📷 Take photo</strong><span>{doNotList ? 'Optional for store-only' : stockPhotoPath ? 'Stock photo can save this unit' : 'Required to save'}</span></>}
              {photoBusy && <span>Uploading…</span>}
            </button>
            <div className="receive-stock-photo">{merged?.images?.[0] ? <img src={merged.images[0]} alt="Catalog stock photo, not the unit" /> : <div aria-hidden="true">▯</div>}<span>Stock photo</span></div>
          </>}
        </div>
        {stockPhotoError && <small className="receive-confirm-note" role="status">{stockPhotoError}</small>}
        <label className="receive-title-field">Item title
          <textarea ref={titleField} rows={2} value={form.title} onFocus={e => { typingTarget.current = e.currentTarget; }} onChange={e => update('title', e.target.value)} />
        </label>
        <div className="receive-confirm-fields">
          <label>Brand<input value={form.unbranded ? 'Unbranded' : form.brand} disabled={form.unbranded} onFocus={e => { typingTarget.current = e.currentTarget; }} onChange={e => update('brand', e.target.value)} />
            <button type="button" className="text-button" onClick={chooseNoBrand}>No brand</button></label>
          <label>Model<input value={form.model} onFocus={e => { typingTarget.current = e.currentTarget; }} onChange={e => update('model', e.target.value)} /></label>
          <label>Variant<input value={form.variant} onFocus={e => { typingTarget.current = e.currentTarget; }} onChange={e => update('variant', e.target.value)} placeholder="Scent, color…" /></label>
          <label>Size<input value={form.size} onFocus={e => { typingTarget.current = e.currentTarget; }} onChange={e => update('size', e.target.value)} placeholder="Size or measurements" /></label>
          <CategoryField
            label="Floor category"
            value={form.category}
            options={choices(options?.categories)}
            hint="Online store categories are set after saving. Floor fills a suggested eBay category when it finds a match; otherwise search the channel categories below."
            onChange={v => update('category', v)}
            onFocus={e => { typingTarget.current = e.currentTarget; }}
          />
          <div className="receive-condition-field"><span>Condition</span><div className="receive-chip-row" role="radiogroup" aria-label="Condition">
            {CONDITIONS.map(([value, label]) => <label className={`receive-chip${form.condition === value ? ' on' : ''}`} key={value}>
              <input type="radio" name="receive-condition-main" checked={form.condition === value} onChange={() => update('condition', value)} />{label}
            </label>)}
          </div></div>
        </div>
        {isDefectiveCondition(form.condition) && <label className="receive-confirm-full">Defect note<input value={form.conditionNote} onFocus={e => { typingTarget.current = e.currentTarget; }} onChange={e => update('conditionNote', e.target.value)} /></label>}
        {!storePhoneMode && <details className="receive-confirm-details"><summary>Description {form.description ? '· filled' : '· empty'}</summary>
          <textarea rows={3} value={form.description} onChange={e => update('description', e.target.value)} /></details>}
        {!storePhoneMode && <details className="receive-confirm-details"><summary>Product · {[form.productHeight, form.productWidth, form.productDepth].every(Boolean)
          ? `${form.productDepth} × ${form.productWidth} × ${form.productHeight} in (L × W × H)` : 'Add dimensions'}{form.productWeight ? ` · ${form.productWeight} lb` : ''}
          {dimensionsBusy ? ' · finding…' : ''} <small>{[...new Set(['product_height_in','product_width_in','product_depth_in','product_weight_lb'].map(k => dimensionSources[k]).filter(Boolean))].join(' / ')}</small></summary>
          <div className="receive-confirm-dims">{([['productDepth','Length (in)','product_depth_in'],['productWidth','Width (in)','product_width_in'],
            ['productHeight','Height (in)','product_height_in'],['productWeight','Weight (lb)','product_weight_lb']] as const).map(([key,label,source]) =>
            <label key={key}>{label}<input type="number" min="0" step="any" inputMode="decimal" value={form[key]} onChange={e => { update(key, e.target.value); setDimensionSources(p => ({...p,[source]:'staff'})); }} />
              {form[key] && <small>{dimensionSources[source] || 'staff'}</small>}</label>)}</div></details>}
        {!storePhoneMode && <details className="receive-confirm-details"><summary>Package · {[form.length, form.width, form.height].every(Boolean)
          ? `${form.length} × ${form.width} × ${form.height} in` : 'Add dimensions'}{form.weight ? ` · ${form.weight} lb` : ''}
          {dimensionsBusy ? ' · finding…' : ''} <small>{[...new Set(['package_length_in','package_width_in','package_height_in','package_weight_lb'].map(k => dimensionSources[k]).filter(Boolean))].join(' / ')}</small></summary>
          <div className="receive-confirm-dims">{([['length','Length (in)','package_length_in'],['width','Width (in)','package_width_in'],
            ['height','Height (in)','package_height_in'],['weight','Weight (lb)','package_weight_lb']] as const).map(([key,label,source]) =>
            <label key={key}>{label}<input type="number" min="0" step="any" inputMode="decimal" value={form[key]} onChange={e => { update(key, e.target.value); setDimensionSources(p => ({...p,[source]:'staff'})); }} />
              {form[key] && <small>{dimensionSources[source] || 'staff'}</small>}</label>)}</div></details>}
        {!storePhoneMode && dimensionsError && ![form.length,form.width,form.height,form.weight,form.productHeight,form.productWidth,form.productDepth,form.productWeight].some(v => Number(v)>0) && <small className="receive-confirm-note">No size found. Measure on mat.</small>}
        {!storePhoneMode && <button type="button" className="secondary" onClick={() => setMatOpen(true)}>Measure on mat</button>}
        {!storePhoneMode && matOpen && <Suspense fallback={<p role="status">Opening measuring tools…</p>}><MeasureOnMat onClose={() => setMatOpen(false)} onApply={(value, target) => {
          for (const key of target === 'product' ? ['productDepth','productWidth','productHeight'] : ['length','width','height']) dimensionTouched.current.add(key);
          setForm(prev => target === 'product' ? {...prev, productDepth:value.length, productWidth:value.width, productHeight:value.height}
            : {...prev, length:value.length, width:value.width, height:value.height});
          setDimensionSources(prev => ({...prev, ...Object.fromEntries((target === 'product'
            ? ['product_depth_in','product_width_in','product_height_in'] : ['package_length_in','package_width_in','package_height_in'])
            .map(key => [key,'ArUco mat · staff reviewed']))}));
          setMatOpen(false);
        }} /></Suspense>}

        <div className="receive-confirm-bottom">
          {!staffMode && <details className="receive-confirm-prices" open={storePhoneMode}><summary>{photoPriceBusy ? 'Searching prices...' : !photoIdentity ? 'Price reference unavailable' : photoPriceError ? 'Price search incomplete' : photoPrice?.median_cents != null
            ? `Online asking price ~${money(photoPrice.median_cents)} (${photoPrice.count} listings, ${money(photoPrice.low_cents)}–${money(photoPrice.high_cents)})`
            : photoPrice?.count ? `Online price ${money(photoPrice.low_cents)}${photoPrice.count > 1 ? `–${money(photoPrice.high_cents)}` : ''}` : 'Price reference unavailable'}</summary>
            {photoPrice?.listings?.map(listing => <a key={listing.url} href={listing.url} target="_blank" rel="noreferrer">{listing.store} · {money(listing.price_cents)} · {listing.product_name}</a>)}
            {photoPrice?.highest_retail && <small>Highest retail seen: {photoPrice.highest_retail.store} · {money(photoPrice.highest_retail.price_cents)}</small>}
            {photoPriceError && <><span>{photoPriceError}</span>{photoIdentity && <button type="button" className="secondary" onClick={() => void findPhotoPrices(photoIdentity)}>Retry prices</button>}</>}
          </details>}
          {!staffMode && photoPrice?.listings?.[0] && <a className="receive-confirm-source" href={photoPrice.listings[0].url} target="_blank" rel="noreferrer">
            {photoPrice.listings[0].store} · {money(photoPrice.listings[0].price_cents)} · source ↗</a>}
          <div className="receive-confirm-bottom-row">
            <label>Price<ManifestReceiveReference result={manifestReference} /><input inputMode="decimal" placeholder="0.00" value={form.ask} onFocus={e => { typingTarget.current = e.currentTarget; }} onChange={e => update('ask',e.target.value)} /></label>
            {!staffMode && <label>Cost<input inputMode="decimal" placeholder="Leave blank if unknown" value={form.cost} onChange={e => update('cost',e.target.value)} /></label>}
          </div>
          <div className={`receive-location-card${showSaveValidation && !selectedLocation.trim() && !doNotList ? ' receive-v2-invalid' : ''}`}><label>Location{!doNotList ? ' *' : ''}<select value={selectedLocation} onChange={e => setSelectedLocation(e.target.value)}>
            <option value="">No location yet</option>{receiveLocations.map(location => <option key={location.code} value={location.code}>{locationMenuLabel(location)}{location.code === selectedLocation ? ' · same as last item' : ''}</option>)}
          </select></label>{showSaveValidation && !selectedLocation.trim() && !doNotList && <span className="receive-v2-msg">{receiveFieldMessage('location')}</span>}{(!storePhoneMode || locationEditOpen) && <label className="receive-location-scan">Scan bin label<input inputMode={scannerInputMode()} value={locationScan} placeholder="Bay 12 · R2-B3" onChange={e => setLocationScan(e.target.value)} onKeyDown={e => {
            if (e.key !== 'Enter') return; e.preventDefault();
            const parts = locationScan.trim().match(/(?:bay\s*)?(\d+)\s*[·\s-]+\s*r?(\d+)(?:\s*-\s*b?\s*(\d+))?/i);
            const code = parts ? `${parts[1]}-${parts[2]}${parts[3] ? `-${parts[3]}` : ''}` : locationScan.trim();
            const typed = locationScan.trim().toLowerCase();
            const match = receiveLocations.find(location => location.code === code || locationMenuLabel(location).toLowerCase() === typed || `Bay ${location.bay_no} · R${location.row_no}${location.bin_no == null ? '' : `-B${location.bin_no}`}`.toLowerCase() === typed);
            if (match) { setSelectedLocation(match.code); setLocationScan(''); setLocationEditOpen(false); } else setError('That barcode does not match a configured bay, row and bin.');
          }} /></label>}<button type="button" className="text-button" onClick={() => {
            if (storePhoneMode) setLocationEditOpen(value => !value);
            else { setSelectedLocation(''); setLocationScan(''); }
          }}>{storePhoneMode ? locationEditOpen ? 'Done' : 'Change' : 'Change'}</button></div>
          {selectedLocation && <small className="receive-last-location">{locationMenuLabel(receiveLocations.find(l => l.code === selectedLocation) || { code: selectedLocation })} · same as last item</small>}
          {storePhoneMode && <details className="receive-phone-fold"><summary>More options</summary>
          <div className="receive-channel-card">
            {!staffMode && <ChannelPicker value={channels} onChange={setChannels} disabled={doNotList || doNotShip} upc={form.noUpc ? '' : (form.upc || current?.upc || '')} />}
            {!staffMode && <label className="mboard-inline"><input type="checkbox" checked={doNotShip} disabled={dnsRequired} onChange={e => { setDns(e.target.checked); if (e.target.checked) setChannels([]); }} /> DNS — Do not ship</label>}
            <label className="mboard-inline"><input type="checkbox" checked={doNotList} onChange={e => { setDoNotList(e.target.checked); if (e.target.checked) setChannels([]); }} /> Do not list for sale</label>
            {doNotShip && <small>Store / website pickup only. No marketplace listings.</small>}
          </div>
          <details className="receive-confirm-details"><summary>Product dimensions · {[form.productDepth,form.productWidth,form.productHeight].every(Boolean)
            ? `${form.productDepth} × ${form.productWidth} × ${form.productHeight} in` : 'optional'}{form.productWeight ? ` · ${form.productWeight} lb` : ''}{dimensionsBusy ? ' · finding…' : ''}
            <small>{[...new Set(['product_depth_in','product_width_in','product_height_in','product_weight_lb'].map(key => dimensionSources[key]).filter(Boolean))].join(' / ')}</small></summary>
            <div className="receive-confirm-dims">{([['productDepth','Length (in)','product_depth_in'],['productWidth','Width (in)','product_width_in'],['productHeight','Height (in)','product_height_in'],['productWeight','Weight (lb)','product_weight_lb']] as const).map(([key,label,source]) =>
              <label key={key}>{label}<input type="number" min="0" step="any" inputMode="decimal" value={form[key]} placeholder="Optional" onChange={e => { update(key,e.target.value); setDimensionSources(p => ({...p,[source]:'staff'})); }} /></label>)}</div>
          </details>
          <details className="receive-confirm-details"><summary>Size & weight {form.length || form.weight ? '· entered' : '· optional'}</summary>
            <div className="receive-confirm-dims">{([['length','Length (in)','package_length_in'],['width','Width (in)','package_width_in'],['height','Height (in)','package_height_in'],['weight','Weight (lb)','package_weight_lb']] as const).map(([key,label,source]) =>
              <label key={key}>{label}<input type="number" min="0" step="any" inputMode="decimal" value={form[key]} placeholder="Optional" onChange={e => { update(key,e.target.value); setDimensionSources(p => ({...p,[source]:'staff'})); }} /></label>)}</div>
            {needsEbayBox && <small className="receive-confirm-note">Needs box size for eBay. Save now and measure later.</small>}
            <button type="button" className="secondary" onClick={() => setMatOpen(true)}>Measure on mat</button>
          </details>
          <details className="receive-confirm-details"><summary>Description {form.description ? '· filled' : '· optional'}</summary><textarea rows={3} value={form.description} onChange={e => update('description',e.target.value)} /></details>
          {!staffMode && <BundleReceive client={client} lastReceived={saved[0]} onSaved={onSaved} />}
          </details>}
          {liveMissing.length > 0 && <small>{doNotList ? 'Brand required before saving.' : `Missing: ${liveMissing.join(', ')} · saves to Unfinished`}</small>}
          {needsEbayBox && <small className="receive-confirm-note">Needs box size for eBay. You can save now and measure it later.</small>}
          {files.length > 0 && !stagedPhotoPaths.length && !photoBusy && !photoIdBusy && <button type="button" className="secondary" onClick={() => {
            setPhotoBusy(true); setError('');
            void stageUnitPhotos(files).then(setStagedPhotoPaths).catch(e => setError(`Photo upload failed: ${errText(e)}`)).finally(() => setPhotoBusy(false));
          }}>Retry photo upload</button>}
          <button className="receive-save-next" type="submit" disabled={busy || (doNotList ? (photoBusy && hasAnyPhoto) : photoBusy || stockPhotoBusy || photoIdBusy || !hasAnyPhoto) || (dups !== null && dups.count > 0 && !dupAck)}>{busy ? 'Saving…' : doNotList ? 'Save store-only unit' : photoBusy || stockPhotoBusy || photoIdBusy ? 'Preparing photo…' : hasCatalogPhoto && !files.length && !stockPhotoPath ? 'Use stock photo & save' : hasAnyPhoto ? 'Save & next' : '📷 Take a photo to save'}</button>
        </div>
      </div>}

      <div className={`receive-advanced${manual ? ' receive-manual' : ''}`}><div className="unit-edit-grid receive-v2-grid">
        {staffMode && manual && !doNotList && <label className="rcv-check receive-v2-span2"><input type="checkbox" checked={false} onChange={() => { setDoNotList(true); setChannels([]); }} /> DNL — Do not list</label>}
        {staffMode && doNotList && <div className="rcv-dnl">
          <label className="rcv-check"><input type="checkbox" checked onChange={() => setDoNotList(false)} /> DNL — Do not list</label>
          <p className="hint">Saving sets the condition to Defective/non-sellable. Only a title is required. No photo, brand, or price. Unchecking brings the rest of the form back.</p>
          <label className={invalid('title') ? 'receive-v2-invalid' : undefined}>
            <span className="receive-v2-label">Title<span className="receive-v2-req"> *</span></span>
            <input value={form.title} onChange={e => update('title', e.target.value)} placeholder="What is it" autoComplete="off" />
          </label>
        </div>}
        {!manual && current && (trueMiss ? <div className="rcv-miss">
          <strong>No match for this UPC</strong>
          <small>Take one photo and we’ll fill in the rest</small>
          <div className="rcv-miss-actions">
            <button type="button" className="secondary" disabled={photoIdBusy} onClick={() => {
              try { sessionStorage.removeItem(`floor:receive-photo-dismissed:${storeId}:${current.upc}`); } catch { /* reopen still works */ }
              setDialog('miss-photo');
            }}>Scan with photo</button>
            <button type="button" className="secondary" onClick={toggleManual}>Enter manually</button>
          </div>
        </div> : <div className="rcv-found">
          <label className="rcv-upc-field">{current.upc}
            <button type="button" className="text-button" disabled={busy} onClick={() => retry(current)}>Rescan</button>
          </label>
          <strong>{merged?.title || form.title || 'Item'}</strong>
          <small>Found by UPC · filled in for you</small>
        </div>)}
        {unifiedV2 && !(staffMode && doNotList) && <ReceiveSection id="photos" title="Photos" required={!mediaWaived} open={openSec === 'photos'} onOpen={toggleSection}
          tone={!personPhotoReady() && !mediaWaived ? 'bad' : 'muted'}
          status={(() => {
            const count = files.length || stagedPhotoPaths.length;
            const stock = Boolean(stockPhotoPath || stockPhotoSourceUrl || merged?.images?.[0]);
            if (mediaWaived) return doNotList ? 'Optional (not listed)' : 'Optional (defective)';
            if (count > 0) return `${count} photo${count === 1 ? '' : 's'}${stock ? ' + stock' : ''}`;
            if (stock) return 'Needs your photo';
            return 'Required';
          })()}>
        <div ref={el => { fieldRefs.current.photo = el; }} className={invalid('photo') ? 'receive-v2-invalid' : undefined}>
          <div className="receive-v2-photo-actions">
            <input ref={takePhotoFile} type="file" accept="image/*" capture="environment" className="sr-only" aria-hidden tabIndex={-1}
              onChange={e => { const input = e.currentTarget; void ingestFiles(input.files).finally(() => { input.value = ''; }); }} />
            <input ref={choosePhotoFile} type="file" accept="image/*" multiple className="sr-only" aria-hidden tabIndex={-1}
              onChange={e => { const input = e.currentTarget; void ingestFiles(input.files).finally(() => { input.value = ''; }); }} />
            <button type="button" className="secondary" disabled={photoBusy || busy} onClick={() => takePhotoFile.current?.click()}>{photoBusy ? 'Saving…' : 'Take photo'}</button>
            <button type="button" className="secondary" disabled={photoBusy || busy} onClick={() => choosePhotoFile.current?.click()}>Choose photos</button>
          </div>
          {hasFiles && <div className="receive-photos">{files.map((f, i) => <figure key={`${f.name}-${f.size}-${i}`}>
            <img src={previews[i]} alt={`Photo ${i + 1}`} />
            <button type="button" className="text-button" onClick={() => {
              const path = stagedPhotoPaths[i];
              if (path) void client.storage.from('unit-photos').remove([path]);
              setStagedPhotoPaths(prev => prev.filter((_, j) => j !== i));
              setFiles(prev => {
                const next = prev.filter((_, j) => j !== i);
                void savePendingPhotos(pendingPhotoKey(storeId, photoSessionKey.current), next);
                return next;
              });
            }}>Remove</button>
          </figure>)}</div>}
          {(stockPhotoSourceUrl || merged?.images?.[0]) ? <figure className="rcv-stock">
            {stockPhotoBroken
              ? <div className="rcv-stock-miss">Stock photo unavailable</div>
              : <img src={stockPhotoSourceUrl || String(merged?.images?.[0] || '')} alt="" onError={() => setStockPhotoBroken(true)} />}
            <figcaption>
              <strong>Stock photo</strong>
              <small>Pulled from the UPC and saved with the item. You still need to add your own photo.</small>
            </figcaption>
          </figure> : (!manual && current && !trueMiss && !stockPhotoBusy ? <p className="rcv-note">No stock photo found</p> : null)}
          {invalid('photo') && <span className="receive-v2-msg">{receiveFieldMessage('photo')}</span>}
        </div>
        </ReceiveSection>}

        {!(staffMode && doNotList) && <ReceiveSection id="item" title="Item" required={!doNotList} keepMounted open={openSec === 'item'} onOpen={toggleSection}
          tone={liveMissing.some(g => receiveSectionForGap(g) === 'item') ? 'bad' : 'muted'}
          status={liveMissing.filter(g => receiveSectionForGap(g) === 'item').length
            ? (liveMissing.filter(g => receiveSectionForGap(g) === 'item').length === 1
              ? ({ category: 'Category', brand: 'Brand', 'item specifics': 'Specifics' } as Record<string, string>)[liveMissing.find(g => receiveSectionForGap(g) === 'item') || ''] || 'Required'
              : `${liveMissing.filter(g => receiveSectionForGap(g) === 'item').length} missing`)
            : (brandReady() ? `${form.unbranded ? 'Unbranded' : form.brand}${(form.category || ebayAspects.path?.split('>').pop()?.trim()) ? ` · ${form.category || ebayAspects.path?.split('>').pop()?.trim()}` : ''}` : 'Required')}>
        <label ref={el => { fieldRefs.current.brand = el; }} className={`receive-v2-span2${invalid('brand') ? ' receive-v2-invalid' : ''}`}>
          <span className="receive-v2-label">Brand{!doNotList && <span className="receive-v2-req"> *</span>}</span>
          <input placeholder="Type brand" value={form.unbranded ? 'Unbranded' : form.brand} disabled={form.unbranded} onChange={e => update('brand', e.target.value)} />
        </label>
        <label className="rcv-check receive-v2-span2">
          <input type="checkbox" checked={form.unbranded} onChange={e => setForm(p => ({ ...p, unbranded: e.target.checked, title: composeListingTitle(p.brand, p.model, e.target.checked) }))} />
          No brand
        </label>

        <ReceiveCategoryAspects
          client={client}
          storeId={storeId}
          accessToken={accessToken}
          doNotList={doNotList}
          channels={channels}
          disabled={busy}
          showErrors={showSaveValidation || Boolean(ebayAspects.categoryId)}
          identity={{
            brand: form.unbranded ? 'Unbranded' : form.brand,
            model: form.model,
            title: form.title,
            condition: form.condition,
            upc: form.noUpc ? '' : (form.upc || current?.upc || ''),
          }}
          onChannelValues={(next, missing) => { channelAttrs.current = next; setChannelMissing(missing); }}
          value={ebayAspects}
          onChange={next => {
            setEbayAspects(next);
            const grades = next.allowedGrades || [];
            const onlyGrade = grades.length === 1 ? grades[0].grade : '';
            // Costco returns are USED_GOOD — do not auto-pick New / Brand New when that is the only allowed grade.
            const autoNew = /^brand\s*new$/i.test(onlyGrade) || onlyGrade === NEW;
            const stillAllowed = !form.condition || grades.length === 0 || grades.some(grade => grade.grade === form.condition) || isDefectiveCondition(form.condition);
            if (!stillAllowed) update('condition', grades.length === 1 && !autoNew ? onlyGrade : '');
            else if (grades.length === 1 && !form.condition && !autoNew) update('condition', onlyGrade);
            const modelGuess = next.attributes.Model || next.attributes.Type || next.attributes['Model Number'] || '';
            if (modelGuess && !form.model.trim()) update('model', modelGuess);
          }}
        />
        </ReceiveSection>}

        {!(staffMode && doNotList) && <ReceiveSection id="price" title="Price & condition" required={!doNotList} open={openSec === 'price'} onOpen={toggleSection}
          tone={liveMissing.some(g => receiveSectionForGap(g) === 'price') ? 'bad' : 'muted'}
          status={form.ask && form.condition ? `$${form.ask} · ${form.condition}` : doNotList ? 'Optional' : 'Required'}>
        <div className="receive-v2-row2">
        <label className={invalid('price') ? 'receive-v2-invalid' : undefined}>
          <span className="receive-v2-label">Price{!doNotList && <span className="receive-v2-req"> *</span>}</span>
          <ManifestReceiveReference result={manifestReference} />
          <input inputMode="decimal" placeholder="0.00" value={form.ask} onChange={e => update('ask', e.target.value)} autoComplete="off" />
        </label>
        {!staffMode && <label>
          <span className="receive-v2-label">Cost <span className="receive-v2-opt">optional</span></span>
          <input inputMode="decimal" placeholder="Leave blank if unknown" value={form.cost} onChange={e => update('cost', e.target.value)} />
          </label>}
        </div>
        <div className={invalid('condition') ? 'receive-v2-invalid' : undefined}>
          <span className="receive-v2-label">Condition{!doNotList && <span className="receive-v2-req"> *</span>}</span>
          {(ebayAspects.allowedGrades || []).length === 0
            ? <p className="rcv-note">Pick a category first. eBay decides which conditions this category allows.</p>
            : <div className="receive-chip-row" role="radiogroup" aria-label="Condition">
              {(ebayAspects.allowedGrades || []).map(grade => (
                <button type="button" key={grade.grade} className={`receive-chip${form.condition === grade.grade ? ' on' : ''}`} onClick={() => update('condition', grade.grade)}>{grade.grade}</button>
              ))}
            </div>}
          {ebayAspects.conditionNote ? <p className="rcv-note">{ebayAspects.conditionNote}</p> : null}
        </div>
        <ReceiveQuantity value={form.quantity} onChange={value => update('quantity', value)} disabled={busy} />
        </ReceiveSection>}

        {!(staffMode && doNotList) && <ReceiveSection id="size" title="Size & weight" required={!mediaWaived} open={openSec === 'size'} onOpen={toggleSection}
          tone={!dimensionsReady() && !mediaWaived ? 'bad' : 'muted'}
          status={dimensionsReady() ? (!manual && current && !trueMiss ? 'From UPC' : `${form.length} × ${form.width} × ${form.height} in · ${form.weight} lb`) : mediaWaived ? (doNotList ? 'Optional (not listed)' : 'Optional (defective)') : 'Required'}>
          <div className="receive-v2-dims">
            <label>Length (in)<input inputMode="decimal" value={form.length} onChange={e => update('length', e.target.value)} /></label>
            <label>Width (in)<input inputMode="decimal" value={form.width} onChange={e => update('width', e.target.value)} /></label>
            <label>Height (in)<input inputMode="decimal" value={form.height} onChange={e => update('height', e.target.value)} /></label>
            <label>Box weight (lb)<input inputMode="decimal" value={form.weight} onChange={e => update('weight', e.target.value)} /></label>
            <label>Item weight (lb)<input inputMode="decimal" value={form.productWeight} onChange={e => update('productWeight', e.target.value)} placeholder="From catalog when known" /></label>
          </div>
          <p className="rcv-note">Box weight is the packaged ship weight. Item weight is the product itself.</p>
        </ReceiveSection>}

        {!(staffMode && doNotList) && <ReceiveSection id="location" title="Location" required={!doNotList} open={openSec === 'location'} onOpen={toggleSection}
          tone={!selectedLocation.trim() && !doNotList ? 'bad' : 'muted'}
          status={selectedLocation
            ? locationMenuLabel(receiveLocations.find(l => l.code === selectedLocation) || { code: selectedLocation })
            : (doNotList ? 'Optional' : 'Required')}>
          <label className={!selectedLocation.trim() && !doNotList && showSaveValidation ? 'receive-v2-invalid' : undefined}>
            <span className="receive-v2-label">Bay{!doNotList ? <span className="receive-v2-req"> *</span> : null}</span>
            <select value={selectedLocation} onChange={e => setSelectedLocation(e.target.value)}>
              <option value="">Choose a bay</option>
              {receiveLocations.map(location => <option key={location.code} value={location.code}>{locationMenuLabel(location)}</option>)}
            </select>
          </label>
          {!selectedLocation.trim() && !doNotList && showSaveValidation && <span className="receive-v2-msg">{receiveFieldMessage('location')}</span>}
        </ReceiveSection>}

        {!(staffMode && doNotList) && <ReceiveSection id="upc" title="UPC" open={openSec === 'upc'} onOpen={toggleSection}
          tone={invalid('upc') ? 'bad' : 'muted'}
          status={form.noUpc ? 'Not set' : (form.upc || current?.upc || 'Not set')}>
        <label className={invalid('upc') ? 'receive-v2-invalid' : undefined}>
          <span className="receive-v2-label">UPC{upcRequired(channels) && !doNotList && <span className="receive-v2-req"> *</span>}</span>
          <input
            value={form.noUpc ? UPC_NOT_APPLICABLE : form.upc}
            disabled={form.noUpc}
            onFocus={e => { typingTarget.current = e.currentTarget; }}
            onChange={e => {
              const v = e.target.value;
              setForm(p => ({ ...p, upc: v, noUpc: false }));
              setDups(null); setDupAck(false);
            }}
            inputMode="numeric"
            autoComplete="off"
            placeholder="Scan or type UPC"
          />
        </label>
        <label className="rcv-check">
          <input type="checkbox" checked={form.noUpc} onChange={e => {
            const on = e.target.checked;
            setForm(p => ({ ...p, noUpc: on, upc: on ? '' : p.upc }));
            setDups(null); setDupAck(false);
          }} />
          No UPC
        </label>
        </ReceiveSection>}

        {!staffMode && <ReceiveSection id="sell" title="Sell on" open={openSec === 'sell'} onOpen={toggleSection} status={channels.length ? channels.map(c => c === 'tiktok' ? 'TikTok' : c === 'ebay' ? 'eBay' : 'Amazon').join(', ') : 'None'}>
          <ChannelPicker bare value={channels} onChange={setChannels} disabled={doNotList || doNotShip} upc={form.noUpc ? '' : (form.upc || current?.upc || '')} />
        </ReceiveSection>}

        {!(staffMode && doNotList) && <ReceiveSection id="flags" title="Flags" open={openSec === 'flags'} onOpen={toggleSection}
          status={[doNotShip && 'Do not ship', doNotList && 'Do not list', isDefectiveCondition(form.condition) && 'Defective'].filter(Boolean).join(' · ') || 'None'}>
          {!staffMode && <label className="rcv-check"><input type="checkbox" checked={doNotShip} disabled={dnsRequired} onChange={e => { setDns(e.target.checked); if (e.target.checked) setChannels([]); }} /> Do not ship</label>}
          <label className="rcv-check"><input type="checkbox" checked={doNotList} onChange={e => { const on = e.target.checked; setDoNotList(on); if (on) setChannels([]); }} /> {staffMode ? 'DNL — Do not list' : 'Do not list for sale'}</label>
          <label className="rcv-check"><input type="checkbox" checked={isDefectiveCondition(form.condition)} onChange={e => update('condition', e.target.checked ? SCRATCH : (isDefectiveCondition(form.condition) ? '' : form.condition))} /> Defective</label>
          {needNoteForScratch && <label>Defect note<textarea rows={2} value={form.conditionNote} onChange={e => update('conditionNote', e.target.value)} /></label>}
        </ReceiveSection>}

        {!(staffMode && doNotList) && <ReceiveSection id="details" title="Details" open={openSec === 'details'} onOpen={toggleSection}
          tone={liveMissing.includes('store category') || !ebayCheck.ready ? 'bad' : 'muted'}
          status={liveMissing.includes('store category') ? 'Store category' : ebayCheck.text}>
          <p className="rcv-note">eBay check</p>
          <strong>{ebayCheck.ready ? 'All required fields set' : 'Still missing a required eBay field'}</strong>
          <div className="rcv-ebay-rows">
            <p><span>Category</span><strong>{ebayAspects.path ? ebayAspects.path.split('>').slice(-2).join(' · ') : 'Not set'}</strong></p>
            <p><span>Condition</span><strong>{form.condition || 'Not set'}</strong></p>
            {ebayAspects.fields.filter(field => field.required).map(field => (
              <p key={field.name}><span>{field.name}</span><strong>{ebayAspects.attributes[field.name] || 'Missing'}</strong></p>
            ))}
            {form.description ? <p><span>Description</span><strong>From UPC</strong></p> : null}
          </div>
          <label>Title<input value={form.title} onChange={e => update('title', e.target.value)} placeholder="Brand + specifics" autoComplete="off" /></label>
          <label>Description<textarea rows={2} value={form.description} onChange={e => update('description', e.target.value)} /></label>
          <CategoryField label="Store category" value={form.category} options={choices(options?.categories)} onChange={v => update('category', v)} onFocus={e => { typingTarget.current = e.currentTarget; }} />
          {!staffMode && <label>Manifest<select value={manifestId} onChange={e => setManifestId(e.target.value)}><option value="">No manifest</option>{manifests.map(m => <option key={m.id} value={m.id}>{m.name} · {m.manifest_on}</option>)}</select></label>}
        </ReceiveSection>}

        {!staffMode && <ReceiveSection id="bundle" title="Bundle items" open={openSec === 'bundle'} onOpen={toggleSection} status="Optional">
          <BundleReceive client={client} lastReceived={saved[0]} onSaved={onSaved} />
        </ReceiveSection>}

        {!unifiedV2 && <>
        <label className="unit-edit-wide">
          Title
          <input value={form.title} onFocus={e => { typingTarget.current = e.currentTarget; }} onChange={e => update('title', e.target.value)} placeholder="Brand + item specifics" autoComplete="off" />
        </label>
        {manual && <label className="unit-edit-wide">Description<textarea rows={3} value={form.description} onChange={e => update('description', e.target.value)} /></label>}
        {manual && !staffMode && <label>Cost<input inputMode="decimal" value={form.cost} onChange={e => update('cost', e.target.value)} /></label>}
        {!staffMode && <label className="unit-edit-wide">Manifest<select value={manifestId} onChange={e => setManifestId(e.target.value)}><option value="">No manifest</option>{manifests.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>}
        </>}

        {!unifiedV2 && <div ref={el => { fieldRefs.current.photo = el; }} className={`unit-edit-wide${invalid('photo') ? ' receive-v2-invalid' : ''}`}>
          <span className="receive-v2-label">Photos<span className="receive-v2-req"> *</span></span>
          <div className="receive-v2-photo-actions">
            <button type="button" className="secondary" disabled={photoBusy || busy} onClick={() => takePhotoFile.current?.click()}>Take photo</button>
            <button type="button" className="secondary" disabled={photoBusy || busy} onClick={() => choosePhotoFile.current?.click()}>Choose photos</button>
          </div>
        </div>}

        {!unifiedV2 && <>
        <label className="mboard-inline unit-edit-wide">
          <input type="checkbox" checked={doNotList} onChange={e => { const on = e.target.checked; setDoNotList(on); if (on) setChannels([]); }} />
          Do not list for sale
        </label>
        {!staffMode && <ChannelPicker value={channels} onChange={setChannels} disabled={doNotList || doNotShip} upc={form.noUpc ? '' : (form.upc || current?.upc || '')} />}
        </>}
      </div>

      {!unifiedV2 && <p className="hint receive-check">
        {doNotList
          ? (files.length
            ? 'Store-only — will receive without listing. Photo is optional.'
            : 'Store-only — photo not required. Unit stays off the website and marketplaces.')
          : doNotShip ? 'DNS — store / website pickup only. No marketplace listing will be queued.'
          : liveMissing.length === 0
            ? (channels.length ? 'Complete — the checked channels are queued after receiving.' : 'Complete — check the channels to list on, or Finish to land in Needs to be checked.')
            : channels.length
              ? `Before it can list it still needs: ${liveMissing.join(', ')}.`
              : `Missing for listing: ${liveMissing.join(', ')}. You can still receive; incomplete units land in Needs attention.`}
      </p>}
      <div className="receive-v2-pin">
        {liveMissing.length > 0 && <button type="button" className="rcv-needed" onClick={() => { setShowSaveValidation(true); setOpenSec(receiveSectionForGap(liveMissing[0])); }}>
          Still needed: {liveMissing.join(', ')}
        </button>}
        <button type="submit" className={`receive-v2-save${formValid ? '' : ' is-dim'}`} disabled={busy || photoBusy || !formValid}>
          {busy ? 'Saving…' : 'Save item'}
        </button>
        {!manual && <button type="submit" className={`secondary rcv-scan-next${formValid ? '' : ' is-dim'}`} disabled={busy || photoBusy || !formValid}>Save and scan next</button>}
      </div>
      {!manual && current && <button type="button" className="secondary" disabled={busy} onClick={skipCurrent}>Skip this scan</button>}
      </div>
    </form>}

    {camera && <CameraScanner
      onClose={() => { setCamera(false); focusUpc(); }}
      onDetect={code => { setCamera(false); enqueue(code); }}
      onFile={file => { void decodeFile(file).then(code => { setCamera(false); if (code) enqueue(code); else { setError('Could not read a barcode from that photo. Type the digits instead.'); focusUpc(); } }); }}
    />}

    {dialog === 'ready' && <div className="receive-modal" role="dialog" aria-modal="true" aria-labelledby="ready-title">
      <div className="receive-modal-card">
        <h3 id="ready-title">Receive this unit?</h3>
        <p><strong>{form.title.trim() || [form.brand, form.model].filter(Boolean).join(' ')}</strong><br />
          Price {money(cents(form.ask) as number | null)} · {form.condition || 'no condition'} · {files.length} photo{files.length === 1 ? '' : 's'}</p>
        <p className="hint">Yes receives it with normal show defaults. Tick eBay, Amazon or TikTok Shop on the unit to list it.
          {form.costEstimate ? ` Cost uses ${floor.costLabel} until you edit it.` : ''}</p>
        <div className="actions">
          <button type="button" disabled={busy} autoFocus onClick={() => { const p = parse(); if (p) void receive(p, null); }}>Yes — receive</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => setDialog('reason')}>No</button>
          <button type="button" className="text-button" onClick={() => setDialog(null)}>Back</button>
          <button type="button" className="text-button" onClick={() => setDialog(null)}>Cancel</button>
        </div>
      </div>
    </div>}

    {dialog === 'reason' && <div className="receive-modal" role="dialog" aria-modal="true" aria-labelledby="reason-title">
      <div className="receive-modal-card">
        <h3 id="reason-title">Why not list it?</h3>
        <div className="receive-cond-row">{HOLD_REASONS.map(([value, text2]) => <label key={value} className={reason === value ? 'receive-chip on' : 'receive-chip'}>
          <input type="radio" name="hold-reason" value={value} checked={reason === value} onChange={() => setReason(value)} />{text2}
        </label>)}</div>
        <label className="receive-notes">Note{reason === 'other' ? ' (required)' : ' (optional)'}
          <textarea rows={2} value={reasonNote} onChange={e => setReasonNote(e.target.value)} />
        </label>
        <p className="hint">The unit is received with no price, hidden from the website, and the reason is saved in its notes.</p>
        <div className="actions">
          <button type="button" disabled={busy || !holdReady} onClick={() => { const p = parse(); if (p) void receive(p, { reason, note: reasonNote }); }}>Receive without listing</button>
          <button type="button" className="text-button" onClick={() => setDialog('ready')}>Back</button>
          <button type="button" className="text-button" onClick={() => setDialog(null)}>Cancel</button>
        </div>
      </div>
    </div>}

    {dialog === 'miss-photo' && <div className="receive-modal" role="dialog" aria-modal="true" aria-labelledby="miss-photo-title">
      <div className="receive-modal-card">
        <h3 id="miss-photo-title">{photoCandidate ? 'Confirm product from photo' : photoNeed ? 'More product details needed' : 'Can\'t find this item. Scan with camera?'}</h3>
        <p>{photoCandidate ? photoConflictText : `${photoNeed || 'Take one clear photo of the box or label.'} We\'ll identify the product and show asking prices so you can set the price.`}</p>
        <ManifestReceiveReference result={manifestReference} />
        <ManifestSearchBox client={client} onPick={pickManifestLine} disabled={busy || photoIdBusy} />
        {previews[0] && <img src={previews[0]} alt="Photo being identified" style={{ maxWidth: '100%', maxHeight: 180, objectFit: 'contain' }} />}
        {photoIdBusy && <p role="status">{photoIdStatus || 'Identifying product…'}</p>}
        {photoIdError && <p className="alert" role="alert">{photoIdError}</p>}
        {photoCandidate && <div className="receive-photo-candidate">
          <strong>{text(photoCandidate.title)}</strong>
          <span>{[text(photoCandidate.brand) || 'No visible brand', text(photoCandidate.model), text(photoCandidate.size), text(photoCandidate.color)].filter(Boolean).join(' · ')}</span>
        </div>}
          <input
          ref={missPhotoFile}
          type="file"
          accept="image/*"
          capture="environment"
          className="sr-only"
          aria-hidden
          tabIndex={-1}
          onChange={e => {
            const input = e.currentTarget;
            const file = input.files?.[0] || null;
            input.value = '';
            void identifyMissPhoto(file);
          }}
        />
        <input ref={missChooseFile} type="file" accept="image/*" className="sr-only" aria-label="Choose product photo" onChange={e => {
          const file = e.currentTarget.files?.[0] || null;
          e.currentTarget.value = '';
          void identifyMissPhoto(file);
        }} />
        {photoCandidate ? <div className="actions">
          <button type="button" disabled={photoIdBusy} autoFocus onClick={() => void choosePhotoIdentity(true)}>Use photo product</button>
          {text(photoCandidate.brand) && <button type="button" className="secondary" disabled={photoIdBusy} onClick={() => void choosePhotoIdentity(true, true)}>No brand</button>}
          {!current?.result?.store_label && current?.result?.merged?.title && <button type="button" className="secondary" disabled={photoIdBusy} onClick={() => void choosePhotoIdentity(false)}>Keep barcode product</button>}
          <button type="button" className="secondary" disabled={photoIdBusy} onClick={dismissPhotoCheck}>Enter details myself</button>
          <button type="button" className="text-button" onClick={dismissPhotoCheck}>Cancel</button>
          <button type="button" className="text-button" onClick={skipCurrent}>Discard this scan</button>
        </div> : <div className="actions">
          <button type="button" disabled={photoIdBusy} autoFocus onClick={() => missPhotoFile.current?.click()}>
            {photoIdError ? 'Retry photo' : 'Yes — take photo'}
          </button>
          <button type="button" className="secondary" disabled={photoIdBusy} onClick={() => missChooseFile.current?.click()}>Choose photo</button>
          {photoVerifyPending && current?.result?.merged?.title && <button type="button" className="secondary" disabled={photoIdBusy} onClick={() => void choosePhotoIdentity(false)}>Keep barcode product</button>}
          <button type="button" className="secondary" onClick={dismissPhotoCheck}>Enter details myself</button>
          <button type="button" className="text-button" onClick={dismissPhotoCheck}>Cancel</button>
          <button type="button" className="text-button" onClick={skipCurrent}>Discard this scan</button>
        </div>}
      </div>
    </div>}

  </section>;
}
