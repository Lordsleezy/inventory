import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient, type Session } from '@supabase/supabase-js';
import { InventoryPage } from './InventoryPage';

const sb = createClient(import.meta.env.VITE_SUPABASE_URL || 'https://zoukmsmbztcuyoslvikp.supabase.co', import.meta.env.VITE_SUPABASE_ANON_KEY || 'missing', { auth: { persistSession: true } });
const zone = 'America/Los_Angeles';
const money = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n / 100);
const moneyEntry = /^\d*(?:\.\d{0,2})?$/;
const cleanMoney = (value: string) => (Number(value === '.' ? 0 : value || 0)).toFixed(2);
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
type Payment = { id: string; employee_id: string; amount_cents: number; paid_at: string; paid_by: string; legacy_ticket_key: string | null };
type Expense = { description: string; category: string; amount_cents: number; needs_reimbursement?: boolean; employee_id?: string };
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
  if (!rule) return null;
  if (rule.method === 'flat_ticket') return Math.round(Number(rule.rate) * 100);
  if (rule.method === 'percent_profit' && t.cost === null) return null;
  const basis = rule.method === 'percent_profit' ? Math.max(0, t.subtotal - (t.cost || 0)) : t.subtotal;
  return Math.round(basis * Number(rule.rate) / 100);
}
function remainingProfit(t: Ticket, rules: Rule[]): number | null {
  const cuts = rules.map(r => payout(t, r));
  return cuts.some(x => x === null) ? null
    : t.subtotal - cuts.reduce<number>((n, x) => n + (x || 0), 0);
}
const check = <T,>(r: { data: T | null; error: { message: string } | null }): T => { if (r.error) throw new Error(r.error.message); return r.data as T; };
async function sales(start: string, end: string) { return tickets(check<Line[]>(await sb.rpc('portal_sales', range(start, end)))); }
async function reportLines(r: { period_start: string; period_end: string }) {
  const lines: Line[] = [];
  for (let offset = 0;; offset += 1000) {
    const batch = check<Line[]>(await sb.rpc('portal_sales', range(r.period_start, r.period_end)).range(offset, offset + 999));
    lines.push(...batch);
    if (batch.length < 1000) return lines;
  }
}
async function storedReports(storeId: string) {
  const reports: Report[] = [];
  for (let offset = 0;; offset += 1000) {
    const batch = check<Report[]>(await sb.from('portal_reports').select('*').eq('store_id', storeId).order('created_at', { ascending: false }).range(offset, offset + 999));
    reports.push(...batch);
    if (batch.length < 1000) return reports;
  }
}
async function storedPayments(storeId: string) {
  const payments: Payment[] = [];
  for (let offset = 0;; offset += 1000) {
    const batch = check<Payment[]>(await sb.from('portal_payout_payments')
      .select('id,employee_id,amount_cents,paid_at,paid_by,legacy_ticket_key')
      .eq('store_id', storeId).order('paid_at', { ascending: false })
      .range(offset, offset + 999));
    payments.push(...batch);
    if (batch.length < 1000) return payments;
  }
}
async function payoutSales() {
  const lines: Line[] = [];
  for (let offset = 0;; offset += 1000) {
    const batch = check<Line[]>(await sb.rpc('portal_payout_sales').range(offset, offset + 999));
    lines.push(...batch);
    if (batch.length < 1000) break;
  }
  return tickets(lines);
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [store, setStore] = useState<string | null>(null);
  const [page, setPage] = useState<'sales' | 'inventory' | 'reports' | 'payouts' | 'settings' | 'cameras'>('sales');
  const [selectedDay, setSelectedDay] = useState(today());
  const [live, setLive] = useState<Ticket[]>([]);
  const [allSales, setAllSales] = useState<Ticket[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [editing, setEditing] = useState<Report | 'daily' | 'weekly' | null>(null);
  const [reportReadOnly, setReportReadOnly] = useState(false);
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);

  useEffect(() => { void sb.auth.getSession().then(({ data }) => setSession(data.session)); const { data } = sb.auth.onAuthStateChange((_e, s) => setSession(s)); return () => data.subscription.unsubscribe(); }, []);
  useEffect(() => { setStore(null); setLive([]); setAllSales([]); setPeople([]); setRules([]); setPayments([]); setReports([]); if (!session) return; void sb.from('portal_admins').select('store_id').eq('user_id', session.user.id).single().then(({ data, error: e }) => { setStore(e ? null : data?.store_id || null); if (e && e.code !== 'PGRST116') setError(e.message); }); }, [session]);
  const loadCommon = useCallback(async () => {
    if (!store) return;
    try {
      const [p, r, a] = await Promise.all([
        sb.rpc('portal_people'), sb.from('portal_payout_rules').select('employee_id,method,rate').eq('store_id', store),
        storedReports(store)
      ]);
      setPeople(check<Person[]>(p)); setRules(check<Rule[]>(r)); setReports(a); setError('');
    } catch (e) { setError(String(e)); }
  }, [store]);
  const loadPayments = useCallback(async () => { if (!store) return; try { setPayments(await storedPayments(store)); } catch (e) { setError(String(e)); } }, [store]);
  const loadSales = useCallback(async () => { if (!store) return; try { setLive(await sales(selectedDay, datePlus(selectedDay, 1))); } catch (e) { setError(String(e)); } }, [store, selectedDay]);
  const loadPayoutSales = useCallback(async () => { if (!store) return; try { setAllSales(await payoutSales()); } catch (e) { setError(String(e)); } }, [store]);
  useEffect(() => { void loadCommon(); }, [loadCommon]);
  useEffect(() => { if (page === 'payouts') void loadPayments(); }, [page, loadPayments]);
  useEffect(() => { void loadSales(); }, [loadSales]);
  useEffect(() => { void loadPayoutSales(); }, [loadPayoutSales]);
  useEffect(() => { if (!store) return; const c = sb.channel(`portal-sales-${store}`).on('postgres_changes', { event: '*', schema: 'public', table: 'sales', filter: `store_id=eq.${store}` }, () => { void loadSales(); void loadPayoutSales(); }).subscribe(); return () => { void sb.removeChannel(c); }; }, [store, loadSales, loadPayoutSales]);
  const ruleMap = useMemo(() => new Map(rules.map(x => [x.employee_id, x])), [rules]);
  const staff = people.filter(p => p.kind === 'employee');
  const activeRules = rules.filter(r => staff.some(p => p.user_id === r.employee_id));
  const defaultReimbursementId = staff.find(p => p.display_name === 'Paul')?.user_id || staff[0]?.user_id || '';
  const personName = (id: string) => people.find(x => x.user_id === id)?.display_name || 'Unknown';
  const sum = (ts: Ticket[]): Summary => { const cuts = ts.flatMap(t => activeRules.map(r => payout(t, r))); return { sales_cents: ts.reduce((n, t) => n + t.subtotal, 0), tax_cents: ts.reduce((n, t) => n + t.tax, 0), card_fee_cents: ts.reduce((n, t) => n + t.fee, 0), collected_cents: ts.reduce((n, t) => n + t.total, 0), cash_cents: ts.reduce((n, t) => n + t.cash, 0), card_cents: ts.reduce((n, t) => n + t.card, 0), other_cents: ts.reduce((n, t) => n + t.total - t.cash - t.card, 0), sale_count: ts.length, payout_cents: cuts.reduce<number>((n, x) => n + (x || 0), 0), payout_unset: cuts.filter(x => x === null).length }; };
  async function run(f: () => Promise<void>) { setBusy(true); setError(''); try { await f(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } }
  async function openReport(type: 'daily' | 'weekly') { const start = type === 'daily' ? selectedDay : weekStart(selectedDay); const summary = sum(await sales(start, datePlus(start, type === 'daily' ? 1 : 7))); setReportDraft({ start, end: datePlus(start, type === 'daily' ? 1 : 7), summary, expenses: [], notes: '' }); setReportReadOnly(false); setEditing(type); }
  const [draft, setReportDraft] = useState<{ start: string; end: string; summary: Summary; expenses: Expense[]; notes: string } | null>(null);
  function viewReport(r: Report, editable = false) { setEditing(r); setReportReadOnly(!editable); setReportDraft({ start: r.period_start, end: r.period_end, summary: r.summary, expenses: r.expenses, notes: r.notes }); }
  async function saveReport() { if (!store || !session || !editing || !draft) return; if (draft.expenses.some(x => !x.description.trim() || !Number.isFinite(x.amount_cents) || x.amount_cents < 0 || (x.needs_reimbursement && !people.some(p => p.kind === 'employee' && p.user_id === x.employee_id)))) { setError('Every expense needs a description, amount, and valid reimbursement recipient.'); return; } await run(async () => { const payload = { store_id: store, period_type: typeof editing === 'string' ? editing : editing.period_type, period_start: draft.start, period_end: draft.end, summary: draft.summary, expenses: draft.expenses, notes: draft.notes, edited_by: session.user.id, created_by: session.user.id }; if (typeof editing === 'string') check(await sb.from('portal_reports').insert(payload)); else check(await sb.from('portal_reports').update({ expenses: payload.expenses, notes: payload.notes, edited_by: session.user.id }).eq('id', editing.id)); setEditing(null); setReportDraft(null); await loadCommon(); }); }
  async function setRule(id: string, method: Rule['method'], rate: number) { if (!store || !session) return; await run(async () => { check(await sb.from('portal_payout_rules').upsert({ store_id: store, employee_id: id, method, rate, updated_at: new Date().toISOString(), updated_by: session.user.id })); await loadCommon(); }); }
  async function recordPayment(employeeId: string, amountCents: number): Promise<boolean> { if (!store || !session) return false; setBusy(true); setError(''); try { const saved = check<Payment>(await sb.from('portal_payout_payments').insert({ store_id: store, employee_id: employeeId, amount_cents: amountCents, paid_by: session.user.id }).select('id,employee_id,amount_cents,paid_at,paid_by,legacy_ticket_key').single()); setPayments(current => [saved, ...current.filter(p => p.id !== saved.id)]); return true; } catch (e) { setError(e instanceof Error ? e.message : String(e)); return false; } finally { setBusy(false); } }
  async function downloadReports(selected: Report[], all: boolean) { await run(async () => { const { downloadReportWorkbook } = await import('./reportExport'); await downloadReportWorkbook(selected, reportLines, personName, all); }); }

  if (!session) return <main className="auth"><div className="login"><div className="brand">OPEN BOX <span>INDUSTRIES</span></div><h1>Floor Admin</h1><p>Sign in to view your store.</p><form onSubmit={e => { e.preventDefault(); void run(async () => { const result = await sb.auth.signInWithPassword({ email, password }); if (result.error) throw result.error; }); }}><label>Email<input type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} required /></label><label>Password<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required /></label><button disabled={busy}>Sign in</button></form>{error && <p className="error">{error}</p>}</div></main>;
  if (!store) return <main className="auth"><div className="login"><h1>Access unavailable</h1><p>This account has no Floor Admin access. Ask an existing administrator to add it.</p><button onClick={() => void sb.auth.signOut()}>Sign out</button>{error && <p className="error">{error}</p>}</div></main>;
  return <div className="app"><aside><div className="brand">OPEN BOX <span>INDUSTRIES</span></div><div className="product">Floor <b>Admin</b></div><nav>{([['sales','Live Sales'],['inventory','Inventory'],['reports','Reports'],['payouts','Payouts'],['settings','Payout Settings'],['cameras','Cameras']] as const).map(([id,label]) => <button className={page === id ? 'active' : ''} key={id} onClick={() => { setPage(id); setEditing(null); }}>{label}</button>)}</nav><div className="account"><small>{session.user.email}</small><button onClick={() => void sb.auth.signOut()}>Sign out</button></div></aside><main className="content">{error && <div className="alert" role="alert">{error}<button onClick={() => setError('')}>Dismiss</button></div>}
  {page === 'sales' && <><header><div><div className="eyebrow">REGISTER ACTIVITY</div><h1>Live Sales</h1><p>Transactions from Floor, updated as sales arrive.</p></div><label className="date-control">Date<input type="date" value={selectedDay} onChange={e => setSelectedDay(e.target.value)} /></label></header><div className="stats"><Stat name="Collected" value={money(sum(live).collected_cents)} /><Stat name="Sales" value={String(live.length)} /><Stat name="Cash" value={money(sum(live).cash_cents)} /><Stat name="Card" value={money(sum(live).card_cents)} /><Stat name="Card fees" value={money(sum(live).card_fee_cents)} /><Stat name="Other / unallocated" value={money(sum(live).other_cents)} /></div><section className="panel"><h2>{selectedDay === today() ? 'Today’s transactions' : `Transactions · ${selectedDay}`}</h2>{live.length === 0 ? <Empty>No sales recorded for this date.</Empty> : <div className="ticket-list">{live.map(t => <div className="ticket" key={t.key}><div className="ticket-top"><strong>{money(t.total)}</strong><span>{stamp(t.at)}</span></div><div className="ticket-items">{t.lines.map(l => <div key={l.id}>{l.qty > 1 ? `${l.qty}× ` : ''}{l.title} <span>· SKU {l.sku}</span></div>)}</div><div className="ticket-bottom"><span>{t.method === 'split' ? (t.lines[0].cash_cents === null ? 'Split amounts unavailable' : `Cash ${money(t.cash)} · Card ${money(t.card)}`) : t.method === 'card' ? `Card ${money(t.card)}` : t.method === 'cash' ? `Cash ${money(t.cash)}` : t.method}{t.fee > 0 && ` · fee ${money(t.fee)}`}</span><span>Rang up by {t.actor}</span></div></div>)}</div>}</section></>}
  {page === 'inventory' && <InventoryPage client={sb} storeId={store} money={money} stamp={stamp} />}
  {page === 'reports' && <><header><div><div className="eyebrow">CLOSEOUTS</div><h1>Reports</h1><p>Save a day or week with expenses and notes.</p></div><div className="report-actions"><label className="date-control">Report date<input type="date" value={selectedDay} onChange={e => setSelectedDay(e.target.value)} /></label><div className="actions"><button onClick={() => void run(() => openReport('daily'))}>Submit Daily Report</button><button className="secondary" onClick={() => void run(() => openReport('weekly'))}>Submit Weekly Report</button>{reports.length > 0 && <button className="secondary" disabled={busy} onClick={() => void downloadReports(reports,true)}>Download all</button>}</div></div></header>{editing && draft ? <section className="panel editor"><div className="section-head"><div><div className="eyebrow">{typeof editing === 'string' ? 'NEW REPORT' : 'SUBMITTED REPORT'}</div><h2>{draft.start} {draft.end !== datePlus(draft.start,1) && `– ${datePlus(draft.end,-1)}`}</h2></div><div className="actions">{reportReadOnly && <button onClick={() => setReportReadOnly(false)}>Edit report</button>}{typeof editing !== 'string' && <button className="secondary" disabled={busy} onClick={() => void downloadReports([editing],false)}>Download</button>}<button className="text-button" onClick={() => { setEditing(null); setReportDraft(null); }}>Close</button></div></div><div className="stats compact"><Stat name="Sales" value={money(draft.summary.sales_cents)} /><Stat name="Card fees" value={money(draft.summary.card_fee_cents)} /><Stat name="Tax" value={money(draft.summary.tax_cents)} /></div><h3>Expenses</h3>{draft.expenses.map((x,i) => <div className="expense-row" key={i}><input disabled={reportReadOnly} aria-label="Description" placeholder="Description" value={x.description} onChange={e => setReportDraft({ ...draft, expenses: draft.expenses.map((v,j) => j===i ? {...v,description:e.target.value} : v) })} /><ExpenseAmount disabled={reportReadOnly} cents={x.amount_cents} onCommit={cents => setReportDraft({ ...draft, expenses: draft.expenses.map((v,j) => j===i ? {...v,amount_cents:cents} : v) })} /><label className="reimburse-check"><input type="checkbox" disabled={reportReadOnly} checked={!!x.needs_reimbursement} onChange={e => setReportDraft({...draft,expenses:draft.expenses.map((v,j)=>j===i ? {...v,needs_reimbursement:e.target.checked,employee_id:e.target.checked ? (v.employee_id || defaultReimbursementId) : undefined} : v)})} />Needs Reimbursement</label>{x.needs_reimbursement && <select disabled={reportReadOnly} aria-label="Reimburse employee" value={x.employee_id || defaultReimbursementId} onChange={e => setReportDraft({...draft,expenses:draft.expenses.map((v,j)=>j===i ? {...v,employee_id:e.target.value} : v)})}>{staff.map(p=><option value={p.user_id} key={p.user_id}>{p.display_name}</option>)}</select>}{!reportReadOnly && <button className="text-button" onClick={() => setReportDraft({...draft,expenses:draft.expenses.filter((_,j)=>j!==i)})}>Remove</button>}</div>)}{!reportReadOnly && <button className="secondary" onClick={() => setReportDraft({...draft,expenses:[...draft.expenses,{description:'',category:'',amount_cents:0}]})}>Add expense</button>}<label className="notes">Notes<textarea disabled={reportReadOnly} rows={4} value={draft.notes} onChange={e => setReportDraft({...draft,notes:e.target.value})} placeholder="Anything to remember about this period" /></label><div className="net"><span>Net merchandise after expenses</span><strong>{money(draft.summary.sales_cents - draft.expenses.reduce((n,x)=>n+x.amount_cents,0))}</strong></div>{!reportReadOnly && <button disabled={busy} onClick={() => void saveReport()}>{typeof editing === 'string' ? 'Submit report' : 'Save edits'}</button>}{typeof editing !== 'string' && <p className="hint">Last edited by {personName(editing.edited_by)} · {stamp(editing.edited_at)}</p>}</section> : <section className="panel"><h2>Submitted reports</h2>{reports.length===0 ? <Empty>No reports submitted yet.</Empty> : reports.map(r => <div className="report-list-row" key={r.id}><button className="report-row" onClick={() => viewReport(r)}><span><strong>{r.period_type === 'daily' ? 'Daily' : 'Weekly'} · {r.period_start}</strong><small>{r.summary.sale_count} sales · Edited {stamp(r.edited_at)} by {personName(r.edited_by)}</small></span><b>{money(r.summary.sales_cents - r.expenses.reduce((n,x)=>n+x.amount_cents,0))}</b></button><button className="secondary" onClick={() => viewReport(r,true)}>Edit</button><button className="secondary" disabled={busy} onClick={() => void downloadReports([r],false)}>Download</button></div>)}</section>}</>}
  {page === 'payouts' && <PayoutsPage allSales={allSales} staff={staff} rules={activeRules} payments={payments} reports={reports} personName={personName} busy={busy} recordPayment={recordPayment} />}
  {page === 'settings' && <><header><div><div className="eyebrow">PAYOUTS</div><h1>Payout Settings</h1><p>Each rule applies to every store sale. Rates use merchandise price before tax and card fees; a flat rate applies once per transaction.</p></div></header><section className="panel"><h2>Employee cuts</h2>{staff.map(p => <RuleEditor key={p.user_id} person={p} rule={ruleMap.get(p.user_id)} save={setRule} busy={busy} />)}</section></>}
  {page === 'cameras' && <><header><div><div className="eyebrow">FUTURE INTEGRATION</div><h1>Cameras</h1></div></header><section className="panel"><Empty>Coming soon.</Empty></section></>}
  </main></div>;
}
function Stat({name,value}:{name:string;value:string}) { return <div className="stat"><span>{name}</span><strong>{value}</strong></div>; }
function Empty({children}:{children:React.ReactNode}) { return <div className="empty">{children}</div>; }
function ExpenseAmount({cents,onCommit,disabled}:{cents:number;onCommit:(cents:number)=>void;disabled:boolean}) {
  const [text,setText] = useState((cents/100).toFixed(2));
  useEffect(() => setText((cents/100).toFixed(2)), [cents]);
  return <input disabled={disabled} aria-label="Amount" type="text" inputMode="decimal" value={text}
    onFocus={e => e.currentTarget.select()}
    onChange={e => { if (moneyEntry.test(e.target.value)) setText(e.target.value); }}
    onBlur={() => { const clean = cleanMoney(text); setText(clean); onCommit(Math.round(Number(clean)*100)); }} />;
}
type LedgerEntry = { at: string; kind: 'sale' | 'reimbursement' | 'payment'; amount: number | null; detail: string; note?: string };
function PayoutsPage({allSales,staff,rules,payments,reports,personName,busy,recordPayment}:{allSales:Ticket[];staff:Person[];rules:Rule[];payments:Payment[];reports:Report[];personName:(id:string)=>string;busy:boolean;recordPayment:(id:string,amount:number)=>Promise<boolean>}) {
  const active = staff.filter(p => rules.some(r => r.employee_id === p.user_id));
  const profits = allSales.map(t => remainingProfit(t,rules));
  const totalProfit = profits.some(x => x === null) ? null : profits.reduce<number>((n,x) => n + (x || 0),0);
  const cards = active.map(person => {
    const rule = rules.find(r => r.employee_id === person.user_id)!;
    const saleEntries: LedgerEntry[] = allSales.map(t => ({
      at: t.at, kind: 'sale', amount: payout(t,rule),
      detail: t.lines.map(l => l.sku).join(', '),
      note: `${money(t.subtotal)} merchandise · ${rule.method === 'flat_ticket' ? money(Math.round(Number(rule.rate)*100)) + ' flat' : rule.rate + '% ' + (rule.method === 'percent_profit' ? 'of profit' : 'of sale')} · Remaining profit ${remainingProfit(t,rules) === null ? 'pending' : money(remainingProfit(t,rules)!)}`
    }));
    const reimbursements: LedgerEntry[] = reports.flatMap(r => r.expenses.filter(e => e.needs_reimbursement && e.employee_id === person.user_id).map(e => ({
      at: r.created_at, kind: 'reimbursement' as const, amount: e.amount_cents,
      detail: e.description, note: `${r.period_type} report · ${r.period_start}`
    })));
    const paid: LedgerEntry[] = payments.filter(p => p.employee_id === person.user_id).map(p => ({
      at: p.paid_at, kind: 'payment' as const, amount: -p.amount_cents,
      detail: `Recorded by ${personName(p.paid_by)}`, note: p.legacy_ticket_key ? 'Previous per-sale payment' : undefined
    }));
    const entries = [...saleEntries,...reimbursements,...paid].sort((a,b)=>b.at.localeCompare(a.at));
    const balance = entries.reduce((n,e)=>n+(e.amount || 0),0);
    return {person,balance,entries};
  });
  const totalOwed = cards.reduce((n,c)=>n+c.balance,0);
  return <>
    <header><div><div className="eyebrow">TEAM EARNINGS</div><h1>Payouts</h1><p>Every rule earns on every store sale. Balances carry forward until paid.</p></div></header>
    <div className="stats payout-stats"><Stat name="Total owed" value={money(totalOwed)} /><Stat name="Remaining profit" value={totalProfit === null ? 'Pending commission' : money(totalProfit)} /></div>
    {cards.length === 0 && <section className="panel"><Empty>No employee payout rules set.</Empty></section>}
    {cards.map(card => <PayoutCard key={card.person.user_id} {...card} busy={busy} recordPayment={recordPayment} />)}
  </>;
}
function PayoutCard({person,balance,entries,busy,recordPayment}:{person:Person;balance:number;entries:LedgerEntry[];busy:boolean;recordPayment:(id:string,amount:number)=>Promise<boolean>}) {
  const [amount,setAmount] = useState('');
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const cents = Math.round(Number(amount)*100);
    if (!Number.isFinite(cents) || cents <= 0) return;
    if (cents > balance && !window.confirm(`This payment exceeds ${person.display_name}'s ${money(balance)} balance. Record ${money(cents)} anyway?`)) return;
    if (await recordPayment(person.user_id,cents)) setAmount('');
  }
  return <section className="panel payout-card"><div className="payout-card-top"><div><h2>{person.display_name}</h2><strong>{money(balance)} owed</strong></div><form onSubmit={e=>void submit(e)}><label>Payment amount<input type="text" inputMode="decimal" value={amount} onChange={e=>{ if (moneyEntry.test(e.target.value)) setAmount(e.target.value); }} onBlur={() => { if (amount) setAmount(cleanMoney(amount)); }} required /></label><button disabled={busy || !amount}>Paid</button></form></div><details><summary>Balance breakdown ({entries.length})</summary><div className="ledger-list">{entries.map((e,i)=><div className="ledger-row" key={i}><div><strong>{e.kind === 'sale' ? 'Sale' : e.kind === 'payment' ? 'Payment' : 'Reimbursement'} · {stamp(e.at)}</strong><span>{e.detail}</span>{e.note && <small>{e.note}</small>}</div><b>{e.amount === null ? 'Cost needed' : (e.amount < 0 ? '−' : '+') + money(Math.abs(e.amount))}</b></div>)}</div></details></section>;
}function RuleEditor({person,rule,save,busy}:{person:Person;rule?:Rule;save:(id:string,m:Rule['method'],r:number)=>Promise<void>;busy:boolean}) { const [method,setMethod]=useState<Rule['method']>(rule?.method||'percent_sale'); const [rate,setRate]=useState(String(rule?.rate??'')); useEffect(()=>{setMethod(rule?.method||'percent_sale');setRate(String(rule?.rate??''));},[rule]); return <form className="rule-row" onSubmit={e=>{e.preventDefault();void save(person.user_id,method,Number(rate));}}><strong>{person.display_name}</strong><select aria-label={`Cut type for ${person.display_name}`} value={method} onChange={e=>setMethod(e.target.value as Rule['method'])}><option value="percent_sale">Percent of sale</option><option value="flat_ticket">Flat per sale</option><option value="percent_profit">Percent of profit</option></select><label><input type={method==='flat_ticket'?'text':'number'} inputMode="decimal" min={method==='flat_ticket'?undefined:0} max={method==='flat_ticket'?undefined:100} step="0.01" required value={rate} onChange={e=>{ if (method!=='flat_ticket' || moneyEntry.test(e.target.value)) setRate(e.target.value); }} onBlur={() => { if (method==='flat_ticket' && rate) setRate(cleanMoney(rate)); }} />{method==='flat_ticket'?'$':'%'}</label><button disabled={busy}>Save</button></form>; }
