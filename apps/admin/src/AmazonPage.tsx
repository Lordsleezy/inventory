import { useCallback, useEffect, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
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

  async function retry(sku: string) {
    setBusy(true);
    setError('');
    try {
      const prep = await amazonListCall(accessToken, { action: 'retry', sku });
      if (prep.ok === false) {
        setError(`${sku}: ${String(prep.needs_review_reason || prep.last_error || prep.message || 'prepare failed')}`);
      } else if (prep.status === 'needs_review') {
        setFlash(`${sku}: needs review — ${String(prep.needs_review_reason || 'see details')}`);
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

  return (
    <>
      <header>
        <div>
          <div className="eyebrow">SELLING PARTNER</div>
          <h1>Amazon</h1>
        </div>
      </header>

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
        <h2>Add to queue</h2>
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
                    {(r.status === 'needs_review' || isRestrictionReview(r.needs_review_reason)) && (
                      <div className="amazon-review-banner" role="status">
                        <strong>
                          {/approval/i.test(r.needs_review_reason || '')
                            ? 'Approval needed in Seller Central'
                            : /not eligible|restriction/i.test(r.needs_review_reason || '')
                              ? 'Listing restricted'
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
                      {(r.status === 'error' || r.status === 'needs_review' || r.status === 'queued') && (
                        <button className="secondary" disabled={busy} onClick={() => void retry(r.sku)}>
                          Retry / prepare
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
    </>
  );
}
