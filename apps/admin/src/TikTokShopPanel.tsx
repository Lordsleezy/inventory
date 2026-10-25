import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { floorFunctionUrl } from './floorApi';
import { errText } from './errText';

type TikTokStatus = {
  ok?: boolean;
  connected?: boolean;
  healthy?: boolean;
  shopId?: string | null;
  listingEnabled?: boolean;
  hasEnvCreds?: boolean;
  hasStoredTokens?: boolean;
  redirectUrl?: string;
  scopes?: string[];
  checklist?: string[];
  lastError?: string | null;
  connectedAt?: string | null;
  expiresAt?: string | null;
  error?: string;
};

type QueueRow = {
  sku: string;
  status: string;
  product_id: string | null;
  tiktok_price_cents: number | null;
  last_error: string | null;
  listed_at: string | null;
  updated_at: string;
  title: string | null;
};

type Props = {
  client: SupabaseClient;
  accessToken: string;
  money: (n: number) => string;
  /** Marketplaces page: connection + order sync only (listing lives under TikTok tab). */
  connectionOnly?: boolean;
};

async function tiktokCall(token: string, body: Record<string, unknown>) {
  const res = await fetch(floorFunctionUrl('tiktok-list'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) throw new Error(json.error || json.message || json.reason || `TikTok request failed (${res.status})`);
  return json as TikTokStatus & Record<string, unknown>;
}

export function TikTokShopPanel({ client, accessToken, money, connectionOnly = false }: Props) {
  const [status, setStatus] = useState<TikTokStatus | null>(null);
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [skuDraft, setSkuDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadQueue = useCallback(async () => {
    const { data, error: e } = await client.rpc('portal_tiktok_list');
    if (e) throw e;
    setRows((data as QueueRow[]) || []);
  }, [client]);

  const loadStatus = useCallback(async () => {
    try {
      const s = await tiktokCall(accessToken, { action: 'status' });
      setStatus(s);
      setError('');
    } catch (e) {
      setError(errText(e));
    }
  }, [accessToken]);

  useEffect(() => {
    void loadStatus();
    if (!connectionOnly) {
      void loadQueue().catch((e) => setError(errText(e)));
    }
  }, [loadStatus, loadQueue, connectionOnly]);

  async function authorize() {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`${floorFunctionUrl('oauth-start')}?provider=tiktok`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || body.error || `Authorize failed (${res.status})`);
      if (body.url) window.location.href = body.url;
      else throw new Error('No authorize URL returned');
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function addSku() {
    const sku = skuDraft.trim();
    if (!sku) return;
    setBusy(true);
    setError('');
    try {
      const { data, error: e } = await client.rpc('portal_tiktok_list_add', { p_skus: [sku] });
      if (e) throw e;
      setSkuDraft('');
      setNotice(`Queued ${data || 0} SKU(s). Preparing…`);
      await loadQueue();
      await tiktokCall(accessToken, { action: 'prepare', sku }).catch((err) => {
        setError(errText(err));
      });
      await loadQueue();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function listOne(sku: string) {
    setBusy(true);
    setError('');
    try {
      const result = await tiktokCall(accessToken, { action: 'list_one', sku });
      setNotice(result.ok ? `Listed SKU ${sku} on TikTok Shop.` : String(result.message || result.reason));
      await loadQueue();
    } catch (e) {
      setError(errText(e));
      await loadQueue();
    } finally {
      setBusy(false);
    }
  }

  async function prepare(sku: string) {
    setBusy(true);
    setError('');
    try {
      await tiktokCall(accessToken, { action: 'prepare', sku });
      setNotice(`Prepared SKU ${sku}.`);
      await loadQueue();
    } catch (e) {
      setError(errText(e));
      await loadQueue();
    } finally {
      setBusy(false);
    }
  }

  const errors = rows.filter((r) => r.status === 'error' || r.last_error);

  return (
    <section className="panel">
      <h2>TikTok Shop connection</h2>
      <p>
        OAuth, API health, and order sync. List / edit / end listings from the TikTok sidebar tab. Keys live in Netlify
        env; tokens in <code>connections</code> (provider=tiktok).
      </p>

      {error && (
        <div className="alert" role="alert">
          {error}
          <button type="button" onClick={() => setError('')}>
            Dismiss
          </button>
        </div>
      )}
      {notice && (
        <div className="hint">
          {notice}{' '}
          <button type="button" className="text-button" onClick={() => setNotice('')}>
            Dismiss
          </button>
        </div>
      )}

      <div className="ticket-list">
        <div className="ticket">
          <div className="ticket-top">
            <strong>{status?.connected ? 'Connected' : 'Not connected'}</strong>
            <span>
              {status?.healthy ? 'API healthy' : status?.lastError || 'Waiting for env / authorize'}
              {status?.shopId ? ` · shop ${status.shopId}` : ''}
              {status?.listingEnabled === false ? ' · listing OFF' : ''}
            </span>
          </div>
          {status?.redirectUrl && (
            <p className="hint">
              Partner Center redirect URL: <code>{status.redirectUrl}</code>
            </p>
          )}
          {status?.lastError && <p className="hint">Last error: {status.lastError}</p>}
          {!!status?.checklist?.length && (
            <ul className="hint">
              {status.checklist.slice(0, 6).map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          )}
          <div className="actions">
            <button disabled={busy || !status?.hasEnvCreds} onClick={() => void authorize()}>
              Authorize TikTok Shop
            </button>
            <button className="secondary" disabled={busy} onClick={() => void loadStatus()}>
              Refresh status
            </button>
            <button
              className="secondary"
              disabled={busy || !status?.connected}
              onClick={() =>
                void (async () => {
                  setBusy(true);
                  try {
                    await tiktokCall(accessToken, { action: 'sync_orders' });
                    setNotice('TikTok order sync finished.');
                  } catch (e) {
                    setError(errText(e));
                  } finally {
                    setBusy(false);
                  }
                })()
              }
            >
              Sync orders now
            </button>
          </div>
          {!status?.hasEnvCreds && (
            <p className="hint">
              Set <code>TIKTOK_SHOP_APP_KEY</code> and <code>TIKTOK_SHOP_APP_SECRET</code> (plus shop id) in Netlify
              before Authorize works.
            </p>
          )}
        </div>
      </div>

      {!connectionOnly && (
        <>
          <h3 style={{ marginTop: '1.25rem' }}>Listing queue</h3>
          <p className="hint">
            Listings are priced at the Floor set price; the buyer pays shipping.
          </p>
          <div className="actions">
            <input
              aria-label="Floor SKU"
              inputMode="numeric"
              placeholder="Floor SKU"
              value={skuDraft}
              disabled={busy}
              onChange={(e) => setSkuDraft(e.target.value.replace(/[^\dA-Za-z\-]/g, ''))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void addSku();
                }
              }}
            />
            <button disabled={busy || !skuDraft.trim()} onClick={() => void addSku()}>
              Add to queue
            </button>
          </div>

          {errors.length > 0 && (
            <div className="alert" role="status">
              <strong>{errors.length} queue error(s)</strong>
              <ul>
                {errors.slice(0, 12).map((r) => (
                  <li key={r.sku}>
                    SKU {r.sku}: {r.last_error || r.status}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {rows.length === 0 ? (
            <div className="empty">No TikTok queue items yet.</div>
          ) : (
            <div className="ticket-list">
              {rows.map((r) => (
                <div className="ticket" key={r.sku}>
                  <div className="ticket-top">
                    <strong>{r.title || `SKU ${r.sku}`}</strong>
                    <span>
                      {r.status}
                      {r.tiktok_price_cents != null ? ` · ${money(r.tiktok_price_cents)}` : ''}
                      {r.product_id ? ` · ${r.product_id}` : ''}
                    </span>
                  </div>
                  {r.last_error && <p className="hint">Error: {r.last_error}</p>}
                  <div className="actions">
                    {(r.status === 'queued' || r.status === 'error' || r.status === 'ready') && (
                      <button className="secondary" disabled={busy} onClick={() => void prepare(r.sku)}>
                        Prepare
                      </button>
                    )}
                    {(r.status === 'ready' || r.status === 'error') && (
                      <button disabled={busy || status?.listingEnabled === false} onClick={() => void listOne(r.sku)}>
                        List on TikTok
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
