import { useEffect, useMemo, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isKioskShell, scannerInputMode } from './kiosk';
import { floorFunctionUrl } from './floorApi';
import { reportClientError } from './clientLog';
import { categoryDefaultCostCents, priceFloorCents, suggestAskCents } from './scanPricing';

/* ------------------------------------------------------------------------------------------------
 * Receive = scan-to-list.
 *   scan UPC -> Amazon + UPCitemdb lookup -> review/fix fields -> real photo + condition -> price
 *   -> completeness check -> "Ready to list?" -> receive (portal_receive_unit) -> photo upload ->
 *   merge lookup data into units.listing_specs.
 * "Enter manually" falls back to the old blank form (no lookup).
 * ---------------------------------------------------------------------------------------------- */

type Options = { next_sku: string | null; conditions: unknown; test_statuses: unknown };
type Props = { client: SupabaseClient; storeId: string; accessToken: string; onSaved: () => void };

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
  package?: Pkg;
  price_cents?: number | null;
  price_source?: string | null;
  price_as_of?: string | null;
  price_pending?: boolean;
  msrp_cents?: number | null;
  raw_error?: string | null;
};
type Disagreement = { field: string; amazon?: string | number | null; upcitemdb?: string | number | null };
type Lookup = {
  gtin?: { gtin14?: string; upcA?: string; ean13?: string };
  cached?: boolean;
  amazon?: Source;
  upcitemdb?: Source;
  merged?: {
    title?: string | null; brand?: string | null; model?: string | null; description?: string | null;
    category?: string | null;
    features?: string[]; package?: Pkg; asin?: string | null; msrp_cents?: number | null;
    retail_cents?: number | null; retail_source?: string | null; retail_as_of?: string | null;
    disagreements?: Disagreement[]; never_list_reason?: string | null;
  };
  fieldCoverage?: { package?: string | null };
};

  type Form = {
  brand: string; unbranded: boolean; model: string; title: string; category: string; description: string;
  condition: string; conditionNote: string; testStatus: string; ask: string; cost: string;
  notes: string; upc: string; quantity: string; shippable: string;
  length: string; width: string; height: string; weight: string;
  costEstimate: boolean;
};
const blank: Form = {
  brand: '', unbranded: false, model: '', title: '', category: '', description: '', condition: '', conditionNote: '', testStatus: '',
  ask: '', cost: '', notes: '', upc: '', quantity: '1', shippable: 'auto',
  length: '', width: '', height: '', weight: '', costEstimate: false,
};

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
const SCRATCH = 'Scratch & dent';
const CONDITIONS: [string, string][] = [[NEW, 'New (sealed)'], [OPEN, 'Open box'], [SCRATCH, 'Scratch & dent']];
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
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const num = (n: number | null | undefined) => (pos(n) ? String(n) : '');
const label = (s: string | null | undefined) => (s || '').replace(/_/g, ' ');

function pkgText(p?: Pkg) {
  if (!p) return '';
  const dims = [p.length_in, p.width_in, p.height_in];
  const d = dims.every(pos) ? `${dims.join(' × ')} in` : '';
  const w = pos(p.weight_lb) ? `${p.weight_lb} lb` : '';
  return [d, w].filter(Boolean).join(' · ');
}

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
  const raw = body?.error || body?.message || (err instanceof Error ? err.message : String(err || ''));
  const lower = raw.toLowerCase();
  if (err instanceof DOMException && err.name === 'AbortError') return 'Lookup timed out — the server took too long. Retry or enter manually.';
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(raw)) {
    return "Couldn't reach the lookup server (network/CORS). Retry once; if it keeps failing, enter manually.";
  }
  if (status === 401 || /not_logged_in|sign in required|not_signed_in/i.test(lower)) return 'Not logged in — sign in again, then retry the scan.';
  if (status === 403 || /not_authorized|staff access|not_owner|not_staff/i.test(lower)) return 'Not authorized for lookup — ask an admin to check your staff access.';
  if (status === 429 || /rate.?limit|quota/i.test(lower)) return 'Amazon rate-limited pricing — catalog may still show; retry in a moment for the price.';
  if (/invalid_gtin|upc_required/i.test(lower)) return 'That barcode does not look like a valid UPC/EAN.';
  if (/not found|no source|upcitemdb/i.test(lower) && status === 404) return 'UPC not found in Amazon or UPCitemdb — fill the fields by hand.';
  if (raw && raw !== 'Failed to fetch') return raw;
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

async function decodeFile(file: File): Promise<string | null> {
  const Ctor = detectorCtor();
  if (!Ctor) return null;
  try {
    const bitmap = await createImageBitmap(file);
    const codes = await new Ctor({ formats: FORMATS }).detect(bitmap);
    return codes[0]?.rawValue || null;
  } catch { return null; }
}

function CameraScanner({ onDetect, onFile, onClose }: {
  onDetect: (code: string) => void; onFile: (file: File) => void; onClose: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const done = useRef(false);
  const detect = useRef(onDetect);
  detect.current = onDetect;
  const [err, setErr] = useState('');
  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer = 0;
    let stopped = false;
    void (async () => {
      try {
        const Ctor = detectorCtor();
        if (!Ctor) throw new Error('This browser cannot read barcodes from the camera.');
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } });
        if (stopped) { stream.getTracks().forEach(t => t.stop()); return; }
        const el = video.current;
        if (!el) return;
        el.srcObject = stream;
        await el.play();
        const detector = new Ctor({ formats: FORMATS });
        timer = window.setInterval(() => {
          void detector.detect(el).then(codes => {
            const raw = codes[0]?.rawValue;
            if (raw && !done.current) { done.current = true; detect.current(raw); }
          }).catch(() => undefined);
        }, 250);
      } catch (e) { setErr(e instanceof Error ? e.message : 'Camera unavailable.'); }
    })();
    return () => { stopped = true; window.clearInterval(timer); stream?.getTracks().forEach(t => t.stop()); };
  }, []);
  return <div className="receive-modal" role="dialog" aria-modal="true" aria-label="Scan barcode with camera">
    <div className="receive-modal-card">
      <h3>Scan barcode</h3>
      {err ? <p className="error">{err}</p> : <video ref={video} className="receive-video" playsInline muted />}
      <div className="actions">
        <label className="secondary receive-file-btn">Take photo of barcode
          <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onFile(f); }} />
        </label>
        <button type="button" className="secondary" onClick={onClose}>Close</button>
      </div>
    </div>
  </div>;
}

/* ================================================================================================ */

export function ReceivePanel({ client, storeId, accessToken, onSaved }: Props) {
  const [options, setOptions] = useState<Options | null>(null);
  const [manual, setManual] = useState(false);
  const [draft, setDraft] = useState('');
  const [queue, setQueue] = useState<Scan[]>([]);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(blank);
  const [files, setFiles] = useState<File[]>([]);
  const [saved, setSaved] = useState<string[]>([]);
  const [last, setLast] = useState<LastReceived | null>(null);
  const [warning, setWarning] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dups, setDups] = useState<Dups | null>(null);
  const [dupAck, setDupAck] = useState(false);
  const [dialog, setDialog] = useState<null | 'ready' | 'reason'>(null);
  const [reason, setReason] = useState('damaged');
  const [reasonNote, setReasonNote] = useState('');
  const [camera, setCamera] = useState(false);

  const upcInput = useRef<HTMLInputElement>(null);
  const cameraFile = useRef<HTMLInputElement>(null);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(true);
  const askTouched = useRef(false);
  const activeScan = useRef<string | null>(null);
  const modalOpen = useRef(false);
  modalOpen.current = camera || dialog !== null;

  const current = manual ? undefined : queue[0];
  const result = current?.result;
  const merged = result?.merged;
  const A = result?.amazon;
  const U = result?.upcitemdb;
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
  const suggestion = useMemo(() => suggestAskCents(retail?.cents ?? null, floor), [retail, floor]);

  const focusUpc = () => { requestAnimationFrame(() => upcInput.current?.focus()); };
  const update = (key: keyof Form, value: string) => {
    if (key === 'ask') askTouched.current = true;
    setForm(prev => {
      const next = { ...prev, [key]: value };
      if (key === 'cost') next.costEstimate = false;
      return next;
    });
  };

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { focusUpc(); }, []);

  async function loadOptions() {
    const { data, error: e } = await client.rpc('portal_receive_options');
    if (e) throw e;
    setOptions(data as Options);
  }
  useEffect(() => { void loadOptions().catch(e => setError(e instanceof Error ? e.message : String(e))); }, [client]);

  /* ----- photo previews ----- */
  const previews = useMemo(() => files.map(f => URL.createObjectURL(f)), [files]);
  useEffect(() => () => { previews.forEach(u => URL.revokeObjectURL(u)); }, [previews]);

  /* ----- duplicate check ----- */
  async function findDups(variants: string[]): Promise<Dups | null> {
    if (!variants.length) return null;
    const { data, error: e } = await client.from('units').select('sku')
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
        const msg = e instanceof Error ? e.message : String(e);
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

  function retry(scan: Scan) {
    setQueue(q => q.map(s => (s.id === scan.id ? { ...s, status: 'loading', error: undefined } : s)));
    setLoadedId(null);
    runLookup(scan.id, scan.upc);
  }

  function resetEntry(keepProduct?: Partial<Form>) {
    askTouched.current = false;
    setForm({ ...blank, ...keepProduct });
    setFiles([]);
    setDups(null);
    setDupAck(false);
    setDialog(null);
    setReason('damaged');
    setReasonNote('');
  }

  /* Load the head of the queue into the form once its lookup has settled. */
  useEffect(() => {
    if (manual) return;
    if (!current) { if (loadedId !== null) { setLoadedId(null); resetEntry(); } return; }
    if (current.status === 'loading' || loadedId === current.id) return;
    const r = current.result;
    const m = r?.merged;
    const p = m?.package;
    const retailNow = retailOf(r);
    const defaultCost = categoryDefaultCostCents({
      title: m?.title, brand: m?.brand, model: m?.model, category: m?.category,
    });
    const floorSuggest = priceFloorCents({
      costCents: null,
      weightLb: p?.weight_lb ?? null,
      title: m?.title, brand: m?.brand, model: m?.model, category: m?.category,
    });
    const suggested = suggestAskCents(retailNow?.cents ?? null, floorSuggest);
    const initial: Form = {
      ...blank,
      upc: current.upc,
      brand: text(m?.brand),
      unbranded: false,
      model: text(m?.model),
      title: text(m?.title),
      category: text(m?.category),
      // description falls back to the real feature bullets from the lookup; never invented text
      description: text(m?.description) || featuresText(m?.features),
      length: num(p?.length_in), width: num(p?.width_in), height: num(p?.height_in), weight: num(p?.weight_lb),
      ask: suggested ? dollars(suggested) : '',
      cost: dollars(defaultCost.cents),
      ...(current.seed || {}),
      costEstimate: current.seed?.cost ? false : true,
    };
    askTouched.current = Boolean(current.seed && 'ask' in current.seed);
    setForm(initial);
    setFiles([]);
    setDialog(null);
    setDupAck(Boolean(current.again));
    setDups(null);
    if (!current.again) setLast(null);
    setLoadedId(current.id);
    activeScan.current = current.id;
    const scanId = current.id;
    void findDups(upcVariants(current.upc, r)).then(d => { if (mounted.current && activeScan.current === scanId) setDups(d); });
    focusUpc();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, current?.status, manual, loadedId]);

  /* Cost changes can move the suggestion (cost floor); only follow it until the user edits price. */
  useEffect(() => {
    if (manual || askTouched.current || !suggestion) return;
    setForm(p => (p.ask === dollars(suggestion) ? p : { ...p, ask: dollars(suggestion) }));
  }, [suggestion, manual]);

  function toggleManual() {
    setError(''); setWarning('');
    if (!manual) { setManual(true); return; }
    setManual(false);
    setLoadedId(null);
    resetEntry();
  }

  /* ----- helpers on the compare table ----- */
  const disagree = new Map<string, Disagreement>((merged?.disagreements || []).map(d => [d.field, d]));
  const pkgDisagrees = [...disagree.keys()].some(k => k.startsWith('package.'));
  const setFrom = (key: 'title' | 'brand' | 'model', value?: string | null) => { if (value) update(key, value); };
  const setPackage = (p?: Pkg) => {
    if (!p) return;
    setForm(prev => ({
      ...prev,
      length: num(p.length_in) || prev.length, width: num(p.width_in) || prev.width,
      height: num(p.height_in) || prev.height, weight: num(p.weight_lb) || prev.weight,
    }));
  };

  /* ----- validation / completeness ----- */
  type Parsed = { ask: number | null; cost: number | null; dims: (number | null)[] };
  function parse(): Parsed | null {
    const ask = cents(form.ask);
    const cost = cents(form.cost);
    if (ask === undefined) { setError('Price must look like 24.99.'); return null; }
    if (cost === undefined) { setError('Cost must look like 9.00 (blank = unknown).'); return null; }
    const dims = [form.length, form.width, form.height, form.weight].map(v => {
      const t = v.trim();
      if (!t) return null;
      const n = Number(t);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    });
    if (dims.some(v => v === undefined)) { setError('Dimensions and weight must be positive numbers (or blank).'); return null; }
    return { ask, cost, dims: dims as (number | null)[] };
  }
  function brandReady() {
    if (form.unbranded) return true;
    const value = form.brand.trim();
    if (!value) return false;
    return !/^(generic|unknown|n\/?a|does not apply)$/i.test(value);
  }
  function missingFor(p: Parsed): string[] {
    const out: string[] = [];
    if (!brandReady()) out.push('brand');
    if (!form.title.trim()) out.push('title');
    if (!form.category.trim()) out.push('category');
    if (!form.condition) out.push('condition');
    if (!(form.upc.trim() || current?.upc || '').trim()) out.push('UPC');
    if (!pos(p.ask)) out.push('price');
    if (!form.description.trim()) out.push('description/features');
    if (p.dims.some(d => !pos(d))) out.push('package L/W/H/weight');
    if (!files.length) out.push('photo');
    return out;
  }
  const liveMissing = (() => {
    const a = cents(form.ask);
    const dims = [form.length, form.width, form.height, form.weight].map(v => Number(v.trim()));
    const out: string[] = [];
    if (!brandReady()) out.push('brand');
    if (!form.title.trim()) out.push('title');
    if (!form.category.trim()) out.push('category');
    if (!form.condition) out.push('condition');
    if (!(form.upc.trim() || current?.upc || '').trim()) out.push('UPC');
    if (!pos(typeof a === 'number' ? a : null)) out.push('price');
    if (!form.description.trim()) out.push('description/features');
    if (dims.some(d => !pos(d))) out.push('package L/W/H/weight');
    if (!files.length) out.push('photo');
    return out;
  })();

  /* ----- finish ----- */
  async function finish(event?: React.FormEvent) {
    event?.preventDefault();
    setError(''); setWarning(''); setSaved([]);
    if (!manual && !current) { setError('Scan a UPC first, or use Enter manually.'); return; }
    if (!manual && current?.status === 'loading') { setError('Lookup still running…'); return; }
    const quantity = manual ? Number(form.quantity) : 1;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) { setError('Quantity must be 1–100.'); return; }
    if (files.some(file => !file.type.startsWith('image/') || file.size > 15 * 1024 * 1024)) {
      setError('Photos must be images under 15 MB each.'); return;
    }
    if (!manual) {
      if (!files.length) { setError('Add at least one real photo of this unit before finishing.'); return; }
      if (files.some(f => f.size < 2048)) { setError('One of the photos looks empty or too small. Retake it.'); return; }
      if (!form.condition) { setError('Pick a condition: New (sealed), Open box, or Scratch & dent.'); return; }
    }
    if (form.condition === SCRATCH && !form.conditionNote.trim()) { setError('Scratch & dent needs a note describing the damage.'); return; }
    const parsed = parse();
    if (!parsed) return;
    // Duplicate check right before create (another device may have received it meanwhile).
    if (!dupAck) {
      const upc = (manual ? form.upc : current?.upc || '').trim();
      const d = await findDups(upcVariants(upc, result));
      if (d && d.count > 0) { setDups(d); setError(`You already have ${d.count} of these in stock. Tap "Add another unit" to confirm this is a new one.`); return; }
    }
    const gaps = missingFor(parsed);
    if (pos(parsed.ask) && gaps.length) {
      setError(`Fill these before saving a price: ${gaps.join(', ')}. Clear the price to receive it into Needs attention.`);
      return;
    }
    if (gaps.length === 0) { setDialog('ready'); return; }
    await receive(parsed, null);
  }

  async function receive(parsed: Parsed, hold: { reason: string; note: string } | null) {
    setDialog(null);
    setBusy(true);
    setError('');
    try {
      const quantity = manual ? Number(form.quantity) : 1;
      const holdLabel = hold ? (HOLD_REASONS.find(([k]) => k === hold.reason)?.[1] || hold.reason) : '';
      const notes = [
        form.condition === SCRATCH ? `Scratch & dent: ${form.conditionNote.trim()}` : '',
        hold ? `Not listing — ${holdLabel}${hold.note.trim() ? `: ${hold.note.trim()}` : ''}` : '',
        form.notes.trim(),
      ].filter(Boolean).join('\n');
      const { data, error: e } = await client.rpc('portal_receive_unit', {
        p_quantity: quantity,
        p_brand: form.unbranded ? 'Unbranded' : form.brand.trim(),
        p_model: form.model.trim(),
        p_title: form.title.trim(),
        p_category: form.category.trim() || null,
        p_description: form.description.trim() || null,
        p_condition: form.condition || null,
        p_test_status: form.testStatus || null,
        p_ask_cents: hold ? null : parsed.ask, // held units never get an ask
        p_cost_cents: parsed.cost ?? floor.costCents,
        p_notes: notes || null,
        p_upc: form.upc.trim() || current?.upc || null,
        p_shippable: form.shippable,
        p_length: parsed.dims[0],
        p_width: parsed.dims[1],
        p_height: parsed.dims[2],
        p_weight: parsed.dims[3],
      });
      if (e) throw e;
      const skus = (data as { skus: string[] }).skus;
      setSaved(skus);
      const warnings: string[] = [];

      let failed = 0;
      for (const sku of skus) for (const file of files) {
        const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_') || 'photo.jpg';
        const path = `${storeId}/${sku}/${Date.now()}-${crypto.randomUUID()}-${safe}`;
        try {
          const upload = await client.storage.from('unit-photos').upload(path, file, { contentType: file.type, upsert: false });
          if (upload.error) throw upload.error;
          const linked = await client.rpc('portal_add_unit_photo', { p_sku: sku, p_path: path });
          if (linked.error) throw linked.error;
        } catch { failed++; }
      }
      if (failed) warnings.push(`${failed} photo upload(s) did not finish. The unit(s) were received; they will show under Needs attention → Missing photo.`);

      // Merge lookup data (and any hold) into the new unit(s).
      const blocked = skus.includes(NEVER_LIST_SKU);
      const enrichFailed = await enrichUnits(skus, parsed, hold, blocked);
      if (enrichFailed) warnings.push(`Could not save lookup details on ${enrichFailed} unit(s).${hold ? ' They have no price, so they will not list.' : ''}`);
      if (blocked) warnings.push(`SKU ${NEVER_LIST_SKU} is a permanent do-not-list item; it was hidden from the website.`);
      if (warnings.length) setWarning(warnings.join(' '));

      // Remember product data for "Add another unit".
      const seed: Partial<Form> = {
        brand: form.unbranded ? 'Unbranded' : form.brand, unbranded: form.unbranded, model: form.model, title: form.title, category: form.category, description: form.description,
        ask: hold ? '' : form.ask, testStatus: '', shippable: form.shippable,
        length: form.length, width: form.width, height: form.height, weight: form.weight, upc: form.upc || current?.upc || '',
      };
      if (hold) delete seed.ask;
      setLast({ upc: (form.upc || current?.upc || '').trim(), result, seed });

      if (manual) {
        askTouched.current = false;
        setForm(prev => ({ ...blank, brand: prev.brand, condition: prev.condition, testStatus: prev.testStatus, shippable: prev.shippable }));
        setFiles([]); setDups(null); setDupAck(false);
      } else {
        const doneId = current?.id;
        setQueue(q => q.filter(s => s.id !== doneId));
        setLoadedId(null);
        resetEntry();
      }
      onSaved();
      await loadOptions().catch(() => setWarning(w => `${w} Units were received. Refresh the page to see the next suggested SKU.`.trim()));
      focusUpc();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  /** Build listing_specs from the lookup (only real values) and merge into each new unit. */
  async function enrichUnits(skus: string[], parsed: Parsed, hold: { reason: string; note: string } | null, forceHide: boolean): Promise<number> {
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
      if (parsed.dims.some(pos)) put('package_source', packageSource(parsed));
      if (form.costEstimate || parsed.cost == null) {
        put('cost_estimate', true);
        put('cost_source', floor.costLabel);
      }
      if (A?.price_pending) put('amazon_price_pending', true);
    } else if (manual && form.upc.trim()) {
      put('upc', form.upc.trim());
    }
    if (hold) { put('hold_reason', hold.reason); put('hold_note', hold.note.trim()); }
    const hide = Boolean(hold) || forceHide;
    if (!Object.keys(specs).length && !hide) return 0;

    const patch = {
      specs, msrp: msrp, show: hide ? false : null,
      brand: form.brand.trim(), model: form.model.trim(), title: form.title.trim(), description: form.description.trim(),
    };
    let failed = 0;
    for (const sku of skus) { if (!(await enrichOne(sku, patch))) failed++; }
    return failed;
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

  async function enrichOne(sku: string, p: {
    specs: Record<string, unknown>; msrp: number | null; show: boolean | null;
    brand: string; model: string; title: string; description: string;
  }): Promise<boolean> {
    // Preferred: RPC (units has no UPDATE policy for authenticated users).
    const rpc = await client.rpc('portal_enrich_received_unit', {
      p_sku: sku, p_specs: p.specs, p_msrp_cents: p.msrp, p_show: p.show,
      p_brand: p.brand || null, p_model: p.model || null, p_title: p.title || null, p_description: p.description || null,
    });
    if (!rpc.error) return true;
    // Fallback: direct update with client-side coalesce (only works if RLS allows it; verified via returned rows).
    try {
      const cur = await client.from('units').select('listing_specs, msrp_cents, brand, model, title, listing_body')
        .eq('store_id', storeId).eq('sku', sku).maybeSingle();
      if (cur.error || !cur.data) return false;
      const row = cur.data as Record<string, unknown>;
      const blankVal = (v: unknown) => typeof v !== 'string' || !v.trim();
      const update: Record<string, unknown> = {
        listing_specs: { ...((row.listing_specs as Record<string, unknown> | null) || {}), ...p.specs },
      };
      if (row.msrp_cents == null && p.msrp != null) update.msrp_cents = p.msrp;
      if (blankVal(row.brand) && p.brand) update.brand = p.brand;
      if (blankVal(row.model) && p.model) update.model = p.model;
      if (blankVal(row.title) && p.title) update.title = p.title;
      if (blankVal(row.listing_body) && p.description) update.listing_body = p.description;
      if (p.show === false) update.show_on_website = false;
      const upd = await client.from('units').update(update).eq('store_id', storeId).eq('sku', sku).select('sku');
      return !upd.error && (upd.data?.length || 0) > 0;
    } catch { return false; }
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

  function addFiles(list: FileList | null) {
    if (!list || !list.length) return;
    setFiles(prev => [...prev, ...Array.from(list)]);
  }

  const picker = (labelText: string, key: Exclude<keyof Form, 'costEstimate'>, values: string[]) => (
    <label>{labelText}<select value={form[key]} onChange={e => update(key, e.target.value)}>
      <option value="">—</option>{values.map(x => <option key={x} value={x}>{x}</option>)}
    </select></label>
  );

  const cmpRow = (name: string, a: string, u: string, flagged: boolean, actions?: React.ReactNode) => (
    <tr className={flagged ? 'receive-flagged' : undefined} key={name}>
      <td><strong>{name}</strong></td>
      <td>{a || <span className="hint">—</span>}</td>
      <td>{u || <span className="hint">—</span>}</td>
      <td>{flagged && <span className="tag warn">disagree</span>}{actions}</td>
    </tr>
  );
  const textRow = (key: 'title' | 'brand' | 'model', name: string) => {
    const a = text(A?.found ? A[key] : null);
    const u = text(U?.found ? U[key] : null);
    const differ = Boolean(a && u && !same(a, u));
    return cmpRow(name, a, u, disagree.has(key) || differ, differ && <>
      {' '}<button type="button" className="text-button" onClick={() => setFrom(key, a)}>Use Amazon</button>
      <button type="button" className="text-button" onClick={() => setFrom(key, u)}>Use UPCitemdb</button>
    </>);
  };

  const showForm = manual || (current && current.status !== 'loading' && loadedId === current.id);
  const waiting = queue.length - (current ? 1 : 0);
  const hasFiles = files.length > 0;
  const needNoteForScratch = form.condition === SCRATCH;
  const holdReady = reason !== 'other' || reasonNote.trim().length > 0;

  return <section className="panel receive-panel">
    <div className="receive-next">
      <div className="receive-sku-block">
        <div><div className="eyebrow">NEXT AVAILABLE SKU</div><strong>{options?.next_sku || 'Loading…'}</strong></div>
        {!manual && <label className="receive-upc">Scan UPC
          <input
            ref={upcInput}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); enqueue(draft); } }}
            onBlur={() => { setTimeout(() => { if (!modalOpen.current && (!document.activeElement || document.activeElement === document.body)) upcInput.current?.focus(); }, 0); }}
            autoFocus
            inputMode={scannerInputMode()}
            autoComplete="off"
            enterKeyHint="done"
            placeholder={isKioskShell() ? 'Scan barcode' : 'Scan or type · Enter'}
            disabled={!accessToken}
          />
        </label>}
        {!manual && <div className="actions">
          <button type="button" disabled={!draft.trim()} onClick={() => enqueue(draft)}>Look up</button>
          <button type="button" className="secondary" onClick={() => { if (detectorCtor()) setCamera(true); else cameraFile.current?.click(); }}>Camera</button>
          <input ref={cameraFile} type="file" accept="image/*" capture="environment" className="sr-only" aria-label="Photo of barcode" onChange={e => {
            const f = e.target.files?.[0]; e.target.value = '';
            if (f) void decodeFile(f).then(code => { if (code) enqueue(code); else { setError('This browser cannot read barcodes from photos. Type the digits under the barcode instead.'); focusUpc(); } });
          }} />
        </div>}
      </div>
      <div>
        <p>{manual ? 'Manual entry: no lookup. Same fields as Browse → edit unit.' : 'Scan a UPC, check the product data, add a photo and condition, then confirm the price.'}</p>
        <button type="button" className="text-button" onClick={toggleManual}>{manual ? '← Back to scan' : 'Enter manually'}</button>
      </div>
    </div>

    {!manual && queue.length > 0 && <p className="hint" role="status">
      {current?.status === 'loading' ? `Looking up ${current.upc}…` : current ? `Working on ${current.upc}` : ''}
      {waiting > 0 ? ` · ${waiting} more scan${waiting === 1 ? '' : 's'} queued` : ''}
    </p>}

    {saved.length > 0 && <div className="receive-success">
      <strong>Received {saved.length === 1 ? 'SKU' : 'SKUs'}: {saved.join(', ')}</strong>
      <p>Write {saved.length === 1 ? 'this number' : 'these numbers'} on the unit{saved.length === 1 ? '' : 's'}. Ready for the next scan.</p>
      {last && <button type="button" className="secondary" onClick={addAnother}>Add another unit</button>}
    </div>}
    {warning && <p className="hint">{warning}</p>}
    {error && <div className="alert" role="alert">{error}<button type="button" onClick={() => setError('')}>Dismiss</button></div>}

    {!manual && !current && <div className="empty">Scan a UPC to start. Rapid scans are queued.</div>}
    {!manual && current?.status === 'loading' && <div className="empty">Looking up {current.upc}…</div>}

    {showForm && <form onSubmit={e => void finish(e)}>
      {dups && dups.count > 0 && <div className="receive-dup" role="status">
        <strong>You have {dups.count} of these</strong>{dups.skus.length ? <> (SKU {dups.skus.slice(0, 8).join(', ')}{dups.skus.length > 8 ? '…' : ''})</> : null}
        {!dupAck ? <> <button type="button" className="secondary" onClick={confirmDup}>Add another unit</button></> : <span className="tag on">confirmed — new unit</span>}
        <p>A new unit gets a new SKU and needs its own photo and condition.</p>
      </div>}

      {!manual && current?.status === 'error' && <div className="alert" role="alert">
        <span>Lookup failed: {current.error}. Fill the fields by hand, or retry.</span>
        <button type="button" onClick={() => retry(current)}>Retry</button>
      </div>}

      {!manual && result && <div className="receive-compare">
        <div className="eyebrow">LOOKUP{result.cached ? ' · CACHED' : ''} · {upcVariants(current?.upc || '', result).join(' / ')}</div>
        <div className="table-wrap"><table className="tbl">
          <thead><tr><th>Field</th><th>Amazon</th><th>UPCitemdb</th><th /></tr></thead>
          <tbody>
            {textRow('title', 'Title')}
            {textRow('brand', 'Brand')}
            {textRow('model', 'Model')}
            {cmpRow('Description', text(A?.description).slice(0, 140), text(U?.description).slice(0, 140), false)}
            {cmpRow('Features', A?.features?.length ? `${A.features.length} bullets` : '', U?.features?.length ? `${U.features.length} bullets` : '', false)}
            {cmpRow('Package', pkgText(A?.package), pkgText(U?.package), pkgDisagrees, pkgDisagrees && <>
              {' '}<button type="button" className="text-button" onClick={() => setPackage(A?.package)}>Use Amazon</button>
              <button type="button" className="text-button" onClick={() => setPackage(U?.package)}>Use UPCitemdb</button>
            </>)}
            {cmpRow('Retail price', pos(A?.price_cents) ? `${money(A.price_cents)}${A.price_source ? ` (${label(A.price_source)})` : ''}` : (A?.price_pending ? 'pending (rate limit)' : ''), pos(U?.price_cents) ? `${money(U.price_cents)}${U.price_source ? ` (${label(U.price_source)})` : ''}` : '', false)}
            {cmpRow('ASIN', text(A?.asin), text(U?.asin), disagree.has('asin'))}
          </tbody>
        </table></div>
        {[...disagree.keys()].length > 0 && <p className="hint" role="status">Sources disagree on: {[...disagree.keys()].map(k => k.replace('package.', 'package ').replace(/_/g, ' ')).join(', ')}. Check the box/label before saving. Blank means no source had a value.</p>}
        {A?.raw_error && <p className="hint">Amazon: {A.raw_error}</p>}
        {merged?.never_list_reason && <p className="hint">Amazon will not list this: {merged.never_list_reason}</p>}
        {!A?.found && !U?.found && <p className="hint">No source knew this UPC. Fill the fields by hand — nothing was guessed.</p>}
      </div>}

      <div className="unit-edit-grid">
        {manual && <label>UPC<input value={form.upc} onChange={e => { update('upc', e.target.value); setDups(null); setDupAck(false); }} inputMode={scannerInputMode()} autoComplete="off" placeholder="optional" /></label>}
        {manual && <label>Quantity<input type="number" min="1" max="100" step="1" value={form.quantity} onChange={e => update('quantity', e.target.value)} required /></label>}
        <label>Brand<input value={form.unbranded ? 'Unbranded' : form.brand} disabled={form.unbranded} onChange={e => update('brand', e.target.value)} /></label>
        <label className="mboard-inline">
          <input type="checkbox" checked={form.unbranded} onChange={e => setForm(p => ({ ...p, unbranded: e.target.checked }))} />
          Unbranded — no brand anywhere on the product or packaging
        </label>
        <label>Model<input value={form.model} onChange={e => update('model', e.target.value)} /></label>
        <label>Category<input value={form.category} onChange={e => update('category', e.target.value)} /></label>
        <label className="unit-edit-wide">Title<input value={form.title} onChange={e => update('title', e.target.value)} /></label>
        <label className="unit-edit-wide">Description / features<textarea rows={4} value={form.description} onChange={e => update('description', e.target.value)} /></label>

        <div className="unit-edit-wide receive-cond" role="radiogroup" aria-label="Condition">
          <span className="receive-label">Condition{manual ? '' : ' (required)'}</span>
          {manual
            ? <select value={form.condition} onChange={e => update('condition', e.target.value)}>
              <option value="">—</option>{[...new Set([...choices(options?.conditions), SCRATCH])].map(x => <option key={x} value={x}>{x}</option>)}
            </select>
            : <div className="receive-cond-row">{CONDITIONS.map(([value, text2]) => <label key={value} className={form.condition === value ? 'receive-chip on' : 'receive-chip'}>
              <input type="radio" name="receive-condition" value={value} checked={form.condition === value} onChange={() => update('condition', value)} />{text2}
            </label>)}</div>}
        </div>
        {needNoteForScratch && <label className="unit-edit-wide">What is scratched or dented? (required)<textarea rows={2} value={form.conditionNote} onChange={e => update('conditionNote', e.target.value)} /></label>}

        <label>Price{retail && !askTouched.current ? ' (suggested — edit if needed)' : ''}<input inputMode="decimal" placeholder="24.99" value={form.ask} onChange={e => update('ask', e.target.value)} /></label>
        <label>Cost{form.costEstimate ? ' (estimate — edit if you know it)' : ' (optional)'}
          <input inputMode="decimal" placeholder="9.00" value={form.cost} onChange={e => update('cost', e.target.value)} />
        </label>
        {!manual && <div className="unit-edit-wide receive-retail">
          {retail
            ? <>Retail {money(retail.cents)} from {label(retail.source)}{retail.asOf ? ` (as of ${retail.asOf.slice(0, 10)})` : ''}
              {msrp ? ` · MSRP ${money(msrp)}` : ''}
              {A?.price_pending ? ' · Amazon price pending (rate limit)' : ''}
              {suggestion ? <> · Suggested {money(suggestion)} <button type="button" className="text-button" onClick={() => { askTouched.current = true; setForm(p => ({ ...p, ask: dollars(suggestion) })); }}>Use</button></> : null}
              <br /><small>{floor.mathLine}. Suggestion ≈ 55% of retail, never under that floor, always under retail.</small></>
            : <>No retail price found{msrp ? ` · MSRP ${money(msrp)}` : ''}{A?.price_pending ? ' · Amazon price pending (rate limit)' : ''}.
              <br /><small>{floor.mathLine}</small>
              Enter a price yourself or leave it blank.</>}
        </div>}
        {picker('Test status', 'testStatus', choices(options?.test_statuses))}
        <label>Shippable
          <select value={form.shippable} onChange={e => update('shippable', e.target.value)}>
            <option value="auto">Automatic (rules)</option>
            <option value="ship">Yes — can ship</option>
            <option value="pickup">No — pickup only</option>
          </select>
        </label>
        <label>Length (in)<input inputMode="decimal" value={form.length} onChange={e => update('length', e.target.value)} /></label>
        <label>Width (in)<input inputMode="decimal" value={form.width} onChange={e => update('width', e.target.value)} /></label>
        <label>Height (in)<input inputMode="decimal" value={form.height} onChange={e => update('height', e.target.value)} /></label>
        <label>Weight (lb)<input inputMode="decimal" value={form.weight} onChange={e => update('weight', e.target.value)} /></label>
        <label className="unit-edit-wide">Notes<textarea rows={2} value={form.notes} onChange={e => update('notes', e.target.value)} /></label>

        <div className="unit-edit-wide">
          <span className="receive-label">Photos{manual ? ' (optional)' : ' (at least 1 real photo required)'}</span>
          <div className="actions">
            <label className="secondary receive-file-btn">Take photo
              <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
            </label>
            <label className="secondary receive-file-btn">Choose photos
              <input type="file" accept="image/*" multiple className="sr-only" onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
            </label>
          </div>
          {hasFiles && <div className="receive-photos">{files.map((f, i) => <figure key={`${f.name}-${i}`}>
            <img src={previews[i]} alt={`Photo ${i + 1}`} />
            <button type="button" className="text-button" onClick={() => setFiles(prev => prev.filter((_, j) => j !== i))}>Remove</button>
          </figure>)}</div>}
        </div>
      </div>

      <p className="hint receive-check">
        {liveMissing.length === 0 ? 'Complete — ready to list.' : `Missing for listing: ${liveMissing.join(', ')}. You can still receive; these land in Needs attention.`}
      </p>
      <div className="actions">
        <button disabled={busy || !options?.next_sku || (dups !== null && dups.count > 0 && !dupAck)}>{busy ? 'Receiving…' : 'Finish & receive'}</button>
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
        <h3 id="ready-title">Ready to list?</h3>
        <p><strong>{form.title.trim() || [form.brand, form.model].filter(Boolean).join(' ')}</strong><br />
          Price {money(cents(form.ask) as number | null)} · {form.condition || 'no condition'} · {files.length} photo{files.length === 1 ? '' : 's'}</p>
        <p className="hint">Yes receives it with normal show defaults; it moves to Online → Ready once the board criteria are met.
          {form.costEstimate ? ` Cost uses ${floor.costLabel} until you edit it.` : ''}</p>
        <div className="actions">
          <button type="button" disabled={busy} autoFocus onClick={() => { const p = parse(); if (p) void receive(p, null); }}>Yes — receive &amp; list</button>
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
  </section>;
}
