import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

type PlatformKey = 'square' | 'ebay' | 'depop' | 'amazon' | 'tiktok';

type PlatformRow = {
  platform: PlatformKey;
  label: string;
  available_cents: number;
  available_noted_on: string | null;
  withdrawn_cents: number;
  withdrawn_range_cents: number;
};

type Summary = {
  start: string;
  end: string;
  cash_in_cents: number;
  cash_in_all_cents: number;
  owner_take_cents: number;
  owner_take_all_cents: number;
  owner_put_cents: number;
  owner_put_all_cents: number;
  cash_on_hand_cents: number;
  platforms: PlatformRow[];
};

type CashMovement = {
  id: string;
  kind: 'owner_take' | 'owner_put' | 'adjustment';
  amount_cents: number;
  moved_on: string;
  note: string;
  created_at: string;
  voided_at: string | null;
};

type PlatformWithdrawal = {
  id: string;
  platform: PlatformKey;
  amount_cents: number;
  withdrawn_on: string;
  note: string;
  created_at: string;
  voided_at: string | null;
};

type Props = {
  client: SupabaseClient;
  money: (n: number) => string;
  stamp: (s: string) => string;
};

const zone = 'America/Los_Angeles';
const todayLA = () => new Date().toLocaleDateString('en-CA', { timeZone: zone });
const monthStartLA = () => `${todayLA().slice(0, 7)}-01`;
const moneyEntry = /^\d*(?:\.\d{0,2})?$/;

const KIND_LABEL: Record<CashMovement['kind'], string> = {
  owner_take: 'Owner take',
  owner_put: 'Cash put back',
  adjustment: 'Adjustment',
};

const PLATFORMS: { key: PlatformKey; label: string }[] = [
  { key: 'square', label: 'Square' },
  { key: 'ebay', label: 'eBay' },
  { key: 'depop', label: 'Depop' },
  { key: 'amazon', label: 'Amazon' },
  { key: 'tiktok', label: 'TikTok' },
];

function centsFromInput(value: string) {
  const n = Math.round(Number(value === '.' ? 0 : value || 0) * 100);
  return Number.isFinite(n) ? n : NaN;
}

/** Cash drawer + marketplace balances the owner can withdraw. */
export function WithdrawalsPage({ client, money, stamp }: Props) {
  const [start, setStart] = useState(monthStartLA);
  const [end, setEnd] = useState(todayLA);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [cashMoves, setCashMoves] = useState<CashMovement[]>([]);
  const [withdrawals, setWithdrawals] = useState<PlatformWithdrawal[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [cashKind, setCashKind] = useState<CashMovement['kind']>('owner_take');
  const [cashAmount, setCashAmount] = useState('');
  const [cashDate, setCashDate] = useState(todayLA);
  const [cashNote, setCashNote] = useState('');

  const [platForms, setPlatForms] = useState<Record<PlatformKey, { available: string; withdraw: string; note: string }>>(() =>
    Object.fromEntries(PLATFORMS.map(p => [p.key, { available: '', withdraw: '', note: '' }])) as Record<
      PlatformKey,
      { available: string; withdraw: string; note: string }
    >,
  );

  const load = useCallback(async () => {
    setError('');
    const [sumRes, cashRes, wdRes] = await Promise.all([
      client.rpc('portal_withdrawals_summary', { p_start: start, p_end: end }),
      client.rpc('portal_cash_movements', { p_limit: 150 }),
      client.rpc('portal_platform_withdrawals', { p_limit: 150 }),
    ]);
    if (sumRes.error) { setError(sumRes.error.message); setSummary(null); return; }
    if (cashRes.error) { setError(cashRes.error.message); return; }
    if (wdRes.error) { setError(wdRes.error.message); return; }
    const body = sumRes.data as Summary;
    setSummary({
      ...body,
      platforms: (body.platforms || []) as PlatformRow[],
    });
    setCashMoves((cashRes.data || []) as CashMovement[]);
    setWithdrawals((wdRes.data || []) as PlatformWithdrawal[]);
    setPlatForms(prev => {
      const next = { ...prev };
      for (const p of (body.platforms || []) as PlatformRow[]) {
        const cur = next[p.platform] || { available: '', withdraw: '', note: '' };
        next[p.platform] = {
          ...cur,
          available: (Number(p.available_cents || 0) / 100).toFixed(2),
        };
      }
      return next;
    });
  }, [client, start, end]);

  useEffect(() => { void load(); }, [load]);

  const platformByKey = useMemo(() => {
    const map = new Map<PlatformKey, PlatformRow>();
    for (const p of summary?.platforms || []) map.set(p.platform, p);
    return map;
  }, [summary]);

  async function submitCash(ev: React.FormEvent) {
    ev.preventDefault();
    const cents = centsFromInput(cashAmount);
    if (!Number.isFinite(cents) || cents <= 0) { setError('Enter a cash amount.'); return; }
    setBusy(true); setError('');
    const { error: e } = await client.rpc('portal_add_cash_movement', {
      p_kind: cashKind,
      p_amount_cents: cents,
      p_moved_on: cashDate,
      p_note: cashNote.trim(),
    });
    setBusy(false);
    if (e) { setError(e.message); return; }
    setCashAmount('');
    setCashNote('');
    await load();
  }

  async function voidCash(id: string) {
    if (!window.confirm('Remove this cash movement?')) return;
    setBusy(true); setError('');
    const { error: e } = await client.rpc('portal_void_cash_movement', { p_id: id });
    setBusy(false);
    if (e) setError(e.message);
    else await load();
  }

  async function setAvailable(platform: PlatformKey) {
    const cents = centsFromInput(platForms[platform].available);
    if (!Number.isFinite(cents) || cents < 0) { setError('Enter an available amount (0 or more).'); return; }
    setBusy(true); setError('');
    const { error: e } = await client.rpc('portal_set_platform_available', {
      p_platform: platform,
      p_available_cents: cents,
      p_noted_on: todayLA(),
      p_note: platForms[platform].note.trim(),
    });
    setBusy(false);
    if (e) { setError(e.message); return; }
    await load();
  }

  async function recordWithdrawal(platform: PlatformKey) {
    const cents = centsFromInput(platForms[platform].withdraw);
    if (!Number.isFinite(cents) || cents <= 0) { setError('Enter a withdrawal amount.'); return; }
    setBusy(true); setError('');
    const { error: e } = await client.rpc('portal_add_platform_withdrawal', {
      p_platform: platform,
      p_amount_cents: cents,
      p_withdrawn_on: todayLA(),
      p_note: platForms[platform].note.trim(),
      p_reduce_available: true,
    });
    setBusy(false);
    if (e) { setError(e.message); return; }
    setPlatForms(prev => ({
      ...prev,
      [platform]: { ...prev[platform], withdraw: '', note: '' },
    }));
    await load();
  }

  async function voidWithdrawal(id: string) {
    if (!window.confirm('Remove this platform withdrawal?')) return;
    setBusy(true); setError('');
    const { error: e } = await client.rpc('portal_void_platform_withdrawal', { p_id: id });
    setBusy(false);
    if (e) setError(e.message);
    else await load();
  }

  const labelFor = (platform: string) => PLATFORMS.find(p => p.key === platform)?.label || platform;

  return <>
    <header>
      <div>
        <div className="eyebrow">MONEY OUT</div>
        <h1>Withdrawals</h1>
        <p>
          Track cash from the register, owner takes from the drawer, and what you can still pull
          from Square, eBay, Depop, Amazon, and TikTok.
        </p>
      </div>
      <div className="report-actions">
        <label className="date-control">From
          <input type="date" value={start} onChange={e => setStart(e.target.value)} />
        </label>
        <label className="date-control">To
          <input type="date" value={end} onChange={e => setEnd(e.target.value)} />
        </label>
      </div>
    </header>

    {error && <p className="error" role="alert">{error}</p>}

    <div className="stats">
      <div className="stat"><span>Cash in (range)</span><strong>{money(summary?.cash_in_cents ?? 0)}</strong></div>
      <div className="stat"><span>Cash in (all time)</span><strong>{money(summary?.cash_in_all_cents ?? 0)}</strong></div>
      <div className="stat"><span>Owner taken (range)</span><strong>{money(summary?.owner_take_cents ?? 0)}</strong></div>
      <div className="stat"><span>Owner taken (all time)</span><strong>{money(summary?.owner_take_all_cents ?? 0)}</strong></div>
      <div className="stat"><span>Est. cash in drawer</span><strong>{money(summary?.cash_on_hand_cents ?? 0)}</strong></div>
    </div>

    <section className="panel">
      <h2>Cash drawer</h2>
      <p className="hint" style={{ marginTop: 0 }}>
        Cash in comes from register sales. Record when the owner takes cash out (or puts cash back).
      </p>
      <form className="exp-form" onSubmit={e => void submitCash(e)}>
        <label>Type
          <select value={cashKind} onChange={e => setCashKind(e.target.value as CashMovement['kind'])}>
            <option value="owner_take">Owner take</option>
            <option value="owner_put">Cash put back</option>
            <option value="adjustment">Adjustment</option>
          </select>
        </label>
        <label>Amount ($)
          <input
            inputMode="decimal"
            value={cashAmount}
            onChange={e => { if (moneyEntry.test(e.target.value)) setCashAmount(e.target.value); }}
            onBlur={() => cashAmount && setCashAmount(Number(cashAmount === '.' ? 0 : cashAmount).toFixed(2))}
          />
        </label>
        <label>Date
          <input type="date" value={cashDate} onChange={e => setCashDate(e.target.value)} />
        </label>
        <label>Note
          <input value={cashNote} onChange={e => setCashNote(e.target.value.slice(0, 200))} placeholder="Optional" />
        </label>
        <div className="actions"><button disabled={busy}>Record</button></div>
      </form>
      {cashMoves.length === 0 ? <div className="empty" style={{ marginTop: 16 }}>No cash movements yet.</div> : (
        <table className="tbl" style={{ marginTop: 16 }}>
          <thead><tr><th>Date</th><th>Type</th><th className="n">Amount</th><th>Note</th><th /></tr></thead>
          <tbody>
            {cashMoves.map(m => (
              <tr key={m.id} style={m.voided_at ? { opacity: 0.5, textDecoration: 'line-through' } : undefined}>
                <td>{m.moved_on}</td>
                <td>{KIND_LABEL[m.kind]}</td>
                <td className="n">{money(m.amount_cents)}</td>
                <td>{m.note || '—'}{m.voided_at ? <> · voided {stamp(m.voided_at)}</> : null}</td>
                <td>{!m.voided_at && <button type="button" className="text-button danger" disabled={busy} onClick={() => void voidCash(m.id)}>Remove</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>

    <section className="panel">
      <h2>Platform balances</h2>
      <p className="hint" style={{ marginTop: 0 }}>
        Enter the available-to-withdraw balance you see in each app. Recording a withdrawal logs it and
        lowers available by that amount.
      </p>
      <div className="withdrawals-grid">
        {PLATFORMS.map(p => {
          const row = platformByKey.get(p.key);
          const form = platForms[p.key];
          return (
            <div className="withdrawal-card" key={p.key}>
              <div className="withdrawal-card-top">
                <h3>{p.label}</h3>
                <div className="stats compact" style={{ margin: 0 }}>
                  <div className="stat">
                    <span>Available</span>
                    <strong>{money(row?.available_cents ?? 0)}</strong>
                    {row?.available_noted_on ? <small className="stat-hint">as of {row.available_noted_on}</small> : null}
                  </div>
                  <div className="stat">
                    <span>Withdrawn (all)</span>
                    <strong>{money(row?.withdrawn_cents ?? 0)}</strong>
                  </div>
                  <div className="stat">
                    <span>Withdrawn (range)</span>
                    <strong>{money(row?.withdrawn_range_cents ?? 0)}</strong>
                  </div>
                </div>
              </div>
              <div className="exp-form">
                <label>Available now ($)
                  <input
                    inputMode="decimal"
                    value={form.available}
                    onChange={e => {
                      if (!moneyEntry.test(e.target.value)) return;
                      setPlatForms(prev => ({ ...prev, [p.key]: { ...prev[p.key], available: e.target.value } }));
                    }}
                  />
                </label>
                <label>Withdraw ($)
                  <input
                    inputMode="decimal"
                    value={form.withdraw}
                    onChange={e => {
                      if (!moneyEntry.test(e.target.value)) return;
                      setPlatForms(prev => ({ ...prev, [p.key]: { ...prev[p.key], withdraw: e.target.value } }));
                    }}
                  />
                </label>
                <label>Note
                  <input
                    value={form.note}
                    onChange={e => setPlatForms(prev => ({ ...prev, [p.key]: { ...prev[p.key], note: e.target.value.slice(0, 200) } }))}
                    placeholder="Optional"
                  />
                </label>
                <div className="actions">
                  <button type="button" className="secondary" disabled={busy} onClick={() => void setAvailable(p.key)}>Set available</button>
                  <button type="button" disabled={busy} onClick={() => void recordWithdrawal(p.key)}>Record withdrawal</button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>

    <section className="panel">
      <h2>Recent platform withdrawals</h2>
      {withdrawals.length === 0 ? <div className="empty">No platform withdrawals yet.</div> : (
        <table className="tbl">
          <thead><tr><th>Date</th><th>Platform</th><th className="n">Amount</th><th>Note</th><th /></tr></thead>
          <tbody>
            {withdrawals.map(w => (
              <tr key={w.id} style={w.voided_at ? { opacity: 0.5, textDecoration: 'line-through' } : undefined}>
                <td>{w.withdrawn_on}</td>
                <td>{labelFor(w.platform)}</td>
                <td className="n">{money(w.amount_cents)}</td>
                <td>{w.note || '—'}{w.voided_at ? <> · voided {stamp(w.voided_at)}</> : null}</td>
                <td>{!w.voided_at && <button type="button" className="text-button danger" disabled={busy} onClick={() => void voidWithdrawal(w.id)}>Remove</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  </>;
}
