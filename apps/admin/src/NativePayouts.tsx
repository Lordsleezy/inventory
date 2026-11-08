import { useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { CommissionOverrideControls } from './CommissionOverride';
import {
  effectiveCommissionSplit,
  frozenCutsForTicket,
  payoutDay,
  remainingProfit,
  type OnlineCfg,
  type Rule,
  type TicketLike,
} from './payouts';

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

function personCutPct(ticket: TicketLike, personId: string, rules: Rule[], cfg: OnlineCfg) {
  const split = effectiveCommissionSplit(ticket, rules, cfg);
  if (cfg.slots?.paul && personId === cfg.slots.paul) return split.paulPct;
  if (cfg.slots?.jacob && personId === cfg.slots.jacob) return split.jacobPct;
  const rule = rules.find(r => r.employee_id === personId);
  return rule ? Number(rule.rate) || 0 : 0;
}

function saleSubtitleParts(entry: Entry, personId: string, rules: Rule[], cfg: OnlineCfg, personName: (id: string) => string) {
  const sku = entry.ticket?.lines?.find(line => line.sku)?.sku || entry.detail.split(',')[0]?.trim() || '';
  const pct = entry.ticket ? personCutPct(entry.ticket, personId, rules, cfg) : 0;
  const overridden = !!entry.ticket?.commissionOverride;
  return {
    line: `SKU ${sku} · ${personName(personId)} ${pct}%`,
    overridden,
  };
}

function owedBits(commission: number, reimburse: number, sales: number, money: (n: number) => string) {
  const bits: string[] = [];
  if (commission) bits.push(`Commission ${money(commission)}`);
  if (reimburse) bits.push(`Reimbursements ${money(reimburse)}`);
  bits.push(`${sales} sale${sales === 1 ? '' : 's'}`);
  return bits.join(' · ');
}

function PayForm({ person, balance, busy, recordPayment, money, showNote }: {
  person: Card['person'];
  balance: number;
  busy: boolean;
  money: (n: number) => string;
  recordPayment: (id: string, amount: number, paidAt: string, note: string, applyToCommission?: boolean) => Promise<string | null>;
  showNote?: boolean;
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
        <button type="submit" disabled={busy || !amount}>Pay</button>
      </form>
      {showNote && (
        <input className="rpt-note-field" aria-label="Note for this payment" placeholder="Note (optional)" value={note} onChange={e => setNote(e.target.value.slice(0, 500))} />
      )}
      {error && <p className="rpt-note" role="alert">{error}</p>}
    </>
  );
}

function rowTitle(entry: Entry, when: string) {
  return `${kindLabel(entry.kind)} · ${when}`;
}

function rowSubtitle(entry: Entry, personId: string, rules: Rule[], cfg: OnlineCfg, personName: (id: string) => string) {
  if (entry.kind === 'bonus') return { text: 'Added to commission', overridden: false };
  if (entry.kind === 'payment') return { text: entry.detail, overridden: false };
  if (entry.kind === 'sale' || entry.kind === 'online') {
    const parts = saleSubtitleParts(entry, personId, rules, cfg, personName);
    return { text: parts.line, overridden: parts.overridden };
  }
  if (entry.note) return { text: `${entry.detail} · ${entry.note}`, overridden: false };
  return { text: entry.detail, overridden: false };
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
  const [filter, setFilter] = useState<'all' | 'needs' | 'sales' | 'payments'>('all');
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [costError, setCostError] = useState('');
  const [showEarlier, setShowEarlier] = useState(false);
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
      if (filter === 'payments') return entry.kind === 'payment';
      return true;
    });
    const ordered = [...shown].sort((a, b) => b.at.localeCompare(a.at));
    const visible = showEarlier ? ordered : ordered.slice(0, 40);
    const groups = new Map<string, Entry[]>();
    for (const entry of visible) {
      const day = payoutDay(entry.at) || entry.at.slice(0, 10);
      groups.set(day, [...(groups.get(day) || []), entry]);
    }
    const rule = rules.find(r => r.employee_id === open.person.user_id);
    const rate = rule && rule.method === 'percent_profit' && cfg.employeeId === open.person.user_id
      ? `${rule.rate}% in store · ${cfg.pct}% online`
      : rule && rule.method === 'percent_profit'
        ? `${rule.rate}% of commission profit`
        : rule
          ? `${rule.rate}${rule.method === 'flat_ticket' ? ' flat' : '% of sale'}`
          : 'Reimbursements';
    return (
      <div className="rpt-sheet" role="dialog" aria-label={`${open.person.display_name} payout breakdown`}>
        <div className="app-nav">
          <button type="button" onClick={() => { setOpenId(null); setOpenRow(null); setShowEarlier(false); }}>‹ Payouts</button>
          <div className="app-nav-title">{open.person.display_name}</div>
          <button type="button" style={{ visibility: 'hidden' }}>·</button>
        </div>
        <p className="rpt-note" style={{ marginTop: 0 }}>Owed · {rate}</p>
        <div className="native-report-hero">
          <strong>{money(open.balance)}</strong>
          <span>{owedBits(open.commissionOwed, open.reimburseOwed, sales.length, money)}</span>
        </div>
        <PayForm person={open.person} balance={open.balance} busy={busy} recordPayment={recordPayment} money={money} showNote />
        <div className="rpt-filters" role="tablist" aria-label="Breakdown filters">
          {([['all', `All ${sales.length}`], ['needs', `Needs cost ${needs}`], ['sales', 'Sales'], ['payments', 'Payments']] as const).map(([id, label]) => (
            <button
              type="button"
              key={id}
              role="tab"
              aria-selected={filter === id}
              className={`${filter === id ? 'on' : ''}${id === 'needs' && needs > 0 ? ' rpt-need' : ''}`}
              onClick={() => setFilter(id)}
            >
              {label}
            </button>
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
              const sub = rowSubtitle(entry, open.person.user_id, rules, cfg, personName);
              const ownerShare = entry.ticket ? remainingProfit(entry.ticket, rules, cfg) : null;
              const isSale = entry.kind === 'sale' || entry.kind === 'online';
              return (
                <div key={id}>
                  <button type="button" className="rpt-row" onClick={() => setOpenRow(expanded ? null : id)}>
                    <span>
                      {rowTitle(entry, when)}
                      <small>
                        {sub.text}
                        {sub.overridden ? <> · <span className="rpt-override">Override</span></> : null}
                      </small>
                    </span>
                    {entry.amount === null
                      ? <b className="rpt-need">Needs cost</b>
                      : <b className="deduct">{entry.amount < 0 ? '−' : ''}{money(Math.abs(entry.amount))}</b>}
                  </button>
                  {expanded && isSale && entry.ticket && entry.ticketKey && (
                    <div className="rpt-open">
                      <p>
                        Paul {split?.paulPct ?? 0}% · Jacob {split?.jacobPct ?? 0}%
                        {ownerShare == null ? '' : ` · owner share ${money(ownerShare)}`}
                      </p>
                      <div className="rpt-links">
                        {entry.amount === null && (
                          <button type="button" disabled={!sku} onClick={() => sku && void addCost(sku)}>Add cost</button>
                        )}
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
        {!showEarlier && ordered.length > visible.length && (
          <button type="button" className="rpt-more" onClick={() => setShowEarlier(true)}>Show earlier</button>
        )}
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
        const splitBits: string[] = [];
        if (card.commissionOwed) splitBits.push(`Commission ${money(card.commissionOwed)}`);
        if (card.reimburseOwed) splitBits.push(`Reimbursements ${money(card.reimburseOwed)}`);
        return (
          <section className="rpt-person" key={card.person.user_id}>
            <div className="rpt-person-top">
              <span>
                <strong>{card.person.display_name}</strong>
                <small>{rate}</small>
              </span>
              <span>
                <b>{money(card.balance)}</b>
                <small className="rpt-owed">OWED</small>
              </span>
            </div>
            {splitBits.length > 0 && card.reimburseOwed > 0 && (
              <p className="rpt-note">{splitBits.join(' · ')}</p>
            )}
            <PayForm person={card.person} balance={card.balance} busy={busy} recordPayment={recordPayment} money={money} />
            <button type="button" className="rpt-break-link" onClick={() => { setOpenId(card.person.user_id); setFilter('all'); setOpenRow(null); setShowEarlier(false); }}>
              <span>Breakdown · {sales.length} sale{sales.length === 1 ? '' : 's'}</span>
              <span>
                {needs > 0 && <b className="rpt-need">{needs} need cost</b>}
                <span className="native-chevron">›</span>
              </span>
            </button>
          </section>
        );
      })}
      {!loading && (
        <button type="button" className="rpt-owner-link" onClick={() => window.dispatchEvent(new Event('floor:reports-action'))}>
          Owner payout
        </button>
      )}
    </div>
  );
}
