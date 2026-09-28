import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient, type Session } from '@supabase/supabase-js';

const sb = createClient(import.meta.env.VITE_SUPABASE_URL || 'https://zoukmsmbztcuyoslvikp.supabase.co', import.meta.env.VITE_SUPABASE_ANON_KEY || 'missing', { auth: { persistSession: true } });
const zone = 'America/Los_Angeles';
const money = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n / 100);
const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
const day = (d: Date) => { const p = Object.fromEntries(dateFmt.formatToParts(d).map(x => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}`; };
const today = () => day(new Date());
const datePlus = (d: string, n: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
function laMidnight(d: string) {
  const [y, m, a] = d.split('-').map(Number);
  let t = Date.UTC(y, m - 1, a, 8);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(parts.formatToParts(new Date(t)).map(x => [x.type, Number(x.value)]));
    const seen = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    t += Date.UTC(y, m - 1, a) - seen;
  }
  return new Date(t).toISOString();
}
const weekStart = (d: string) => { const wd = new Date(`${d}T12:00:00Z`).getUTCDay(); return datePlus(d, -(wd + 6) % 7); };
const range = (start: string, end: string) => ({ p_from: laMidnight(start), p_to: laMidnight(end) });
const stamp = (s: string) => new Intl.DateTimeFormat('en-US', { timeZone: zone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(s));

type Line = { id: number; ticket_key: string; sku: string; title: string; qty: number; sold_at: string; price_cents: number; tax_cents: number; card_fee_cents: number; cost_cents: number | null; payment_method: string | null; cash_cents: number | null; card_cents: number | null; actor_id: string | null; actor_name: string; channel: string; receipt_no: string };
type Ticket = { key: string; at: string; lines: Line[]; subtotal: number; tax: number; fee: number; total: number; cash: number; card: number; method: string; actorId: string | null; actor: string; cost: number | null; channel: string };
type Person = { user_id: string; display_name: string; kind: string };
type Rule = { employee_id: string; method: 'percent_sale' | 'flat_ticket' | 'percent_profit'; rate: number };
type Paid = { ticket_key: string; employee_id: string; amount_cents: number; paid_at: string };
type Expense = { description: string; category: string; amount_cents: number };
type Summary = { sales_cents: number; tax_cents: number; card_fee_cents: number; collected_cents: number; cash_cents: number; card_cents: number; other_cents: number; sale_count: number; payout_cents: number; payout_unset: number };
type Report = { id: string; period_type: 'daily' | 'weekly'; period_start: string; period_end: string; summary: Summary; expenses: Expense[]; notes: string; created_at: string; created_by: string; edited_at: string; edited_by: string };

function tickets(lines: Line[]): Ticket[] {
  const map = new Map<string, Ticket>();
  for (const l of lines) {
    let t = map.get(l.ticket_key);
    if (!t) { t = { key: l.ticket_key, at: l.sold_at, lines: [], subtotal: 0, tax: 0, fee: 0, total: 0, cash: 0, card: 0, method: l.payment_method || 'other', actorId: l.actor_id, actor: l.actor_name, cost: 0, channel: l.channel }; map.set(l.ticket_key, t); }
    t.lines.push(l); t.subtotal += l.price_cents; t.tax += l.tax_cents; t.fee += l.card_fee_cents;
    if (l.cost_cents === null) t.cost = null;
    else if (t.cost !== null) t.cost += l.cost_cents * l.qty;
  }
  for (const t of map.values()) {
    t.total = t.subtotal + t.tax + t.fee;
    const x = t.lines[0];
    t.cash = x.cash_cents ?? (t.method === 'cash' ? t.total : 0);
    t.card = x.card_cents ?? (t.method === 'card' ? t.total : 0);
  }
  return [...map.values()].sort((a, b) => b.at.localeCompare(a.at));
}
function payout(t: Ticket, rule?: Rule): number | null {
  if (!rule || !t.actorId) return null;
  if (rule.method === 'flat_ticket') return Math.round(Number(rule.rate) * 100);
  if (rule.method === 'percent_profit' && t.cost === null) return null;
  const basis = rule.method === 'percent_profit' ? Math.max(0, t.subtotal - (t.cost || 0)) : t.subtotal;
  return Math.round(basis * Number(rule.rate) / 100);
}
function payoutIssue(t: Ticket, rule?: Rule): string | null {
  if (!t.actorId) return 'No employee recorded';
  if (!rule) return 'No rule set';
  if (rule.method === 'percent_profit' && t.cost === null) return 'Item cost missing';
  return null;
}
function remainingProfit(t: Ticket, rule?: Rule, paid?: Paid): number | null {
  const cut = paid?.amount_cents ?? payout(t, rule);
  return t.cost === null || cut === null ? null : t.subtotal - t.cost - cut;
}
const check = <T,>(r: { data: T | null; error: { message: string } | null }): T => { if (r.error) throw new Error(r.error.message); return r.data as T; };
async function sales(start: string, end: string) { return tickets(check<Line[]>(await sb.rpc('portal_sales', range(start, end)))); }

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [store, setStore] = useState<string | null>(null);
  const [page, setPage] = useState<'sales' | 'reports' | 'payouts' | 'settings' | 'cameras'>('sales');
  const [selectedDay, setSelectedDay] = useState(today());
  const [selectedWeek, setSelectedWeek] = useState(weekStart(today()));
  const [live, setLive] = useState<Ticket[]>([]);
  const [weekly, setWeekly] = useState<Ticket[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [paid, setPaid] = useState<Paid[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [editing, setEditing] = useState<Report | 'daily' | 'weekly' | null>(null);
  const [reportReadOnly, setReportReadOnly] = useState(false);
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);

  useEffect(() => { void sb.auth.getSession().then(({ data }) => setSession(data.session)); const { data } = sb.auth.onAuthStateChange((_e, s) => setSession(s)); return () => data.subscription.unsubscribe(); }, []);
  useEffect(() => { setStore(null); setLive([]); setWeekly([]); setPeople([]); setRules([]); setPaid([]); setReports([]); if (!session) return; void sb.from('portal_admins').select('store_id').eq('user_id', session.user.id).single().then(({ data, error: e }) => { setStore(e ? null : data?.store_id || null); if (e && e.code !== 'PGRST116') setError(e.message); }); }, [session]);
  const loadCommon = useCallback(async () => {
    if (!store) return;
    try {
      const [p, r, q, a] = await Promise.all([
        sb.rpc('portal_people'), sb.from('portal_payout_rules').select('employee_id,method,rate').eq('store_id', store),
        sb.from('portal_paid_payouts').select('ticket_key,employee_id,amount_cents,paid_at').eq('store_id', store),
        sb.from('portal_reports').select('*').eq('store_id', store).order('created_at', { ascending: false })
      ]);
      setPeople(check<Person[]>(p)); setRules(check<Rule[]>(r)); setPaid(check<Paid[]>(q)); setReports(check<Report[]>(a)); setError('');
    } catch (e) { setError(String(e)); }
  }, [store]);
  const loadSales = useCallback(async () => { if (!store) return; try { setLive(await sales(selectedDay, datePlus(selectedDay, 1))); } catch (e) { setError(String(e)); } }, [store, selectedDay]);
  const loadWeek = useCallback(async () => { if (!store) return; try { setWeekly(await sales(selectedWeek, datePlus(selectedWeek, 7))); } catch (e) { setError(String(e)); } }, [store, selectedWeek]);
  useEffect(() => { void loadCommon(); }, [loadCommon]);
  useEffect(() => { void loadSales(); }, [loadSales]);
  useEffect(() => { void loadWeek(); }, [loadWeek]);
  useEffect(() => { if (!store) return; const c = sb.channel(`portal-sales-${store}`).on('postgres_changes', { event: '*', schema: 'public', table: 'sales', filter: `store_id=eq.${store}` }, () => { void loadSales(); void loadWeek(); }).subscribe(); return () => { void sb.removeChannel(c); }; }, [store, loadSales, loadWeek]);
  const paidMap = useMemo(() => new Map(paid.map(x => [x.ticket_key, x])), [paid]);
  const ruleMap = useMemo(() => new Map(rules.map(x => [x.employee_id, x])), [rules]);
  const personName = (id: string) => people.find(x => x.user_id === id)?.display_name || 'Unknown';
  const sum = (ts: Ticket[]): Summary => { const cuts = ts.map(t => paidMap.get(t.key)?.amount_cents ?? payout(t, ruleMap.get(t.actorId || ''))); return { sales_cents: ts.reduce((n, t) => n + t.subtotal, 0), tax_cents: ts.reduce((n, t) => n + t.tax, 0), card_fee_cents: ts.reduce((n, t) => n + t.fee, 0), collected_cents: ts.reduce((n, t) => n + t.total, 0), cash_cents: ts.reduce((n, t) => n + t.cash, 0), card_cents: ts.reduce((n, t) => n + t.card, 0), other_cents: ts.reduce((n, t) => n + t.total - t.cash - t.card, 0), sale_count: ts.length, payout_cents: cuts.reduce<number>((n, x) => n + (x || 0), 0), payout_unset: cuts.filter(x => x === null).length }; };
  async function run(f: () => Promise<void>) { setBusy(true); setError(''); try { await f(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } }
  async function openReport(type: 'daily' | 'weekly') { const start = type === 'daily' ? selectedDay : weekStart(selectedDay); const summary = sum(await sales(start, datePlus(start, type === 'daily' ? 1 : 7))); setReportDraft({ start, end: datePlus(start, type === 'daily' ? 1 : 7), summary, expenses: [], notes: '' }); setReportReadOnly(false); setEditing(type); }
  const [draft, setReportDraft] = useState<{ start: string; end: string; summary: Summary; expenses: Expense[]; notes: string } | null>(null);
  function viewReport(r: Report) { setEditing(r); setReportReadOnly(true); setReportDraft({ start: r.period_start, end: r.period_end, summary: r.summary, expenses: r.expenses, notes: r.notes }); }
  async function saveReport() { if (!store || !session || !editing || !draft) return; if (draft.expenses.some(x => !x.description.trim() || !x.category.trim() || !Number.isFinite(x.amount_cents) || x.amount_cents < 0)) { setError('Every expense needs a description, category, and nonnegative amount.'); return; } await run(async () => { const payload = { store_id: store, period_type: typeof editing === 'string' ? editing : editing.period_type, period_start: draft.start, period_end: draft.end, summary: draft.summary, expenses: draft.expenses, notes: draft.notes, edited_by: session.user.id, created_by: session.user.id }; if (typeof editing === 'string') check(await sb.from('portal_reports').insert(payload)); else check(await sb.from('portal_reports').update({ expenses: payload.expenses, notes: payload.notes, edited_by: session.user.id }).eq('id', editing.id)); setEditing(null); setReportDraft(null); await loadCommon(); }); }
  async function setRule(id: string, method: Rule['method'], rate: number) { if (!store || !session) return; await run(async () => { check(await sb.from('portal_payout_rules').upsert({ store_id: store, employee_id: id, method, rate, updated_at: new Date().toISOString(), updated_by: session.user.id })); await loadCommon(); }); }
  async function markPaid(t: Ticket) { if (!store || !session || !t.actorId) return; const amount = payout(t, ruleMap.get(t.actorId)); if (amount === null) return; await run(async () => { check(await sb.from('portal_paid_payouts').insert({ store_id: store, ticket_key: t.key, employee_id: t.actorId, amount_cents: amount, paid_by: session.user.id })); await loadCommon(); }); }

  if (!session) return <main className="auth"><div className="login"><div className="brand">OPEN BOX <span>INDUSTRIES</span></div><h1>Floor Admin</h1><p>Sign in to view your store.</p><form onSubmit={e => { e.preventDefault(); void run(async () => { const result = await sb.auth.signInWithPassword({ email, password }); if (result.error) throw result.error; }); }}><label>Email<input type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} required /></label><label>Password<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required /></label><button disabled={busy}>Sign in</button></form>{error && <p className="error">{error}</p>}</div></main>;
  if (!store) return <main className="auth"><div className="login"><h1>Access unavailable</h1><p>This account has no Floor Admin access. Ask an existing administrator to add it.</p><button onClick={() => void sb.auth.signOut()}>Sign out</button>{error && <p className="error">{error}</p>}</div></main>;
  return <div className="app"><aside><div className="brand">OPEN BOX <span>INDUSTRIES</span></div><div className="product">Floor <b>Admin</b></div><nav>{([['sales','Live Sales'],['reports','Reports'],['payouts','Payouts'],['settings','Payout Settings'],['cameras','Cameras']] as const).map(([id,label]) => <button className={page === id ? 'active' : ''} key={id} onClick={() => { setPage(id); setEditing(null); }}>{label}</button>)}</nav><div className="account"><small>{session.user.email}</small><button onClick={() => void sb.auth.signOut()}>Sign out</button></div></aside><main className="content">{error && <div className="alert" role="alert">{error}<button onClick={() => setError('')}>Dismiss</button></div>}
  {page === 'sales' && <><header><div><div className="eyebrow">REGISTER ACTIVITY</div><h1>Live Sales</h1><p>Transactions from Floor, updated as sales arrive.</p></div><label className="date-control">Date<input type="date" value={selectedDay} onChange={e => setSelectedDay(e.target.value)} /></label></header><div className="stats"><Stat name="Collected" value={money(sum(live).collected_cents)} /><Stat name="Sales" value={String(live.length)} /><Stat name="Cash" value={money(sum(live).cash_cents)} /><Stat name="Card" value={money(sum(live).card_cents)} /><Stat name="Card fees" value={money(sum(live).card_fee_cents)} /><Stat name="Other / unallocated" value={money(sum(live).other_cents)} /></div><section className="panel"><h2>{selectedDay === today() ? 'Today’s transactions' : `Transactions · ${selectedDay}`}</h2>{live.length === 0 ? <Empty>No sales recorded for this date.</Empty> : <div className="ticket-list">{live.map(t => <div className="ticket" key={t.key}><div className="ticket-top"><strong>{money(t.total)}</strong><span>{stamp(t.at)}</span></div><div className="ticket-items">{t.lines.map(l => <div key={l.id}>{l.qty > 1 ? `${l.qty}× ` : ''}{l.title} <span>· SKU {l.sku}</span></div>)}</div><div className="ticket-bottom"><span>{t.method === 'split' ? (t.lines[0].cash_cents === null ? 'Split amounts unavailable' : `Cash ${money(t.cash)} · Card ${money(t.card)}`) : t.method === 'card' ? `Card ${money(t.card)}` : t.method === 'cash' ? `Cash ${money(t.cash)}` : t.method}{t.fee > 0 && ` · fee ${money(t.fee)}`}</span><span>Rang up by {t.actor}</span></div></div>)}</div>}</section></>}
  {page === 'reports' && <><header><div><div className="eyebrow">CLOSEOUTS</div><h1>Reports</h1><p>Save a day or week with expenses and notes.</p></div><div className="report-actions"><label className="date-control">Report date<input type="date" value={selectedDay} onChange={e => setSelectedDay(e.target.value)} /></label><div className="actions"><button onClick={() => void run(() => openReport('daily'))}>Submit Daily Report</button><button className="secondary" onClick={() => void run(() => openReport('weekly'))}>Submit Weekly Report</button></div></div></header>{editing && draft ? <section className="panel editor"><div className="section-head"><div><div className="eyebrow">{typeof editing === 'string' ? 'NEW REPORT' : 'SUBMITTED REPORT'}</div><h2>{draft.start} {draft.end !== datePlus(draft.start,1) && `– ${datePlus(draft.end,-1)}`}</h2></div><div className="actions">{reportReadOnly && <button onClick={() => setReportReadOnly(false)}>Edit report</button>}<button className="text-button" onClick={() => { setEditing(null); setReportDraft(null); }}>Close</button></div></div><div className="stats compact"><Stat name="Sales" value={money(draft.summary.sales_cents)} /><Stat name="Collected" value={money(draft.summary.collected_cents)} /><Stat name="Tax" value={money(draft.summary.tax_cents)} /><Stat name="Cash" value={money(draft.summary.cash_cents)} /><Stat name="Card" value={money(draft.summary.card_cents)} /><Stat name="Card fees" value={money(draft.summary.card_fee_cents)} /><Stat name="Other / unallocated" value={money(draft.summary.other_cents)} /><Stat name="Transactions" value={String(draft.summary.sale_count)} /><Stat name="Payouts owed" value={money(draft.summary.payout_cents)} /></div>{draft.summary.payout_unset > 0 && <p className="hint">{draft.summary.payout_unset} transaction(s) have no payout rule or need item cost.</p>}<h3>Expenses</h3>{draft.expenses.map((x,i) => <div className="expense-row" key={i}><input disabled={reportReadOnly} aria-label="Description" placeholder="Description" value={x.description} onChange={e => setReportDraft({ ...draft, expenses: draft.expenses.map((v,j) => j===i ? {...v,description:e.target.value} : v) })} /><input disabled={reportReadOnly} aria-label="Category" placeholder="Category" value={x.category} onChange={e => setReportDraft({ ...draft, expenses: draft.expenses.map((v,j) => j===i ? {...v,category:e.target.value} : v) })} /><input disabled={reportReadOnly} aria-label="Amount" type="number" min="0" step="0.01" placeholder="Amount" value={(x.amount_cents/100).toFixed(2)} onChange={e => setReportDraft({ ...draft, expenses: draft.expenses.map((v,j) => j===i ? {...v,amount_cents:Math.round(Number(e.target.value)*100)} : v) })} />{!reportReadOnly && <button className="text-button" onClick={() => setReportDraft({...draft,expenses:draft.expenses.filter((_,j)=>j!==i)})}>Remove</button>}</div>)}{!reportReadOnly && <button className="secondary" onClick={() => setReportDraft({...draft,expenses:[...draft.expenses,{description:'',category:'',amount_cents:0}]})}>Add expense</button>}<label className="notes">Notes<textarea disabled={reportReadOnly} rows={4} value={draft.notes} onChange={e => setReportDraft({...draft,notes:e.target.value})} placeholder="Anything to remember about this period" /></label><div className="net"><span>Net merchandise after expenses</span><strong>{money(draft.summary.sales_cents - draft.expenses.reduce((n,x)=>n+x.amount_cents,0))}</strong></div>{!reportReadOnly && <button disabled={busy} onClick={() => void saveReport()}>{typeof editing === 'string' ? 'Submit report' : 'Save edits'}</button>}{typeof editing !== 'string' && <p className="hint">Last edited by {personName(editing.edited_by)} · {stamp(editing.edited_at)}</p>}</section> : <section className="panel"><h2>Submitted reports</h2>{reports.length===0 ? <Empty>No reports submitted yet.</Empty> : reports.map(r => <button className="report-row" key={r.id} onClick={() => viewReport(r)}><span><strong>{r.period_type === 'daily' ? 'Daily' : 'Weekly'} · {r.period_start}</strong><small>{r.summary.sale_count} sales · Edited {stamp(r.edited_at)} by {personName(r.edited_by)}</small></span><b>{money(r.summary.sales_cents - r.expenses.reduce((n,x)=>n+x.amount_cents,0))}</b></button>)}</section>}</>}
  {page === 'payouts' && <PayoutsPage weekly={weekly} selectedWeek={selectedWeek} setSelectedWeek={setSelectedWeek} paidMap={paidMap} ruleMap={ruleMap} busy={busy} markPaid={markPaid} />}
  {page === 'settings' && <><header><div><div className="eyebrow">PAYOUTS</div><h1>Payout Settings</h1><p>Rates apply to the merchandise price before tax and card fees. A flat rate applies once per transaction.</p></div></header><section className="panel"><h2>Employee cuts</h2>{people.filter(p=>p.kind==='employee').map(p => <RuleEditor key={p.user_id} person={p} rule={ruleMap.get(p.user_id)} save={setRule} busy={busy} />)}</section></>}
  {page === 'cameras' && <><header><div><div className="eyebrow">FUTURE INTEGRATION</div><h1>Cameras</h1></div></header><section className="panel"><Empty>Coming soon.</Empty></section></>}
  </main></div>;
}
function Stat({name,value}:{name:string;value:string}) { return <div className="stat"><span>{name}</span><strong>{value}</strong></div>; }
function Empty({children}:{children:React.ReactNode}) { return <div className="empty">{children}</div>; }
function PayoutsPage({weekly,selectedWeek,setSelectedWeek,paidMap,ruleMap,busy,markPaid}:{weekly:Ticket[];selectedWeek:string;setSelectedWeek:(d:string)=>void;paidMap:Map<string,Paid>;ruleMap:Map<string,Rule>;busy:boolean;markPaid:(t:Ticket)=>Promise<void>}) {
  const owed = (ts: Ticket[]) => ts.reduce((n,t) => n + (paidMap.has(t.key) ? 0 : payout(t,ruleMap.get(t.actorId || '')) || 0),0);
  const remaining = (ts: Ticket[]) => {
    const values = ts.map(t => remainingProfit(t,ruleMap.get(t.actorId || ''),paidMap.get(t.key)));
    return { amount: values.some(v => v === null) ? null : values.reduce<number>((n,v) => n + (v || 0),0), missing: values.filter(v => v === null).length };
  };
  const people = [...new Set(weekly.map(t => t.actorId || 'unknown'))];
  const days = [...new Set(weekly.map(t => day(new Date(t.at))))].sort().reverse();
  const weekProfit = remaining(weekly);
  return <>
    <header><div><div className="eyebrow">TEAM EARNINGS</div><h1>Payouts</h1><p>Credit follows the account that rang up each transaction. Cuts use merchandise only.</p></div><label className="date-control">Week of<input type="date" value={selectedWeek} onChange={e => setSelectedWeek(weekStart(e.target.value))} /></label></header>
    <div className="stats"><Stat name="Owed this week" value={money(owed(weekly))} /><Stat name="Transactions" value={String(weekly.length)} /><Stat name="Paid this week" value={money(weekly.reduce((n,t) => n + (paidMap.get(t.key)?.amount_cents || 0),0))} /><Stat name="Remaining profit" value={weekProfit.amount === null ? '—' : money(weekProfit.amount)} /></div>
    {weekProfit.missing > 0 && <p className="hint">Remaining profit unavailable for {weekProfit.missing} transaction(s) with missing cost or payout rule.</p>}
    <section className="panel"><h2>Daily totals</h2>{days.length === 0 && <Empty>No sales this week.</Empty>}{days.map(d => { const ts=weekly.filter(t => day(new Date(t.at)) === d); const profit=remaining(ts); return <div className="daily-row" key={d}><strong>{d}</strong><span>{ts.length} {ts.length === 1 ? 'sale' : 'sales'} · {money(owed(ts))} owed</span><b>Remaining {profit.amount === null ? '—' : money(profit.amount)}</b>{profit.missing > 0 && <small>{profit.missing} unavailable</small>}</div>; })}</section>
    {people.map(id => { const own=weekly.filter(t => (t.actorId || 'unknown') === id); const profit=remaining(own); return <section className="panel" key={id}><div className="section-head"><h2>{own[0]?.actor || 'Unknown employee'}</h2><strong>{money(owed(own))} owed · Remaining {profit.amount === null ? '—' : money(profit.amount)}</strong></div>{own.map(t => { const rule=ruleMap.get(id); const paid=paidMap.get(t.key); const cut=paid?.amount_cents ?? payout(t,rule); const net=remainingProfit(t,rule,paid); return <div className="payout-row" key={t.key}><div><strong>{stamp(t.at)} · {money(t.subtotal)} merchandise</strong><small>{t.lines.map(l => l.sku).join(', ')} · Cost {t.cost === null ? 'not recorded' : money(t.cost)}</small><small>Remaining profit: {net === null ? (cut === null ? payoutIssue(t,rule) : null) || (t.cost === null ? 'Item cost missing' : 'Unavailable') : money(net)}</small></div><span>{cut === null ? payoutIssue(t,rule) : money(cut)}</span>{paid ? <span className="badge">Paid {stamp(paid.paid_at)}</span> : <button disabled={busy || cut === null} onClick={() => void markPaid(t)}>Mark paid</button>}</div>; })}</section>; })}
  </>;
}
function RuleEditor({person,rule,save,busy}:{person:Person;rule?:Rule;save:(id:string,m:Rule['method'],r:number)=>Promise<void>;busy:boolean}) { const [method,setMethod]=useState<Rule['method']>(rule?.method||'percent_sale'); const [rate,setRate]=useState(String(rule?.rate??'')); useEffect(()=>{setMethod(rule?.method||'percent_sale');setRate(String(rule?.rate??''));},[rule]); return <form className="rule-row" onSubmit={e=>{e.preventDefault();void save(person.user_id,method,Number(rate));}}><strong>{person.display_name}</strong><select aria-label={`Cut type for ${person.display_name}`} value={method} onChange={e=>setMethod(e.target.value as Rule['method'])}><option value="percent_sale">Percent of sale</option><option value="flat_ticket">Flat per sale</option><option value="percent_profit">Percent of profit</option></select><label><input type="number" min="0" max={method==='flat_ticket'?undefined:100} step="0.01" required value={rate} onChange={e=>setRate(e.target.value)} />{method==='flat_ticket'?'$':'%'}</label><button disabled={busy}>Save</button></form>; }
