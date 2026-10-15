import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  defaultCommissionSplit,
  effectiveCommissionSplit,
  type CommissionOverride,
  type OnlineCfg,
  type Rule,
  type TicketLike,
} from './payouts';

export type CommissionOverrideRow = { ticket_key: string; paul_pct: number; jacob_pct: number };
export type CommissionLogRow = {
  id: string;
  ticket_key: string;
  changed_at: string;
  changed_by: string;
  action: 'set' | 'flip' | 'reset';
  old_paul_pct: number | null;
  old_jacob_pct: number | null;
  new_paul_pct: number | null;
  new_jacob_pct: number | null;
  was_override: boolean;
  reason: string | null;
};

type Props = {
  client: SupabaseClient;
  ticketKey: string;
  ticket: TicketLike;
  rules: Rule[];
  cfg: OnlineCfg;
  override: CommissionOverride | null;
  personName: (id: string) => string;
  stamp: (iso: string) => string;
  busy?: boolean;
  onChanged: (next: CommissionOverride | null) => void;
};

function pctLabel(paul: number, jacob: number) {
  return `Paul ${paul}% / Jacob ${jacob}%`;
}

export function CommissionOverrideMark({ overridden }: { overridden: boolean }) {
  if (!overridden) return null;
  return <small className="sale-override commission-overridden">Commission overridden</small>;
}

export function CommissionOverrideControls({
  client, ticketKey, ticket, rules, cfg, override, personName, stamp, busy, onChanged,
}: Props) {
  const [open, setOpen] = useState(false);
  const [paulText, setPaulText] = useState('');
  const [jacobText, setJacobText] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<CommissionLogRow[] | null>(null);
  const [historyError, setHistoryError] = useState('');

  const def = defaultCommissionSplit(ticket, rules, cfg);
  const current = effectiveCommissionSplit({ ...ticket, commissionOverride: override }, rules, cfg);

  useEffect(() => {
    if (!open) return;
    setPaulText(String(current.paulPct));
    setJacobText(String(current.jacobPct));
    setReason('');
    setError('');
  }, [open, current.paulPct, current.jacobPct]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void (async () => {
      setHistoryError('');
      const { data, error: e } = await client
        .from('portal_commission_override_log')
        .select('id,ticket_key,changed_at,changed_by,action,old_paul_pct,old_jacob_pct,new_paul_pct,new_jacob_pct,was_override,reason')
        .eq('ticket_key', ticketKey)
        .order('changed_at', { ascending: false })
        .limit(20);
      if (!alive) return;
      if (e) { setHistoryError(e.message); setHistory([]); return; }
      setHistory((data || []) as CommissionLogRow[]);
    })();
    return () => { alive = false; };
  }, [open, client, ticketKey, override]);

  async function apply(action: 'set' | 'flip' | 'reset', paul?: number, jacob?: number) {
    setSaving(true); setError('');
    try {
      const { data, error: e } = await client.rpc('portal_set_commission_override', {
        p_ticket_key: ticketKey,
        p_paul_pct: action === 'reset' ? null : (paul ?? null),
        p_jacob_pct: action === 'reset' ? null : (jacob ?? null),
        p_action: action,
        p_reason: reason.trim() || null,
      });
      if (e) throw new Error(e.message);
      const row = data as { override: { paul_pct: number; jacob_pct: number } | null } | null;
      if (!row?.override) onChanged(null);
      else onChanged({ paulPct: Number(row.override.paul_pct), jacobPct: Number(row.override.jacob_pct) });
      if (action !== 'set') setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const paulN = Number(paulText);
  const jacobN = Number(jacobText);
  const sum = (Number.isFinite(paulN) ? paulN : 0) + (Number.isFinite(jacobN) ? jacobN : 0);
  const over100 = sum > 100;
  const disabled = !!busy || saving;

  return (
    <div className="commission-override">
      <div className="commission-override-summary">
        <span>Commission · {pctLabel(current.paulPct, current.jacobPct)}
          {current.overridden ? ' (override)' : ' (default)'}</span>
        <button type="button" className="secondary" disabled={disabled} onClick={() => setOpen(o => !o)}>
          {open ? 'Close' : 'Change commission'}
        </button>
      </div>
      {open && (
        <div className="commission-override-panel">
          <p className="hint" style={{ marginTop: 0 }}>
            Split is a percent of sale − cost (merchandise + buyer shipping). Tax and fees stay out.
            Defaults: {pctLabel(def.paulPct, def.jacobPct)}.
            Flip swaps the two percentages. Custom lets you type any split. Reset clears the override.
            Changing a sale that was already paid just moves the running balance — past payments stay as recorded.
          </p>
          <div className="actions" style={{ flexWrap: 'wrap', gap: 8 }}>
            <button type="button" disabled={disabled} onClick={() => void apply('flip')}>
              Flip ({current.jacobPct}% / {current.paulPct}%)
            </button>
            <button type="button" className="secondary" disabled={disabled || !current.overridden}
              onClick={() => void apply('reset')}>
              Reset to default
            </button>
          </div>
          <form className="commission-custom" onSubmit={e => {
            e.preventDefault();
            if (!Number.isFinite(paulN) || !Number.isFinite(jacobN) || paulN < 0 || jacobN < 0) {
              setError('Enter valid percentages (0 or more).');
              return;
            }
            void apply('set', paulN, jacobN);
          }}>
            <label>Paul %
              <input type="number" min={0} max={1000} step="0.01" value={paulText}
                onChange={e => setPaulText(e.target.value)} required disabled={disabled} />
            </label>
            <label>Jacob %
              <input type="number" min={0} max={1000} step="0.01" value={jacobText}
                onChange={e => setJacobText(e.target.value)} required disabled={disabled} />
            </label>
            <label className="commission-reason">Reason (optional)
              <input type="text" maxLength={500} value={reason}
                onChange={e => setReason(e.target.value)} disabled={disabled} placeholder="Optional note" />
            </label>
            <button type="submit" disabled={disabled}>Save custom</button>
          </form>
          {over100 && (
            <p className="hint" role="status">
              These add to {sum}% of profit — more than 100%. You can still save; owner share goes negative on this sale.
            </p>
          )}
          {error && <p className="error" role="alert">{error}</p>}
          <div className="commission-history">
            <strong>Change history</strong>
            {historyError && <p className="error" role="alert">{historyError}</p>}
            {history === null && <p className="hint">Loading…</p>}
            {history && history.length === 0 && <p className="hint">No changes yet.</p>}
            {history && history.length > 0 && (
              <ul>
                {history.map(h => {
                  const oldL = h.old_paul_pct == null ? '—' : pctLabel(Number(h.old_paul_pct), Number(h.old_jacob_pct || 0));
                  const newL = h.action === 'reset' || h.new_paul_pct == null
                    ? 'default'
                    : pctLabel(Number(h.new_paul_pct), Number(h.new_jacob_pct || 0));
                  return (
                    <li key={h.id}>
                      <span>{stamp(h.changed_at)} · {personName(h.changed_by)} · {h.action}</span>
                      <span>{oldL} → {newL}{h.reason ? ` · ${h.reason}` : ''}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
