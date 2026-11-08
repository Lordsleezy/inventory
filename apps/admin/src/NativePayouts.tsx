import { useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { CommissionOverrideControls } from './CommissionOverride';
import { effectiveCommissionSplit, frozenCutsForTicket, payoutDay, type OnlineCfg, type Rule, type TicketLike } from './payouts';

const moneyEntry = /^\d*(?:\.\d{0,2})?$/;
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

type Entry = {
  at: string;
  kind: 'sale' | 'online' | 'reimbursement' | 'bonus' | 'payment' | 'adjustment';
  amount: number | null;
  detail: string;
  note?: string;
  ticketKey?: string;
  ticket?: TicketLike;
};

type Card = {
  person: { user_id: string; display_name: string };
  balance: number;
  commissionOwed: number;
  reimburseOwed: number;
  entries: Entry[];
};

function kindLabel(kind: Entry['kind']) {
  if (kind === 'sale') return 'In-store sale';
  if (kind === 'online') return 'Online sale';
  if (kind === 'payment') return 'Payment';
  if (kind === 'adjustment') return 'Adjustment';
  if (kind === 'bonus') return 'Bonus';
  return 'Reimbursement';
}

function PayForm({ person, balance, busy, recordPayment, money }: {
  person: Card['person'];
  balance: number;
  busy: boolean;
  money: (n: number) => string;
  recordPayment: (id: string, amount: number, paidAt: string, note: string, applyToCommission?: boolean) => Promise<string | null>;
}) {
  const [amount, setAmount] = useState('');
  const [paidOn, setPaidOn] = useState(today);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    const cents = Math.round(Number(amount) * 100);
    if (!Number.isFinite(cents) || cents <= 0) { setError('Enter an amount greater than zero.'); return; }
    if (cents > balance && !window.confirm(`This payment exceeds ${person.display_name}'s ${money(balance)} balance. Record ${money(cents)} anyway?`)) return;
    const failure = await recordPayment(person.user_id, cents, paidOn, note);
    if (failure) setError(failure);
    else { setAmount(''); setNote(''); setPaidOn(today()); }
  }
  return (
    <>
      <form className="rpt-pay" onSubmit={e => void submit(e)}>
        <input aria-label={`Payment amount for ${person.display_name}`} placeholder="$ Amount" inputMode="decimal" value={amount} onChange={e => { if (moneyEntry.test(e.target.value)) setAmount(e.target.value); }} required />
        <input aria-label={`Payment date for ${person.display_name}`} type="date" value={paidOn} onChange={e => setPaidOn(e.target.value)} required />
        <button disabled={busy || !amount}>Pay</button>
      </form>
      <input className="rpt-note-field" style={{ marginTop: 8 }} aria-label="Note for this payment" placeholder="Note for this payment (optional)" value={note} onChange={e => setNote(e.target.value.slice(0, 500))} />
      {error && <p className="rpt-note" role="alert">{error}</p>}
    </>
  );
}

export function NativePayouts({
  money, loading, owedLabel, paidLine, cards, rules, cfg, personName, frozen, busy, recordPayment, onCommissionChanged, client, onReload,
}: {
  money: (n: number) => string;
  loading?: boolean;
  owedLabel: string;
  paidLine: string;
  cards: Card[];
  rules: Rule[];
  cfg: OnlineCfg;
  personName: (id: string) => string;
  frozen?: Map<string, number | null> | null;
  busy: boolean;
  recordPayment: (id: string, amount: number, paidAt: string, note: string, applyToCommission?: boolean) => Promise<string | null>;
  onCommissionChanged: (ticketKey: string, next: { paulPct: number; jacobPct: number } | null) => void;
  client: SupabaseClient;
  onReload: () => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'needs' | 'sales' | 'reimburse'>('all');
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [costError, setCostError] = useState('');
  const open = cards.find(card => card.person.user_id === openId);

  async function addCost(sku: string) {
    const raw = window.prompt(`Cost for SKU ${sku} (dollars)`);
    if (raw == null || !raw.trim()) return;
    const cents = Math.round(Number(raw) * 100);
    if (!Number.isFinite(cents) || cents < 0) { setCostError('Enter a cost like 9.00.'); return; }
    const { error } = await client.rpc('portal_set_unit_cost', { p_sku: sku, p_cost_cents: cents });
    if (error) { setCostError(error.message); return; }
    setCostError('');
    onReload();
  }

  if (open) {
    const sales = open.entries.filter(entry => entry.kind === 'sale' || entry.kind === 'online');
    const needs = sales.filter(entry => entry.amount === null).length;
    const shown = open.entries.filter(entry => {
      if (filter === 'needs') return (entry.kind === 'sale' || entry.kind === 'online') && entry.amount === null;
      if (filter === 'sales') return entry.kind === 'sale' || entry.kind === 'online';
      if (filter === 'reimburse') return entry.kind === 'reimbursement' || entry.kind === 'bonus';
      return true;
    });
    const groups = new Map<string, Entry[]>();
    for (const entry of shown) {
      const day = payoutDay(entry.at) || entry.at.slice(0, 10);
      groups.set(day, [...(groups.get(day) || []), entry]);
    }
    const rule = rules.find(r => r.employee_id === open.person.user_id);
    const rate = rule
      ? `${rule.rate}${rule.method === 'flat_ticket' ? ' flat' : rule.method === 'percent_profit' ? '% of commission profit' : '% of sale'}`
      : 'Reimbursements';
    const online = cfg.employeeId === open.person.user_id ? ` · ${cfg.pct}% online` : '';
    return (
      <div className="native-report-body">
        <button type="button" className="rpt-break-link" onClick={() => { setOpenId(null); setOpenRow(null); }}><span>‹ Payouts</span><strong>{open.person.display_name}</strong><span /></button>
        <p className="rpt-note">Owed · {rate}{online}</p>
        <div className="native-report-hero"><strong>{money(open.balance)}</strong><span>Commission {money(open.commissionOwed)} · Reimbursements {money(open.reimburseOwed)} · {sales.length} sales</span></div>
        <PayForm person={open.person} balance={open.balance} busy={busy} recordPayment={recordPayment} money={money} />
        <div className="rpt-filters" role="tablist">
          {([['all', `All ${sales.length}`], ['needs', `Needs cost ${needs}`], ['sales', 'Sales'], ['reimburse', 'Reimburse']] as const).map(([id, label]) => (
            <button type="button" key={id} className={`${filter === id ? 'on' : ''}${id === 'needs' && needs > 0 ? ' rpt-need' : ''}`} onClick={() => setFilter(id)}>{label}</button>
          ))}
        </div>
        {costError && <p className="rpt-note" role="alert">{costError}</p>}
        {[...groups.entries()].map(([day, rows]) => (
          <div key={day}>
            <div className="rpt-day">{new Date(`${day}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' })}</div>
            {rows.map((entry, index) => {
              const id = `${day}-${index}-${entry.ticketKey || entry.detail}`;
              const expanded = openRow === id;
              const when = new Date(entry.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' });
              const split = entry.ticket ? effectiveCommissionSplit(entry.ticket, rules, cfg) : null;
              const frozenCuts = entry.ticketKey ? frozenCutsForTicket(frozen, entry.ticketKey, cfg) : null;
              const sku = entry.ticket?.lines?.find(line => line.sku)?.sku || entry.detail.split(',')[0]?.trim();
              return (
                <div key={id}>
                  <button type="button" className="rpt-row" onClick={() => setOpenRow(expanded ? null : id)}>
                    <span>{kindLabel(entry.kind)} · {when}<small>{entry.detail}{entry.note ? ` · ${entry.note}` : ''}</small></span>
                    {entry.amount === null ? <b className="rpt-need">Needs cost</b> : <b className="deduct">{entry.amount < 0 ? '−' : ''}{money(Math.abs(entry.amount))}</b>}
                  </button>
                  {expanded && (entry.kind === 'sale' || entry.kind === 'online') && entry.ticket && entry.ticketKey && (
                    <div className="rpt-open">
                      <p>Split Paul {split?.paulPct ?? 0}% · Jacob {split?.jacobPct ?? 0}% · {frozenCuts ? 'frozen at sale' : 'not frozen yet'}{entry.amount === null ? ' · no payout yet' : ''}</p>
                      <div className="rpt-links">
                        <button type="button" disabled={!sku} onClick={() => sku && void addCost(sku)}>Add cost</button>
                        <CommissionOverrideControls
                          appearance="links"
                          client={client}
                          ticketKey={entry.ticketKey}
                          ticket={entry.ticket}
                          rules={rules}
                          cfg={cfg}
                          override={entry.ticket.commissionOverride || null}
                          frozenCuts={frozenCuts}
                          personName={personName}
                          stamp={iso => iso}
                          money={money}
                          busy={busy}
                          onChanged={next => onCommissionChanged(entry.ticketKey!, next)}
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="native-report-body">
      <div className="native-report-hero">
        <small>Owed right now</small>
        <strong>{loading ? <span className="native-skeleton" /> : owedLabel}</strong>
        <span>{loading ? 'Loading payouts…' : paidLine}</span>
      </div>
      {loading && <p className="rpt-note">Loading balances…</p>}
      {!loading && cards.map(card => {
        const sales = card.entries.filter(entry => entry.kind === 'sale' || entry.kind === 'online');
        const needs = sales.filter(entry => entry.amount === null).length;
        const rule = rules.find(r => r.employee_id === card.person.user_id);
        const rate = rule && rule.method === 'percent_profit' && cfg.employeeId === card.person.user_id
          ? `${rule.rate}% in store · ${cfg.pct}% online`
          : rule && rule.method === 'percent_profit'
            ? `${rule.rate}% of commission profit`
            : rule ? `${rule.rate}${rule.method === 'flat_ticket' ? ' flat per sale' : '% of sale'}` : 'Reimbursements';
        return (
          <section className="rpt-person" key={card.person.user_id}>
            <div className="rpt-person-top">
              <span><strong>{card.person.display_name}</strong><small>{rate}</small></span>
              <span><b>{money(card.balance)}</b><small className="rpt-owed">OWED</small></span>
            </div>
            <p className="rpt-note">Commission {money(card.commissionOwed)} · Reimbursements {money(card.reimburseOwed)}</p>
            <PayForm person={card.person} balance={card.balance} busy={busy} recordPayment={recordPayment} money={money} />
            <button type="button" className="rpt-break-link" onClick={() => { setOpenId(card.person.user_id); setFilter('all'); setOpenRow(null); }}>
              <span>Breakdown · {sales.length} sales</span>
              <span>{needs > 0 && <b className="rpt-need">{needs} need cost </b>}<span className="native-chevron">›</span></span>
            </button>
          </section>
        );
      })}
    </div>
  );
}
