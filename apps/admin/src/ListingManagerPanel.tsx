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

type Eligible = {
  sku: string;
  title: string | null;
  brand: string | null;
  ask_cents: number | null;
  photo_count: number;
  thumb: string | null;
  condition: string | null;
};

type Channel = 'amazon' | 'ebay' | 'tiktok';

type Props = {
  accessToken: string;
  money: (n: number) => string;
};

async function lm(token: string, body: Record<string, unknown>) {
  const res = await fetch(floorFunctionUrl('listing-manager'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) {
    throw new Error(json.error || json.message || `Request failed (${res.status})`);
  }
  return json;
}

export function ListingManagerPanel({ accessToken, money }: Props) {
  const [channel, setChannel] = useState<Channel>('ebay');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<ListingRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [meta, setMeta] = useState('');
  const [lastSynced, setLastSynced] = useState<string | null>(null);

  const [edit, setEdit] = useState<ListingRow | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editPrice, setEditPrice] = useState('');
  const [editQty, setEditQty] = useState('');
  const [editCondition, setEditCondition] = useState('');
  const [editBullets, setEditBullets] = useState('');
  const [editImages, setEditImages] = useState('');

  const [showAdd, setShowAdd] = useState(false);
  const [eligible, setEligible] = useState<Eligible[]>([]);
  const [eligibleQuery, setEligibleQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);
  const [draftSku, setDraftSku] = useState('');

  const [legacy, setLegacy] = useState<{ sku: string; listing_id: string; title: string }[]>([]);
  const [showMigrate, setShowMigrate] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const body = await lm(accessToken, { action: 'list', channel, query, limit: 80 });
      setItems((body.items || []) as ListingRow[]);
      const synced = body.last_synced?.at || null;
      setLastSynced(synced);
      if (body.stub) setMeta(String(body.message || 'Not connected'));
      else if (body.accounts) setMeta(`${body.accounts.length} eBay account(s) · ${(body.items || []).length} listing(s)`);
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

  async function openEdit(row: ListingRow) {
    setBusy(true);
    setError('');
    try {
      const detail = await lm(accessToken, {
        action: 'detail',
        channel: row.channel,
        sku: row.sku,
        offer_id: row.offer_id,
        account_id: row.account_id,
        product_id: row.product_id,
      });
      setEdit(row);
      setEditTitle(String(detail.title || row.title || ''));
      setEditDesc(String(detail.description || ''));
      setEditPrice(
        detail.price_cents != null
          ? (Number(detail.price_cents) / 100).toFixed(2)
          : row.price_cents != null
            ? (row.price_cents / 100).toFixed(2)
            : '',
      );
      setEditQty(detail.qty != null ? String(detail.qty) : row.qty != null ? String(row.qty) : '1');
      setEditCondition(String(detail.condition_description || detail.condition_note || ''));
      setEditBullets('');
      setEditImages(Array.isArray(detail.image_urls) ? detail.image_urls.join('\n') : '');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit() {
    if (!edit) return;
    const price_cents = editPrice.trim() ? Math.round(Number(editPrice) * 100) : null;
    const quantity = editQty.trim() ? Math.round(Number(editQty)) : null;
    setBusy(true);
    setError('');
    try {
      const body = await lm(accessToken, {
        action: 'patch',
        channel: edit.channel,
        sku: edit.sku,
        offer_sku: edit.offer_sku,
        offer_id: edit.offer_id,
        account_id: edit.account_id,
        product_id: edit.product_id,
        price_cents,
        quantity,
        title: editTitle.trim() || null,
        description: editDesc.trim() || null,
        condition_note: editCondition.trim() || null,
        bullets: editBullets
          .split(/\n+/)
          .map((s) => s.trim())
          .filter(Boolean),
        image_urls: editImages
          .split(/\n+/)
          .map((s) => s.trim())
          .filter(Boolean),
        sync_floor_ask: true,
      });
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
    if (!window.confirm(`End this ${row.channel} listing${row.sku ? ` (SKU ${row.sku})` : ''}? Unit stays available — not marked sold.`))
      return;
    setBusy(true);
    setError('');
    try {
      await lm(accessToken, {
        action: 'end',
        channel: row.channel,
        sku: row.sku,
        offer_sku: row.offer_sku,
        offer_id: row.offer_id,
        account_id: row.account_id,
        product_id: row.product_id,
      });
      setNotice('Listing ended via marketplace API. Floor unit was not marked sold.');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function relist(row: ListingRow) {
    if (row.channel !== 'ebay' || !row.sku) return;
    if (!window.confirm(`Relist SKU ${row.sku} on eBay selling account?`)) return;
    setBusy(true);
    setError('');
    try {
      const body = await lm(accessToken, {
        action: 'relist',
        channel: 'ebay',
        sku: row.sku,
        offer_id: row.offer_id,
        account_id: row.account_id,
      });
      setNotice(body.url ? `Relisted — ${body.url}` : 'Relist submitted.');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function openAdd() {
    setShowAdd(true);
    setDraft(null);
    setDraftSku('');
    setSelected(new Set());
    setBusy(true);
    setError('');
    try {
      const body = await lm(accessToken, {
        action: 'eligible',
        channel,
        query: eligibleQuery,
        limit: 40,
      });
      setEligible((body.items || []) as Eligible[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function loadEligible() {
    setBusy(true);
    try {
      const body = await lm(accessToken, { action: 'eligible', channel, query: eligibleQuery, limit: 40 });
      setEligible((body.items || []) as Eligible[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function pickForDraft(sku: string) {
    setBusy(true);
    setError('');
    try {
      const body = await lm(accessToken, { action: 'prefill', channel, sku });
      setDraftSku(sku);
      setDraft({
        ...(body.draft || {}),
        title: body.draft?.title || '',
        description: body.draft?.description || '',
        price: body.draft?.price_cents != null ? (Number(body.draft.price_cents) / 100).toFixed(2) : '',
      });
      if (body.draft?.note) setNotice(String(body.draft.note));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function publishDraft() {
    if (!draftSku || !draft) return;
    setBusy(true);
    setError('');
    try {
      const body = await lm(accessToken, {
        action: 'publish',
        channel,
        sku: draftSku,
        title: draft.title || null,
        description: draft.description || null,
        price_cents: draft.price ? Math.round(Number(draft.price) * 100) : null,
        image_urls: draft.image_urls || null,
        confirm_create: true,
      });
      if (body.needs_confirm) {
        setNotice(String(body.message || 'Preview clean — confirm to go live.'));
      } else if (body.ok) {
        setNotice(body.url ? `Live: ${body.url}` : body.warning ? `Published with warning: ${body.warning}` : 'Published.');
        setShowAdd(false);
        setDraft(null);
        await load();
      } else {
        setError(String(body.error || body.message || 'Publish failed'));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function bulkPublish() {
    const skus = [...selected];
    if (!skus.length) return;
    if (!window.confirm(`Create paced drafts/publish for ${skus.length} SKU(s) on ${channel}? ~10s between each.`)) return;
    setBusy(true);
    setError('');
    try {
      const body = await lm(accessToken, { action: 'bulk_publish', channel, skus });
      setNotice(String(body.message || 'Bulk started'));
      setShowAdd(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function openMigrate() {
    setShowMigrate(true);
    setBusy(true);
    setError('');
    try {
      const body = await lm(accessToken, { action: 'migrate_candidates', limit: 50 });
      setLegacy((body.items || []) as { sku: string; listing_id: string; title: string }[]);
      setNotice(`${(body.items || []).length} legacy candidate(s) (Floor listed, not in Inventory API).`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function migrateOne(listingId: string) {
    if (!window.confirm(`Migrate listing ${listingId} into Inventory API? Live listing should stay the same (price/photos/views).`))
      return;
    setBusy(true);
    setError('');
    try {
      const body = await lm(accessToken, {
        action: 'migrate_one',
        listing_ids: [listingId],
      });
      const r = (body.results || [])[0];
      if (r?.ok || body.ok) setNotice(`Migrated ${listingId} — refresh eBay tab to edit.`);
      else setError((r?.errors || []).join(' · ') || body.error || 'Migrate failed');
      await openMigrate();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function migrateBatch() {
    const ids = legacy.slice(0, 5).map((x) => x.listing_id);
    if (!ids.length) return;
    if (!window.confirm(`Migrate next ${ids.length} listing(s) into Inventory API?`)) return;
    setBusy(true);
    setError('');
    try {
      const body = await lm(accessToken, { action: 'migrate_batch', listing_ids: ids });
      setNotice(
        `Migrate batch: ${body.summary?.ok ?? 0} ok · ${body.summary?.failed ?? 0} failed of ${body.summary?.requested ?? ids.length}`,
      );
      await openMigrate();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const syncedLabel = lastSynced
    ? `Last synced ${new Date(lastSynced).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })} PT`
    : 'Not synced this session';

  return (
    <section className="panel">
      <div className="section-head">
        <div>
          <div className="eyebrow">LIVE LISTINGS</div>
          <h2>Listing manager</h2>
          <p className="hint" style={{ margin: 0 }}>
            Add, edit, and end Amazon / eBay / TikTok listings from Floor. Admin-only. Real photos only — no AI images. Ending never
            marks a unit sold. Depop has no public listing API.
          </p>
        </div>
        <div className="actions">
          <button type="button" className="secondary" disabled={busy} onClick={() => void load()}>
            Refresh
          </button>
          <button type="button" disabled={busy} onClick={() => void openAdd()}>
            Add listing
          </button>
          {channel === 'ebay' && (
            <button type="button" className="secondary" disabled={busy} onClick={() => void openMigrate()}>
              Migrate legacy eBay
            </button>
          )}
        </div>
      </div>

      <div className="actions" style={{ marginBottom: '0.75rem', flexWrap: 'wrap' }}>
        {(
          [
            ['ebay', 'eBay'],
            ['amazon', 'Amazon'],
            ['tiktok', 'TikTok Shop'],
          ] as const
        ).map(([key, label]) => (
          <button key={key} type="button" className={channel === key ? '' : 'secondary'} disabled={busy} onClick={() => setChannel(key)}>
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
      <p className="hint">
        {meta} · {syncedLabel}
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
          {notice}
          <button type="button" className="text-button" onClick={() => setNotice('')}>
            Dismiss
          </button>
        </div>
      )}

      {items.length === 0 ? (
        <div className="empty">No listings loaded for {channel}. Use Add listing or Refresh.</div>
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
                <p className="hint">
                  Not editable via API{row.api === 'legacy_floor_only' ? ' (Trading/Vendoo — use Migrate legacy eBay)' : ''}.
                </p>
              )}
              <div className="actions">
                {row.url && (
                  <a className="text-button" href={row.url} target="_blank" rel="noreferrer">
                    Open live
                  </a>
                )}
                {row.editable && (
                  <button type="button" className="secondary" disabled={busy} onClick={() => void openEdit(row)}>
                    Edit
                  </button>
                )}
                {row.editable && (
                  <button type="button" className="text-button danger" disabled={busy} onClick={() => void endListing(row)}>
                    End
                  </button>
                )}
                {row.channel === 'ebay' && row.sku && (
                  <button type="button" className="text-button" disabled={busy} onClick={() => void relist(row)}>
                    Relist
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
            style={{ maxWidth: 640 }}
            onSubmit={(e) => {
              e.preventDefault();
              void saveEdit();
            }}
          >
            <h2>Edit {edit.channel} listing</h2>
            <p>
              {edit.sku ? `SKU ${edit.sku}` : ''}
              {edit.account ? ` · ${edit.account}` : ''}
            </p>
            <label>
              Title
              <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
            </label>
            <label>
              Description
              <textarea rows={5} value={editDesc} onChange={(e) => setEditDesc(e.target.value)} />
            </label>
            {edit.channel === 'amazon' && (
              <label>
                Bullets (one per line)
                <textarea rows={4} value={editBullets} onChange={(e) => setEditBullets(e.target.value)} />
              </label>
            )}
            <label>
              Price ($)
              <input type="number" step="0.01" min="1" value={editPrice} onChange={(e) => setEditPrice(e.target.value)} />
            </label>
            <label>
              Quantity
              <input type="number" step="1" min="0" value={editQty} onChange={(e) => setEditQty(e.target.value)} />
            </label>
            <label>
              Condition notes
              <textarea rows={2} value={editCondition} onChange={(e) => setEditCondition(e.target.value)} />
            </label>
            {edit.channel === 'ebay' && (
              <label>
                Photo URLs (https, one per line — real photos only)
                <textarea rows={4} value={editImages} onChange={(e) => setEditImages(e.target.value)} />
              </label>
            )}
            <p className="hint">Warns if under ~$5 profit floor — does not silently block. Price syncs to Floor ask.</p>
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

      {showAdd && (
        <div className="modal-backdrop">
          <div className="panel modal" style={{ maxWidth: 720 }}>
            <h2>Add {channel} listing from Floor</h2>
            {!draft ? (
              <>
                <label>
                  Find units (photos + price, not already on {channel})
                  <input
                    value={eligibleQuery}
                    onChange={(e) => setEligibleQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void loadEligible();
                      }
                    }}
                  />
                </label>
                <div className="actions">
                  <button type="button" className="secondary" disabled={busy} onClick={() => void loadEligible()}>
                    Search
                  </button>
                  <button type="button" disabled={busy || selected.size < 2} onClick={() => void bulkPublish()}>
                    Bulk publish selected ({selected.size})
                  </button>
                  <button type="button" className="secondary" onClick={() => setShowAdd(false)}>
                    Close
                  </button>
                </div>
                <div className="ticket-list">
                  {eligible.map((u) => (
                    <div className="ticket" key={u.sku}>
                      <div className="ticket-top">
                        <strong>{u.title || `SKU ${u.sku}`}</strong>
                        <span>
                          SKU {u.sku}
                          {u.ask_cents != null ? ` · ${money(u.ask_cents)}` : ''} · {u.photo_count} photo(s)
                        </span>
                      </div>
                      <div className="actions">
                        <label>
                          <input
                            type="checkbox"
                            checked={selected.has(u.sku)}
                            onChange={(e) => {
                              const next = new Set(selected);
                              if (e.target.checked) next.add(u.sku);
                              else next.delete(u.sku);
                              setSelected(next);
                            }}
                          />{' '}
                          Select
                        </label>
                        <button type="button" disabled={busy} onClick={() => void pickForDraft(u.sku)}>
                          Review & publish
                        </button>
                      </div>
                    </div>
                  ))}
                  {!eligible.length && <div className="empty">No eligible units.</div>}
                </div>
              </>
            ) : (
              <>
                <p className="hint">SKU {draftSku} — real brand/photos only. Review then publish live.</p>
                <label>
                  Title
                  <input
                    value={String(draft.title || '')}
                    onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  />
                </label>
                <label>
                  Description
                  <textarea
                    rows={5}
                    value={String(draft.description || '')}
                    onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  />
                </label>
                <label>
                  Price ($)
                  <input
                    type="number"
                    step="0.01"
                    value={String(draft.price || '')}
                    onChange={(e) => setDraft({ ...draft, price: e.target.value })}
                  />
                </label>
                <div className="actions">
                  <button type="button" disabled={busy} onClick={() => void publishDraft()}>
                    Publish live
                  </button>
                  <button type="button" className="secondary" onClick={() => setDraft(null)}>
                    Back
                  </button>
                  <button type="button" className="secondary" onClick={() => setShowAdd(false)}>
                    Close
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {showMigrate && (
        <div className="modal-backdrop">
          <div className="panel modal" style={{ maxWidth: 720 }}>
            <h2>Migrate legacy eBay → Inventory API</h2>
            <p className="hint">
              Trading/Vendoo listings that Floor knows about but Inventory API does not. Migrating should keep the live listing
              (price/photos/views). Test one first.
            </p>
            <div className="actions">
              <button type="button" disabled={busy || !legacy.length} onClick={() => void migrateBatch()}>
                Migrate next 5
              </button>
              <button type="button" className="secondary" onClick={() => setShowMigrate(false)}>
                Close
              </button>
            </div>
            <div className="ticket-list">
              {legacy.map((row) => (
                <div className="ticket" key={row.listing_id}>
                  <strong>
                    {row.title} · SKU {row.sku}
                  </strong>
                  <small>Item {row.listing_id}</small>
                  <div className="actions">
                    <button type="button" className="secondary" disabled={busy} onClick={() => void migrateOne(row.listing_id)}>
                      Migrate this one
                    </button>
                  </div>
                </div>
              ))}
              {!legacy.length && <div className="empty">No legacy candidates found (all Floor eBay rows already in Inventory API, or none listed).</div>}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
