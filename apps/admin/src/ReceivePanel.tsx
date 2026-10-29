import { ReceiveQuantity, ReceiveGroupPicker } from './ReceiveQuantity';
import { ReceiveWorkStatus } from './ReceiveWorkStatus';
import { scannerLifecycle } from './scannerLifecycle';
import { commitReceive } from './receiveCommit';
import { isDnsType } from './dns';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { ChannelPicker, type ChannelId } from './ChannelCheckboxes';
import { createPortal } from 'react-dom';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isKioskShell, scannerInputMode } from './kiosk';
import { floorFunctionUrl } from './floorApi';
import { reportClientError } from './clientLog';
import { priceFloorCents } from './scanPricing';
import { errText } from './errText';
import { ManifestReceiveReference, useManifestReceiveReference } from './ManifestReceiveReference';
import { BundleReceive } from './BundleReceive';
const MeasureOnMat = lazy(() => import('./MeasureOnMat').then(module => ({ default: module.MeasureOnMat })));
import { receiveSpecifics, receiveVariant } from '../../../shared/receive-specifics.mjs';
import { notForSaleBrandError, receiveMissingFields } from './receive-validation';
import { CategoryPanel } from './CategoryPanel';
import { EbaySpecificsPanel } from './EbaySpecificsPanel';
import { isCompleteReceiveTitle, isStoreLabelBarcode, storeLabelWarning } from '../../../shared/store-barcode.mjs';

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

type Options = { next_sku: string | null; conditions: unknown; test_statuses: unknown };
type ReceiveLocation = { code: string; bay_no: number; row_no: number; bin_no: number | null };
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
  const b = unbranded ? 'Unbranded' : brand.trim();
  const m = model.trim();
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
  const [stockPhotoBusy, setStockPhotoBusy] = useState(false);
  const [stockPhotoError, setStockPhotoError] = useState('');
  const [manual, setManual] = useState(!!initialManual);
  const [draft, setDraft] = useState('');
  const [queue, setQueue] = useState<Scan[]>([]);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(blank);
  const [files, setFiles] = useState<File[]>([]);
  const [saved, setSaved] = useState<string[]>([]);
  const [manifestId, setManifestId] = useState('');
  const [receiveGroup, setReceiveGroup] = useState<string | null>(null);
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
  const [dns, setDns] = useState(false);
  const dnsRequired = isDnsType(form);
  const doNotShip = dns || dnsRequired;
  const [photoIdBusy, setPhotoIdBusy] = useState(false);
  const [photoIdStatus, setPhotoIdStatus] = useState('');
  const [photoIdError, setPhotoIdError] = useState('');
  const [photoNeed, setPhotoNeed] = useState('');
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
  const priceRequest = useRef(0);
  const dimensionTouched = useRef(new Set<string>());
  const activeScan = useRef<string | null>(null);
  const modalOpen = useRef(false);
  modalOpen.current = camera || dialog !== null;

  const current = manual ? undefined : queue[0];
  useEffect(()=>{setReceiveGroup(null)},[current?.upc,manual,manual ? form.upc : null]);
  const manifestReference = useManifestReceiveReference(client, manual ? form.upc : current?.upc || '');
  const result = current?.result;
  const merged = result?.merged;
  const A = result?.amazon;
  const formOpen = Boolean(manual || (current && current.status !== 'loading' && loadedId === current.id));
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
  const update = (key: keyof Form, value: string) => {
    const dimensionField = ({length:'package_length_in',width:'package_width_in',height:'package_height_in',weight:'package_weight_lb',
      productHeight:'product_height_in',productWidth:'product_width_in',productDepth:'product_depth_in',productWeight:'product_weight_lb'} as Record<string,string>)[key];
    if (dimensionField) {
      dimensionTouched.current.add(key);
      setDimensionSources(prev => ({...prev,[dimensionField]:'staff'}));
    }
    if (key === 'ask') askTouched.current = true;
    if (key === 'title') titleTouched.current = true;
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
      const locations = (data?.locations || []) as ReceiveLocation[];
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
      if (activeScan.current === scanId) setStockPhotoPath(data.path);
      return data.path;
    } catch {
      if (activeScan.current === scanId) setStockPhotoError('Stock photo could not be saved. Tap the save button to retry, or add a unit photo.');
      return null;
    } finally {
      if (activeScan.current === scanId) setStockPhotoBusy(false);
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

  function enqueue(raw: string) {
    const upc = raw.replace(/\s+/g, '');
    if (!upc) return;
    setDraft('');
    if (!/^\d{8,14}$/.test(upc)) { setError(`"${raw.trim()}" does not look like a UPC/EAN (8–14 digits). Scan again or use Enter manually.`); focusUpc(); return; }
    setError('');
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setQueue(q => [...q, { id, upc, status: 'loading' }]);
    runLookup(id, upc);
    focusUpc();
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
    setDimensionSources({});
    dimensionTouched.current.clear();
    setDimensionsError('');
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
      category: text(m?.category),
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
    // Seed may override brand/model — keep title in sync.
    if (!initial.title) initial.title = composeListingTitle(initial.brand, initial.model, initial.unbranded);
    askTouched.current = Boolean(current.seed && 'ask' in current.seed);
    titleTouched.current = Boolean(initial.title);
    setDimensionSources(Object.fromEntries([
      ...(['length_in', 'width_in', 'height_in', 'weight_lb'] as const).map((key, i) => [
        ['package_length_in', 'package_width_in', 'package_height_in', 'package_weight_lb'][i],
        p?.[key] != null ? (r?.fieldCoverage?.package || 'Floor') : '',
      ]),
      ...(['product_height_in', 'product_width_in', 'product_depth_in', 'product_weight_lb'] as const)
        .map(key => [key, m?.aspects?.[key] ? (r?.floor_product ? 'Floor' : 'Amazon') : '']),
    ].filter(([, source]) => source)));
    setForm(initial);
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
    setStockPhotoError('');
    // Instant miss popup (photo fallback). Do not re-prompt the same scan id.
    const identityNeeds = missingIdentityFields(r);
    setPhotoPrice(null);
    if (!identityNeeds.length && m?.title && m?.brand) {
      const priceIdentity = { title: m.title, brand: m.brand, model: m.model || '',
        variant: initial.variant, size: initial.size, unit_count: 1 };
      setPhotoIdentity(priceIdentity);
      void findPhotoPrices(priceIdentity);
    }
    if ((isTrueCatalogMiss(r) || identityNeeds.length > 0) && missPromptedFor.current !== current.id) {
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
    if (!r?.store_label && m?.images?.[0]) void stageStockPhoto(String(m.images[0]), current.upc, scanId);
    if (!r?.store_label && !isTrueCatalogMiss(r) && [initial.length, initial.width, initial.height, initial.weight,
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
    upcInput.current?.blur();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, current?.status, manual, loadedId]);

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
    if (doNotList) return { ask: null, cost: null, dims: [null, null, null, null] };
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
  /** Listing requirements only (price, condition, category, brand, UPC, weight+dims, item specifics, photo). */
  function missingFor(p: Parsed, hasAcceptedStockPhoto = Boolean(stockPhotoPath)): string[] {
    if (doNotList) return receiveMissingFields({ doNotList: true, brandReady: brandReady(), hasPhoto: true });
    const out: string[] = [];
    if (!pos(p.ask)) out.push('price');
    if (!form.condition) out.push('condition');
    if (isDefectiveCondition(form.condition) && !form.conditionNote.trim()) out.push('defect note');
    if (!form.category.trim()) out.push('category');
    if (!brandReady()) out.push('brand');
    if (!upcReady()) out.push('UPC');
    if (!form.model.trim()) out.push('item specifics');
    return receiveMissingFields({ doNotList: false, brandReady: brandReady(), otherGaps: out,
      hasPhoto: Boolean(files.length || hasAcceptedStockPhoto || (!manual && merged?.images?.[0])) });
  }
  const liveMissing = (() => {
    if (doNotShip) return [];
    if (doNotList) return receiveMissingFields({ doNotList: true, brandReady: brandReady(), hasPhoto: true });
    const a = cents(form.ask);
    const out: string[] = [];
    if (!pos(typeof a === 'number' ? a : null)) out.push('price');
    if (!form.condition) out.push('condition');
    if (isDefectiveCondition(form.condition) && !form.conditionNote.trim()) out.push('defect note');
    if (!form.category.trim()) out.push('category');
    if (!brandReady()) out.push('brand');
    if (!upcReady()) out.push('UPC');
    if (!form.model.trim()) out.push('item specifics');
    return receiveMissingFields({ doNotList: false, brandReady: brandReady(), otherGaps: out,
      hasPhoto: Boolean(files.length || stockPhotoPath || (!manual && merged?.images?.[0])) });
  })();

  /* ----- finish ----- */
  async function finish(event?: React.FormEvent) {
    saveTappedAt.current = performance.now();
    event?.preventDefault();
    setError(''); setWarning(''); setSaved([]);
    if (!manual && !current) { setError('Scan a UPC first, or use Enter manually.'); return; }
    const brandError = notForSaleBrandError(doNotList, brandReady());
    if (brandError) { setError(brandError); return; }
    if (!doNotList && photoVerifyPending) { setError('Choose whether the photo or barcode product is correct before saving.'); setDialog('miss-photo'); return; }
    if (!doNotList && photoTitleConfirmed && !isCompleteReceiveTitle(form.title, form.brand)) {
      setError('Enter the full product title, including the brand and what the item is, before saving.'); return;
    }
    if (!manual && current?.status === 'loading') { setError('Lookup still running…'); return; }
    const quantity = Number(form.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) { setError('Quantity must be 1–100.'); return; }
    let acceptedStockPhotoPath = doNotList ? '' : stockPhotoPath;
    if (!doNotList && !files.length && !acceptedStockPhotoPath && stockPhotoBusy) { setError('Stock photo is still preparing. Wait a moment and try again.'); return; }
    if (!doNotList && !files.length && !acceptedStockPhotoPath && !manual && merged?.images?.[0] && current?.upc) {
      acceptedStockPhotoPath = await stageStockPhoto(String(merged.images[0]), current.upc, current.id) || '';
    }
    if (!doNotList && !files.length && !acceptedStockPhotoPath) { setError('Stock photo could not be saved. Retry it or add a unit photo before saving.'); return; }
    if (photoBusy && files.length) { setError('Wait for the unit photo to finish uploading.'); return; }
    if (!doNotList && files.some(file => (file.type && !file.type.startsWith('image/')) || file.size > PHOTO_MAX_BYTES)) {
      setError('Photos must be images under 15 MB each.'); return;
    }
    if (!doNotList && files.some(f => f.size < PHOTO_MIN_BYTES)) { setError('One of the photos looks empty or too small. Retake it.'); return; }
    const parsed = parse();
    if (!parsed) return;
    if (!doNotList && !dupAck && dups && dups.count > 0) { setError('Tap Add another unit to confirm this is a new physical item.'); return; }
    const gaps = missingFor(parsed, Boolean(acceptedStockPhotoPath));
    if (doNotList) {
      if (gaps.length) {
        setWarning(`Saving without listing. Still incomplete (ok for store-only): ${gaps.join(', ')}.`);
      } else {
        setWarning('Saving without listing — hidden from the website and marketplaces.');
      }
      await receive(parsed, null, acceptedStockPhotoPath);
      return;
    }
    if (channels.length) {
      if (gaps.length) {
        setWarning(`Saved to Unfinished. Missing: ${gaps.join(', ')}.`);
      }
      await receive(parsed, null, acceptedStockPhotoPath);
      return;
    }
    // Never block save or price for missing listing fields. Incomplete units keep
    // their ask (if any) and land in Needs attention until Push/list requirements
    // are filled. Marketplace push enforces channel-specific fields.
    if (gaps.length) {
      setWarning(`Saving now. Still needed for listing (Needs attention): ${gaps.join(', ')}.`);
    }
    await receive(parsed, null, acceptedStockPhotoPath);
  }

  async function receive(parsed: Parsed, hold: { reason: string; note: string } | null, acceptedStockPhotoPath = stockPhotoPath) {
    setDialog(null);
    setBusy(true);
    setError('');
    const receiveStarted = performance.now();
    try {
      const quantity = Number(form.quantity);
      if (!doNotList && !files.length && !acceptedStockPhotoPath) throw new Error('Add a photo before saving.');
      const unitPhotoPaths = [...(acceptedStockPhotoPath ? [acceptedStockPhotoPath] : []), ...stagedPhotoPaths];
      if (!doNotList && !unitPhotoPaths.length) throw new Error('The unit photo did not finish uploading. Retry the photo.');
      const holdLabel = hold ? (HOLD_REASONS.find(([k]) => k === hold.reason)?.[1] || hold.reason) : '';
      const notes = [
        isDefectiveCondition(form.condition) ? `Defective/non-sellable: ${form.conditionNote.trim()}` : '',
        hold ? `Not listing — ${holdLabel}${hold.note.trim() ? `: ${hold.note.trim()}` : ''}` : '',
        form.notes.trim(),
      ].filter(Boolean).join('\n');
      const brandValue = form.unbranded ? 'Unbranded' : form.brand.trim();
      // Scans and manual: title is always brand + item specifics (never catalog junk / digit codes).
      const titleValue = form.title.trim() || composeListingTitle(form.brand, form.model, form.unbranded);
      const fields = {
        p_quantity: quantity,
        p_brand: brandValue,
        p_model: form.model.trim(),
        p_title: titleValue,
        p_category: form.category.trim() || null,
        p_description: form.description.trim() || null,
        p_condition: form.condition || null,
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
      const data = await commitReceive(client, storeId, {
        p_request: receiveRequest.current, p_fields: fields, p_photos: unitPhotoPaths,
        p_extras: { group_id: receiveGroup, location: selectedLocation || null, manifest: staffMode ? null : manifestId || null,
          dns: !staffMode && doNotShip, do_not_list: doNotList,
          channels: staffMode || quantity > 1 || receiveGroup ? [] : channels, enrichment,
          stock_photo_paths: acceptedStockPhotoPath ? [acceptedStockPhotoPath] : [],
          photo_identity_confirmed: photoTitleConfirmed,
          photo_identity_type: photoTitleConfirmed ? text(photoIdentity?.item_type) : '' },
      });
      const skus = data.skus as string[];
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
        model: form.model, variant: form.variant, size: form.size,
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
      setSaved(skus); setReceiveGroup(null);
      onSaved();
      void loadOptions().catch(() => setWarning(w => `${w} Refresh Receive to see the next suggested SKU.`.trim()));
      focusUpc();
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
    if (!file) {
      setPhotoIdError('Could not read that photo. Try one clear picture of the box or label.');
      setPhotoIdBusy(false);
      return;
    }
    setError('');
    try {
      if (!alreadyStaged) setFiles([file]);
      if (!alreadyStaged) void savePendingPhotos(pendingPhotoKey(storeId, photoSessionKey.current), [file]);
      if (!alreadyStaged) setStagedPhotoPaths(await stageUnitPhotos([file]));
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
        setPhotoIdError('Photo identification returned only a partial title. Enter the full brand and product name before saving.');
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
      void findPhotoPrices(identity);
      photoCheckedFor.current = current.id;
      setDialog('miss-photo');
      console.info('receive_photo_timing', { compressed_ms: Math.round(compressedMs), upload_ms: Math.round(photoResponse.uploadMs),
        photo_bytes: upload.size, photo_to_filled_ms: Math.round(performance.now() - photoStarted),
        identify_server_ms: json.timing?.identify_ms || null, request_ms: Math.round(photoResponse.requestMs) });
    } catch (e) {
      setPhotoIdError(errText(e) || 'Photo identify failed. Retry or fill fields by hand.');
    } finally {
      setPhotoIdBusy(false);
      setPhotoIdStatus('');
    }
  }

  async function choosePhotoIdentity(usePhoto: boolean) {
    if (!usePhoto) {
      setPhotoCandidate(null);
      setPhotoConflictText('');
      setPhotoVerifyPending(false);
      setDialog(null);
      setWarning('Kept the barcode product details.');
      return;
    }
    if (!current || !photoCandidate) return;
    setPhotoIdBusy(true);
    setPhotoIdError('');
    setPhotoIdStatus('Saving confirmed barcode match…');
    try {
      const response = await fetch(floorFunctionUrl('receive-photo-identify'), {
        method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'confirm_identity', upc: current.upc, fields: photoCandidate }),
        signal: AbortSignal.timeout(25000),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.message || 'Could not save the confirmed product match.');
      const product = data.product || {};
      const brand = text(photoCandidate.brand);
      const title = text(photoCandidate.title);
      const model = text(photoCandidate.model);
      const dimFields = ['length','width','height','weight','productHeight','productWidth','productDepth','productWeight'] as const;
      setForm(prev => {
        const next = { ...prev, brand, unbranded: false, model,
        variant: text(photoCandidate.variant) || prev.variant, size: text(photoCandidate.size) || prev.size,
        category: text(photoCandidate.category) || prev.category,
        description: text(photoCandidate.description) || prev.description, title };
        for (const key of dimFields) if (!dimensionTouched.current.has(key)) next[key] = '';
        return next;
      });
      setDimensionSources(prev => Object.fromEntries(Object.entries(prev).filter(([, value]) => /staff/i.test(value))));
      setPhotoTitleConfirmed(true);
      setPhotoVerifyPending(false);
      setStockPhotoPath('');
      if (Array.isArray(product.images) && product.images[0]) {
        const staged = await stageStockPhoto(String(product.images[0]), current.upc, current.id);
        if (!staged) setWarning('Product confirmed and saved to the UPC catalog, but its matching stock photo could not be saved. Your actual photo will be used.');
        else setWarning('Product confirmed. Its matching stock photo will be photo #1, followed by your unit photo.');
      } else setWarning('Product confirmed and saved to the UPC catalog. No matching stock photo was found; your unit photo will be used.');
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
    if (photoVerifyPending) {
      setForm(prev => ({ ...prev, brand:'', model:'', variant:'', size:'', title:'', category:'', description:'' }));
      setStockPhotoPath('');
      setPhotoTitleConfirmed(false);
    }
    setPhotoVerifyPending(false);
    setDialog(null);
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
  const waiting = queue.length - (current ? 1 : 0);
  const hasFiles = files.length > 0;
  const needNoteForScratch = !doNotList && isDefectiveCondition(form.condition);
  const needsEbayBox = channels.includes('ebay') && [form.length,form.width,form.height,form.weight].some(value => !pos(Number(value.trim())));
  const holdReady = reason !== 'other' || reasonNote.trim().length > 0;
  const catalogMiss = !manual && current?.status === 'ready' ? catalogMissMessage(result) : null;
  const trueMiss = !manual && current?.status === 'ready' && isTrueCatalogMiss(result);

  const hasCatalogPhoto = Boolean(!manual && merged?.images?.[0]);
  const hasAnyPhoto = Boolean(files.length || stagedPhotoPaths.length || stockPhotoPath || hasCatalogPhoto);
  return <section className={`panel receive-panel${appChrome ? ' receive-app' : ''}${storePhoneMode ? ' receive-store-phone' : ''}`}>
    {appChrome && (
      <div className="app-nav receive-app-nav">
        <button type="button" onClick={() => { onAppCancel?.(); }}>Cancel</button>
        <div className="app-nav-title">Receive · {options?.next_sku || '…'}</div>
        {storePhoneMode ? <span className="receive-phone-scanner"><i />Scanner</span> : <button type="button" disabled={busy || photoBusy || photoIdBusy || !hasAnyPhoto} onClick={() => {
          const formEl = document.getElementById('receive-app-form') as HTMLFormElement | null;
          formEl?.requestSubmit();
        }}>Save</button>}
      </div>
    )}
    <div className="receive-next">
      <div className="receive-sku-block">
        <div><div className="eyebrow">NEXT AVAILABLE SKU</div><strong>{options?.next_sku || 'Loading…'}</strong></div>
        {!manual && <label className="receive-upc">Scan UPC
          <input
            ref={upcInput}
            value={draft}
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
            placeholder={isKioskShell() ? 'Scan barcode' : 'Scan or type · Enter'}
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
      </div>
      {!appChrome && (
        <div>
          <p>{doNotList ? 'Store-only: brand is required; all other fields and the photo are optional.' : manual ? 'Manual entry: fill listing fields, add a photo, then receive.' : 'Scan a UPC, edit the listing fields, add a photo, then receive.'}</p>
          <button type="button" className="text-button" onClick={toggleManual}>{manual ? '← Back to scan' : 'Enter manually'}</button>
        </div>
      )}
    </div>

    {!storePhoneMode && <BundleReceive client={client} lastReceived={saved[0]} onSaved={onSaved} />}
    {saved.length > 0 && <EbaySpecificsPanel key={saved[0]} client={client} sku={saved[0]} storeId={storeId} appMode={Boolean(appChrome)} />}
    {saved.length > 0 && !staffMode && <details className="receive-category-details" open><summary>Categories for received items</summary>
      <CategoryPanel client={client} storeId={storeId} initialSku={saved[0]} onSaved={onSaved} />
    </details>}

    {!manual && queue.length > 0 && <p className="hint" role="status">
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
      <ReceiveQuantity value={form.quantity} onChange={value=>update('quantity',value)} disabled={busy} />
      {(Number(form.quantity)>1 || receiveGroup) && <p role="status">Intake only: these units will not be published to any channel.</p>}
      <ReceiveGroupPicker client={client} upc={manual ? form.upc : current?.upc || ''} selected={receiveGroup} onChoose={group=>{
        setReceiveGroup(group?.id || null);
        if(group){setForm(prev=>({...prev,...Object.fromEntries(Object.entries(group.fields).filter(([key])=>!staffMode||key!=='cost').map(([key,v])=>[key,v==null?'':String(v)])),quantity:prev.quantity}));setDupAck(true);}
      }} />
      {dups && dups.count > 0 && <div className="receive-dup" role="status">
        <strong>You have {dups.count} of these</strong>{dups.skus.length ? <> (SKU {dups.skus.slice(0, 8).join(', ')}{dups.skus.length > 8 ? '…' : ''})</> : null}
        {!dupAck ? <> <button type="button" className="secondary" onClick={confirmDup}>Add another unit</button></> : <span className="tag on">confirmed — new unit</span>}
        <p>Each received unit gets a new SKU. Confirm that the batch shares the same condition and representative photos.</p>
      </div>}

      {!manual && current?.status === 'error' && <div className="alert" role="alert">
        <span>Lookup failed: {current.error}. Fill the fields by hand, or retry.</span>
        <button type="button" onClick={() => retry(current)}>Retry</button>
      </div>}

      {catalogMiss && current && <div className="alert" role="alert">
        <span>{catalogMiss}</span>
        {trueMiss && (
          <button type="button" disabled={photoIdBusy} onClick={() => setDialog('miss-photo')}>
            Scan with camera
          </button>
        )}
        <button type="button" onClick={() => retry(current)}>Retry lookup</button>
      </div>}
      {photoIdBusy && <p className="hint" role="status">{photoIdStatus || 'Identifying from photo…'}</p>}

      {!manual && merged?.never_list_reason && <p className="hint">Amazon will not list this: {merged.never_list_reason}</p>}

      {!storePhoneMode && <div className="receive-channel-card">
        {!staffMode && <ChannelPicker value={channels} onChange={setChannels} disabled={doNotList || doNotShip} upc={form.noUpc ? '' : (form.upc || current?.upc || '')} />}
        {!staffMode && <label className="mboard-inline"><input type="checkbox" checked={doNotShip} disabled={dnsRequired} onChange={e => { setDns(e.target.checked); if (e.target.checked) setChannels([]); }} /> DNS — Do not ship</label>}
        <label className="mboard-inline"><input type="checkbox" checked={doNotList} onChange={e => { setDoNotList(e.target.checked); if (e.target.checked) setChannels([]); }} /> Do not list for sale</label>
        {doNotShip && <small>Store / website pickup only. No marketplace listings.</small>}
      </div>}
      {!manual && <div className="receive-confirm">
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
          <textarea ref={titleField} rows={2} value={form.title} onChange={e => update('title', e.target.value)} />
        </label>
        <div className="receive-confirm-fields">
          <label>Brand<input value={form.brand} onChange={e => update('brand', e.target.value)} /></label>
          <label>Model<input value={form.model} onChange={e => update('model', e.target.value)} /></label>
          <label>Variant<input value={form.variant} onChange={e => update('variant', e.target.value)} placeholder="Scent, color…" /></label>
          <label>Size<input value={form.size} onChange={e => update('size', e.target.value)} placeholder="Size or measurements" /></label>
          <label>Floor category<input value={form.category} onChange={e => update('category', e.target.value)} />
            <small>Online store categories are set after saving. Floor fills a suggested eBay category when it finds a match; otherwise search the channel categories below.</small>
          </label>
          <div className="receive-condition-field"><span>Condition</span><div className="receive-chip-row" role="radiogroup" aria-label="Condition">
            {CONDITIONS.map(([value, label]) => <label className={`receive-chip${form.condition === value ? ' on' : ''}`} key={value}>
              <input type="radio" name="receive-condition-main" checked={form.condition === value} onChange={() => update('condition', value)} />{label}
            </label>)}
          </div></div>
        </div>
        {isDefectiveCondition(form.condition) && <label className="receive-confirm-full">Defect note<input value={form.conditionNote} onChange={e => update('conditionNote', e.target.value)} /></label>}
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
          <details className="receive-confirm-prices" open={storePhoneMode}><summary>{photoPriceBusy ? 'Searching prices...' : !photoIdentity ? 'Price reference unavailable' : photoPriceError ? 'Price search incomplete' : photoPrice?.median_cents != null
            ? `Online asking price ~${money(photoPrice.median_cents)} (${photoPrice.count} listings, ${money(photoPrice.low_cents)}–${money(photoPrice.high_cents)})`
            : photoPrice?.count ? `Online price ${money(photoPrice.low_cents)}${photoPrice.count > 1 ? `–${money(photoPrice.high_cents)}` : ''}` : 'Price reference unavailable'}</summary>
            {photoPrice?.listings?.map(listing => <a key={listing.url} href={listing.url} target="_blank" rel="noreferrer">{listing.store} · {money(listing.price_cents)} · {listing.product_name}</a>)}
            {photoPrice?.highest_retail && <small>Highest retail seen: {photoPrice.highest_retail.store} · {money(photoPrice.highest_retail.price_cents)}</small>}
            {photoPriceError && <><span>{photoPriceError}</span>{photoIdentity && <button type="button" className="secondary" onClick={() => void findPhotoPrices(photoIdentity)}>Retry prices</button>}</>}
          </details>
          {photoPrice?.listings?.[0] && <a className="receive-confirm-source" href={photoPrice.listings[0].url} target="_blank" rel="noreferrer">
            {photoPrice.listings[0].store} · {money(photoPrice.listings[0].price_cents)} · source ↗</a>}
          <div className="receive-confirm-bottom-row">
            <label>Price<ManifestReceiveReference result={manifestReference} /><input inputMode="decimal" placeholder="0.00" value={form.ask} onChange={e => update('ask',e.target.value)} /></label>
            {!staffMode && <label>Cost<input inputMode="decimal" placeholder="Leave blank if unknown" value={form.cost} onChange={e => update('cost',e.target.value)} /></label>}
          </div>
          <div className="receive-location-card"><label>Location<select value={selectedLocation} onChange={e => setSelectedLocation(e.target.value)}>
            <option value="">No location yet</option>{receiveLocations.map(location => <option key={location.code} value={location.code}>Bay {location.bay_no} · R{location.row_no}{location.bin_no == null ? '' : `-B${location.bin_no}`}{location.code === selectedLocation ? ' · same as last item' : ''}</option>)}
          </select></label>{(!storePhoneMode || locationEditOpen) && <label className="receive-location-scan">Scan bin label<input inputMode={scannerInputMode()} value={locationScan} placeholder="Bay 12 · R2-B3" onChange={e => setLocationScan(e.target.value)} onKeyDown={e => {
            if (e.key !== 'Enter') return; e.preventDefault();
            const parts = locationScan.trim().match(/(?:bay\s*)?(\d+)\s*[·\s-]+\s*r?(\d+)(?:\s*-\s*b?\s*(\d+))?/i);
            const code = parts ? `${parts[1]}-${parts[2]}${parts[3] ? `-${parts[3]}` : ''}` : locationScan.trim();
            const match = receiveLocations.find(location => location.code === code || `Bay ${location.bay_no} · R${location.row_no}${location.bin_no == null ? '' : `-B${location.bin_no}`}`.toLowerCase() === locationScan.trim().toLowerCase());
            if (match) { setSelectedLocation(match.code); setLocationScan(''); setLocationEditOpen(false); } else setError('That barcode does not match a configured bay, row and bin.');
          }} /></label>}<button type="button" className="text-button" onClick={() => {
            if (storePhoneMode) setLocationEditOpen(value => !value);
            else { setSelectedLocation(''); setLocationScan(''); }
          }}>{storePhoneMode ? locationEditOpen ? 'Done' : 'Change' : 'Change'}</button></div>
          {selectedLocation && <small className="receive-last-location">Bay {receiveLocations.find(l => l.code === selectedLocation)?.bay_no} · same as last item</small>}
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

      <details className={`receive-advanced${manual ? ' receive-manual' : ''}`} open={manual}><summary>{manual ? 'Receive details' : 'More options'}</summary><div className="unit-edit-grid">
        <label className={liveMissing.includes('price') ? 'receive-need' : undefined}>
          Price{liveMissing.includes('price')
            ? ' (needed to list)'
            : ((retail || photoPrice?.count) ? ' (reference only — enter your selling price)' : ' (enter your selling price)')}
          <ManifestReceiveReference result={manifestReference} />
          <input inputMode="decimal" placeholder="24.99" value={form.ask} onChange={e => update('ask', e.target.value)} autoComplete="off" />
        </label>

        <div className={`unit-edit-wide receive-cond${liveMissing.includes('condition') ? ' receive-need' : ''}`} role="radiogroup" aria-label="Condition">
          <span className="receive-label">Condition{liveMissing.includes('condition') ? ' (needed to list)' : ''}</span>
          {manual
            ? <select value={form.condition} onChange={e => update('condition', e.target.value)}>
              <option value="">—</option>{[...new Set([...choices(options?.conditions), SCRATCH])].map(x => <option key={x} value={x}>{x}</option>)}
            </select>
            : <div className="receive-cond-row">{CONDITIONS.map(([value, text2]) => <label key={value} className={form.condition === value ? 'receive-chip on' : 'receive-chip'}>
              <input type="radio" name="receive-condition" value={value} checked={form.condition === value} onChange={() => update('condition', value)} />{text2}
            </label>)}</div>}
        </div>
        {needNoteForScratch && <label className="unit-edit-wide">What is defective / why non-sellable? (required)<textarea rows={2} value={form.conditionNote} onChange={e => update('conditionNote', e.target.value)} /></label>}

        <label className={liveMissing.includes('category') ? 'receive-need' : undefined}>
          Floor category{liveMissing.includes('category') ? ' (needed to list)' : ''}
          <input value={form.category} onChange={e => update('category', e.target.value)} />
          <small>Online store categories are set after saving. Floor fills a suggested eBay category when it finds a match; otherwise search the channel categories below.</small>
        </label>

        <label className={liveMissing.includes('brand') ? 'receive-need' : undefined}>
          Brand{liveMissing.includes('brand') ? (doNotList ? ' (required to save)' : ' (needed to list)') : ''}
          <input value={form.unbranded ? 'Unbranded' : form.brand} disabled={form.unbranded} onChange={e => update('brand', e.target.value)} />
        </label>
        <label className="mboard-inline">
          <input type="checkbox" checked={form.unbranded} onChange={e => setForm(p => {
            const unbranded = e.target.checked;
            return {
              ...p,
              unbranded,
              title: composeListingTitle(p.brand, p.model, unbranded),
            };
          })} />
          Unbranded — no brand anywhere on the product or packaging
        </label>

        <label className={liveMissing.includes('UPC') ? 'receive-need' : undefined}>
          UPC{liveMissing.includes('UPC') ? ' (needed to list)' : ''}
          <input
            value={form.noUpc ? UPC_NOT_APPLICABLE : form.upc}
            disabled={form.noUpc}
            onChange={e => {
              const v = e.target.value;
              setForm(p => ({ ...p, upc: v, noUpc: false }));
              setDups(null); setDupAck(false);
            }}
            /* Always allow the soft keyboard on the form UPC field (kiosk mode hides it only on the scan box). */
            inputMode="numeric"
            autoComplete="off"
            placeholder="optional — or mark No UPC below"
          />
        </label>
        <label className="mboard-inline">
          <input type="checkbox" checked={form.noUpc} onChange={e => {
            const on = e.target.checked;
            setForm(p => ({ ...p, noUpc: on, upc: on ? '' : p.upc }));
            setDups(null); setDupAck(false);
          }} />
          No UPC / doesn’t have a barcode — marketplaces get “Does not apply”
        </label>

        <label>
          Length (in)
          <input inputMode="decimal" value={form.length} onChange={e => update('length', e.target.value)} />
        </label>
        <label>
          Width (in)
          <input inputMode="decimal" value={form.width} onChange={e => update('width', e.target.value)} />
        </label>
        <label>
          Height (in)
          <input inputMode="decimal" value={form.height} onChange={e => update('height', e.target.value)} />
        </label>
        <label>
          Weight (lb)
          <input inputMode="decimal" value={form.weight} onChange={e => update('weight', e.target.value)} />
        </label>

        <label className={`unit-edit-wide${liveMissing.includes('item specifics') ? ' receive-need' : ''}`}>
          Item specifics{liveMissing.includes('item specifics') ? ' (needed to list)' : (formatAspectsLine(merged?.aspects) && !text(merged?.model) ? ' (from UPC lookup)' : '')}
          <input
            value={form.model}
            onChange={e => update('model', e.target.value)}
            placeholder="Model, flavor, size, color… (from UPC when available)"
            autoComplete="off"
            enterKeyHint="done"
            autoCapitalize="sentences"
          />
        </label>

        <label className="unit-edit-wide">
          Title
          <input
            value={form.title}
            onChange={e => update('title', e.target.value)}
            placeholder="Brand + item specifics"
            autoComplete="off"
          />
          <span className="hint">Auto-filled as brand + item specifics (scans and manual).</span>
        </label>
        {manual && <label className="unit-edit-wide">Description / features<textarea rows={3} value={form.description} onChange={e => update('description', e.target.value)} /></label>}
        {manual && !staffMode && <label>Cost (optional)<input inputMode="decimal" placeholder="9.00" value={form.cost} onChange={e => update('cost', e.target.value)} /></label>}
        {!staffMode && <label className="unit-edit-wide">Manifest (optional)
          <select value={manifestId} onChange={e => setManifestId(e.target.value)}>
            <option value="">No manifest</option>
            {manifests.map(m => <option key={m.id} value={m.id}>{m.name} · {m.manifest_on}</option>)}
          </select>
        </label>}

        <div className={`unit-edit-wide${liveMissing.includes('photo') ? ' receive-need' : ''}`}>
          <span className="receive-label">Photo{doNotList || manual ? ' (optional)' : (liveMissing.includes('photo') ? ' (needed to list)' : '')}</span>
          <div className="actions">
            {/* Buttons + programmatic click — label+sr-only file inputs often do nothing in iOS PWA. */}
            <input
              ref={takePhotoFile}
              type="file"
              accept="image/*"
              capture="environment"
              className="sr-only"
              aria-hidden
              tabIndex={-1}
              onChange={e => {
                const input = e.currentTarget;
                const list = input.files;
                // Copy bytes before clearing — clearing first empties the File on some Android PWAs.
                void ingestFiles(list).finally(() => { input.value = ''; });
              }}
            />
            <input
              ref={choosePhotoFile}
              type="file"
              accept="image/*"
              multiple
              className="sr-only"
              aria-hidden
              tabIndex={-1}
              onChange={e => {
                const input = e.currentTarget;
                const list = input.files;
                void ingestFiles(list).finally(() => { input.value = ''; });
              }}
            />
            <button type="button" className="secondary receive-file-btn" disabled={photoBusy || busy} onClick={() => takePhotoFile.current?.click()}>
              {photoBusy ? 'Saving photo…' : 'Take photo'}
            </button>
            <button type="button" className="secondary receive-file-btn" disabled={photoBusy || busy} onClick={() => choosePhotoFile.current?.click()}>
              Choose photos
            </button>
          </div>
          {hasFiles && <div className="receive-photos">{files.map((f, i) => <figure key={`${f.name}-${f.size}-${i}`}>
            <img src={previews[i]} alt={`Photo ${i + 1}`} />
            <button type="button" className="text-button" onClick={() => {
              const path=stagedPhotoPaths[i];
              if(path) void client.storage.from('unit-photos').remove([path]);
              setStagedPhotoPaths(prev=>prev.filter((_,j)=>j!==i));
              setFiles(prev => {
                const next = prev.filter((_, j) => j !== i);
                void savePendingPhotos(pendingPhotoKey(storeId, photoSessionKey.current), next);
                return next;
              });
            }}>Remove</button>
          </figure>)}</div>}
        </div>

        <label className="mboard-inline unit-edit-wide">
          <input
            type="checkbox"
            checked={doNotList}
            onChange={e => {
              const on = e.target.checked;
              setDoNotList(on);
              if (on) {
                setChannels([]);
              }
            }}
          />
          Do not list for sale
        </label>
        {!staffMode && <ChannelPicker value={channels} onChange={setChannels} disabled={doNotList || doNotShip} upc={form.noUpc ? '' : (form.upc || current?.upc || '')} />}
      </div>

      <p className="hint receive-check">
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
      </p>
      <div className="actions">
        <button disabled={busy || (doNotList ? (photoBusy && hasAnyPhoto) : photoBusy || stockPhotoBusy || photoIdBusy || !hasAnyPhoto) || (dups !== null && dups.count > 0 && !dupAck)}>{busy ? 'Receiving…' : doNotList ? 'Receive store-only unit' : stockPhotoBusy || photoIdBusy ? 'Preparing photo…' : hasCatalogPhoto && !files.length && !stockPhotoPath ? 'Use stock photo & receive' : hasAnyPhoto ? 'Finish & receive' : 'Take a photo to save'}</button>
        {!manual && current && <button type="button" className="secondary" disabled={busy} onClick={skipCurrent}>Skip this scan</button>}
      </div>
      </details>
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
        </div>
      </div>
    </div>}

    {dialog === 'miss-photo' && <div className="receive-modal" role="dialog" aria-modal="true" aria-labelledby="miss-photo-title">
      <div className="receive-modal-card">
        <h3 id="miss-photo-title">{photoCandidate ? 'Confirm product from photo' : photoNeed ? 'More product details needed' : 'Can\'t find this item. Scan with camera?'}</h3>
        <p>{photoCandidate ? photoConflictText : `${photoNeed || 'Take one clear photo of the box or label.'} We\'ll identify the product and show asking prices so you can set the price.`}</p>
        <ManifestReceiveReference result={manifestReference} />
        {previews[0] && <img src={previews[0]} alt="Photo being identified" style={{ maxWidth: '100%', maxHeight: 180, objectFit: 'contain' }} />}
        {photoIdBusy && <p role="status">{photoIdStatus || 'Identifying product…'}</p>}
        {photoIdError && <p className="alert" role="alert">{photoIdError}</p>}
        {photoCandidate && <div className="receive-photo-candidate">
          <strong>{text(photoCandidate.title)}</strong>
          <span>{[text(photoCandidate.brand), text(photoCandidate.model), text(photoCandidate.size), text(photoCandidate.color)].filter(Boolean).join(' · ')}</span>
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
          {!current?.result?.store_label && current?.result?.merged?.title && <button type="button" className="secondary" disabled={photoIdBusy} onClick={() => void choosePhotoIdentity(false)}>Keep barcode product</button>}
        </div> : <div className="actions">
          <button type="button" disabled={photoIdBusy} autoFocus onClick={() => missPhotoFile.current?.click()}>
            {photoIdError ? 'Retry photo' : 'Yes — take photo'}
          </button>
          <button type="button" className="secondary" disabled={photoIdBusy} onClick={() => missChooseFile.current?.click()}>Choose photo</button>
          {photoVerifyPending && current?.result?.merged?.title && <button type="button" className="secondary" disabled={photoIdBusy} onClick={() => void choosePhotoIdentity(false)}>Keep barcode product</button>}
          <button type="button" className="secondary" disabled={photoIdBusy} onClick={dismissPhotoCheck}>
            No — fill by hand
          </button>
        </div>}
      </div>
    </div>}

  </section>;
}
