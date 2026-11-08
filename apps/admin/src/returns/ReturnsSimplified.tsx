import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { errText } from '../errText';
import { useVisibleInterval } from '../useVisibleInterval';
import { floorFunctionUrl } from '../floorApi';
import {
  type Candidate,
  type ReturnRow,
  type TrackingBundle,
  cents,
  dollars,
  laToday,
  statusLabel,
  statusTone,
} from './returnsShared';

type Screen = 'list' | 'new' | 'detail' | 'edit';
type Seg = 'open' | 'closed';

type Props = {
  client: SupabaseClient;
  storeId: string;
  money: (n: number) => string;
  stamp: (s: string) => string;
  variant: 'app' | 'desktop';
  accessToken?: string;
};

const CHANNEL: Record<string, string> = {
  website: 'Website', ebay: 'eBay', amazon: 'Amazon', tiktok: 'TikTok', depop: 'Depop', mercari: 'Mercari',
};

function toneClass(tone: ReturnType<typeof statusTone>) {
  if (tone === 'warn') return 'returns-status-warn';
  if (tone === 'ok') return 'returns-status-ok';
  if (tone === 'info') return 'returns-status-info';
  return 'returns-status-muted';
}

export function ReturnsSimplified({ client, storeId: _storeId, money, stamp, variant, accessToken }: Props) {
  void _storeId;
  const app = variant === 'app';
  const [screen, setScreen] = useState<Screen>('list');
  const [seg, setSeg] = useState<Seg>('open');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<ReturnRow[] | null>(null);
  const [selected, setSelected] = useState<ReturnRow | null>(null);
  const [tracking, setTracking] = useState<TrackingBundle | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const [search, setSearch] = useState('');
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [pickedSale, setPickedSale] = useState<number | null>(null);
  const [pickQty, setPickQty] = useState('1');
  const [buyerKeeps, setBuyerKeeps] = useState(false);
  const [refund, setRefund] = useState('');
  const [labelCost, setLabelCost] = useState('');
  const [trackingNo, setTrackingNo] = useState('');

  const [editKeeps, setEditKeeps] = useState(false);
  const [editRefund, setEditRefund] = useState('');
  const [editLabel, setEditLabel] = useState('');
  const [editTracking, setEditTracking] = useState('');
  const [editQty, setEditQty] = useState('1');
  const [deductPct, setDeductPct] = useState('10');
  const [deductNote, setDeductNote] = useState('');
  const [deductPhoto, setDeductPhoto] = useState('');
  const [deductType, setDeductType] = useState('image/jpeg');

  const load = useCallback(async () => {
    const filter = seg === 'open' ? 'open' : 'closed';
    const { data, error: e } = await client.rpc('portal_return_desk', {
      p_filter: filter,
      p_query: query.trim() || null,
      p_from: seg === 'closed' ? '2000-01-01' : null,
      p_to: laToday(),
    });
    if (e) {
      setError(e.message);
      return;
    }
    const body = (data || {}) as { rows?: ReturnRow[] };
    setRows(body.rows || []);
    setSelected((cur) => (cur ? body.rows?.find((r) => r.id === cur.id) || cur : null));
  }, [client, query, seg]);

  useVisibleInterval(load, 60_000);

  const loadTracking = useCallback(async (returnId: string) => {
    try {
      if (accessToken) {
        await fetch(floorFunctionUrl('return-track-sync'), {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ return_id: returnId }),
        });
      }
      const { data, error: e } = await client.rpc('portal_return_tracking_timeline', { p_return: returnId });
      if (e) throw e;
      setTracking((data || null) as TrackingBundle | null);
    } catch {
      setTracking(null);
    }
  }, [accessToken, client]);

  useEffect(() => {
    if (screen === 'detail' && selected) void loadTracking(selected.id);
  }, [screen, selected?.id, loadTracking]);

  useEffect(() => {
    if (screen !== 'detail' || !selected) return;
    const id = selected.id;
    const t = setInterval(() => { void loadTracking(id); }, 120_000);
    return () => clearInterval(t);
  }, [screen, selected, loadTracking]);

  const picked = useMemo(
    () => candidates?.find((c) => c.sale_id === pickedSale) || null,
    [candidates, pickedSale],
  );

  async function findSales() {
    const q = search.trim();
    if (!q) return;
    setBusy('search');
    setError('');
    const { data, error: e } = await client.rpc('portal_return_candidates', { p_query: q });
    setBusy('');
    if (e) {
      setError(e.message);
      return;
    }
    const list = (data as Candidate[]) || [];
    setCandidates(list);
    if (list.length === 1) {
      setPickedSale(list[0].sale_id);
      const max = Math.max(1, list[0].qty - list[0].qty_open);
      setPickQty(String(max));
      if (list[0].hint_refund_cents) setRefund(dollars(list[0].hint_refund_cents));
      if (list[0].hint_tracking) setTrackingNo(list[0].hint_tracking);
    } else {
      setPickedSale(null);
    }
    if (!list.length) setError(`Nothing sold matches “${q}”.`);
  }

  function openNew() {
    setScreen('new');
    setSearch('');
    setCandidates(null);
    setPickedSale(null);
    setBuyerKeeps(false);
    setRefund('');
    setLabelCost('');
    setTrackingNo('');
    setError('');
  }

  async function submitNew() {
    if (!picked) {
      setError('Select a sale.');
      return;
    }
    const qty = Math.max(1, Math.trunc(Number(pickQty) || 1));
    setBusy('save');
    setError('');
    const { data, error: e } = await client.rpc('portal_start_returns', {
      p_lines: [{ sale_id: picked.sale_id, qty }],
      p_label_cents: buyerKeeps ? 0 : cents(labelCost),
      p_label_paid_by: 'seller',
      p_note: null,
      p_reason: 'other',
      p_no_shipment: buyerKeeps,
      p_refund_cents: cents(refund),
      p_tracking_number: buyerKeeps ? null : trackingNo.trim() || null,
    });
    setBusy('');
    if (e) {
      setError(errText(e));
      return;
    }
    const created = (data as ReturnRow[]) || [];
    await load();
    if (created[0]) {
      setSelected(created[0]);
      setScreen('detail');
    } else {
      setScreen('list');
    }
  }

  function openDetail(r: ReturnRow) {
    setSelected(r);
    setScreen('detail');
  }

  function openEdit() {
    if (!selected) return;
    setEditKeeps(selected.route_to === 'buyer_keeps' || selected.status === 'refunded_no_return');
    setEditRefund(selected.refund_cents ? dollars(selected.refund_cents) : '');
    setEditLabel(selected.return_label_cents ? dollars(selected.return_label_cents) : '');
    setEditTracking(selected.tracking_number || '');
    setEditQty(String(selected.requested_qty || 1));
    setScreen('edit');
  }

  async function saveEdit() {
    if (!selected) return;
    setBusy('edit');
    setError('');
    const { data, error: e } = await client.rpc('portal_return_edit', {
      p_return: selected.id,
      p_patch: {
        buyer_keeps: editKeeps,
        refund_cents: cents(editRefund),
        return_label_cents: cents(editLabel),
        tracking_number: editTracking.trim() || null,
        requested_qty: Math.max(1, Math.trunc(Number(editQty) || 1)),
      },
    });
    setBusy('');
    if (e) {
      setError(errText(e));
      return;
    }
    const row = data as ReturnRow;
    setSelected(row);
    setScreen('detail');
    await load();
    void loadTracking(row.id);
  }

  async function cancelReturn() {
    if (!selected || !confirm('Cancel this return? Money entries will be reversed.')) return;
    setBusy('cancel');
    const { error: e } = await client.rpc('portal_return_edit', {
      p_return: selected.id,
      p_patch: { cancel: true },
    });
    setBusy('');
    if (e) {
      setError(errText(e));
      return;
    }
    setScreen('list');
    setSelected(null);
    await load();
  }

  async function ebayAction(action: string, extra: Record<string, unknown> = {}) {
    if (!accessToken) return;
    if (action !== 'sync' && !selected) return;
    setBusy(action);
    setError('');
    try {
      const res = await fetch(floorFunctionUrl('ebay-returns'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action, return_id: selected?.id, ...extra }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `eBay returns failed (${res.status})`);
      await load();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy('');
    }
  }

  function readDeductPhoto(file: File | null) {
    if (!file) { setDeductPhoto(''); return; }
    setDeductType(file.type || 'image/jpeg');
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '');
      setDeductPhoto(text.includes(',') ? text.slice(text.indexOf(',') + 1) : text);
    };
    reader.readAsDataURL(file);
  }

  async function resolveDelivered(defective: boolean) {
    if (!selected) return;
    const qty = Math.max(1, Math.trunc(Number(selected.requested_qty) || 1));
    setBusy('resolve');
    const { error: e } = await client.rpc('portal_return_partial', {
      p_return_id: selected.id,
      p_qty: qty,
      p_defective: defective,
    });
    setBusy('');
    if (e) {
      setError(errText(e));
      return;
    }
    await load();
    const { data } = await client.rpc('portal_return_desk', { p_filter: 'open', p_query: selected.sku, p_from: null, p_to: laToday() });
    const body = (data || {}) as { rows?: ReturnRow[] };
    const fresh = body.rows?.find((r) => r.id === selected.id);
    if (fresh) setSelected(fresh);
  }

  const showDecide = selected && (
    tracking?.status_line?.toLowerCase().includes('delivered')
    || selected.status === 'received'
  ) && !['closed', 'canceled', 'dispositioned', 'refunded_no_return'].includes(selected.status);

  const listBody = (
    <>
      <div className={app ? 'returns-list-head' : 'returns-desktop-head'}>
        {app ? (
          <div className="returns-title-row">
            <h1>Returns</h1>
            <button type="button" className="returns-text-btn" onClick={openNew}>New return</button>
            {accessToken && <button type="button" className="returns-text-btn" disabled={!!busy} onClick={() => void ebayAction('sync')}>{busy === 'sync' ? 'Checking eBay…' : 'Check eBay'}</button>}
          </div>
        ) : (
          <header>
            <div className="eyebrow">GARAGE</div>
            <div className="returns-title-row returns-title-row-desktop">
              <h1>Returns</h1>
              <button type="button" className="primary" onClick={openNew}>New return</button>
              {accessToken && <button type="button" className="secondary" disabled={!!busy} onClick={() => void ebayAction('sync')}>{busy === 'sync' ? 'Checking eBay…' : 'Check eBay'}</button>}
            </div>
            <p>Returns, refunds, and replacements. Admin only.</p>
          </header>
        )}
        <input
          className="returns-search"
          placeholder="Search SKU or order"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="app-segment returns-segment" role="tablist">
          <button type="button" className={seg === 'open' ? 'active' : ''} onClick={() => setSeg('open')}>Open</button>
          <button type="button" className={seg === 'closed' ? 'active' : ''} onClick={() => setSeg('closed')}>Closed</button>
        </div>
      </div>
      {error && screen === 'list' && <div className="app-inline-error" role="alert">{error}</div>}
      <div className="returns-rows">
        {rows === null && <p className="app-footer-count">Loading…</p>}
        {rows && rows.length === 0 && <div className="app-empty-row">Nothing here.</div>}
        {rows?.map((r) => (
          <button key={r.id} type="button" className="returns-row" onClick={() => openDetail(r)}>
            <span className="returns-row-main">
              <strong>{r.title || `SKU ${r.sku}`}</strong>
              <small>SKU {r.sku}{r.replacement_sku ? ` · replacement ${r.replacement_sku}` : ''}</small>
            </span>
            <span className={`returns-row-status ${toneClass(statusTone(r.status, r.route_to))}`}>
              {statusLabel(r.status, r.route_to)}
              <span className="app-chevron">›</span>
            </span>
          </button>
        ))}
      </div>
    </>
  );

  const newBody = (
    <div className="returns-sheet">
      <div className="returns-nav-bar">
        <button type="button" className="returns-text-btn" onClick={() => setScreen('list')}>Cancel</button>
        <strong>New return</strong>
        <span />
      </div>
      {error && <div className="app-inline-error" role="alert">{error}</div>}
      <input
        className="returns-search"
        placeholder="Scan or type SKU / order"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void findSales(); }}
      />
      {candidates && candidates.length > 0 && (
        <div className="returns-pick-list">
          {candidates.map((c) => {
            const on = pickedSale === c.sale_id;
            const max = Math.max(1, c.qty - c.qty_open);
            return (
              <button
                key={c.sale_id}
                type="button"
                className={`returns-pick-card${on ? ' on' : ''}`}
                onClick={() => {
                  setPickedSale(c.sale_id);
                  setPickQty(String(max));
                  if (c.hint_refund_cents) setRefund(dollars(c.hint_refund_cents));
                  else if (!refund && c.price_cents) setRefund(dollars(c.price_cents));
                  if (c.hint_tracking) setTrackingNo(c.hint_tracking);
                }}
              >
                <span>
                  <strong>{c.title}</strong>
                  <small>SKU {c.sku} · {CHANNEL[c.channel] || c.channel} · sold {money(c.price_cents)}</small>
                </span>
                {on && <span className="returns-check">✓</span>}
              </button>
            );
          })}
          {picked && picked.qty > 1 && (
            <label className="returns-field">
              Quantity
              <input inputMode="numeric" value={pickQty} onChange={(e) => setPickQty(e.target.value)} />
            </label>
          )}
        </div>
      )}
      {picked && (
        <>
          <div className="returns-field-row">
            <span>Coming back?</span>
            <div className="app-segment returns-segment-inline">
              <button type="button" className={!buyerKeeps ? 'active' : ''} onClick={() => setBuyerKeeps(false)}>Yes</button>
              <button type="button" className={buyerKeeps ? 'active' : ''} onClick={() => setBuyerKeeps(true)}>Buyer keeps</button>
            </div>
          </div>
          <div className="returns-kv-group">
            <label className="returns-kv">
              <span>Refunded</span>
              <input inputMode="decimal" value={refund} onChange={(e) => setRefund(e.target.value)} placeholder="0.00" />
            </label>
            {!buyerKeeps && (
              <>
                <label className="returns-kv">
                  <span>Label cost (I paid)</span>
                  <input inputMode="decimal" value={labelCost} onChange={(e) => setLabelCost(e.target.value)} placeholder="0.00" />
                </label>
                <label className="returns-kv">
                  <span>Tracking #</span>
                  <input value={trackingNo} onChange={(e) => setTrackingNo(e.target.value)} placeholder="9400…" />
                </label>
              </>
            )}
          </div>
          <p className="returns-hint">
            {buyerKeeps
              ? 'No shipment to track. Profit on this sale drops by the refund.'
              : 'Status updates on its own from the tracking number.'}
          </p>
          <button type="button" className="returns-primary" disabled={!!busy} onClick={() => void submitNew()}>
            {busy ? 'Saving…' : buyerKeeps ? 'Save refund' : 'Start return'}
          </button>
        </>
      )}
      {!candidates && search.trim() && (
        <button type="button" className="returns-secondary" disabled={busy === 'search'} onClick={() => void findSales()}>
          {busy === 'search' ? 'Searching…' : 'Find sale'}
        </button>
      )}
    </div>
  );

  const detailBody = selected && (
    <div className="returns-sheet">
      <div className="returns-nav-bar">
        <button type="button" className="returns-text-btn" onClick={() => { setScreen('list'); setSelected(null); }}>Returns</button>
        <span />
        <button type="button" className="returns-text-btn" onClick={openEdit}>Edit</button>
      </div>
      {error && <div className="app-inline-error" role="alert">{error}</div>}
      <p className="returns-meta">SKU {selected.sku} · {CHANNEL[selected.channel] || selected.channel}</p>
      <h2 className="returns-detail-title">{selected.title || `SKU ${selected.sku}`}</h2>
      <p className={`returns-status-line ${toneClass(statusTone(selected.status, selected.route_to))}`}>
        {tracking?.status_line || statusLabel(selected.status, selected.route_to)}
      </p>
      {selected.route_to !== 'buyer_keeps' && selected.status !== 'refunded_no_return' && (
        <div className="returns-timeline-card">
          {(tracking?.events || []).length === 0 && (
            <p className="returns-hint">Tracking will appear once the carrier reports scans.</p>
          )}
          <ol className="returns-timeline">
            {(tracking?.events || []).map((ev, i) => (
              <li key={`${ev.occurred_at}-${i}`} className={ev.current ? 'current' : ev.status === 'pending' ? 'pending' : ''}>
                <span className="returns-dot" />
                <span>
                  <strong>{ev.status_detail || ev.status}</strong>
                  {ev.location ? ` · ${ev.location}` : ''}
                  <small>{stamp(ev.occurred_at)}{ev.carrier ? ` · ${ev.carrier}` : ''}</small>
                </span>
              </li>
            ))}
          </ol>
          {tracking?.tracking_source && (
            <p className="returns-tracking-note">Updated automatically from {tracking.tracking_source}.</p>
          )}
        </div>
      )}
      <div className="returns-kv-group">
        <div className="returns-kv readonly"><span>Refunded</span><strong>{money(selected.refund_cents || 0)}</strong></div>
        <div className="returns-kv readonly"><span>Label (I paid)</span><strong>{money(selected.return_label_cents || 0)}</strong></div>
        <div className="returns-kv readonly"><span>Tracking #</span><strong>{selected.tracking_number || '—'}</strong></div>
      </div>
      {selected.channel === 'ebay' && selected.status !== 'closed' && selected.status !== 'canceled' && (
        <div className="returns-decide">
          <p>eBay refund. Change-of-mind returns refund the item price only. Original shipping stays with eBay.</p>
          <div className="returns-decide-actions">
            <button type="button" className="returns-primary" disabled={!!busy} onClick={() => void ebayAction('refund_item', { note: 'Item price only. Buyer paid the original shipping and the return label.' })}>
              {busy === 'refund_item' ? 'Sending…' : `Refund item ${money(selected.refund_cents || 0)}`}
            </button>
          </div>
          <p>If it came back used or damaged, deduct up to 50%. A photo and a note are required. {deductPct && Number(deductPct) > 0 ? `That refunds ${money(Math.round((selected.refund_cents || 0) * (100 - Math.min(50, Number(deductPct))) / 100))}.` : ''}</p>
          <div className="returns-kv-group">
            <label className="returns-kv">
              <span>Deduct %</span>
              <input inputMode="numeric" value={deductPct} onChange={(e) => {
                const n = e.target.value.replace(/[^\d]/g, '').slice(0, 2);
                setDeductPct(n === '' ? '' : String(Math.min(50, Number(n))));
              }} />
            </label>
            <label className="returns-kv">
              <span>Condition note</span>
              <input value={deductNote} onChange={(e) => setDeductNote(e.target.value)} />
            </label>
            <label className="returns-kv">
              <span>Photo</span>
              <input type="file" accept="image/*" onChange={(e) => readDeductPhoto(e.target.files?.[0] || null)} />
            </label>
          </div>
          <button
            type="button"
            className="returns-secondary"
            disabled={!!busy || !deductNote.trim() || !deductPhoto || !(Number(deductPct) > 0)}
            onClick={() => void ebayAction('deduct', { percent: Math.min(50, Number(deductPct) || 0), note: deductNote.trim(), photo_base64: deductPhoto, photo_type: deductType })}
          >
            {busy === 'deduct' ? 'Sending…' : 'Submit deduction'}
          </button>
        </div>
      )}
      {showDecide && (
        <div className="returns-decide">
          <p>Package delivered. Where does this unit go?</p>
          <div className="returns-decide-actions">
            <button type="button" className="returns-primary" disabled={!!busy} onClick={() => void resolveDelivered(false)}>Back in stock</button>
            <button type="button" className="returns-secondary" disabled={!!busy} onClick={() => void resolveDelivered(true)}>Defective</button>
          </div>
        </div>
      )}
    </div>
  );

  const editBody = selected && (
    <div className="returns-sheet">
      <div className="returns-nav-bar">
        <button type="button" className="returns-text-btn" onClick={() => setScreen('detail')}>Cancel</button>
        <strong>Edit return</strong>
        <button type="button" className="returns-text-btn danger" disabled={!!busy} onClick={() => void cancelReturn()}>Cancel return</button>
      </div>
      {error && <div className="app-inline-error" role="alert">{error}</div>}
      <div className="returns-field-row">
        <span>Coming back?</span>
        <div className="app-segment returns-segment-inline">
          <button type="button" className={!editKeeps ? 'active' : ''} onClick={() => setEditKeeps(false)}>Yes</button>
          <button type="button" className={editKeeps ? 'active' : ''} onClick={() => setEditKeeps(true)}>Buyer keeps</button>
        </div>
      </div>
      <div className="returns-kv-group">
        <label className="returns-kv">
          <span>Refunded</span>
          <input inputMode="decimal" value={editRefund} onChange={(e) => setEditRefund(e.target.value)} />
        </label>
        {!editKeeps && (
          <>
            <label className="returns-kv">
              <span>Label cost (I paid)</span>
              <input inputMode="decimal" value={editLabel} onChange={(e) => setEditLabel(e.target.value)} />
            </label>
            <label className="returns-kv">
              <span>Tracking #</span>
              <input value={editTracking} onChange={(e) => setEditTracking(e.target.value)} />
            </label>
          </>
        )}
        <label className="returns-kv">
          <span>Quantity</span>
          <input inputMode="numeric" value={editQty} onChange={(e) => setEditQty(e.target.value)} />
        </label>
      </div>
      <button type="button" className="returns-primary" disabled={!!busy} onClick={() => void saveEdit()}>
        {busy ? 'Saving…' : 'Save changes'}
      </button>
    </div>
  );

  return (
    <div className={`returns-root${app ? '' : ' returns-root-desktop'}`}>
      {screen === 'list' && listBody}
      {screen === 'new' && newBody}
      {screen === 'detail' && detailBody}
      {screen === 'edit' && editBody}
    </div>
  );
}
