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
};

function parseSkus(raw: string): string[] {
  return raw
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function amazonListCall(token: string, body: Record<string, unknown>) {
  const res = await fetch(`${base}/.netlify/functions/amazon-sync`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok && json.ok !== true) throw new Error(json.message || json.error || `Amazon list failed (${res.status})`);
  return json;
}

export function AmazonPage({ client, accessToken, money: moneyFmt }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const [draft, setDraft] = useState('');
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [listingEnabled, setListingEnabled] = useState<boolean | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const { data, error: e } = await client.rpc('portal_amazon_list');
    if (e) throw e;
    setRows((data as Row[]) || []);
  }, [client]);

  useEffect(() => {
    void load().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [load]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`${base}/.netlify/functions/amazon-sync`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'status' }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok) setListingEnabled(Boolean(body.listingEnabled));
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

  async function addSkus(raw: string) {
    const skus = parseSkus(raw);
    if (!skus.length) return;
    setBusy(true);
    setError('');
    try {
      const { data, error: e } = await client.rpc('portal_amazon_list_add', { p_skus: skus, p_note: '' });
      if (e) throw e;
      const results = (data as { sku: string; ok: boolean; reason: string }[]) || [];
      const added = results.filter((x) => x.ok);
      const bad = results.filter((x) => !x.ok);
      setFlash(
        bad.length
          ? `Added ${added.length}. Skipped: ${bad.map((b) => `${b.sku} (${b.reason})`).join(', ')}`
          : `Added ${added.length} SKU${added.length === 1 ? '' : 's'}. Matching ASINsΓÇª`,
      );
      setDraft('');
      await load();
      // Prepare newly added (ASIN match + price) without listing
      for (const a of added) {
        await amazonListCall(accessToken, { action: 'prepare', sku: a.sku }).catch(() => undefined);
      }
      await load();
      inputRef.current?.focus();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function onScanKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    void addSkus(draft);
  }

  async function remove(sku: string) {
    setBusy(true);
    try {
      const { error: e } = await client.rpc('portal_amazon_list_remove', { p_sku: sku });
      if (e) throw e;
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveAsin(sku: string, asin: string) {
    setBusy(true);
    setError('');
    try {
      await amazonListCall(accessToken, { action: 'set_asin', sku, asin });
      await amazonListCall(accessToken, { action: 'prepare', sku });
      setFlash(`ASIN saved for ${sku}.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function retry(sku: string) {
    setBusy(true);
    try {
      await amazonListCall(accessToken, { action: 'retry', sku });
      setFlash(`Retried prepare for ${sku}.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
      setError(e instanceof Error ? e.message : String(e));
      await load();
    } finally {
      setBusy(false);
    }
  }

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
          Listing is OFF (`AMAZON_LISTING_ENABLED` Γëá 1). You can queue and prepare SKUs; List one will stay blocked until
          you enable it on inventoryobi.
        </div>
      )}

      <section className="panel amazon-add">
        <h2>Add SKU</h2>
        <div className="amazon-add-row">
          <input
            ref={inputRef}
            autoFocus
            inputMode={isKioskShell() ? 'none' : 'numeric'}
            autoComplete="off"
            spellCheck={false}
            placeholder="Scan or type SKU"
            aria-label="Scan or type SKU"
            value={draft}
            onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ''))}
            onKeyDown={onScanKey}
            disabled={busy}
          />
          <button disabled={busy || !parseSkus(draft).length} onClick={() => void addSkus(draft)}>
            Enter
          </button>
          <span className="hint">{rows.length} on list</span>
        </div>
      </section>

      <section className="panel">
        <h2>Queue</h2>
        {rows.length === 0 ? (
          <div className="empty">No SKUs yet. Scan or enter one above.</div>
        ) : (
          <div className="amazon-grid">
            {rows.map((r) => (
              <article className="amazon-card" key={r.id}>
                <div className="amazon-thumb">
                  {thumbs[r.sku] ? <img src={thumbs[r.sku]} alt="" /> : <span>No photo</span>}
                </div>
                <div className="amazon-body">
                  <div className="amazon-card-top">
                    <strong>SKU {r.sku}</strong>
                    <span className={`amazon-status st-${r.status}`}>{STATUS_LABEL[r.status] || r.status}</span>
                  </div>
                  <div className="amazon-title">{r.title || 'Untitled'}</div>
                  <div className="amazon-meta">
                    Floor {r.ask_cents != null ? moneyFmt(r.ask_cents) : 'ΓÇö'}
                    {r.amazon_price_cents != null ? ` ┬╖ Amazon ${moneyFmt(r.amazon_price_cents)}` : ''}
                    {r.fee_estimate_cents != null ? ` ┬╖ Fees ~${moneyFmt(r.fee_estimate_cents)}` : ''}
                    {r.cost_cents != null ? ` ┬╖ Cost ${moneyFmt(r.cost_cents)}` : ''}
                  </div>
                  <div className="amazon-meta">
                    Condition: {r.condition || 'ΓÇö'}
                    {r.condition_code ? ` ΓåÆ ${r.condition_code}` : ''}
                    {r.upc ? ` ┬╖ UPC ${r.upc}` : ''}
                  </div>
                  {r.asin ? (
                    <div className="amazon-meta">
                      ASIN <strong>{r.asin}</strong>
                      {r.matched_title ? ` ┬╖ ${r.matched_title}` : ''}
                    </div>
                  ) : (
                    <div className="amazon-meta">No ASIN matched yet</div>
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
                  {r.last_error && <p className="error" style={{ margin: '6px 0' }}>{r.last_error}</p>}
                  {r.needs_review_reason && <p className="hint" style={{ margin: '6px 0' }}>{r.needs_review_reason}</p>}
                  {r.condition_note && <p className="hint" style={{ margin: '6px 0' }}>{r.condition_note}</p>}

                  <label>
                    Confirm / change ASIN
                    <input
                      defaultValue={r.asin || ''}
                      key={`${r.sku}:asin:${r.asin}`}
                      disabled={busy}
                      placeholder="B0XXXXXXXX"
                      onBlur={(e) => {
                        const v = e.target.value.trim().toUpperCase();
                        if (v && v !== (r.asin || '')) void saveAsin(r.sku, v);
                      }}
                    />
                  </label>
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
            ))}
          </div>
        )}
      </section>
    </>
  );
}
