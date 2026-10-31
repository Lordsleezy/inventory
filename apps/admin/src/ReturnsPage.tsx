import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { errText } from './errText';
import { useVisibleInterval } from './useVisibleInterval';

export type ReturnRow = {
  id: string;
  sku: string;
  title?: string;
  channel: string;
  status: string;
  reason: string;
  fault: string;
  external_order_id: string | null;
  external_return_id: string | null;
  refund_cents: number;
  return_label_cents: number;
  label_paid_by: string;
  unrecovered_fees_cents: number;
  regrade_loss_cents: number;
  needs_decision: boolean;
  decision_deadline_at: string | null;
  decision_seconds_left?: number | null;
  condition_before?: string | null;
  condition_after?: string | null;
  unit_condition?: string | null;
  unit_state?: string | null;
  inspection_notes?: string | null;
  disposition?: string | null;
  route_to?: string;
  supplier_name?: string | null;
  photo_count?: number;
  photos?: { id: string; path: string; kind: string }[];
  tracking_number?: string | null;
  created_at: string;
};

type Props = {
  client: SupabaseClient;
  storeId: string;
  money: (n: number) => string;
  stamp: (s: string) => string;
};

const CONDITIONS = ['Excellent', 'Good', 'Fair', 'Defective'];
const CHANNEL_LABEL: Record<string, string> = {
  amazon: 'Amazon',
  tiktok: 'TikTok Shop',
  ebay: 'eBay',
  mercari: 'Mercari',
  website: 'Website',
  depop: 'Depop',
  whatnot: 'Whatnot',
  facebook: 'Facebook',
};

function channelLabel(c?: string | null) {
  if (!c) return 'Channel';
  return CHANNEL_LABEL[c.toLowerCase()] || c;
}

function countdown(seconds: number | null | undefined, deadline: string | null, now: number) {
  let left = seconds;
  if (left == null && deadline) left = (new Date(deadline).getTime() - now) / 1000;
  if (left == null) return null;
  const urgent = left < 6 * 3600;
  if (left <= 0) return { text: 'Decision overdue', urgent: true };
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  const text = h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h left` : `${h}h ${m}m left`;
  return { text, urgent };
}

export function ReturnsPage({ client, storeId, money, stamp }: Props) {
  const [rows, setRows] = useState<ReturnRow[] | null>(null);
  const [filter, setFilter] = useState<'needs_decision' | 'open' | 'all'>('needs_decision');
  const [scan, setScan] = useState('');
  const [selected, setSelected] = useState<ReturnRow | null>(null);
  const [error, setError] = useState('');
  const [returnQty, setReturnQty] = useState('1');
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [condition, setCondition] = useState('Good');
  const [notes, setNotes] = useState('');
  const [regradeLoss, setRegradeLoss] = useState('');
  const [refund, setRefund] = useState('');
  const [labelCost, setLabelCost] = useState('');
  const [fees, setFees] = useState('');

  const load = useCallback(async () => {
    const { data, error: e } = await client.rpc('portal_returns', {
      p_status: filter === 'all' ? null : filter,
      p_limit: 300,
    });
    if (e) {
      setError(e.message);
      return;
    }
    setRows((data as ReturnRow[]) || []);
  }, [client, filter]);

  useVisibleInterval(load, 60_000);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);

  async function lookupScan() {
    const q = scan.trim();
    if (!q) return;
    setBusy('scan');
    setError('');
    const { data, error: e } = await client.rpc('portal_return_lookup', { p_query: q });
    setBusy(null);
    if (e) {
      setError(e.message);
      return;
    }
    const list = (data as ReturnRow[]) || [];
    if (!list.length) {
      setError(`No return found for “${q}”.`);
      return;
    }
    pick(list[0]);
  }

  function pick(r: ReturnRow) {
    setSelected(r);
    setCondition(r.condition_after || r.unit_condition || 'Good');
    setNotes(r.inspection_notes || '');
    setRegradeLoss(r.regrade_loss_cents ? (r.regrade_loss_cents / 100).toFixed(2) : '');
    setRefund(r.refund_cents != null ? (r.refund_cents / 100).toFixed(2) : '');
    setLabelCost(r.return_label_cents != null ? (r.return_label_cents / 100).toFixed(2) : '');
    setFees(r.unrecovered_fees_cents != null ? (r.unrecovered_fees_cents / 100).toFixed(2) : '');
    setFlash('');
  }

  function cents(raw: string) {
    const n = Math.round(Number(String(raw).replace(/[$,\s]/g, '')) * 100);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  async function setStatus(status: string, patch: Record<string, unknown> = {}) {
    if (!selected) return;
    setBusy(status);
    setError('');
    const { data, error: e } = await client.rpc('portal_set_return_status', {
      p_return: selected.id,
      p_status: status,
      p_patch: {
        refund_cents: cents(refund),
        return_label_cents: cents(labelCost),
        unrecovered_fees_cents: cents(fees),
        ...patch,
      },
    });
    setBusy(null);
    if (e) {
      setError(e.message);
      return;
    }
    pick(data as ReturnRow);
    setFlash(`Status → ${status}`);
    await load();
  }

  async function inspect() {
    if (!selected) return;
    setBusy('inspect');
    setError('');
    const { data, error: e } = await client.rpc('portal_inspect_return', {
      p_return: selected.id,
      p_condition: condition,
      p_notes: notes,
      p_regrade_loss_cents: cents(regradeLoss),
    });
    setBusy(null);
    if (e) {
      setError(e.message);
      return;
    }
    pick(data as ReturnRow);
    setFlash(`Inspected as ${condition}`);
    await load();
  }

  async function uploadPhoto(file: File) {
    if (!selected) return;
    if (!file.type.startsWith('image/')) {
      setError('Choose an image file.');
      return;
    }
    setBusy('photo');
    setError('');
    try {
      const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_') || 'return.jpg';
      const path = `${storeId}/${selected.sku}/returns/${Date.now()}-${crypto.randomUUID()}-${safe}`;
      const upload = await client.storage.from('unit-photos').upload(path, file, {
        contentType: file.type || 'image/jpeg',
        upsert: false,
      });
      if (upload.error) throw upload.error;
      const { error: e } = await client.rpc('portal_add_return_photo', {
        p_return: selected.id,
        p_path: path,
        p_kind: 'inspection',
      });
      if (e) throw e;
      setFlash('Inspection photo saved (also attached to the unit).');
      const { data } = await client.rpc('portal_return_lookup', { p_query: selected.id });
      const list = (data as ReturnRow[]) || [];
      if (list[0]) pick(list[0]);
      await load();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  }

  async function disposition(disp: string) {
    if (!selected) return;
    if (!window.confirm(`Disposition ${selected.sku} as “${disp.replace(/_/g, ' ')}”?\n\nPhotos are required. Relist goes through normal sync / double-sale protection.`)) {
      return;
    }
    setBusy(disp);
    setError('');
    const { data, error: e } = await client.rpc('portal_disposition_return', {
      p_return: selected.id,
      p_disposition: disp,
      p_patch: {
        refund_cents: cents(refund),
        return_label_cents: cents(labelCost),
        unrecovered_fees_cents: cents(fees),
        regrade_loss_cents: cents(regradeLoss),
        label_paid_by: selected.label_paid_by || 'seller',
        mark_refunded: true,
        close: true,
      },
    });
    setBusy(null);
    if (e) {
      setError(e.message);
      return;
    }
    pick(data as ReturnRow);
    setFlash(`Dispositioned: ${disp}`);
    await load();
  }

  const list = rows || [];
  const decisionCount = useMemo(() => list.filter((r) => r.needs_decision && r.status === 'requested').length, [list]);

  return (
    <>
      <div className="section-head" style={{ marginBottom: 12 }}>
        <div>
          <div className="eyebrow">GARAGE RECEIVING</div>
          <h2>Returns</h2>
          <p className="hint" style={{ margin: 0 }}>
            Scan SKU or order. Inspect, re-grade, photo (required), then disposition. Same SKU reopens — never mint a new number.
            {decisionCount > 0 ? ` · ${decisionCount} need a decision` : ''}
          </p>
        </div>
      </div>

      {error && (
        <div className="alert" role="alert">
          {error}
          <button type="button" onClick={() => setError('')}>
            Dismiss
          </button>
        </div>
      )}
      {flash && <div className="notice">{flash}</div>}

      <div className="actions" style={{ marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
        <label>
          Scan SKU / order{' '}
          <input
            value={scan}
            onChange={(e) => setScan(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void lookupScan();
            }}
            placeholder="SKU or order id"
            autoFocus
            style={{ minWidth: 220 }}
          />
        </label>
        <button type="button" disabled={!!busy} onClick={() => void lookupScan()}>
          {busy === 'scan' ? 'Looking up…' : 'Pull up'}
        </button>
        <label>
          Show{' '}
          <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
            <option value="needs_decision">Needs decision</option>
            <option value="open">Open</option>
            <option value="all">All</option>
          </select>
        </label>
        <button type="button" className="secondary" onClick={() => void load()}>
          Refresh
        </button>
      </div>

      <div className="ebay-layout">
        <section className="panel" style={{ margin: 0 }}>
          {rows === null && <p className="hint">Loading returns…</p>}
          {rows && list.length === 0 && <div className="empty">No returns in this view.</div>}
          <div className="ticket-list">
            {list.map((r) => {
              const cd = countdown(r.decision_seconds_left, r.decision_deadline_at, now);
              return (
                <button
                  key={r.id}
                  type="button"
                  className={`ticket order${selected?.id === r.id ? ' ticket-commission-override' : ''}`}
                  style={{ width: '100%', textAlign: 'left', background: 'transparent', border: 0, borderTop: '1px solid #eef1f3' }}
                  onClick={() => pick(r)}
                >
                  <div className="ticket-top">
                    <strong>
                      {channelLabel(r.channel)} · SKU {r.sku} · {money(r.refund_cents)}
                    </strong>
                    <span>
                      {stamp(r.created_at)}
                      <b className="badge"> {r.status}</b>
                      {r.needs_decision && <b className="badge badge-warn"> DECIDE</b>}
                    </span>
                  </div>
                  <div className="ticket-items">
                    <div>
                      {r.title || 'Item'} <span>· {r.reason.replace(/_/g, ' ')}</span>
                    </div>
                    <small>
                      Order {r.external_order_id || '—'}
                      {r.route_to === 'supplier' ? ` · route to supplier${r.supplier_name ? ` (${r.supplier_name})` : ''}` : ''}
                      {r.route_to === 'buyer_keeps' ? ' · refund no return' : ''}
                    </small>
                    {cd && (
                      <div className={`countdown${cd.urgent ? ' urgent' : ''}`}>
                        Seller decision: {cd.text}
                        {r.decision_deadline_at ? ` · by ${stamp(r.decision_deadline_at)}` : ''}
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        <section className="panel ebay-editor" style={{ margin: 0 }}>
          {!selected && <div className="empty">Select or scan a return to inspect.</div>}
          {selected && (
            <>
              <h3 style={{ marginTop: 0 }}>
                SKU {selected.sku} · {channelLabel(selected.channel)}
              </h3>
              <p className="hint">
                Status <b>{selected.status}</b>
                {selected.disposition ? ` · ${selected.disposition}` : ''} · unit {selected.unit_state || '—'} · photos{' '}
                {selected.photo_count ?? selected.photos?.length ?? 0}
              </p>
              {selected.needs_decision && selected.status === 'requested' && (
                <div className="actions" style={{ marginBottom: 12 }}>
                  <button type="button" disabled={!!busy} onClick={() => void setStatus('approved')}>
                    Approve return
                  </button>
                  <button type="button" className="secondary" disabled={!!busy} onClick={() => void setStatus('refunded_no_return')}>
                    Refund, no return
                  </button>
                  <button type="button" className="text-button danger" disabled={!!busy} onClick={() => void setStatus('denied')}>
                    Deny
                  </button>
                </div>
              )}
              <div className="actions" style={{ marginBottom: 12 }}>
                <button type="button" className="secondary" disabled={!!busy} onClick={() => void setStatus('in_transit')}>
                  Mark in transit
                </button>
                <button type="button" className="secondary" disabled={!!busy} onClick={() => void setStatus('received')}>
                  Mark received
                </button>
              </div>

              <div className="number-grid">
                <label>
                  Refund ($)
                  <input value={refund} onChange={(e) => setRefund(e.target.value)} />
                </label>
                <label>
                  Return label ($)
                  <input value={labelCost} onChange={(e) => setLabelCost(e.target.value)} />
                </label>
                <label>
                  Unrecovered fees ($)
                  <input value={fees} onChange={(e) => setFees(e.target.value)} />
                </label>
                <label>
                  Re-grade value lost ($)
                  <input value={regradeLoss} onChange={(e) => setRegradeLoss(e.target.value)} />
                </label>
              </div>

              <label className="receive-notes">
                Re-grade condition
                <select value={condition} onChange={(e) => setCondition(e.target.value)}>
                  {CONDITIONS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
              <label className="receive-notes">
                Inspection notes
                <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
              </label>
              <div className="actions">
                <button type="button" disabled={!!busy} onClick={() => void inspect()}>
                  {busy === 'inspect' ? 'Saving…' : 'Save inspection'}
                </button>
                <label className="secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '10px 14px', border: '1px solid var(--btn-border)', borderRadius: 8, cursor: 'pointer' }}>
                  {busy === 'photo' ? 'Uploading…' : 'Add inspection photo'}
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    hidden
                    disabled={!!busy}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void uploadPhoto(f);
                      e.target.value = '';
                    }}
                  />
                </label>
              </div>
              <p className="hint">Photos required before closing. They attach to the unit for relist sync.</p>

              <h3>Disposition</h3>
              <label>Partial quantity
                <input aria-label="Return quantity" inputMode="numeric" min={1} value={returnQty} onChange={e => setReturnQty(e.target.value)} />
              </label>
              <div className="actions">
                <button type="button" className="secondary" disabled={!!busy} onClick={() => void (async () => {
                  const qty = Math.trunc(Number(returnQty));
                  if (!Number.isInteger(qty) || qty < 1) { setError('Enter a whole quantity of at least 1.'); return; }
                  setBusy('partial'); setError('');
                  const { error: e } = await client.rpc('portal_return_partial', { p_return_id: selected.id, p_qty: qty, p_defective: false });
                  setBusy(null);
                  if (e) { setError(errText(e)); return; }
                  setFlash(`Restocked ${qty}. Channels update within about a minute.`);
                  await load();
                })()}>Restock this many</button>
                <button type="button" className="secondary" disabled={!!busy} onClick={() => void (async () => {
                  const qty = Math.trunc(Number(returnQty));
                  if (!Number.isInteger(qty) || qty < 1) { setError('Enter a whole quantity of at least 1.'); return; }
                  setBusy('partial'); setError('');
                  const { error: e } = await client.rpc('portal_return_partial', { p_return_id: selected.id, p_qty: qty, p_defective: true });
                  setBusy(null);
                  if (e) { setError(errText(e)); return; }
                  setFlash(`${qty} recorded as Defective. Sellable quantity was not increased.`);
                  await load();
                })()}>This many came back defective</button>
                <button type="button" disabled={!!busy} onClick={() => void disposition('relist')}>
                  Relist (same channels)
                </button>
                <button type="button" className="secondary" disabled={!!busy} onClick={() => void disposition('downgrade_channel')}>
                  Downgrade (no Amazon/TikTok)
                </button>
                <button type="button" className="secondary" disabled={!!busy} onClick={() => void disposition('bundle_lot')}>
                  Bundle into a lot
                </button>
                <button type="button" className="text-button danger" disabled={!!busy} onClick={() => void disposition('write_off')}>
                  Write off
                </button>
              </div>
            </>
          )}
        </section>
      </div>
    </>
  );
}
