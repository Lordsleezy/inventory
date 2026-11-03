import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { errText } from './errText';
import { useVisibleInterval } from './useVisibleInterval';

type Refund = {
  id: string;
  amount_cents: number;
  refunded_on: string;
  channel: string;
  kind: string;
  item_kept: boolean;
  note: string | null;
  created_at: string;
};

type Note = { id: string; body: string; kind: string; created_at: string };

export type ReturnRow = {
  id: string;
  kind?: string;
  sku: string;
  title?: string;
  channel: string;
  status: string;
  reason: string;
  external_order_id: string | null;
  buyer_name?: string | null;
  refund_cents: number;
  return_label_cents: number;
  label_paid_by: string;
  unrecovered_fees_cents: number;
  regrade_loss_cents: number;
  requested_qty?: number;
  needs_decision: boolean;
  decision_deadline_at: string | null;
  condition_after?: string | null;
  unit_condition?: string | null;
  unit_state?: string | null;
  inspection_notes?: string | null;
  disposition?: string | null;
  route_to?: string;
  photo_count?: number;
  tracking_number?: string | null;
  created_at: string;
  label_sent_at?: string | null;
  in_transit_at?: string | null;
  received_at?: string | null;
  inspected_at?: string | null;
  dispositioned_at?: string | null;
  closed_at?: string | null;
  refunded_at?: string | null;
  replacement_sku?: string | null;
  sale_id?: number | null;
  refunds?: Refund[];
  notes?: Note[];
};

type Candidate = {
  sale_id: number;
  sku: string;
  title: string;
  qty: number;
  qty_open: number;
  channel: string;
  price_cents: number;
  buyer: string | null;
  order_ref: string;
};

type Totals = { refund_cents: number; label_cents: number; writeoff_cents: number };
type Filter = 'open' | 'awaiting' | 'refunds' | 'replacements' | 'closed';

type Props = {
  client: SupabaseClient;
  storeId: string;
  money: (n: number) => string;
  stamp: (s: string) => string;
  variant?: 'desktop' | 'app';
};

const FILTERS: [Filter, string][] = [
  ['open', 'Open'],
  ['awaiting', 'Awaiting item'],
  ['refunds', 'Refunds'],
  ['replacements', 'Replacements'],
  ['closed', 'Closed'],
];
const CONDITIONS = ['Excellent', 'Good', 'Fair', 'Defective'];
const STATUS_LABEL: Record<string, string> = {
  requested: 'Requested',
  label_sent: 'Label sent',
  approved: 'Label sent',
  in_transit: 'In transit',
  received: 'Received',
  inspected: 'Inspected',
  dispositioned: 'Resolved',
  closed: 'Closed',
  refunded_no_return: 'Buyer kept it',
  denied: 'Denied',
  canceled: 'Canceled',
};

function statusLabel(status: string) {
  return STATUS_LABEL[status] || status.replace(/_/g, ' ');
}

function laToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

function monthStart() {
  const today = laToday();
  return `${today.slice(0, 8)}01`;
}

export function ReturnsPage({ client, storeId, money, stamp, variant = 'desktop' }: Props) {
  const app = variant === 'app';
  const [rows, setRows] = useState<ReturnRow[] | null>(null);
  const [totals, setTotals] = useState<Totals>({ refund_cents: 0, label_cents: 0, writeoff_cents: 0 });
  const [filter, setFilter] = useState<Filter>('open');
  const [query, setQuery] = useState('');
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(laToday);
  const [selected, setSelected] = useState<ReturnRow | null>(null);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [condition, setCondition] = useState('Good');
  const [notes, setNotes] = useState('');
  const [regradeLoss, setRegradeLoss] = useState('');
  const [labelCost, setLabelCost] = useState('');
  const [labelPayer, setLabelPayer] = useState('seller');
  const [fees, setFees] = useState('');
  const [returnQty, setReturnQty] = useState('1');
  const [noteDraft, setNoteDraft] = useState('');
  const [search, setSearch] = useState('');
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [picked, setPicked] = useState<Record<number, number>>({});
  const [startLabel, setStartLabel] = useState('');
  const [startPayer, setStartPayer] = useState('seller');
  const [startNote, setStartNote] = useState('');
  const [startReason, setStartReason] = useState('other');
  const [noShipment, setNoShipment] = useState(false);
  const [startRefund, setStartRefund] = useState('');
  const [refundAmount, setRefundAmount] = useState('');
  const [refundDate, setRefundDate] = useState(laToday);
  const [refundKind, setRefundKind] = useState<'partial' | 'full'>('partial');
  const [refundKept, setRefundKept] = useState(false);

  const load = useCallback(async () => {
    const { data, error: e } = await client.rpc('portal_return_desk', {
      p_filter: filter,
      p_query: query.trim() || null,
      p_from: from,
      p_to: to,
    });
    if (e) {
      setError(e.message);
      return;
    }
    const body = (data || {}) as { rows?: ReturnRow[]; totals?: Totals };
    setRows(body.rows || []);
    setTotals(body.totals || { refund_cents: 0, label_cents: 0, writeoff_cents: 0 });
  }, [client, filter, query, from, to]);

  useVisibleInterval(load, 60_000);
  useEffect(() => {
    setSelected((cur) => {
      if (!cur || !rows) return cur;
      return rows.find((r) => r.id === cur.id) || cur;
    });
  }, [rows]);

  function pick(r: ReturnRow) {
    setSelected(r);
    setCondition(r.condition_after || r.unit_condition || 'Good');
    setNotes(r.inspection_notes || '');
    setRegradeLoss(r.regrade_loss_cents ? (r.regrade_loss_cents / 100).toFixed(2) : '');
    setLabelCost(r.return_label_cents ? (r.return_label_cents / 100).toFixed(2) : '');
    setLabelPayer(r.label_paid_by || 'seller');
    setFees(r.unrecovered_fees_cents ? (r.unrecovered_fees_cents / 100).toFixed(2) : '');
    setReturnQty(String(r.requested_qty || 1));
    setFlash('');
  }

  function cents(raw: string) {
    const n = Math.round(Number(String(raw).replace(/[$,\s]/g, '')) * 100);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  async function findSales() {
    const q = search.trim();
    if (!q) return;
    setBusy('search');
    setError('');
    const { data, error: e } = await client.rpc('portal_return_candidates', { p_query: q });
    setBusy(null);
    if (e) {
      setError(e.message);
      return;
    }
    const list = (data as Candidate[]) || [];
    setCandidates(list);
    const next: Record<number, number> = {};
    for (const row of list) next[row.sale_id] = Math.max(1, row.qty - row.qty_open);
    setPicked(list.length === 1 ? { [list[0].sale_id]: next[list[0].sale_id] } : {});
    if (!list.length) setError(`Nothing sold matches “${q}”.`);
  }

  async function startReturn() {
    const lines = Object.entries(picked)
      .filter(([, qty]) => qty > 0)
      .map(([saleId, qty]) => ({ sale_id: Number(saleId), qty }));
    if (!lines.length) {
      setError('Select at least one SKU.');
      return;
    }
    setBusy('start');
    setError('');
    const { data, error: e } = await client.rpc('portal_start_returns', {
      p_lines: lines,
      p_label_cents: cents(startLabel),
      p_label_paid_by: startPayer,
      p_note: startNote.trim() || null,
      p_reason: startReason,
      p_no_shipment: noShipment,
      p_refund_cents: cents(startRefund),
    });
    setBusy(null);
    if (e) {
      setError(errText(e));
      return;
    }
    setFlash(noShipment ? 'Refund recorded. No shipment.' : 'Return opened.');
    setCandidates(null);
    setSearch('');
    setStartRefund('');
    setStartNote('');
    await load();
    const created = (data as ReturnRow[]) || [];
    if (created[0]) pick(created[0]);
  }

  async function setStatus(status: string) {
    if (!selected) return;
    setBusy(status);
    setError('');
    const { data, error: e } = await client.rpc('portal_set_return_status', {
      p_return: selected.id,
      p_status: status,
      p_patch: {
        return_label_cents: cents(labelCost),
        label_paid_by: labelPayer,
        unrecovered_fees_cents: cents(fees),
      },
    });
    setBusy(null);
    if (e) {
      setError(e.message);
      return;
    }
    pick(data as ReturnRow);
    setFlash(`Status → ${statusLabel(status)}`);
    await load();
  }

  async function logRefund() {
    if (!selected) return;
    const amount = cents(refundAmount);
    if (amount <= 0) {
      setError('Enter a refund amount.');
      return;
    }
    setBusy('refund');
    setError('');
    const { error: e } = await client.rpc('portal_log_return_refund', {
      p_return: selected.id,
      p_amount_cents: amount,
      p_refunded_on: refundDate,
      p_channel: selected.channel,
      p_kind: refundKind,
      p_item_kept: refundKept,
      p_note: null,
      p_close_without_shipment: refundKept,
    });
    setBusy(null);
    if (e) {
      setError(errText(e));
      return;
    }
    setRefundAmount('');
    setFlash(refundKept ? 'Refund logged. Buyer kept the item.' : 'Refund logged.');
    await load();
  }

  async function addNote() {
    if (!selected || !noteDraft.trim()) return;
    setBusy('note');
    const { error: e } = await client.rpc('portal_add_return_note', { p_return: selected.id, p_body: noteDraft.trim() });
    setBusy(null);
    if (e) {
      setError(e.message);
      return;
    }
    setNoteDraft('');
    setFlash('Note saved.');
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
      setFlash('Photo saved.');
      await load();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  }

  async function disposition(disp: string) {
    if (!selected) return;
    if (!window.confirm(`Resolve ${selected.sku} as “${disp.replace(/_/g, ' ')}”? A photo is required before this closes.`)) return;
    setBusy(disp);
    setError('');
    const { data, error: e } = await client.rpc('portal_disposition_return', {
      p_return: selected.id,
      p_disposition: disp,
      p_patch: {
        return_label_cents: cents(labelCost),
        unrecovered_fees_cents: cents(fees),
        regrade_loss_cents: cents(regradeLoss),
        label_paid_by: labelPayer,
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
    setFlash(disp === 'write_off' ? 'Written off. The unit is in Defective.' : `Resolved: ${disp.replace(/_/g, ' ')}`);
    await load();
  }

  const list = rows || [];
  const steps = selected
    ? [
        ['Requested', selected.created_at],
        ['Label sent', selected.label_sent_at],
        ['In transit', selected.in_transit_at],
        ['Received', selected.received_at],
        ['Inspected', selected.inspected_at],
        ['Resolved', selected.dispositioned_at || selected.closed_at],
      ]
    : [];

  const startForm = (
    <section className={app ? 'app-group' : 'panel'} style={app ? undefined : { marginBottom: 16 }}>
      {!app && <h3 style={{ marginTop: 0 }}>Start a return</h3>}
      <div className={app ? '' : 'actions'} style={{ flexWrap: 'wrap', gap: 8 }}>
        <label>
          SKU, order, or buyer{' '}
          <input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void findSales(); }} placeholder="Scan or type" />
        </label>
        <button type="button" disabled={!!busy} onClick={() => void findSales()}>{busy === 'search' ? 'Searching…' : 'Find'}</button>
      </div>
      {candidates && candidates.length > 0 && (
        <div className={app ? 'app-group' : 'ticket-list'} style={{ marginTop: 10 }}>
          {candidates.map((c) => {
            const on = picked[c.sale_id] > 0;
            const max = Math.max(1, c.qty - c.qty_open);
            return (
              <label key={c.sale_id} className={app ? 'app-row' : ''} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 0' }}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) => setPicked((prev) => ({ ...prev, [c.sale_id]: e.target.checked ? max : 0 }))}
                />
                <span style={{ flex: 1 }}>
                  <strong>SKU {c.sku}</strong> {c.title}
                  <small style={{ display: 'block' }}>{c.order_ref} · {c.buyer || 'No buyer'} · sold {c.qty}</small>
                </span>
                {c.qty > 1 && (
                  <input
                    aria-label={`Quantity for ${c.sku}`}
                    inputMode="numeric"
                    style={{ width: 64 }}
                    value={picked[c.sale_id] || ''}
                    onChange={(e) => {
                      const n = Math.max(0, Math.min(max, Math.trunc(Number(e.target.value) || 0)));
                      setPicked((prev) => ({ ...prev, [c.sale_id]: n }));
                    }}
                  />
                )}
              </label>
            );
          })}
          <div className="number-grid" style={{ marginTop: 8 }}>
            <label>Label cost ($)<input value={startLabel} onChange={(e) => setStartLabel(e.target.value)} /></label>
            <label>Who paid
              <select value={startPayer} onChange={(e) => setStartPayer(e.target.value)}>
                <option value="seller">Me</option>
                <option value="buyer">Buyer</option>
                <option value="channel">Marketplace</option>
              </select>
            </label>
            <label>Reason
              <select value={startReason} onChange={(e) => setStartReason(e.target.value)}>
                <option value="buyer_remorse">Buyer remorse</option>
                <option value="defective">Defective</option>
                <option value="not_as_described">Not as described</option>
                <option value="wrong_item">Wrong item</option>
                <option value="damaged_in_transit">Damaged in transit</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label>Refund now ($)<input value={startRefund} onChange={(e) => setStartRefund(e.target.value)} /></label>
          </div>
          <label className="receive-notes">Note<textarea rows={2} value={startNote} onChange={(e) => setStartNote(e.target.value)} /></label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={noShipment} onChange={(e) => setNoShipment(e.target.checked)} />
            Refund, buyer keeps it — no shipment
          </label>
          <button type="button" disabled={!!busy} onClick={() => void startReturn()}>{busy === 'start' ? 'Saving…' : 'Open return'}</button>
        </div>
      )}
    </section>
  );

  const detail = selected && (
    <section className={app ? 'app-group' : 'panel ebay-editor'} style={app ? undefined : { margin: 0 }}>
      <h3 style={{ marginTop: 0 }}>SKU {selected.sku}{selected.replacement_sku ? ` · replacement ${selected.replacement_sku}` : ''}</h3>
      <p className="hint">
        {statusLabel(selected.status)}
        {selected.disposition ? ` · ${selected.disposition.replace(/_/g, ' ')}` : ''}
        {selected.buyer_name ? ` · ${selected.buyer_name}` : ''}
        {selected.external_order_id ? ` · ${selected.external_order_id}` : ''}
        {' · '}photos {selected.photo_count || 0}
      </p>
      <ol className={app ? 'app-group' : ''} style={{ listStyle: 'none', padding: 0, margin: '8px 0 12px' }}>
        {steps.map(([label, at]) => (
          <li key={label} style={{ opacity: at ? 1 : 0.45 }}>
            <strong>{label}</strong> {at ? stamp(at) : '—'}
          </li>
        ))}
      </ol>
      <div className="actions" style={{ flexWrap: 'wrap', gap: 8 }}>
        <button type="button" className="secondary" disabled={!!busy} onClick={() => void setStatus('label_sent')}>Label sent</button>
        <button type="button" className="secondary" disabled={!!busy} onClick={() => void setStatus('in_transit')}>In transit</button>
        <button type="button" className="secondary" disabled={!!busy} onClick={() => void setStatus('received')}>Received</button>
      </div>
      <div className="number-grid">
        <label>Return label ($)
          <input value={labelCost} onChange={(e) => setLabelCost(e.target.value)} />
        </label>
        <label>Who paid
          <select value={labelPayer} onChange={(e) => setLabelPayer(e.target.value)}>
            <option value="seller">Me</option>
            <option value="buyer">Buyer</option>
            <option value="channel">Marketplace</option>
            <option value="unknown">Unknown</option>
          </select>
        </label>
        <label>Unrecovered fees ($)
          <input value={fees} onChange={(e) => setFees(e.target.value)} />
        </label>
        <label>Write-off / re-grade ($)
          <input value={regradeLoss} onChange={(e) => setRegradeLoss(e.target.value)} />
        </label>
      </div>
      <button type="button" className="secondary" disabled={!!busy} onClick={() => void setStatus(selected.status)}>Save label and fees</button>

      <h3>Refunds</h3>
      <p className="hint">A refund is its own record. Buyer keeps it does not invent a shipment. A full return of the item still voids the sale when you resolve it.</p>
      {(selected.refunds || []).map((f) => (
        <p key={f.id}>{stamp(f.refunded_on)} · {money(f.amount_cents)} · {f.kind}{f.item_kept ? ' · buyer kept it' : ''}{f.note ? ` · ${f.note}` : ''}</p>
      ))}
      <div className="number-grid">
        <label>Amount ($)<input value={refundAmount} onChange={(e) => setRefundAmount(e.target.value)} /></label>
        <label>Date<input type="date" value={refundDate} onChange={(e) => setRefundDate(e.target.value)} /></label>
        <label>Kind
          <select value={refundKind} onChange={(e) => setRefundKind(e.target.value as 'partial' | 'full')}>
            <option value="partial">Partial</option>
            <option value="full">Full</option>
          </select>
        </label>
      </div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked={refundKept} onChange={(e) => setRefundKept(e.target.checked)} />
        Buyer keeps the item
      </label>
      <button type="button" disabled={!!busy} onClick={() => void logRefund()}>{busy === 'refund' ? 'Saving…' : 'Log refund'}</button>

      <h3>Inspection</h3>
      <label className="receive-notes">Condition
        <select value={condition} onChange={(e) => setCondition(e.target.value)}>
          {CONDITIONS.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </label>
      <label className="receive-notes">Notes<textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
      <div className="actions">
        <button type="button" disabled={!!busy} onClick={() => void inspect()}>{busy === 'inspect' ? 'Saving…' : 'Save inspection'}</button>
        <label className="secondary" style={{ display: 'inline-flex', alignItems: 'center', padding: '10px 14px', cursor: 'pointer' }}>
          {busy === 'photo' ? 'Uploading…' : 'Add photo'}
          <input type="file" accept="image/*" capture="environment" hidden disabled={!!busy} onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void uploadPhoto(f);
            e.target.value = '';
          }} />
        </label>
      </div>

      <h3>Resolve</h3>
      <label>Quantity back
        <input aria-label="Return quantity" inputMode="numeric" value={returnQty} onChange={(e) => setReturnQty(e.target.value)} />
      </label>
      <div className="actions" style={{ flexWrap: 'wrap' }}>
        <button type="button" className="secondary" disabled={!!busy} onClick={() => void (async () => {
          const qty = Math.trunc(Number(returnQty));
          if (!Number.isInteger(qty) || qty < 1) { setError('Enter a whole quantity of at least 1.'); return; }
          setBusy('partial');
          const { error: e } = await client.rpc('portal_return_partial', { p_return_id: selected.id, p_qty: qty, p_defective: false });
          setBusy(null);
          if (e) { setError(errText(e)); return; }
          setFlash(`Restocked ${qty}.`);
          await load();
        })()}>Restock this many</button>
        <button type="button" className="secondary" disabled={!!busy} onClick={() => void (async () => {
          const qty = Math.trunc(Number(returnQty));
          if (!Number.isInteger(qty) || qty < 1) { setError('Enter a whole quantity of at least 1.'); return; }
          setBusy('partial');
          const { error: e } = await client.rpc('portal_return_partial', { p_return_id: selected.id, p_qty: qty, p_defective: true });
          setBusy(null);
          if (e) { setError(errText(e)); return; }
          setFlash(`${qty} went to Defective.`);
          await load();
        })()}>Came back defective</button>
        <button type="button" disabled={!!busy} onClick={() => void disposition('relist')}>Relist</button>
        <button type="button" className="secondary" disabled={!!busy} onClick={() => void disposition('downgrade_channel')}>Downgrade</button>
        <button type="button" className="text-button danger" disabled={!!busy} onClick={() => void disposition('write_off')}>Write off</button>
      </div>

      <h3>Notes</h3>
      {(selected.notes || []).map((n) => (
        <p key={n.id}><small>{stamp(n.created_at)}</small> {n.body}</p>
      ))}
      <label className="receive-notes">Add a note<textarea rows={2} value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} /></label>
      <button type="button" className="secondary" disabled={!!busy} onClick={() => void addNote()}>Save note</button>
    </section>
  );

  return (
    <>
      {app ? (
        <div className="app-large-title"><h1>Returns</h1></div>
      ) : (
        <header>
          <div>
            <div className="eyebrow">GARAGE</div>
            <h1>Returns</h1>
            <p>One place for returns, refunds, and replacements. Same SKU comes back into stock. Admin only.</p>
          </div>
        </header>
      )}
      {error && <div className={app ? 'app-inline-error' : 'alert'} role="alert">{error}{!app && <button type="button" onClick={() => setError('')}>Dismiss</button>}</div>}
      {flash && <div className={app ? 'app-footer-count' : 'notice'}>{flash}</div>}
      <div className={app ? 'app-group' : 'stats'} style={{ marginBottom: 12 }}>
        <div className={app ? 'app-row' : 'stat'}><span>Refunded</span><strong>{money(totals.refund_cents)}</strong></div>
        <div className={app ? 'app-row' : 'stat'}><span>Labels I paid</span><strong>{money(totals.label_cents)}</strong></div>
        <div className={app ? 'app-row' : 'stat'}><span>Write-offs</span><strong>{money(totals.writeoff_cents)}</strong></div>
      </div>
      <div className={app ? 'app-segment' : 'inventory-tabs'} role="tablist">
        {FILTERS.map(([id, label]) => (
          <button key={id} type="button" className={filter === id ? 'active' : ''} onClick={() => setFilter(id)}>{label}</button>
        ))}
      </div>
      <div className="actions" style={{ margin: '12px 0', flexWrap: 'wrap', gap: 8 }}>
        <label>Search <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="SKU, order, buyer" /></label>
        <label>From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button type="button" className="secondary" onClick={() => void load()}>Refresh</button>
      </div>
      {startForm}
      <div className={app ? '' : 'ebay-layout'}>
        <section className={app ? 'app-group' : 'panel'} style={app ? undefined : { margin: 0 }}>
          {rows === null && <p className="hint">Loading returns…</p>}
          {rows && list.length === 0 && <div className={app ? 'app-empty-row' : 'empty'}>Nothing in this view.</div>}
          {list.map((r) => (
            <button key={r.id} type="button" className={app ? 'app-row' : 'ticket order'} style={app ? { width: '100%', textAlign: 'left' } : { width: '100%', textAlign: 'left', background: 'transparent' }} onClick={() => pick(r)}>
              <span className={app ? 'app-row-text' : ''}>
                <strong>SKU {r.sku} · {statusLabel(r.status)}</strong>
                <small style={{ display: 'block' }}>{r.title} · {r.external_order_id || 'no order'}{r.buyer_name ? ` · ${r.buyer_name}` : ''}</small>
                <small style={{ display: 'block' }}>{r.refund_cents ? money(r.refund_cents) : 'No refund yet'}{r.replacement_sku ? ` · replacement ${r.replacement_sku}` : ''}</small>
              </span>
              {app && <span className="app-chevron">›</span>}
            </button>
          ))}
        </section>
        {detail}
      </div>
    </>
  );
}
