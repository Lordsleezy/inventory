import { useCallback, useEffect, useState } from 'react';
import { floorFunctionUrl } from './floorApi';

type ListingRow = {
  channel: string;
  sku: string | null;
  title: string | null;
  price_cents: number | null;
  qty: number | null;
  status: string | null;
  floor_state?: string | null;
  floor_ask_cents?: number | null;
  drift?: string | null;
  url?: string | null;
  editable?: boolean;
  asin?: string | null;
  offer_sku?: string | null;
  offer_id?: string | null;
  account?: string | null;
  account_id?: string | null;
  account_role?: string | null;
  product_id?: string | null;
  item_id?: string | null;
  api?: string | null;
  error?: string | null;
};

type Channel = 'amazon' | 'ebay' | 'tiktok';

type Props = {
  accessToken: string;
  money: (n: number) => string;
};

export function ListingManagerPanel({ accessToken, money }: Props) {
  const [channel, setChannel] = useState<Channel>('amazon');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<ListingRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [meta, setMeta] = useState('');
  const [edit, setEdit] = useState<ListingRow | null>(null);
  const [editPrice, setEditPrice] = useState('');
  const [editQty, setEditQty] = useState('');

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(floorFunctionUrl('listing-manager'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'list', channel, query, limit: 80 }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) throw new Error(body.error || `List failed (${res.status})`);
      setItems((body.items || []) as ListingRow[]);
      if (body.stub) setMeta(String(body.message || 'Not connected'));
      else if (body.accounts) setMeta(`${body.accounts.length} eBay account(s)`);
      else setMeta(`${(body.items || []).length} listing(s)`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setItems([]);
    } finally {
      setBusy(false);
    }
  }, [accessToken, channel, query]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveEdit() {
    if (!edit) return;
    const price_cents = editPrice.trim() ? Math.round(Number(editPrice) * 100) : null;
    const quantity = editQty.trim() ? Math.round(Number(editQty)) : null;
    if (price_cents != null && (!Number.isFinite(price_cents) || price_cents < 100)) {
      setError('Enter a valid price');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await fetch(floorFunctionUrl('listing-manager'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'patch',
          channel: edit.channel,
          sku: edit.sku,
          offer_sku: edit.offer_sku,
          offer_id: edit.offer_id,
          account_id: edit.account_id,
          product_id: edit.product_id,
          price_cents,
          quantity,
          sync_floor_ask: true,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) throw new Error(body.error || body.message || `Save failed (${res.status})`);
      setNotice(body.warning ? `Saved with warning: ${body.warning}` : 'Saved — pushed to marketplace + Floor ask updated.');
      setEdit(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function endListing(row: ListingRow) {
    if (!row.editable) return;
    if (!window.confirm(`End this ${row.channel} listing${row.sku ? ` (SKU ${row.sku})` : ''}?`)) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(floorFunctionUrl('listing-manager'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'end',
          channel: row.channel,
          sku: row.sku,
          offer_sku: row.offer_sku,
          offer_id: row.offer_id,
          account_id: row.account_id,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) throw new Error(body.error || body.message || `End failed (${res.status})`);
      setNotice('Listing ended via marketplace API.');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <div className="section-head">
        <div>
          <div className="eyebrow">LIVE LISTINGS</div>
          <h2>Listing manager</h2>
          <p className="hint" style={{ margin: 0 }}>
            Manage Amazon, eBay (both accounts), and TikTok listings from Floor. Price edits sync to Floor ask and warn under the $5 profit floor.
            Depop has no public listing API.
          </p>
        </div>
        <button type="button" className="secondary" disabled={busy} onClick={() => void load()}>
          Refresh
        </button>
      </div>

      <div className="actions" style={{ marginBottom: '0.75rem', flexWrap: 'wrap' }}>
        {([
          ['amazon', 'Amazon'],
          ['ebay', 'eBay'],
          ['tiktok', 'TikTok Shop'],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={channel === key ? '' : 'secondary'}
            disabled={busy}
            onClick={() => setChannel(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <label>
        Search
        <input
          value={query}
          disabled={busy}
          placeholder="SKU, title, ASIN…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void load();
            }
          }}
        />
      </label>
      <p className="hint">{meta}</p>
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
          {notice}
          <button type="button" className="text-button" onClick={() => setNotice('')}>
            Dismiss
          </button>
        </div>
      )}

      {items.length === 0 ? (
        <div className="empty">No listings loaded for {channel}.</div>
      ) : (
        <div className="ticket-list">
          {items.map((row, i) => (
            <div className="ticket" key={`${row.channel}-${row.sku}-${row.offer_id || row.asin || row.product_id || i}`}>
              <div className="ticket-top">
                <strong>{row.title || row.sku || 'Listing'}</strong>
                <span>
                  {row.sku ? `SKU ${row.sku}` : 'No Floor SKU'}
                  {row.account ? ` · ${row.account}${row.account_role ? ` (${row.account_role})` : ''}` : ''}
                  {row.asin ? ` · ${row.asin}` : ''}
                  {row.price_cents != null ? ` · ${money(row.price_cents)}` : ''}
                  {row.qty != null ? ` · qty ${row.qty}` : ''}
                  {row.status ? ` · ${row.status}` : ''}
                </span>
              </div>
              {row.drift && (
                <p className="alert" role="status" style={{ margin: '6px 0' }}>
                  Drift: {row.drift}
                </p>
              )}
              {row.error && <p className="error">{row.error}</p>}
              {!row.editable && (
                <p className="hint">Not editable via API{row.api === 'legacy_floor_only' ? ' (Trading/Vendoo-era)' : ''}.</p>
              )}
              <div className="actions">
                {row.url && (
                  <a className="text-button" href={row.url} target="_blank" rel="noreferrer">
                    Open live
                  </a>
                )}
                {row.editable && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      setEdit(row);
                      setEditPrice(row.price_cents != null ? (row.price_cents / 100).toFixed(2) : '');
                      setEditQty(row.qty != null ? String(row.qty) : '');
                    }}
                  >
                    Edit
                  </button>
                )}
                {row.editable && (row.channel === 'amazon' || row.channel === 'ebay') && (
                  <button type="button" className="text-button danger" disabled={busy} onClick={() => void endListing(row)}>
                    End
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {edit && (
        <div className="modal-backdrop">
          <form
            className="panel modal"
            onSubmit={(e) => {
              e.preventDefault();
              void saveEdit();
            }}
          >
            <h2>Edit {edit.channel} listing</h2>
            <p>
              {edit.title}
              {edit.sku ? ` · SKU ${edit.sku}` : ''}
              {edit.account ? ` · ${edit.account}` : ''}
            </p>
            <label>
              Price ($)
              <input
                type="number"
                step="0.01"
                min="1"
                value={editPrice}
                onChange={(e) => setEditPrice(e.target.value)}
              />
            </label>
            <label>
              Quantity
              <input type="number" step="1" min="0" value={editQty} onChange={(e) => setEditQty(e.target.value)} />
            </label>
            <p className="hint">Saves through the marketplace API and updates Floor ask. Warns if under ~$5 profit floor — does not silently block.</p>
            <div className="actions">
              <button type="submit" disabled={busy}>
                Save
              </button>
              <button type="button" className="secondary" onClick={() => setEdit(null)}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
