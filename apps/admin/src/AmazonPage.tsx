import { useCallback, useEffect, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ChannelListingPage } from './ChannelListingPage';
import { isKioskShell } from './kiosk';

const base = (import.meta.env.VITE_FLOOR_FUNCTIONS_URL || 'https://inventoryobi.netlify.app').replace(/\/$/, '');
const money = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n / 100);

type Row = {
  id: string;
  sku: string;
  note: string;
  created_at: string;
  title: string;
  condition: string | null;
  ask_cents: number | null;
  photo_path: string | null;
  upc: string | null;
  flags: string[] | null;
  status: string;
  asin: string | null;
  matched_title: string | null;
  amazon_price_cents: number | null;
  fee_estimate_cents: number | null;
  condition_code: string | null;
  condition_note: string | null;
  last_error: string | null;
  listed_at: string | null;
  cost_cents: number | null;
  needs_review_reason: string | null;
  acquisition_cost_cents: number | null;
  brand: string | null;
  model: string | null;
  state: string | null;
};

type AddResult = {
  sku: string;
  ok: boolean;
  reason: string;
  matched_by?: string | null;
  input?: string | null;
};

type Props = {
  client: SupabaseClient;
  accessToken: string;
  money: (n: number) => string;
};

const STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  ready: 'Ready',
  needs_review: 'Needs review',
  not_on_amazon: 'Not on Amazon',
  listing: 'Listing',
  live: 'Live',
  sold: 'Sold',
  error: 'Error',
  removed: 'Removed',
};

const FLAG_LABEL: Record<string, string> = {
  no_photo: 'No photo',
  no_upc_asin: 'No UPC/ASIN',
  skip_list: 'Skip list',
  not_available: 'Not available',
  gated_brand: 'Gated brand',
  never_list: 'Never list',
  no_price: 'No price',
  approval_required: 'Approval required',
  gated_restriction: 'Listing restricted',
};

function isRestrictionReview(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return /approval required|not eligible|listing restriction|gated|Seller Central|restrictions check/i.test(reason);
}

function isNoAsinCreate(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return /no asin|create-new|create preview|GS1|Not on Amazon/i.test(reason);
}

const SKIP_REASON_LABEL: Record<string, string> = {
  unknown_sku: 'not a Floor SKU',
  unknown_upc: 'no unit with that UPC',
  already_sold: 'already sold',
  already_sold_or_unavailable: 'already sold',
};

function parseCodes(raw: string): string[] {
  return raw
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function hasUpc(row: Row): boolean {
  return Boolean(nullifTrim(row.upc));
}

function nullifTrim(v: string | null | undefined): string | null {
  const t = (v || '').trim();
  return t ? t : null;
}

function formatSkip(b: AddResult): string {
  const label = SKIP_REASON_LABEL[b.reason] || b.reason;
  const shown = b.input && b.input !== b.sku ? `${b.input} → ${b.sku}` : (b.sku || b.input || '?');
  return `${shown} (${label})`;
}

function formatAdded(a: AddResult): string {
  if (a.matched_by === 'upc' && a.input && a.input !== a.sku) return `${a.sku} via UPC ${a.input}`;
  return a.sku;
}

function errText(e: unknown): string {
  if (e == null) return 'Unknown error';
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message || e.name || 'Error';
  if (typeof e === 'object') {
    const o = e as Record<string, unknown>;
    if (typeof o.message === 'string' && o.message.trim()) return o.message;
    if (typeof o.error === 'string' && o.error.trim()) return o.error;
    if (o.error != null && o.error !== e) return errText(o.error);
    if (typeof o.details === 'string' && o.details.trim()) return o.details;
    if (typeof o.hint === 'string' && o.hint.trim()) return o.hint;
    try {
      return JSON.stringify(e);
    } catch {
      /* ignore */
    }
  }
  const s = String(e);
  return s === '[object Object]' ? 'Something went wrong' : s;
}

async function amazonListCall(token: string, body: Record<string, unknown>) {
  const res = await fetch(`${base}/.netlify/functions/amazon-list`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({} as Record<string, unknown>));
  if (!res.ok && json.ok !== true) {
    throw new Error(errText(json.message ?? json.error ?? `Amazon list failed (${res.status})`));
  }
  return json;
}

export function AmazonPage({ client, accessToken, money: moneyFmt }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const [skuDraft, setSkuDraft] = useState('');
  const [upcDraft, setUpcDraft] = useState('');
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [listingEnabled, setListingEnabled] = useState<boolean | null>(null);
  const [createDraft, setCreateDraft] = useState<{
    sku: string;
    title: string;
    brand: string;
    bullets: string;
    description: string;
    price: string;
    productType: string;
    mainImage: string;
    previewOk: boolean | null;
    previewMsg: string;
  } | null>(null);
  const skuRef = useRef<HTMLInputElement>(null);
  const upcRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const { data, error: e } = await client.rpc('portal_amazon_list');
    if (e) throw e;
    setRows((data as Row[]) || []);
  }, [client]);

  useEffect(() => {
    void load().catch((e) => setError(errText(e)));
  }, [load]);

  useEffect(() => {
    void (async () => {
      try {
        const body = await amazonListCall(accessToken, { action: 'status' });
        setListingEnabled(Boolean(body.listingEnabled));
      } catch {
        /* ignore */
      }
    })();
  }, [accessToken]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next: Record<string, string> = {};
      for (const r of rows) {
        if (!r.photo_path || thumbs[r.sku]) continue;
        const { data } = await client.storage.from('unit-photos').createSignedUrl(r.photo_path, 3600);
        if (data?.signedUrl) next[r.sku] = data.signedUrl;
      }
      if (!cancelled && Object.keys(next).length) setThumbs((t) => ({ ...t, ...next }));
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [rows, client, thumbs]);

  async function addCodes(codes: string[], clear: 'sku' | 'upc' | 'both') {
    if (!codes.length) return;
    setBusy(true);
    setError('');
    try {
      const { data, error: e } = await client.rpc('portal_amazon_list_add', { p_skus: codes, p_note: '' });
      if (e) throw e;
      const results = (data as AddResult[]) || [];
      const added = results.filter((x) => x.ok);
      const bad = results.filter((x) => !x.ok);
      if (!results.length) {
        setFlash('Nothing to add — enter a Floor SKU and/or UPC.');
      } else if (bad.length && !added.length) {
        setFlash(`Skipped: ${bad.map(formatSkip).join('; ')}`);
      } else if (bad.length) {
        setFlash(
          `Added ${added.map(formatAdded).join(', ')}. Skipped: ${bad.map(formatSkip).join('; ')}`,
        );
      } else {
        setFlash(`Added ${added.map(formatAdded).join(', ')}. Matching ASINs…`);
      }
      if (clear === 'sku' || clear === 'both') setSkuDraft('');
      if (clear === 'upc' || clear === 'both') setUpcDraft('');
      await load();
      const prepareFails: string[] = [];
      for (const a of added) {
        try {
          const prep = await amazonListCall(accessToken, { action: 'prepare', sku: a.sku });
          if (prep.ok === false) {
            const why = String(prep.needs_review_reason || prep.last_error || prep.message || prep.status || 'prepare failed');
            prepareFails.push(`${a.sku}: ${why}`);
          }
        } catch (e) {
          prepareFails.push(`${a.sku}: ${errText(e)}`);
        }
      }
      await load();
      if (prepareFails.length) {
        setError(`Prepare issues — ${prepareFails.join('; ')}`);
      }
      skuRef.current?.focus();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  function submitAdd() {
    const skus = parseCodes(skuDraft);
    const upcs = parseCodes(upcDraft);
    const codes = [...skus, ...upcs];
    if (!codes.length) return;
    const clear = skus.length && upcs.length ? 'both' : skus.length ? 'sku' : 'upc';
    void addCodes(codes, clear);
  }

  function onSkuKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const codes = parseCodes(skuDraft);
    if (codes.length) void addCodes(codes, 'sku');
    else if (parseCodes(upcDraft).length) void addCodes(parseCodes(upcDraft), 'upc');
  }

  function onUpcKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const codes = parseCodes(upcDraft);
    if (codes.length) void addCodes(codes, 'upc');
    else if (parseCodes(skuDraft).length) void addCodes(parseCodes(skuDraft), 'sku');
  }

  async function remove(sku: string) {
    setBusy(true);
    try {
      const { error: e } = await client.rpc('portal_amazon_list_remove', { p_sku: sku });
      if (e) throw e;
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveMissingUpc(sku: string, upc: string) {
    const digits = upc.replace(/[^\d]/g, '');
    if (!digits) return;
    setBusy(true);
    setError('');
    try {
      const { error: e } = await client.rpc('portal_amazon_set_upc', { p_sku: sku, p_upc: digits });
      if (e) throw e;
      try {
        const prep = await amazonListCall(accessToken, { action: 'prepare', sku });
        if (prep.ok === false) {
          setError(`${sku}: ${String(prep.needs_review_reason || prep.last_error || prep.message || 'prepare failed')}`);
        } else {
          setFlash(`UPC saved for ${sku}. Matching ASINs…`);
        }
      } catch (e) {
        setError(`UPC saved for ${sku}, but prepare failed: ${errText(e)}`);
      }
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveAsin(sku: string, rawAsin: string) {
    const asin = rawAsin.trim().toUpperCase();
    if (!asin) return;
    if (!/^B0[A-Z0-9]{8}$/i.test(asin)) {
      setError('ASIN must look like B0XXXXXXXX (10 characters)');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await amazonListCall(accessToken, { action: 'set_asin', sku, asin });
      const prep = (result.prepare || {}) as Record<string, unknown>;
      if (prep.ok === false) {
        setError(
          `${sku}: ASIN ${asin} saved, but ${String(prep.needs_review_reason || prep.last_error || prep.message || 'needs review')}`,
        );
      } else if (prep.status === 'needs_review') {
        setFlash(`${sku}: ASIN ${asin} saved — ${String(prep.needs_review_reason || 'needs review')}`);
      } else {
        setFlash(`${sku}: ASIN ${asin} saved and prepared.`);
      }
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function savePrice(sku: string, dollars: string) {
    const cents = Math.round(Number(dollars) * 100);
    if (!Number.isFinite(cents) || cents < 500) {
      setError('Price must be at least $5.00');
      return;
    }
    setBusy(true);
    try {
      await amazonListCall(accessToken, { action: 'set_price', sku, price_cents: cents });
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function openCreateListing(sku: string) {
    setBusy(true);
    setError('');
    try {
      const result = await amazonListCall(accessToken, { action: 'create_prefill', sku });
      const prefill = (result.prefill || {}) as {
        productType?: string;
        attributes?: Record<string, unknown>;
      };
      const attrs = prefill.attributes || {};
      const asLang = (key: string) => {
        const arr = attrs[key];
        if (!Array.isArray(arr) || !arr[0] || typeof arr[0] !== 'object') return '';
        const v = (arr[0] as { value?: unknown }).value;
        return typeof v === 'string' ? v : '';
      };
      const bulletArr = Array.isArray(attrs.bullet_point) ? attrs.bullet_point : [];
      const bullets = bulletArr
        .map((b) => (b && typeof b === 'object' ? String((b as { value?: unknown }).value || '') : ''))
        .filter(Boolean)
        .join('\n');
      let dollars = '';
      const offer0 = Array.isArray(attrs.purchasable_offer) ? attrs.purchasable_offer[0] : null;
      if (offer0 && typeof offer0 === 'object') {
        const schedule = (offer0 as { our_price?: { schedule?: { value_with_tax?: number }[] }[] }).our_price?.[0]
          ?.schedule?.[0];
        if (schedule?.value_with_tax != null) dollars = String(schedule.value_with_tax);
      }
      setCreateDraft({
        sku,
        title: asLang('item_name'),
        brand: asLang('brand'),
        bullets,
        description: asLang('product_description'),
        price: dollars,
        productType: prefill.productType || 'STRING_LIGHT',
        mainImage: '',
        previewOk: null,
        previewMsg:
          'Real brand + UPC only. No Generic. No AI images — main image must be a real photo Amazon already hosts (or leave blank for preview).',
      });
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function runCreatePreview() {
    if (!createDraft) return;
    setBusy(true);
    setError('');
    try {
      const bulletLines = createDraft.bullets.split(/\n+/).map((s) => s.trim()).filter(Boolean);
      const result = await amazonListCall(accessToken, {
        action: 'create_preview',
        sku: createDraft.sku,
        product_type: createDraft.productType,
        price_cents: createDraft.price ? Math.round(Number(createDraft.price) * 100) : null,
        main_image_media_location: createDraft.mainImage.trim() || null,
        attributes: {
          item_name: [{ value: createDraft.title, language_tag: 'en_US', marketplace_id: 'ATVPDKIKX0DER' }],
          brand: [{ value: createDraft.brand, language_tag: 'en_US', marketplace_id: 'ATVPDKIKX0DER' }],
          bullet_point: bulletLines.map((value) => ({
            value,
            language_tag: 'en_US',
            marketplace_id: 'ATVPDKIKX0DER',
          })),
          product_description: [
            { value: createDraft.description, language_tag: 'en_US', marketplace_id: 'ATVPDKIKX0DER' },
          ],
        },
      });
      const preview = (result.preview || {}) as Record<string, unknown>;
      const errors = (preview.errors as { code?: string; message?: string }[]) || [];
      if (preview.gs1OrBrandBlocked || preview.autoMarkedNotOnAmazon) {
        setCreateDraft(null);
        setFlash(
          `${createDraft.sku}: Amazon blocked create (UPC/brand GS1). Marked Not on Amazon — sell elsewhere. ${errors[0]?.message || ''}`,
        );
        await load();
        return;
      }
      setCreateDraft({
        ...createDraft,
        previewOk: Boolean(preview.ok),
        previewMsg: preview.ok
          ? `VALIDATION_PREVIEW clean (${String(preview.productType || createDraft.productType)}). Live submit needs Amazon-hosted main image + confirm.`
          : errors.map((e) => e.message).filter(Boolean).join(' · ') || String(preview.message || 'validation errors'),
      });
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function submitCreateLive() {
    if (!createDraft?.previewOk) return;
    if (!createDraft.mainImage.trim()) {
      setError('Live create needs an Amazon-hosted main image URL (media_location). Never use AI images.');
      return;
    }
    if (
      !window.confirm(
        `Submit LIVE create for SKU ${createDraft.sku} under brand "${createDraft.brand}"? This creates a new catalog ASIN if Amazon accepts it.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      const bulletLines = createDraft.bullets.split(/\n+/).map((s) => s.trim()).filter(Boolean);
      const result = await amazonListCall(accessToken, {
        action: 'create_submit',
        sku: createDraft.sku,
        confirm_live: true,
        product_type: createDraft.productType,
        price_cents: createDraft.price ? Math.round(Number(createDraft.price) * 100) : null,
        main_image_media_location: createDraft.mainImage.trim(),
        attributes: {
          item_name: [{ value: createDraft.title, language_tag: 'en_US', marketplace_id: 'ATVPDKIKX0DER' }],
          brand: [{ value: createDraft.brand, language_tag: 'en_US', marketplace_id: 'ATVPDKIKX0DER' }],
          bullet_point: bulletLines.map((value) => ({
            value,
            language_tag: 'en_US',
            marketplace_id: 'ATVPDKIKX0DER',
          })),
          product_description: [
            { value: createDraft.description, language_tag: 'en_US', marketplace_id: 'ATVPDKIKX0DER' },
          ],
        },
      });
      if (result.ok) {
        setFlash(`${createDraft.sku}: create submitted — waiting for Amazon ASIN.`);
        setCreateDraft(null);
      } else {
        setError(errText(result.message || result.error || 'Create submit failed'));
      }
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function markNotOnAmazon(sku: string) {
    if (!window.confirm(`Mark SKU ${sku} as Not on Amazon — sell on other channels?`)) return;
    setBusy(true);
    setError('');
    try {
      await amazonListCall(accessToken, { action: 'mark_not_on_amazon', sku });
      setFlash(`${sku}: marked Not on Amazon.`);
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function retry(sku: string) {
    setBusy(true);
    setError('');
    try {
      const prep = await amazonListCall(accessToken, { action: 'retry', sku });
      if (prep.ok === false) {
        setError(`${sku}: ${String(prep.needs_review_reason || prep.last_error || prep.message || 'prepare failed')}`);
      } else if (prep.status === 'needs_review') {
        setFlash(`${sku}: needs review — ${String(prep.needs_review_reason || 'see details')}`);
      } else if (prep.status === 'not_on_amazon') {
        setFlash(`${sku}: Not on Amazon — ${String(prep.needs_review_reason || 'sell on other channels')}`);
      } else {
        setFlash(`Retried prepare for ${sku} → ${String(prep.status || 'ok')}.`);
      }
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function listOne(sku: string) {
    if (!window.confirm(`Create Amazon offer for SKU ${sku}? One at a time; pause after each.`)) return;
    setBusy(true);
    setError('');
    try {
      const result = await amazonListCall(accessToken, { action: 'list_one', sku });
      if (result.ok) setFlash(`Listed SKU ${sku} as ASIN ${result.asin} @ ${money(result.listCents)}.`);
      else setFlash(`${sku}: ${result.message || result.reason || 'not listed'}`);
      await load();
    } catch (e) {
      setError(errText(e));
      await load();
    } finally {
      setBusy(false);
    }
  }

  const canEnter = Boolean(parseCodes(skuDraft).length || parseCodes(upcDraft).length);

  const amazonQueue = (
    <>
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

      {listingEnabled === false && (
        <div className="alert" role="status">
          Listing is OFF (`AMAZON_LISTING_ENABLED` ≠ 1). You can queue and prepare SKUs; List one will stay blocked until
          you enable it on inventoryobi.
        </div>
      )}

      <section className="panel amazon-add">
        <h2>Create / queue workflow</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          Use the SKU box, the UPC box, or both. Only already-sold units are skipped. UPC with multiple available units
          queues the oldest one.
        </p>
        <div className="amazon-add-row">
          <label className="amazon-add-field">
            SKU
            <input
              ref={skuRef}
              autoFocus
              inputMode={isKioskShell() ? 'none' : 'numeric'}
              autoComplete="off"
              spellCheck={false}
              placeholder="Floor SKU"
              aria-label="Floor SKU"
              value={skuDraft}
              onChange={(e) => setSkuDraft(e.target.value.replace(/[^\dA-Za-z\-]/g, ''))}
              onKeyDown={onSkuKey}
              disabled={busy}
            />
          </label>
          <label className="amazon-add-field">
            UPC
            <input
              ref={upcRef}
              inputMode={isKioskShell() ? 'none' : 'numeric'}
              autoComplete="off"
              spellCheck={false}
              placeholder="Product UPC"
              aria-label="Product UPC"
              value={upcDraft}
              onChange={(e) => setUpcDraft(e.target.value.replace(/[^\d]/g, ''))}
              onKeyDown={onUpcKey}
              disabled={busy}
            />
          </label>
          <button disabled={busy || !canEnter} onClick={submitAdd}>
            Enter
          </button>
          <span className="hint">{rows.length} on list</span>
        </div>
      </section>

      <section className="panel">
        <h2>Queue</h2>
        {rows.length === 0 ? (
          <div className="empty">No SKUs yet. Enter a Floor SKU and/or UPC above.</div>
        ) : (
          <div className="amazon-grid">
            {rows.map((r) => {
              const missingUpc = !hasUpc(r);
              const missingSku = !nullifTrim(r.sku);
              return (
                <article className="amazon-card" key={r.id}>
                  <div className="amazon-thumb">
                    {thumbs[r.sku] ? <img src={thumbs[r.sku]} alt="" /> : <span>No photo</span>}
                  </div>
                  <div className="amazon-body">
                    <div className="amazon-card-top">
                      <strong>SKU {r.sku || '—'}</strong>
                      <span className={`amazon-status st-${r.status}`}>{STATUS_LABEL[r.status] || r.status}</span>
                    </div>
                    <div className="amazon-title">{r.title || 'Untitled'}</div>
                    <div className="amazon-meta">
                      Floor {r.ask_cents != null ? moneyFmt(r.ask_cents) : '—'}
                      {r.amazon_price_cents != null ? ` · Amazon ${moneyFmt(r.amazon_price_cents)}` : ''}
                      {r.fee_estimate_cents != null ? ` · Fees ~${moneyFmt(r.fee_estimate_cents)}` : ''}
                      {r.cost_cents != null ? ` · Cost ${moneyFmt(r.cost_cents)}` : ''}
                    </div>
                    <div className="amazon-meta">
                      Condition: {r.condition || '—'}
                      {r.condition_code ? ` → ${r.condition_code}` : ''}
                      {r.upc ? ` · UPC ${r.upc}` : ''}
                    </div>
                    {r.asin ? (
                      <div className="amazon-meta">
                        ASIN <strong>{r.asin}</strong>
                        {r.matched_title ? ` · ${r.matched_title}` : ''}
                      </div>
                    ) : (
                      <div className="amazon-meta">No ASIN matched yet — paste one below</div>
                    )}
                    {(r.flags || []).length > 0 && (
                      <div className="amazon-flags">
                        {(r.flags || []).map((f) => (
                          <span className="amazon-flag" key={f}>
                            {FLAG_LABEL[f] || f}
                          </span>
                        ))}
                      </div>
                    )}
                    {(r.status === 'needs_review' ||
                      r.status === 'not_on_amazon' ||
                      isRestrictionReview(r.needs_review_reason) ||
                      isNoAsinCreate(r.needs_review_reason)) && (
                      <div className="amazon-review-banner" role="status">
                        <strong>
                          {r.status === 'not_on_amazon' || /Not on Amazon/i.test(r.needs_review_reason || '')
                            ? 'Not on Amazon — sell elsewhere'
                            : /GS1|brand records/i.test(r.needs_review_reason || '')
                              ? 'Create blocked (GS1 / brand)'
                              : /approval/i.test(r.needs_review_reason || '')
                                ? 'Approval needed in Seller Central'
                                : /not eligible|restriction/i.test(r.needs_review_reason || '')
                                  ? 'Listing restricted'
                                  : /No ASIN|create/i.test(r.needs_review_reason || '')
                                    ? 'No catalog match'
                                    : 'Needs review'}
                        </strong>
                        {r.needs_review_reason ? <span>{r.needs_review_reason}</span> : null}
                      </div>
                    )}
                    {r.last_error && (
                      <p className="error amazon-prepare-error" style={{ margin: '6px 0' }}>
                        {r.last_error}
                      </p>
                    )}
                    {r.needs_review_reason &&
                      r.status !== 'needs_review' &&
                      !isRestrictionReview(r.needs_review_reason) && (
                        <p className="hint" style={{ margin: '6px 0' }}>
                          {r.needs_review_reason}
                        </p>
                      )}
                    {r.condition_note && <p className="hint" style={{ margin: '6px 0' }}>{r.condition_note}</p>}

                    <label>
                      Amazon ASIN
                      <input
                        disabled={busy}
                        placeholder="B0…"
                        autoComplete="off"
                        spellCheck={false}
                        defaultValue={r.asin || ''}
                        key={`${r.sku}:asin:${r.asin || ''}`}
                        onBlur={(e) => {
                          const next = e.target.value.trim().toUpperCase();
                          const cur = (r.asin || '').trim().toUpperCase();
                          if (next && next !== cur) void saveAsin(r.sku, next);
                        }}
                        onKeyDown={(e) => {
                          if (e.key !== 'Enter') return;
                          e.preventDefault();
                          const next = (e.target as HTMLInputElement).value.trim().toUpperCase();
                          if (next) void saveAsin(r.sku, next);
                        }}
                      />
                    </label>

                    {missingSku && (
                      <label>
                        Add Floor SKU
                        <input
                          disabled={busy}
                          placeholder="Floor SKU"
                          inputMode={isKioskShell() ? 'none' : 'numeric'}
                          autoComplete="off"
                          onBlur={(e) => {
                            const v = e.target.value.trim();
                            if (v) void addCodes([v], 'sku');
                          }}
                          onKeyDown={(e) => {
                            if (e.key !== 'Enter') return;
                            e.preventDefault();
                            const v = (e.target as HTMLInputElement).value.trim();
                            if (v) void addCodes([v], 'sku');
                          }}
                        />
                      </label>
                    )}
                    {missingUpc && (
                      <label>
                        Add UPC
                        <input
                          disabled={busy}
                          placeholder="Product UPC"
                          inputMode={isKioskShell() ? 'none' : 'numeric'}
                          autoComplete="off"
                          key={`${r.sku}:upc`}
                          onBlur={(e) => {
                            const v = e.target.value.replace(/[^\d]/g, '');
                            if (v) void saveMissingUpc(r.sku, v);
                          }}
                          onKeyDown={(e) => {
                            if (e.key !== 'Enter') return;
                            e.preventDefault();
                            const v = (e.target as HTMLInputElement).value.replace(/[^\d]/g, '');
                            if (v) void saveMissingUpc(r.sku, v);
                          }}
                        />
                      </label>
                    )}
                    <label>
                      Amazon price ($)
                      <input
                        type="number"
                        step="0.01"
                        min="5"
                        defaultValue={r.amazon_price_cents != null ? (r.amazon_price_cents / 100).toFixed(2) : ''}
                        key={`${r.sku}:price:${r.amazon_price_cents}`}
                        disabled={busy}
                        onBlur={(e) => {
                          const next = e.target.value;
                          const cur = r.amazon_price_cents != null ? (r.amazon_price_cents / 100).toFixed(2) : '';
                          if (next && next !== cur) void savePrice(r.sku, next);
                        }}
                      />
                    </label>

                    <div className="actions" style={{ marginTop: 10 }}>
                      {(r.status === 'ready' || r.status === 'error') && (
                        <button disabled={busy || listingEnabled === false} onClick={() => void listOne(r.sku)}>
                          List one
                        </button>
                      )}
                      {!r.asin && r.status !== 'not_on_amazon' && r.status !== 'live' && r.status !== 'sold' && (
                        <button className="secondary" disabled={busy} onClick={() => void openCreateListing(r.sku)}>
                          Create new listing
                        </button>
                      )}
                      {(r.status === 'error' || r.status === 'needs_review' || r.status === 'queued') && (
                        <button className="secondary" disabled={busy} onClick={() => void retry(r.sku)}>
                          Retry / prepare
                        </button>
                      )}
                      {!r.asin && r.status !== 'not_on_amazon' && r.status !== 'live' && (
                        <button className="text-button" disabled={busy} onClick={() => void markNotOnAmazon(r.sku)}>
                          Not on Amazon
                        </button>
                      )}
                      <button className="text-button danger" disabled={busy} onClick={() => void remove(r.sku)}>
                        Remove
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {createDraft && (
        <div className="modal-backdrop">
          <form
            className="panel modal"
            style={{ maxWidth: 640 }}
            onSubmit={(e) => {
              e.preventDefault();
              void runCreatePreview();
            }}
          >
            <h2>Create new Amazon listing — SKU {createDraft.sku}</h2>
            <p className="hint">
              Real brand + real UPC only. Never Generic. Main image must be a real product photo (no AI). Preview runs
              VALIDATION_PREVIEW first; live submit only when clean.
            </p>
            <label>
              Brand
              <input
                required
                value={createDraft.brand}
                onChange={(e) => setCreateDraft({ ...createDraft, brand: e.target.value, previewOk: null })}
              />
            </label>
            <label>
              Title
              <input
                required
                value={createDraft.title}
                onChange={(e) => setCreateDraft({ ...createDraft, title: e.target.value, previewOk: null })}
              />
            </label>
            <label>
              Bullets (one per line)
              <textarea
                rows={5}
                value={createDraft.bullets}
                onChange={(e) => setCreateDraft({ ...createDraft, bullets: e.target.value, previewOk: null })}
              />
            </label>
            <label>
              Description
              <textarea
                rows={4}
                value={createDraft.description}
                onChange={(e) => setCreateDraft({ ...createDraft, description: e.target.value, previewOk: null })}
              />
            </label>
            <label>
              Price ($)
              <input
                type="number"
                step="0.01"
                min="5"
                value={createDraft.price}
                onChange={(e) => setCreateDraft({ ...createDraft, price: e.target.value, previewOk: null })}
              />
            </label>
            <label>
              Product type
              <input
                value={createDraft.productType}
                onChange={(e) => setCreateDraft({ ...createDraft, productType: e.target.value, previewOk: null })}
              />
            </label>
            <label>
              Main image media_location (Amazon-hosted URL only — leave blank for preview)
              <input
                placeholder="https://m.media-amazon.com/… (real photo only)"
                value={createDraft.mainImage}
                onChange={(e) => setCreateDraft({ ...createDraft, mainImage: e.target.value })}
              />
            </label>
            {createDraft.previewMsg && (
              <p className={createDraft.previewOk === false ? 'alert' : 'hint'} role="status">
                {createDraft.previewMsg}
              </p>
            )}
            <div className="actions">
              <button type="submit" disabled={busy}>
                Run VALIDATION_PREVIEW
              </button>
              <button
                type="button"
                disabled={busy || !createDraft.previewOk}
                onClick={() => void submitCreateLive()}
              >
                Submit live create
              </button>
              <button type="button" className="secondary" onClick={() => setCreateDraft(null)}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );

  return (
    <ChannelListingPage
      channel="amazon"
      accessToken={accessToken}
      money={moneyFmt}
      amazonQueue={amazonQueue}
    />
  );
}
