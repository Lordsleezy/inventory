import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { floorCloud, loadStaffSession, staffSignInAttempts, type StaffSession } from '@floor/cloud';
import { InventoryPage } from './InventoryPage';
import { OrdersPage } from './OrdersPage';
import { ReceiptsPage } from './ReceiptsPage';
import { RegisterPage } from './RegisterPage';
import { WithdrawalsPage } from './WithdrawalsPage';
import { ManifestsPage } from './ManifestsPage';
import { LocationsPage } from './LocationsPage';
import { InsightsPage } from './InsightsPage';
import { LogsPage } from './LogsPage';
import { ClientErrorReporter } from './clientLog';
import { inStoreOverrideRate, isOnline, NO_ONLINE, payout, profit, remainingProfit, reportProfitCents, type CommissionOverride, type OnlineCfg, type Rule } from './payouts';
import { CommissionOverrideControls, CommissionOverrideMark } from './CommissionOverride';
import { ExpensesPage, type Expense as StoreExpense } from './ExpensesPage';
import { ConnectionsPage } from './ConnectionsPage';
import { AmazonPage } from './AmazonPage';
import { ChannelListingPage } from './ChannelListingPage';
import { OnlinePage } from './OnlinePage';
import { ReportsPage } from './ReportsPage';
import { SettingsPage } from './SettingsPage';
import { AssociateSettings } from './AssociateSettings';
import { type MainPage, type NavState, defaultNavState, parseNavFromLocation, writeNavToLocation } from './navigation';
import { formatLabelWithPending, parseShipCostSource } from './shipCostSource';
import { errText } from './errText';
import { isStandaloneApp, shouldShowInstallGate } from './appMode/isAppMode';
import { InstallGate } from './appMode/InstallGate';
import { AppModeShell } from './appMode/AppModeShell';
import { NeedsAttentionPanel } from './NeedsAttentionPanel';
import { replacementAddback, replacementLine, type Disposition } from './dispositions';
import { setReplacementRows, useReplacementsForSale } from './replacementsStore';

/** Store associates (Jacob / clock staff): Inventory, Register, Settings only. */
const ASSOCIATE_PAGES: MainPage[] = ['register', 'inventory', 'settings'];

const sb = floorCloud();
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

type Line = { id: number; ticket_key: string; sku: string; title: string; qty: number; sold_at: string; price_cents: number; tax_cents: number; card_fee_cents: number; cost_cents: number | null; payment_method: string | null; cash_cents: number | null; card_cents: number | null; actor_id: string | null; actor_name: string; channel: string; receipt_no: string; list_price_cents: number | null; override_price_cents: number | null; override_reason: string | null; override_by_name: string | null; ebay_fee_cents?: number | null; baked_ship_cents?: number | null; cost_source?: string | null; channel_fee_cents?: number | null; fee_source?: string | null; ship_cost_cents?: number | null; ship_cost_source?: string | null; processing_fee_cents?: number | null; processing_fee_source?: string | null; tax_remitted_by?: string | null; tax_collected_cents?: number | null; tax_owed_cents?: number | null; ask_cents?: number | null; variance_cents?: number | null; profit_cents?: number | null; shipping_cents?: number | null };
type VoidedLine = {
  id: number; ticket_key: string; sku: string; title: string; qty: number;
  sold_at: string; voided_at: string; void_reason: string | null;
  price_cents: number; tax_cents: number; card_fee_cents: number;
  cost_cents: number | null; payment_method: string | null;
  cash_cents: number | null; card_cents: number | null;
  actor_id: string | null; actor_name: string; channel: string; receipt_no: string | null;
  channel_fee_cents: number | null; ship_cost_cents: number | null;
  processing_fee_cents: number | null; profit_cents: number | null;
  shipping_cents: number | null; order_no: string | null; buyer_name: string | null;
};
type Ticket = { key: string; at: string; lines: Line[]; subtotal: number; tax: number; fee: number; total: number; cash: number; card: number; method: string; actorId: string | null; actor: string; cost: number | null; channel: string; ebayFeeCents: number; bakedShipCents: number; feeCents: number; shipCostCents: number; pendingLabelCreditCents: number; processingFeeCents: number; shippingCents: number; costEstimated: boolean; taxOwedCents: number; taxCollectedCents: number; varianceCents: number | null; profitCents: number | null; commissionOverride: CommissionOverride | null; needsMatch?: boolean; webOrderId?: string; orderNo?: string | null; buyerName?: string | null };
type UnmatchedOrder = {
  id: string; ticket_key: string; order_no: string | null; sku: string; title: string;
  channel: string; at: string; price_cents: number; tax_cents: number; shipping_cents: number;
  total_cents: number; buyer_name: string | null; buyer_email: string | null;
  match_status: string | null; marketplace_url?: string | null;
};
type OverrideMap = Map<string, CommissionOverride>;
/** `${ticket_key}|${employee_id}` → frozen commission cents (null = waiting on cost). */
type FrozenMap = Map<string, number | null>;
type Person = { user_id: string; display_name: string; kind: string };
type Payment = { id: string; employee_id: string; amount_cents: number; paid_at: string; paid_by: string; legacy_ticket_key: string | null; note: string | null };
type PayoutAdjustment = {
  id: string; employee_id: string; amount_cents: number; reason: string;
  return_id: string | null; replacement_id?: string | null; sale_id: number | null; ticket_key: string | null;
  sale_commission_cents: number | null; created_at: string;
};
type Expense = { description: string; category: string; amount_cents: number; needs_reimbursement?: boolean; employee_id?: string };
type Summary = { sales_cents: number; tax_cents: number; card_fee_cents: number; collected_cents: number; cash_cents: number; card_cents: number; other_cents: number; sale_count: number; payout_cents: number; payout_unset: number };
type Report = { id: string; period_type: 'daily' | 'weekly'; period_start: string; period_end: string; summary: Summary; expenses: Expense[]; notes: string; created_at: string; created_by: string; edited_at: string; edited_by: string };

function SaleItem({ line }: { line: Line }) {
  const replacements = useReplacementsForSale(line.id);
  const overridden = line.list_price_cents !== null && line.override_price_cents !== null
    && line.list_price_cents !== line.override_price_cents;
  return <div>{line.qty > 1 ? `${line.qty}× ` : ''}{line.title} <span>· SKU {line.sku}</span>
    {overridden && <small className="sale-override">Price override: {money(line.list_price_cents!)} → {money(line.override_price_cents!)}
      {line.override_by_name && ` · ${line.override_by_name}`}{line.override_reason && ` · ${line.override_reason}`}</small>}
    {line.variance_cents != null && line.variance_cents !== 0 && !overridden &&
      <small className="sale-override">Sold {line.variance_cents > 0 ? '+' : '−'}{money(Math.abs(line.variance_cents))} vs ask</small>}
    {replacements?.map(d => <small className="sale-override" key={d.id}>{replacementLine(d, money, stamp)}</small>)}
    {line.cost_source === 'default' && <small className="sale-override">cost: category default</small>}
    {line.cost_source === 'collectible' && <small className="sale-override">collectible · $0 cost</small>}
    {line.fee_source === 'estimated' && (line.channel_fee_cents ?? 0) > 0 && <small className="sale-override">{money(line.channel_fee_cents!)} est. channel fee</small>}
  </div>;
}

function tickets(lines: Line[], overrides: OverrideMap = new Map()): Ticket[] {
  const map = new Map<string, Ticket>();
  for (const l of lines) {
    let t = map.get(l.ticket_key);
    if (!t) { t = { key: l.ticket_key, at: l.sold_at, lines: [], subtotal: 0, tax: 0, fee: 0, total: 0, cash: 0, card: 0, method: l.payment_method || 'other', actorId: l.actor_id, actor: l.actor_name, cost: 0, channel: l.channel, ebayFeeCents: 0, bakedShipCents: 0, feeCents: 0, shipCostCents: 0, pendingLabelCreditCents: 0, processingFeeCents: 0, shippingCents: 0, costEstimated: false, taxOwedCents: 0, taxCollectedCents: 0, varianceCents: null, profitCents: 0, commissionOverride: overrides.get(l.ticket_key) || null }; map.set(l.ticket_key, t); }
    t.lines.push(l); t.subtotal += l.price_cents; t.tax += l.tax_cents; t.fee += l.card_fee_cents;
    t.ebayFeeCents += l.ebay_fee_cents || 0; t.bakedShipCents += l.baked_ship_cents || 0;
    t.feeCents += l.channel_fee_cents ?? l.ebay_fee_cents ?? 0;
    t.shipCostCents += l.ship_cost_cents ?? l.baked_ship_cents ?? 0;
    t.pendingLabelCreditCents += parseShipCostSource(l.ship_cost_source).pendingCreditCents;
    t.processingFeeCents += l.processing_fee_cents || 0;
    t.shippingCents += l.shipping_cents || 0;
    t.taxOwedCents += l.tax_owed_cents ?? l.tax_cents;
    t.taxCollectedCents += l.tax_collected_cents ?? l.tax_cents;
    if (l.cost_source === 'default') t.costEstimated = true;
    if (l.variance_cents !== null && l.variance_cents !== undefined) t.varianceCents = (t.varianceCents ?? 0) + l.variance_cents;
    if (l.cost_cents === null) t.cost = null;
    else if (t.cost !== null) t.cost += l.cost_cents;
  }
  for (const t of map.values()) {
    t.total = t.subtotal + t.tax + t.fee;
    t.profitCents = t.cost === null ? null : t.subtotal + t.shippingCents - t.feeCents - t.shipCostCents
      - t.processingFeeCents - t.cost;
    const x = t.lines[0];
    t.cash = x.cash_cents ?? (t.method === 'cash' ? t.total : 0);
    t.card = x.card_cents ?? (t.method === 'card' ? t.total : 0);
  }
  return [...map.values()].sort((a, b) => b.at.localeCompare(a.at));
}
const check = <T,>(r: { data: T | null; error: { message: string } | null }): T => { if (r.error) throw new Error(r.error.message); return r.data as T; };
async function sales(start: string, end: string, overrides: OverrideMap = new Map()) { return tickets(check<Line[]>(await sb.rpc('portal_sales', range(start, end))), overrides); }
function unmatchedTickets(rows: UnmatchedOrder[]): Ticket[] {
  return (rows || []).map(o => ({
    key: o.ticket_key || `unmatched:${o.id}`,
    at: o.at,
    lines: [{
      id: 0,
      ticket_key: o.ticket_key || `unmatched:${o.id}`,
      sku: o.sku || 'UNMATCHED',
      title: o.title || `${o.channel || 'marketplace'} sale`,
      qty: 1,
      sold_at: o.at,
      price_cents: o.price_cents || 0,
      tax_cents: o.tax_cents || 0,
      card_fee_cents: 0,
      cost_cents: null,
      payment_method: 'marketplace',
      cash_cents: null,
      card_cents: null,
      actor_id: null,
      actor_name: 'Online',
      channel: o.channel,
      receipt_no: o.order_no || 'UNMATCHED',
      list_price_cents: null,
      override_price_cents: null,
      override_reason: null,
      override_by_name: null,
      profit_cents: null,
      shipping_cents: o.shipping_cents || 0,
    }],
    subtotal: o.price_cents || 0,
    tax: o.tax_cents || 0,
    fee: 0,
    total: o.total_cents || o.price_cents || 0,
    cash: 0,
    card: 0,
    method: 'marketplace',
    actorId: null,
    actor: 'Online',
    cost: null,
    channel: o.channel,
    ebayFeeCents: 0,
    bakedShipCents: 0,
    feeCents: 0,
    shipCostCents: 0,
    pendingLabelCreditCents: 0,
    processingFeeCents: 0,
    shippingCents: o.shipping_cents || 0,
    costEstimated: false,
    taxOwedCents: o.tax_cents || 0,
    taxCollectedCents: o.tax_cents || 0,
    varianceCents: null,
    profitCents: null,
    commissionOverride: null,
    needsMatch: true,
    webOrderId: o.id,
    orderNo: o.order_no,
    buyerName: o.buyer_name,
  })).sort((a, b) => b.at.localeCompare(a.at));
}
async function unmatchedOrders(start: string, end: string) {
  try {
    return unmatchedTickets(check<UnmatchedOrder[]>(await sb.rpc('portal_unmatched_orders', range(start, end))));
  } catch (e) {
    // Older DBs without the RPC should still load matched Live Sales.
    if (/portal_unmatched_orders|PGRST202|404|does not exist/i.test(String(e))) return [];
    throw e;
  }
}
async function voidedSales(start: string, end: string) {
  return check<VoidedLine[]>(await sb.rpc('portal_voided_sales', range(start, end)));
}
async function reportLines(r: { period_start: string; period_end: string }) {
  const lines: Line[] = [];
  for (let offset = 0;; offset += 1000) {
    const batch = check<Line[]>(await sb.rpc('portal_sales', range(r.period_start, r.period_end)).range(offset, offset + 999));
    lines.push(...batch);
    if (batch.length < 1000) return lines;
  }
}
async function storedCommissionOverrides(storeId: string): Promise<OverrideMap> {
  const map: OverrideMap = new Map();
  try {
    for (let offset = 0;; offset += 1000) {
      const res = await sb.from('portal_commission_overrides')
        .select('ticket_key,paul_pct,jacob_pct')
        .eq('store_id', storeId)
        .range(offset, offset + 999);
      // Migration not applied yet / schema cache miss — don't block Live Sales or Payouts.
      if (res.error) {
        const msg = res.error.message || '';
        if (/portal_commission_overrides|schema cache|does not exist|Could not find the table/i.test(msg)) {
          return map;
        }
        throw new Error(msg);
      }
      const batch = (res.data || []) as { ticket_key: string; paul_pct: number; jacob_pct: number }[];
      for (const row of batch) {
        map.set(row.ticket_key, { paulPct: Number(row.paul_pct), jacobPct: Number(row.jacob_pct) });
      }
      if (batch.length < 1000) return map;
    }
  } catch (e) {
    const msg = errText(e);
    if (/portal_commission_overrides|schema cache|does not exist|Could not find the table/i.test(msg)) {
      return map;
    }
    throw e;
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
async function frozenCommissions(): Promise<FrozenMap> {
  const map: FrozenMap = new Map();
  for (let offset = 0;; offset += 1000) {
    const res = await sb.rpc('portal_payout_commissions').range(offset, offset + 999);
    // Before the payout migration is applied the RPC does not exist: fall back to browser math.
    if (res.error) { if (/portal_payout_commissions|PGRST202|404|does not exist/i.test(res.error.message)) return map; throw new Error(res.error.message); }
    const batch = (res.data || []) as { ticket_key: string; employee_id: string; amount_cents: number | null }[];
    for (const row of batch) map.set(`${row.ticket_key}|${row.employee_id}`, row.amount_cents);
    if (batch.length < 1000) return map;
  }
}
async function storedPayments(storeId: string) {
  const payments: Payment[] = [];
  for (let offset = 0;; offset += 1000) {
    const batch = check<Payment[]>(await sb.from('portal_payout_payments')
      .select('id,employee_id,amount_cents,paid_at,paid_by,legacy_ticket_key,note')
      .eq('store_id', storeId).is('voided_at', null).order('paid_at', { ascending: false })
      .range(offset, offset + 999));
    payments.push(...batch);
    if (batch.length < 1000) return payments;
  }
}
async function storedPayoutAdjustments(): Promise<PayoutAdjustment[]> {
  try {
    const rows = check<PayoutAdjustment[]>(await sb.rpc('portal_payout_adjustments'));
    return rows || [];
  } catch (e) {
    const msg = errText(e);
    if (/portal_payout_adjustments|schema cache|does not exist|PGRST202|404/i.test(msg)) return [];
    throw e;
  }
}
async function payoutSales(overrides: OverrideMap = new Map()) {
  const lines: Line[] = [];
  for (let offset = 0;; offset += 1000) {
    const batch = check<Line[]>(await sb.rpc('portal_payout_sales').range(offset, offset + 999));
    lines.push(...batch);
    if (batch.length < 1000) break;
  }
  return tickets(lines, overrides);
}
/** Same window as Reports → Profit → All time (ChannelReportPage). */
const PROFIT_ALL_TIME_START = '2020-01-01';
function profitReportEndDate() {
  return new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}
/** eBay insertion and store subscription. Not attached to a sale, so payout sales omit them. */
async function ebayInsertionFees(storeId: string) {
  const end = profitReportEndDate();
  let total = 0;
  for (let offset = 0;; offset += 1000) {
    const batch = check<{ amount_cents: number | null }[]>(await sb.from('portal_expenses')
      .select('amount_cents')
      .eq('store_id', storeId)
      .eq('source', 'ebay')
      .is('voided_at', null)
      .gte('spent_on', PROFIT_ALL_TIME_START)
      .lt('spent_on', end)
      .range(offset, offset + 999));
    total += batch.reduce((n, row) => n + (row.amount_cents || 0), 0);
    if (batch.length < 1000) return total;
  }
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [store, setStore] = useState<string | null>(null);
  const [fullAccess, setFullAccess] = useState(false);
  const [staffSession, setStaffSession] = useState<StaffSession | null>(null);
  const [accessReady, setAccessReady] = useState(false);
  const [nav, setNav] = useState<NavState>(() => parseNavFromLocation());
  const page = nav.page;
  const go = (patch: Partial<NavState>) => setNav(n => ({ ...n, ...patch }));
  const [selectedDay, setSelectedDay] = useState(today());
  const [salesScope, setSalesScope] = useState<'all' | 'instore' | 'online' | 'voided'>('all');
  const [live, setLive] = useState<Ticket[]>([]);
  const [voided, setVoided] = useState<VoidedLine[]>([]);
  const [allSales, setAllSales] = useState<Ticket[]>([]);
  const [ebayFees, setEbayFees] = useState(0);
  const [people, setPeople] = useState<Person[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [payoutAdjustments, setPayoutAdjustments] = useState<PayoutAdjustment[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [reportsLoading, setReportsLoading] = useState(false);
  const [expenses, setExpenses] = useState<StoreExpense[]>([]);
  const [onlineCfg, setOnlineCfg] = useState<OnlineCfg>(NO_ONLINE);
  const [commissionOverrides, setCommissionOverrides] = useState<OverrideMap>(new Map());
  const [frozen, setFrozen] = useState<FrozenMap>(new Map());
  const [editing, setEditing] = useState<Report | 'daily' | 'weekly' | null>(null);
  const [reportReadOnly, setReportReadOnly] = useState(false);
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(() => {
    try { return localStorage.getItem('floor_admin_nav_collapsed') === '1'; } catch { return false; }
  });
  /** Hover expands the retracted rail until the user clicks «/» (pinned until next login). */
  const [navHoverPeek, setNavHoverPeek] = useState(() => {
    try { return !window.matchMedia('(pointer: coarse)').matches; } catch { return true; }
  });
  const [navHoverOpen, setNavHoverOpen] = useState(false);
  const [darkMode, setDarkMode] = useState(() => {
    try { return localStorage.getItem('floor_admin_dark') === '1'; } catch { return false; }
  });
  const [navGroup, setNavGroup] = useState<'reports' | 'inventory' | 'online' | null>(null);
  const [showInstallGate, setShowInstallGate] = useState(() => shouldShowInstallGate());
  // Re-check on mount so store-phone Chrome / kiosk / persisted app mode win over the install coach.
  const [standaloneApp, setStandaloneApp] = useState(() => isStandaloneApp());
  useEffect(() => {
    if (isStandaloneApp()) setStandaloneApp(true);
  }, []);
  useEffect(() => {
    try { localStorage.setItem('floor_admin_nav_collapsed', navCollapsed ? '1' : '0'); } catch { /* ignore */ }
  }, [navCollapsed]);
  useEffect(() => {
    try { localStorage.setItem('floor_admin_dark', darkMode ? '1' : '0'); } catch { /* ignore */ }
    document.documentElement.classList.toggle('dark', darkMode);
    return () => { document.documentElement.classList.remove('dark'); };
  }, [darkMode]);

  useEffect(() => {
    void sb.auth.getSession().then(({ data }) => setSession((current) => current ?? data.session));
    const { data } = sb.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === 'SIGNED_IN') {
        let narrow = false;
        try { narrow = window.matchMedia('(max-width: 900px)').matches; } catch { /* ignore */ }
        if (!narrow) {
          setNavCollapsed(true);
          let peek = true;
          try { peek = !window.matchMedia('(pointer: coarse)').matches; } catch { /* ignore */ }
          setNavHoverPeek(peek);
        } else {
          setNavCollapsed(false);
          setNavHoverPeek(false);
        }
        setNavHoverOpen(false);
      }
    });
    return () => data.subscription.unsubscribe();
  }, []);
  useEffect(() => { writeNavToLocation(nav); }, [nav]);
  useEffect(() => {
    const onPop = () => setNav(parseNavFromLocation());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  useEffect(() => {
    if (page === 'reports') setNavGroup('reports');
    else if (page === 'inventory') setNavGroup('inventory');
    else if (page === 'online') setNavGroup('online');
    if (page === 'register') {
      // Desktop: collapse sidebar for POS. Mobile uses the hamburger drawer — keep labels visible.
      let narrow = false;
      try { narrow = window.matchMedia('(max-width: 900px)').matches; } catch { /* ignore */ }
      if (!narrow) {
        setNavCollapsed(true);
        setNavHoverOpen(false);
      }
    }
  }, [page]);
  useEffect(() => {
    document.body.classList.toggle('menu-lock', menuOpen);
    return () => document.body.classList.remove('menu-lock');
  }, [menuOpen]);
  useEffect(() => {
    // Desktop collapse bit is sticky in localStorage; on phones it blanked the drawer (labels display:none).
    const mq = window.matchMedia('(max-width: 900px)');
    const sync = () => {
      if (mq.matches) {
        setNavCollapsed(false);
        setNavHoverOpen(false);
        setNavHoverPeek(false);
      }
    };
    sync();
    mq.addEventListener?.('change', sync);
    return () => mq.removeEventListener?.('change', sync);
  }, []);
  const closeMenu = () => setMenuOpen(false);
  const goNav = (patch: Partial<NavState>) => {
    go(patch);
    setEditing(null);
    closeMenu();
    if (patch.page === 'register') {
      let narrow = false;
      try { narrow = window.matchMedia('(max-width: 900px)').matches; } catch { /* ignore */ }
      if (!narrow) {
        setNavCollapsed(true);
        setNavHoverOpen(false);
      }
    }
  };
  const pinNavManual = () => {
    setNavHoverPeek(false);
    setNavHoverOpen(false);
    setNavCollapsed(c => !c);
  };
  const userId = session?.user.id;
  useEffect(() => {
    setStore(null);
    setFullAccess(false);
    setStaffSession(null);
    setAccessReady(false);
    setLive([]); setAllSales([]); setPeople([]); setRules([]); setPayments([]); setReports([]); setExpenses([]); setOnlineCfg(NO_ONLINE); setCommissionOverrides(new Map());
    if (!userId) return;
    let alive = true;
    void (async () => {
      try {
        const [{ data: portal, error: portalErr }, staff] = await Promise.all([
          sb.from('portal_admins').select('store_id').eq('user_id', userId).maybeSingle(),
          loadStaffSession(),
        ]);
        if (!alive) return;
        if (portalErr && portalErr.code !== 'PGRST116') setError(portalErr.message);
        const portalStore = portal?.store_id || null;
        const staffStore = staff?.storeId || null;
        const isManager = staff?.role === 'owner' || staff?.role === 'manager';
        const nextFull = Boolean(portalStore) || Boolean(isManager);
        const nextStore = portalStore || staffStore;
        if (!nextStore) {
          setStore(null);
          setFullAccess(false);
          setStaffSession(null);
          return;
        }
        setStore(nextStore);
        setFullAccess(nextFull);
        setStaffSession(staff);
        if (!nextFull && !ASSOCIATE_PAGES.includes(parseNavFromLocation().page)) {
          setNav(defaultNavState('register'));
        }
      } catch (e) {
        if (alive) setError(errText(e));
      } finally {
        if (alive) setAccessReady(true);
      }
    })();
    return () => { alive = false; };
  }, [userId]);
  useEffect(() => {
    if (!accessReady || fullAccess) return;
    if (!ASSOCIATE_PAGES.includes(page)) setNav(defaultNavState('register'));
  }, [accessReady, fullAccess, page]);
  const loadCommon = useCallback(async () => {
    if (!store) return;
    try {
      const [p, r, a, x, c, sp, sr] = await Promise.all([
        sb.rpc('portal_people'), sb.from('portal_payout_rules').select('employee_id,method,rate').eq('store_id', store),
        storedReports(store),
        sb.from('portal_expenses').select('*').eq('store_id', store).order('spent_on', { ascending: false }).order('created_at', { ascending: false }).limit(500),
        sb.rpc('portal_payout_config'),
        sb.from('store_payout_people').select('slot,employee_id').eq('store_id', store),
        sb.from('store_payout_sku_rates').select('sku,employee_id,rate').eq('store_id', store),
      ]);
      setPeople(check<Person[]>(p)); setRules(check<Rule[]>(r)); setReports(a); setExpenses(check<StoreExpense[]>(x));
      const cfg = check<{ online_channels: string[]; online_payout_pct: number; online_payout_employee_id: string | null }>(c);
      const slots = Object.fromEntries(((sp.data || []) as { slot: string; employee_id: string }[]).map(x => [x.slot, x.employee_id]));
      const skuRates: Record<string, Record<string, number>> = {};
      for (const x of (sr.data || []) as { sku: string; employee_id: string; rate: number }[]) (skuRates[x.sku] ||= {})[x.employee_id] = Number(x.rate);
      setOnlineCfg({ channels: (cfg.online_channels || []).map(s => String(s).toLowerCase()), pct: Number(cfg.online_payout_pct) || 0, employeeId: cfg.online_payout_employee_id, slots, skuRates });
      setError('');
      // Non-fatal: shows "Replacement sent" on the original sale rows.
      void Promise.resolve(sb.rpc('portal_dispositions_list', { p_kind: 'replacement' })).then(({ data, error: e }) => { if (!e && Array.isArray(data)) setReplacementRows(data as Disposition[]); });
    } catch (e) { setError(errText(e)); }
  }, [store]);
  const loadPayments = useCallback(async () => {
    if (!store) return;
    try {
      const [pays, adjs] = await Promise.all([storedPayments(store), storedPayoutAdjustments()]);
      setPayments(pays);
      setPayoutAdjustments(adjs);
    } catch (e) { setError(errText(e)); }
  }, [store]);
  const loadCommissionOverrides = useCallback(async () => {
    if (!store) return;
    try { setCommissionOverrides(await storedCommissionOverrides(store)); } catch (e) { setError(errText(e)); }
  }, [store]);
  const loadSales = useCallback(async () => {
    if (!store) return;
    try {
      const overrides = await storedCommissionOverrides(store);
      setCommissionOverrides(overrides);
      const end = datePlus(selectedDay, 1);
      const [rows, pending] = await Promise.all([
        sales(selectedDay, end, overrides),
        unmatchedOrders(selectedDay, end),
      ]);
      // Always keep the selected calendar day (default: today LA). Do not jump to
      // yesterday when today is empty — that made Live Sales show the prior day.
      setLive([...rows, ...pending].sort((a, b) => b.at.localeCompare(a.at)));
    } catch (e) { setError(errText(e)); }
  }, [store, selectedDay]);
  const loadVoided = useCallback(async () => {
    if (!store) return;
    try {
      setVoided(await voidedSales(selectedDay, datePlus(selectedDay, 1)));
    } catch (e) { setError(errText(e)); }
  }, [store, selectedDay]);
  const loadPayoutSales = useCallback(async () => {
    if (!store) return;
    try {
      const overrides = await storedCommissionOverrides(store);
      setCommissionOverrides(overrides);
      const [salesRows, fees, frozen] = await Promise.all([payoutSales(overrides), ebayInsertionFees(store), frozenCommissions()]);
      setAllSales(salesRows);
      setFrozen(frozen);
      setEbayFees(fees);
    } catch (e) { setError(errText(e)); }
  }, [store]);
  const setTicketOverride = useCallback((ticketKey: string, next: CommissionOverride | null) => {
    void frozenCommissions().then(setFrozen).catch(() => undefined);
    setCommissionOverrides(prev => {
      const map = new Map(prev);
      if (next) map.set(ticketKey, next); else map.delete(ticketKey);
      return map;
    });
    setLive(list => list.map(t => t.key === ticketKey ? { ...t, commissionOverride: next } : t));
    setAllSales(list => list.map(t => t.key === ticketKey ? { ...t, commissionOverride: next } : t));
  }, []);
  useEffect(() => { if (page === 'reports' || page === 'settings') void loadCommon(); }, [page, loadCommon]);
  useEffect(() => { if (page === 'reports' && nav.reportTab === 'payouts') void loadPayments(); }, [page, nav.reportTab, loadPayments]);
  useEffect(() => { if (page === 'sales' || (page === 'reports' && nav.reportTab === 'profit')) void loadSales(); }, [page, nav.reportTab, loadSales]);
  useEffect(() => { if (page === 'sales' && salesScope === 'voided') void loadVoided(); }, [page, salesScope, loadVoided]);
  useEffect(() => { if (page === 'reports' && nav.reportTab === 'payouts') void loadPayoutSales(); }, [page, nav.reportTab, loadPayoutSales]);
  useEffect(() => { if (standaloneApp && fullAccess) void loadCommon(); }, [standaloneApp, fullAccess, loadCommon]);
  useEffect(() => {
    if (!standaloneApp || !fullAccess) return;
    if (nav.reportTab === 'payouts') { void loadPayments(); void loadPayoutSales(); }
    if (nav.reportTab === 'profit') void loadSales();
  }, [standaloneApp, fullAccess, nav.reportTab, loadPayments, loadPayoutSales, loadSales]);

  useEffect(() => { if (page === 'orders' && fullAccess) void loadCommissionOverrides(); }, [page, fullAccess, loadCommissionOverrides]);
  useEffect(() => { if (page === 'orders' && fullAccess) void loadCommon(); }, [page, fullAccess, loadCommon]);
  useEffect(() => {
    if (!store || !['sales', 'reports'].includes(page)) return;
    const refresh = () => {
      if (page === 'sales' || (page === 'reports' && nav.reportTab === 'profit')) void loadSales();
      if (page === 'sales' && salesScope === 'voided') void loadVoided();
      if (page === 'reports' && nav.reportTab === 'payouts') void loadPayoutSales();
    };
    const c = sb.channel(`portal-sales-${store}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sales', filter: `store_id=eq.${store}` }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'web_orders', filter: `store_id=eq.${store}` }, refresh)
      .subscribe();
    return () => { void sb.removeChannel(c); };
  }, [store, page, nav.reportTab, salesScope, loadSales, loadVoided, loadPayoutSales]);
  async function matchLiveSku(t: Ticket) {
    if (!t.webOrderId || !t.needsMatch) return;
    const sku = window.prompt(
      `Link this ${(t.channel || 'marketplace').toUpperCase()} sale to a Floor SKU.\n\n${t.lines[0]?.title || 'Sale'}${t.orderNo ? ` · ${t.orderNo}` : ''}`,
      t.lines[0]?.sku === 'UNMATCHED' ? '' : (t.lines[0]?.sku || ''),
    );
    if (sku == null || !sku.trim()) return;
    setBusy(true); setError('');
    try {
      const { error: e } = await sb.rpc('portal_match_web_order', { p_order: t.webOrderId, p_sku: sku.trim() });
      if (e) throw e;
      await loadSales();
    } catch (e) { setError(errText(e)); }
    finally { setBusy(false); }
  }
  const ruleMap = useMemo(() => new Map(rules.map(x => [x.employee_id, x])), [rules]);
  const staff = people.filter(p => p.kind === 'employee');
  const activeRules = (() => {
    const base = rules.filter(r => staff.some(p => p.user_id === r.employee_id));
    // The online payout recipient always gets a card, even without an in-store rule.
    const rid = onlineCfg.employeeId;
    return rid && staff.some(p => p.user_id === rid) && !base.some(r => r.employee_id === rid) ? [...base, { employee_id: rid, method: 'percent_sale' as const, rate: 0 }] : base;
  })();
  const defaultReimbursementId = staff.find(p => p.display_name === 'Paul')?.user_id || staff[0]?.user_id || '';
  const personName = (id: string) => people.find(x => x.user_id === id)?.display_name || 'Unknown';
  const sum = (ts: Ticket[]): Summary => { const cuts = ts.flatMap(t => activeRules.map(r => payout(t, r, onlineCfg))); return { sales_cents: ts.reduce((n, t) => n + t.subtotal, 0), tax_cents: ts.reduce((n, t) => n + t.tax, 0), card_fee_cents: ts.reduce((n, t) => n + t.fee, 0), collected_cents: ts.reduce((n, t) => n + t.total, 0), cash_cents: ts.reduce((n, t) => n + t.cash, 0), card_cents: ts.reduce((n, t) => n + t.card, 0), other_cents: ts.reduce((n, t) => n + t.total - t.cash - t.card, 0), sale_count: ts.length, payout_cents: cuts.reduce<number>((n, x) => n + (x || 0), 0), payout_unset: cuts.filter(x => x === null).length }; };
  async function run(f: () => Promise<void>) { setBusy(true); setError(''); try { await f(); } catch (e) { setError(errText(e)); } finally { setBusy(false); } }
  async function openReport(type: 'daily' | 'weekly') {
    const start = type === 'daily' ? selectedDay : weekStart(selectedDay);
    const overrides = store ? await storedCommissionOverrides(store) : new Map();
    const summary = sum(await sales(start, datePlus(start, type === 'daily' ? 1 : 7), overrides));
    setReportDraft({ start, end: datePlus(start, type === 'daily' ? 1 : 7), summary, expenses: [], notes: '' });
    setReportReadOnly(false); setEditing(type);
  }
  const [draft, setReportDraft] = useState<{ start: string; end: string; summary: Summary; expenses: Expense[]; notes: string } | null>(null);
  function viewReport(r: Report, editable = false) { setEditing(r); setReportReadOnly(!editable); setReportDraft({ start: r.period_start, end: r.period_end, summary: r.summary, expenses: r.expenses, notes: r.notes }); }
  async function saveReport() { if (!store || !session || !editing || !draft) return; if (draft.expenses.some(x => !x.description.trim() || !Number.isFinite(x.amount_cents) || x.amount_cents < 0 || (x.needs_reimbursement && !people.some(p => p.kind === 'employee' && p.user_id === x.employee_id)))) { setError('Every expense needs a description, amount, and valid reimbursement recipient.'); return; } await run(async () => { const payload = { store_id: store, period_type: typeof editing === 'string' ? editing : editing.period_type, period_start: draft.start, period_end: draft.end, summary: draft.summary, expenses: draft.expenses, notes: draft.notes, edited_by: session.user.id, created_by: session.user.id }; if (typeof editing === 'string') check(await sb.from('portal_reports').insert(payload)); else check(await sb.from('portal_reports').update({ expenses: payload.expenses, notes: payload.notes, edited_by: session.user.id }).eq('id', editing.id)); setEditing(null); setReportDraft(null); await loadCommon(); }); }
  async function setRule(id: string, method: Rule['method'], rate: number) { if (!store || !session) return; await run(async () => { check(await sb.from('portal_payout_rules').upsert({ store_id: store, employee_id: id, method, rate, updated_at: new Date().toISOString(), updated_by: session.user.id })); await loadCommon(); }); }
  async function recordPayment(employeeId: string, amountCents: number, paidAt: string, note: string): Promise<string | null> {
    if (!store || !session) return 'Sign in again before recording a payment.';
    setBusy(true); setError('');
    try {
      const paidIso = paidAt.includes('T') ? paidAt : `${paidAt}T12:00:00`;
      const saved = check<Payment>(await sb.from('portal_payout_payments').insert({
        store_id: store, employee_id: employeeId, amount_cents: amountCents,
        paid_at: new Date(paidIso).toISOString(),
        note: note.trim() || null, paid_by: session.user.id,
      }).select('id,employee_id,amount_cents,paid_at,paid_by,legacy_ticket_key,note').single());
      setPayments(current => [saved, ...current.filter(p => p.id !== saved.id)]);
      return null;
    } catch (e) {
      const message = errText(e);
      setError(message);
      return message;
    } finally { setBusy(false); }
  }
  async function downloadReports(selected: Report[], all: boolean) { await run(async () => { const { downloadReportWorkbook } = await import('./reportExport'); await downloadReportWorkbook(selected, reportLines, personName, all); }); }

  if (showInstallGate && !standaloneApp) {
    return (
      <InstallGate
        onContinue={() => {
          // Continue in the browser tab: desktop layout. The phone shell is only for the installed app.
          setShowInstallGate(false);
        }}
      />
    );
  }

  if (!session) return <main className="auth"><div className="login"><div className="brand">OPEN BOX <span>INDUSTRIES</span></div><h1>Floor Admin</h1><p>Email for admins, or clock number + PIN for register staff.</p><form onSubmit={e => { e.preventDefault(); void run(async () => { const attempts = staffSignInAttempts(email, password); if (!attempts.length) throw new Error('Enter a valid email, username, or clock number.'); let last: unknown = new Error('Could not sign in.'); for (const attempt of attempts) { const result = await sb.auth.signInWithPassword(attempt); if (!result.error) return; last = result.error; } throw last; }); }}><label>Email or clock number<input type="text" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required /></label><label>Password or PIN<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required /></label><button disabled={busy}>Sign in</button></form>{error && <p className="error">{error}</p>}</div></main>;
  if (!accessReady) return <main className="auth"><div className="login"><h1>Floor Admin</h1><p>Checking access…</p></div></main>;
  if (!store) return <main className="auth"><div className="login"><h1>Access unavailable</h1><p>This account is not attached to the store as Floor staff or an admin. Ask Paul or Steve to add it.</p><button onClick={() => void sb.auth.signOut({ scope: 'local' })}>Sign out</button>{error && <p className="error">{error}</p>}</div></main>;

  const closeouts = <>
    <header style={{ marginTop: 8 }}><div><div className="eyebrow">CLOSEOUTS</div><h2 style={{ fontSize: '1.18rem', margin: 0 }}>Daily &amp; weekly reports</h2><p>Save a day or week with expenses and notes.</p></div><div className="report-actions"><label className="date-control">Report date<input type="date" value={selectedDay} onChange={e => setSelectedDay(e.target.value)} /></label><div className="actions"><button onClick={() => void run(() => openReport('daily'))}>Submit Daily Report</button><button className="secondary" onClick={() => void run(() => openReport('weekly'))}>Submit Weekly Report</button>{reports.length > 0 && <button className="secondary" disabled={busy} onClick={() => void downloadReports(reports, true)}>Download all</button>}</div></div></header>
    {editing && draft ? <section className="panel editor"><div className="section-head"><div><div className="eyebrow">{typeof editing === 'string' ? 'NEW REPORT' : 'SUBMITTED REPORT'}</div><h2>{draft.start} {draft.end !== datePlus(draft.start, 1) && `– ${datePlus(draft.end, -1)}`}</h2></div><div className="actions">{reportReadOnly && <button onClick={() => setReportReadOnly(false)}>Edit report</button>}{typeof editing !== 'string' && <button className="secondary" disabled={busy} onClick={() => void downloadReports([editing], false)}>Download</button>}<button className="text-button" onClick={() => { setEditing(null); setReportDraft(null); }}>Close</button></div></div><div className="stats compact"><Stat name="Sales" value={money(draft.summary.sales_cents)} /><Stat name="Card fees" value={money(draft.summary.card_fee_cents)} /><Stat name="Tax" value={money(draft.summary.tax_cents)} /></div><h3>Expenses</h3>{draft.expenses.map((x, i) => <div className="expense-row" key={i}><input disabled={reportReadOnly} aria-label="Description" placeholder="Description" value={x.description} onChange={e => setReportDraft({ ...draft, expenses: draft.expenses.map((v, j) => j === i ? { ...v, description: e.target.value } : v) })} /><ExpenseAmount disabled={reportReadOnly} cents={x.amount_cents} onCommit={cents => setReportDraft({ ...draft, expenses: draft.expenses.map((v, j) => j === i ? { ...v, amount_cents: cents } : v) })} /><label className="reimburse-check"><input type="checkbox" disabled={reportReadOnly} checked={!!x.needs_reimbursement} onChange={e => setReportDraft({ ...draft, expenses: draft.expenses.map((v, j) => j === i ? { ...v, needs_reimbursement: e.target.checked, employee_id: e.target.checked ? (v.employee_id || defaultReimbursementId) : undefined } : v) })} />Needs Reimbursement</label>{x.needs_reimbursement && <select disabled={reportReadOnly} aria-label="Reimburse employee" value={x.employee_id || defaultReimbursementId} onChange={e => setReportDraft({ ...draft, expenses: draft.expenses.map((v, j) => j === i ? { ...v, employee_id: e.target.value } : v) })}>{staff.map(p => <option value={p.user_id} key={p.user_id}>{p.display_name}</option>)}</select>}{!reportReadOnly && <button className="text-button" onClick={() => setReportDraft({ ...draft, expenses: draft.expenses.filter((_, j) => j !== i) })}>Remove</button>}</div>)}{!reportReadOnly && <button className="secondary" onClick={() => setReportDraft({ ...draft, expenses: [...draft.expenses, { description: '', category: '', amount_cents: 0 }] })}>Add expense</button>}<label className="notes">Notes<textarea disabled={reportReadOnly} rows={4} value={draft.notes} onChange={e => setReportDraft({ ...draft, notes: e.target.value })} placeholder="Anything to remember about this period" /></label><div className="net"><span>Net merchandise after expenses</span><strong>{money(draft.summary.sales_cents - draft.expenses.reduce((n, x) => n + x.amount_cents, 0))}</strong></div>{!reportReadOnly && <button disabled={busy} onClick={() => void saveReport()}>{typeof editing === 'string' ? 'Submit report' : 'Save edits'}</button>}{typeof editing !== 'string' && <p className="hint">Last edited by {personName(editing.edited_by)} · {stamp(editing.edited_at)}</p>}</section> : <section className="panel"><h2>Submitted reports</h2>{reports.length === 0 ? <Empty>No reports submitted yet.</Empty> : reports.map(r => <div className="report-list-row" key={r.id}><button className="report-row" onClick={() => viewReport(r)}><span><strong>{r.period_type === 'daily' ? 'Daily' : 'Weekly'} · {r.period_start}</strong><small>{r.summary.sale_count} sales · Edited {stamp(r.edited_at)} by {personName(r.edited_by)}</small></span><b>{money(r.summary.sales_cents - r.expenses.reduce((n, x) => n + x.amount_cents, 0))}</b></button><button className="secondary" onClick={() => viewReport(r, true)}>Edit</button><button className="secondary" disabled={busy} onClick={() => void downloadReports([r], false)}>Download</button></div>)}</section>}
  </>;

  const chartDays = Array.from({ length: 7 }, (_, i) => datePlus(today(), i - 6));
  const chartSales = chartDays.map(d => allSales.filter(t => day(new Date(t.at)) === d).reduce((n,t) => n + t.subtotal, 0));
  const chartMax = Math.max(1, ...chartSales);
  const todaySales = chartSales[6];
  const weekSales = allSales.filter(t => day(new Date(t.at)) >= weekStart(today())).reduce((n,t) => n + t.subtotal, 0);
  const todayCount = allSales.filter(t => day(new Date(t.at)) === today()).length;
  const nativeCloseouts = <div className="native-report-body native-closeouts">
    {!editing && <><div className="native-report-hero"><small>Today · {today()}</small><strong>{reportsLoading ? <span className="native-skeleton" /> : money(todaySales)}</strong><span>{reportsLoading ? 'Loading sales…' : `${todayCount} sales · ${money(weekSales)} this week`}</span></div><div className="native-week-chart" aria-label="Sales over the last seven days">{chartSales.map((value,i) => <div key={chartDays[i]} title={`${chartDays[i]}: ${money(value)}`} className={i === 6 ? 'today' : ''} style={{height:`${Math.max(7, value / chartMax * 100)}%`}} />)}</div><div className="native-closeout-buttons"><button type="button" disabled={busy} onClick={() => void run(() => openReport('daily'))}>Submit daily</button><button type="button" disabled={busy} onClick={() => void run(() => openReport('weekly'))}>Submit weekly</button></div><label className="native-report-row native-report-date"><span>Report date</span><input type="date" value={selectedDay} onChange={e => setSelectedDay(e.target.value)} /></label><h3 className="native-report-section">Submitted</h3><div className="native-report-group">{reports.length ? reports.map(r => <button type="button" className="native-report-row" key={r.id} onClick={() => viewReport(r)}><span>{r.period_type === 'daily' ? 'Daily' : 'Weekly'} · {r.period_start}{r.period_type === 'weekly' ? ` – ${datePlus(r.period_end,-1)}` : ''}<small>{r.summary.sale_count} sales · edited {stamp(r.edited_at)}</small></span><b>{money(r.summary.sales_cents - r.expenses.reduce((n,x)=>n+x.amount_cents,0))}</b><span className="native-chevron">›</span></button>) : <p className="native-report-empty">{reportsLoading ? 'Loading reports…' : 'No submitted reports yet.'}</p>}</div><p className="native-report-footnote">Tap a report to view, edit, or download it.</p></>}
    {editing && <div className="native-closeout-editor">{closeouts}</div>}
  </div>;


  const registerOnly = !fullAccess;

  if (standaloneApp) {
    return <>
      <ClientErrorReporter token={session.access_token} />
      <AppModeShell
        client={sb}
        session={session}
        storeId={store}
        fullAccess={fullAccess}
        staffSession={staffSession}
        money={money}
        stamp={stamp}
        rules={activeRules}
        onlineCfg={onlineCfg}
        commissionOverrides={commissionOverrides}
        personName={personName}
        busy={busy}
        onCommissionChanged={setTicketOverride}
        settingsSlot={fullAccess
          ? <SettingsPage client={sb} accessToken={session.access_token} stamp={stamp} money={money} busy={busy} run={run} onLedgerChanged={async () => { await loadSales(); await loadPayoutSales(); }} ruleEditor={<>{staff.map(p => <RuleEditor key={p.user_id} person={p} rule={ruleMap.get(p.user_id)} save={setRule} busy={busy} />)}</>} onlinePayoutSettings={<OnlinePayoutSettings cfg={onlineCfg} staff={staff} busy={busy} save={async (channels, pct, who) => { await run(async () => { check(await sb.rpc('portal_set_payout_config', { p_channels: channels, p_pct: pct, p_employee: who })); await loadCommon(); await loadPayoutSales(); }); }} />} />
          : <AssociateSettings client={sb} displayName={staffSession?.displayName || 'Associate'} />}
        reportsSlot={fullAccess ? (
          <ReportsPage
            client={sb}
            money={money}
            tab={nav.reportTab}
            onTab={(t) => go({ reportTab: t })}
            native
            nativeCloseouts={nativeCloseouts}
            onOrderLinked={() => { void Promise.all([loadPayoutSales(), loadSales()]); }}
            closeouts={closeouts}
            expenses={<ExpensesPage client={sb} money={money} expenses={expenses} staff={staff} ownerId={onlineCfg.employeeId || defaultReimbursementId} onChanged={loadCommon} embedded native />}
            payouts={<PayoutsPage allSales={allSales} ebayFees={ebayFees} staff={staff} rules={activeRules} payments={payments} adjustments={payoutAdjustments} expenses={expenses} frozen={frozen} cfg={onlineCfg} personName={personName} busy={busy} recordPayment={recordPayment} onCommissionChanged={setTicketOverride} native loading={reportsLoading} />}
          />
        ) : null}
        onReportsOpen={() => { setReportsLoading(true); void Promise.all([loadCommon(), loadPayments(), loadPayoutSales(), loadSales()]).finally(() => setReportsLoading(false)); }}
        reportsAction={nav.reportTab === 'expenses' ? 'add' : nav.reportTab === 'daily' || nav.reportTab === 'sales-tax' ? 'download' : undefined}
        onReportsAction={() => { if (nav.reportTab === 'daily') { if (reports.length) void downloadReports(reports, true); } else window.dispatchEvent(new Event('floor:reports-action')); }}
      />
    </>;
  }

  const mainNav: [MainPage, string][] = registerOnly
    ? [['register', 'Register'], ['inventory', 'Inventory'], ['settings', 'Settings']]
    : [
        ['register', 'Register'],
        ['sales', 'Live Sales'],
        ['orders', 'Orders'],
        ['receipts', 'Receipts'],
        ['online', 'Online'],
        ['ebay', 'eBay'],
        ['amazon', 'Amazon'],
        ['tiktok', 'TikTok'],
        ['depop', 'Depop'],
        ['marketplaces', 'Connections & sync'],
        ['cameras', 'Cameras'],
        ['remote', 'Remote'],
        ['logs', 'Logs'],
      ];
  const pageLabel = ({
    register: 'Register',
    sales: 'Live Sales',
    orders: 'Orders',
    receipts: 'Receipts',
    inventory: 'Inventory',
    online: 'Online',
    marketplaces: 'Connections & sync',
    ebay: 'eBay',
    amazon: 'Amazon',
    tiktok: 'TikTok',
    depop: 'Depop',
    reports: 'Reports',
    withdrawals: 'Withdrawals',
    manifests: 'Manifests',
    locations: 'Locations',
    insights: 'Insights',
    cameras: 'Cameras',
    remote: 'Remote',
    logs: 'Logs',
    settings: 'Settings',
  } as const)[page];
  const reportSubs: [typeof nav.reportTab, string][] = [['profit', 'Sales & profits'], ['shipping', 'Shipping & fees'], ['expenses', 'Expenses'], ['payouts', 'Payouts'], ['returns', 'Returns'], ['sales-tax', 'Sales tax']];
  const inventorySubs: [typeof nav.inventoryTab, string][] = [['in-stock', 'In stock'], ['sold', 'Sold'], ['unfinished', 'Unfinished'], ['needs-check', 'Needs to be checked'], ['defective', 'Defective'], ['left-store', 'Replaced / given away'], ['receive', 'Receive'], ['lookup-test', 'Lookup test'], ['products', 'Products'], ['measure-mat', 'Measure mat']];
  const onlineSubs: [typeof nav.onlineTab, string][] = [
    ['listed', 'Listed'],
    ['reports', 'Reports'],
  ];
  return <div className={`app${menuOpen ? ' menu-open' : ''}${navCollapsed ? ' nav-collapsed' : ''}${navCollapsed && navHoverPeek && navHoverOpen ? ' nav-peek-open' : ''}${page === 'register' ? ' register-mode' : ''}${darkMode ? ' dark' : ''}`}><ClientErrorReporter token={session.access_token} />
  <header className="mobile-top">
    <button type="button" className="hamburger" aria-label={menuOpen ? 'Close menu' : 'Open menu'} aria-expanded={menuOpen} aria-controls="admin-nav" onClick={() => setMenuOpen(o => !o)}>
      <span /><span /><span />
    </button>
    <div className="brand">OPEN BOX <span>INDUSTRIES</span></div>
    <strong className="mobile-page">{pageLabel}</strong>
  </header>
  <button type="button" className="mobile-scrim" aria-label="Close menu" tabIndex={menuOpen ? 0 : -1} onClick={closeMenu} />
  <aside
    id="admin-nav"
    onMouseEnter={() => { if (navCollapsed && navHoverPeek) setNavHoverOpen(true); }}
    onMouseLeave={() => { if (navHoverPeek) setNavHoverOpen(false); }}
  >
    <div className="aside-brand">
      <div className="brand">OPEN BOX <span>INDUSTRIES</span></div>
      <div className="product">Floor <b>Admin</b></div>
      <button
        type="button"
        className="nav-collapse-btn"
        aria-label={navCollapsed ? 'Expand menu' : 'Collapse menu'}
        title={navHoverPeek
          ? (navCollapsed ? 'Pin menu open (turns off hover)' : 'Pin menu closed (turns off hover)')
          : (navCollapsed ? 'Expand menu' : 'Collapse menu')}
        onClick={pinNavManual}
      >
        {navCollapsed ? '»' : '«'}
      </button>
    </div>
    <nav>
      {registerOnly
        ? <>
      <button type="button" className={page === 'register' ? 'active' : ''} key="register" title="Register" onClick={() => goNav({ page: 'register' })}>Register</button>
      <button type="button" className={page === 'inventory' ? 'active' : ''} title="Inventory" onClick={() => goNav({ page: 'inventory', inventoryTab: 'in-stock' })}>Inventory</button>
      <button type="button" title="Settings" className={page === 'settings' ? 'active' : ''} onClick={() => goNav({ page: 'settings' })}>Settings</button>
        </>
        : <>
      {mainNav.slice(0, 4).map(([id, label]) => <button type="button" className={page === id ? 'active' : ''} key={id} title={label} onClick={() => goNav({ page: id })}>{label}</button>)}
      <div className={`nav-group${navGroup === 'inventory' ? ' open' : ''}${page === 'inventory' ? ' on' : ''}`}>
        <button type="button" title="Inventory" className={`nav-parent${page === 'inventory' ? ' active' : ''}`} onClick={() => { setNavGroup(g => g === 'inventory' ? null : 'inventory'); go({ page: 'inventory' }); setEditing(null); }}>Inventory</button>
        <div className="nav-sub">
          {inventorySubs.map(([tab, label]) => <button type="button" key={tab} className={page === 'inventory' && nav.inventoryTab === tab ? 'active' : ''} onClick={() => goNav({ page: 'inventory', inventoryTab: tab, ...(tab === 'unfinished' ? { attentionSection: 'all' as const } : {}) })}>{label}</button>)}
        </div>
      </div>
      <div className={`nav-group${navGroup === 'online' ? ' open' : ''}${page === 'online' ? ' on' : ''}`}>
        <button type="button" title="Online" className={`nav-parent${page === 'online' ? ' active' : ''}`} onClick={() => { setNavGroup(g => g === 'online' ? null : 'online'); go({ page: 'online' }); setEditing(null); }}>Online</button>
        <div className="nav-sub">
          {onlineSubs.map(([tab, label]) => <button type="button" key={tab} className={page === 'online' && nav.onlineTab === tab ? 'active' : ''} onClick={() => goNav({ page: 'online', onlineTab: tab })}>{label}</button>)}
        </div>
      </div>
      {mainNav
        .filter(([id]) => id === 'ebay' || id === 'amazon' || id === 'tiktok' || id === 'depop' || id === 'marketplaces')
        .map(([id, label]) => (
          <button type="button" className={page === id ? 'active' : ''} key={id} title={label} onClick={() => goNav({ page: id })}>
            {label}
          </button>
        ))}
      <div className={`nav-group${navGroup === 'reports' ? ' open' : ''}${page === 'reports' ? ' on' : ''}`}>
        <button type="button" title="Reports" className={`nav-parent${page === 'reports' ? ' active' : ''}`} onClick={() => { setNavGroup(g => g === 'reports' ? null : 'reports'); go({ page: 'reports' }); setEditing(null); }}>Reports</button>
        <div className="nav-sub">
          {reportSubs.map(([tab, label]) => <button type="button" key={tab} className={page === 'reports' && nav.reportTab === tab ? 'active' : ''} onClick={() => goNav({ page: 'reports', reportTab: tab })}>{label}</button>)}
        </div>
      </div>
      <button type="button" title="Withdrawals" className={page === 'withdrawals' ? 'active' : ''} onClick={() => goNav({ page: 'withdrawals' })}>Withdrawals</button>
      <button type="button" title="Manifests" className={page === 'manifests' ? 'active' : ''} onClick={() => goNav({ page: 'manifests' })}>Manifests</button>
      <button type="button" title="Locations" className={page === 'locations' ? 'active' : ''} onClick={() => goNav({ page: 'locations' })}>Locations</button>
      <button type="button" title="Insights" className={page === 'insights' ? 'active' : ''} onClick={() => goNav({ page: 'insights' })}>Insights</button>
      {mainNav.filter(([id]) => id === 'cameras' || id === 'remote' || id === 'logs').map(([id, label]) => <button type="button" className={page === id ? 'active' : ''} key={id} title={label} onClick={() => goNav({ page: id })}>{label}</button>)}
      <button type="button" title="Settings" className={page === 'settings' ? 'active' : ''} onClick={() => goNav({ page: 'settings' })}>Settings</button>
        </>}
    </nav>
    <div className="account">
      <small>{staffSession?.displayName || session.user.email}</small>
      <button type="button" onClick={() => { closeMenu(); void sb.auth.signOut({ scope: 'local' }); }}>Sign out</button>
      <label className="theme-toggle" title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}>
        <span>{darkMode ? 'Dark' : 'Light'}</span>
        <input
          type="checkbox"
          checked={darkMode}
          onChange={e => setDarkMode(e.target.checked)}
          aria-label="Dark mode"
        />
        <span className="theme-switch" aria-hidden="true" />
      </label>
    </div>
  </aside>
  <main className="content">{error && <div className="alert" role="alert">{error}<button onClick={() => setError('')}>Dismiss</button></div>}
  {page === 'register' && (staffSession
    ? <RegisterPage staffSession={staffSession} onNeedFullReload={() => { void loadSales(); }} />
    : <section className="panel"><Empty>This login can view Floor Admin but is not on the Floor staff list, so it cannot ring sales. Ask an owner to add a staff row for this account.</Empty></section>)}
  {fullAccess && page === 'sales' && (() => {
    const salesFilters = <div className="report-actions">
      <div className="actions">
        <button type="button" className={salesScope === 'all' ? undefined : 'secondary'} onClick={() => setSalesScope('all')}>All sales</button>
        <button type="button" className={salesScope === 'instore' ? undefined : 'secondary'} onClick={() => setSalesScope('instore')}>In store</button>
        <button type="button" className={salesScope === 'online' ? undefined : 'secondary'} onClick={() => setSalesScope('online')}>Online</button>
        <button type="button" className={salesScope === 'voided' ? undefined : 'secondary'} onClick={() => setSalesScope('voided')}>Cancelled/refunded</button>
      </div>
      <label className="date-control">Date<input type="date" value={selectedDay} onChange={e => setSelectedDay(e.target.value)} /></label>
    </div>;

    if (salesScope === 'voided') {
      const refundedCents = voided.reduce((n, r) => n + r.price_cents + (r.shipping_cents || 0), 0);
      const profitReversed = voided.every(r => r.profit_cents != null)
        ? voided.reduce((n, r) => n + (r.profit_cents || 0), 0)
        : null;
      return <><header><div><div className="eyebrow">REGISTER ACTIVITY</div><h1>Cancelled / refunded</h1><p>Sales voided or refunded on this date (by cancel time). eBay cancels can take hours–days to hit Finances; we poll Fulfillment + Finances REFUND every few minutes. Live Sales totals exclude these.</p></div>{salesFilters}</header>
        <div className="stats">
          <Stat name="Cancelled" value={String(voided.length)} />
          <Stat name="Amount refunded" value={money(refundedCents)} />
          <Stat name="Profit reversed" value={profitReversed === null ? '—' : money(profitReversed)} />
        </div>
        <section className="panel">
          <h2>{selectedDay === today() ? 'Today’s cancellations' : `Cancellations · ${selectedDay}`}</h2>
          {voided.length === 0
            ? <Empty>No cancelled or refunded sales for this date. Pick yesterday if the cancel closed overnight — or wait for eBay Finances to post the REFUND.</Empty>
            : <div className="ticket-list">{voided.map(r => <VoidedTicket key={r.id} r={r} money={money} stamp={stamp} />)}</div>}
        </section></>;
    }

    const liveShown = live.filter(t => {
      const floor = (t.channel || '').toLowerCase() === 'floor';
      if (salesScope === 'instore') return floor;
      if (salesScope === 'online') return !floor;
      return true;
    });
    const liveSum = sum(liveShown);
    // Gross = merchandise + sales tax (card fees stay separate). Fridge $1,499 + $108.68 tax = $1,607.68.
    const salesDollars = liveShown.reduce((n, t) => n + t.subtotal + t.tax, 0);
    const marketplaceFees = liveShown.reduce((n, t) => n + t.feeCents, 0);
    const cardFees = liveShown.reduce((n, t) => n + t.processingFeeCents, 0);
    const taxCollected = liveShown.reduce((n, t) => n + t.taxCollectedCents, 0);
    const shippingCost = liveShown.reduce((n, t) => n + t.shipCostCents, 0);
    const pendingLabelCredit = liveShown.reduce((n, t) => n + t.pendingLabelCreditCents, 0);
    const buyerShip = liveShown.reduce((n, t) => n + t.shippingCents, 0);
    const itemCost = liveShown.every(t => t.cost !== null) ? liveShown.reduce((n, t) => n + (t.cost || 0), 0) : null;
    const profitTotal = liveShown.every(t => t.profitCents != null)
      ? liveShown.reduce((n, t) => n + (t.profitCents || 0), 0)
      : null;
    const onlineN = liveShown.filter(t => (t.channel || '').toLowerCase() !== 'floor').length;
    const instoreN = liveShown.filter(t => (t.channel || '').toLowerCase() === 'floor').length;
    const unmatchedN = liveShown.filter(t => t.needsMatch).length;
    return <><header><div><div className="eyebrow">REGISTER ACTIVITY</div><h1>Live Sales</h1><p>Click a sale for profit, fees, cost, and shipping. Online totals use the same ledger math as Reports.{unmatchedN > 0 ? ` ${unmatchedN} marketplace sale${unmatchedN === 1 ? '' : 's'} still need a Floor SKU link.` : ''}</p></div>
      {salesFilters}
    </header>
    <div className="stats">
      <Stat name="Sales $" hint="item + tax" value={money(salesDollars)} />
      <Stat name="Sales" value={String(liveShown.length)} />
      <Stat name="Profit" value={profitTotal === null ? 'Pending cost' : money(profitTotal)} />
      <Stat name="Marketplace fees" value={money(marketplaceFees)} />
      <Stat name="Card fees" value={money(cardFees)} />
      <Stat name="Tax collected" value={money(taxCollected)} />
      <Stat name="Shipping" value={formatLabelWithPending(money, shippingCost, pendingLabelCredit)} />
      {buyerShip > 0 && <Stat name="Buyer shipping" hint="buyer pays" value={money(buyerShip)} />}
      <Stat name="Item cost" value={itemCost === null ? 'Pending' : money(itemCost)} />
      {salesScope !== 'online' && <Stat name="Cash sales" value={money(liveSum.cash_cents)} />}
      {salesScope !== 'online' && <Stat name="Card sales" value={money(liveSum.card_cents)} />}
      <Stat name="Online sales" value={String(onlineN)} />
      <Stat name="Instore sales" value={String(instoreN)} />
      {unmatchedN > 0 && <Stat name="Need SKU" value={String(unmatchedN)} />}
    </div>
    <section className="panel"><h2>{selectedDay === today() ? 'Today’s transactions' : `Transactions · ${selectedDay}`}{salesScope !== 'all' && <small> · {salesScope === 'instore' ? 'in store' : 'online'}</small>}</h2>
      {liveShown.length === 0 ? <Empty>No {salesScope === 'all' ? '' : salesScope === 'instore' ? 'in-store ' : 'online '}sales for {selectedDay === today() ? 'today' : selectedDay}. Use the date control above to check another day.</Empty> : <div className="ticket-list">{liveShown.map(t => <LiveTicket key={t.key} t={t} money={money} stamp={stamp} rules={activeRules} cfg={onlineCfg} personName={personName} busy={busy} onCommissionChanged={setTicketOverride} onMatchSku={t.needsMatch ? () => void matchLiveSku(t) : undefined} />)}</div>}
    </section></>;
  })()}
  {fullAccess && page === 'orders' && store && <OrdersPage client={sb} accessToken={session.access_token} storeId={store} money={money} stamp={stamp} rules={activeRules} cfg={onlineCfg} commissionOverrides={commissionOverrides} personName={personName} busy={busy} onCommissionChanged={setTicketOverride} />}
  {fullAccess && page === 'receipts' && <ReceiptsPage client={sb} money={money} stamp={stamp} />}
  {fullAccess && page === 'online' && <OnlinePage client={sb} money={money} tab={nav.onlineTab} onTab={t => go({ onlineTab: t, page: 'online' })} channel={nav.onlineChannel} onChannel={c => go({ onlineChannel: c, onlineTab: 'listed', page: 'online' })} onInventory={() => goNav({ page: 'inventory', inventoryTab: 'in-stock' })} />}
  {fullAccess && page === 'marketplaces' && <ConnectionsPage accessToken={session.access_token} />}
  {fullAccess && page === 'ebay' && <ChannelListingPage channel="ebay" accessToken={session.access_token} money={money} />}
  {fullAccess && page === 'amazon' && <AmazonPage client={sb} accessToken={session.access_token} money={money} />}
  {fullAccess && page === 'tiktok' && <ChannelListingPage channel="tiktok" accessToken={session.access_token} money={money} />}
  {fullAccess && page === 'depop' && <ChannelListingPage channel="depop" accessToken={session.access_token} money={money} client={sb} />}
  {fullAccess && page === 'logs' && <LogsPage accessToken={session.access_token} stamp={stamp} />}
  {(fullAccess || registerOnly) && page === 'inventory' && <InventoryPage client={sb} storeId={store} accessToken={session.access_token} money={money} stamp={stamp} tab={nav.inventoryTab} onTab={t => go({ inventoryTab: t })} attentionSection={nav.attentionSection} onAttentionSection={s => go({ attentionSection: s, inventoryTab: 'unfinished' })} canDelete={fullAccess} associateBrowseOnly={registerOnly} onCostChanged={() => { void loadPayoutSales(); void loadSales(); }} />}
  {fullAccess && page === 'reports' && <ReportsPage client={sb} money={money} tab={nav.reportTab} onTab={t => go({ reportTab: t })} closeouts={closeouts} expenses={<ExpensesPage client={sb} money={money} expenses={expenses} staff={staff} ownerId={onlineCfg.employeeId || defaultReimbursementId} onChanged={loadCommon} embedded />} payouts={<PayoutsPage allSales={allSales} ebayFees={ebayFees} staff={staff} rules={activeRules} payments={payments} adjustments={payoutAdjustments} expenses={expenses} frozen={frozen} cfg={onlineCfg} personName={personName} busy={busy} recordPayment={recordPayment} onCommissionChanged={setTicketOverride} />} />}
  {fullAccess && page === 'withdrawals' && <WithdrawalsPage client={sb} storeId={store} money={money} stamp={stamp} />}
  {fullAccess && page === 'manifests' && <ManifestsPage client={sb} storeId={store} money={money} />}
  {fullAccess && page === 'locations' && <LocationsPage client={sb} storeId={store} />}
  {fullAccess && page === 'insights' && <InsightsPage client={sb} money={money} />}
  {fullAccess && page === 'settings' && <SettingsPage client={sb} accessToken={session.access_token} stamp={stamp} money={money} busy={busy} run={run} onLedgerChanged={async () => { await loadSales(); await loadPayoutSales(); }} ruleEditor={<>{staff.map(p => <RuleEditor key={p.user_id} person={p} rule={ruleMap.get(p.user_id)} save={setRule} busy={busy} />)}</>} onlinePayoutSettings={<OnlinePayoutSettings cfg={onlineCfg} staff={staff} busy={busy} save={async (channels, pct, who) => { await run(async () => { check(await sb.rpc('portal_set_payout_config', { p_channels: channels, p_pct: pct, p_employee: who })); await loadCommon(); await loadPayoutSales(); }); }} />} />}
  {registerOnly && page === 'settings' && <AssociateSettings client={sb} displayName={staffSession?.displayName || 'Associate'} />}
  {fullAccess && page === 'cameras' && <><header><div><div className="eyebrow">FUTURE INTEGRATION</div><h1>Cameras</h1></div></header><section className="panel"><Empty>Camera feeds coming soon</Empty></section></>}
  {fullAccess && page === 'remote' && <><header><div><div className="eyebrow">FUTURE INTEGRATION</div><h1>Remote</h1><p>Connect to the store computer from here later.</p></div></header><section className="panel"><Empty>Remote access coming soon</Empty></section></>}
  </main></div>;
}
function Stat({ name, value, hint }: { name: string; value: string; hint?: string }) {
  return <div className="stat"><span>{name}{hint ? <small className="stat-hint"> ({hint})</small> : null}</span><strong>{value}</strong></div>;
}
function Empty({children}:{children:React.ReactNode}) { return <div className="empty">{children}</div>; }
function VoidedTicket({ r, money, stamp }: { r: VoidedLine; money: (n: number) => string; stamp: (s: string) => string }) {
  const amount = r.price_cents + (r.shipping_cents || 0);
  const online = (r.channel || '').toLowerCase() !== 'floor';
  return <div className="ticket">
    <div className="ticket-top">
      <strong>{money(amount)}<small className="ticket-profit"> · cancelled</small></strong>
      <span>{stamp(r.voided_at)}{online && <b className="badge"> {(r.channel || 'online').toUpperCase()}</b>}</span>
    </div>
    <div className="ticket-items">
      <div>{r.qty > 1 ? `${r.qty}× ` : ''}{r.title} <span>· SKU {r.sku}</span></div>
    </div>
    <div className="ticket-bottom">
      <span>{r.void_reason || 'Refunded / voided'}{r.order_no ? ` · ${r.order_no}` : ''}{r.buyer_name ? ` · ${r.buyer_name}` : ''}</span>
      <span>Sold {stamp(r.sold_at)}{!online && r.actor_name ? ` · ${r.actor_name}` : ''}</span>
    </div>
  </div>;
}
function LiveTicket({ t, money, stamp, rules, cfg, personName, busy, onCommissionChanged, onMatchSku }: {
  t: Ticket; money: (n: number) => string; stamp: (s: string) => string;
  rules: Rule[]; cfg: OnlineCfg; personName: (id: string) => string; busy: boolean;
  onCommissionChanged: (ticketKey: string, next: CommissionOverride | null) => void;
  onMatchSku?: () => void;
}) {
  const [open, setOpen] = useState(!!t.needsMatch);
  const online = (t.channel || '').toLowerCase() !== 'floor';
  const feeEst = t.lines.some(l => l.fee_source === 'estimated' && (l.channel_fee_cents ?? 0) > 0);
  const costEst = t.costEstimated;
  const profit = t.profitCents;
  return <div className={`ticket${open ? ' ticket-open' : ''}${t.commissionOverride ? ' ticket-commission-override' : ''}${t.needsMatch ? ' ticket-unmatched' : ''}`}>
    <button type="button" className="ticket-toggle" aria-expanded={open} onClick={() => setOpen(v => !v)}>
      <div className="ticket-top">
        <strong>{money(online ? t.subtotal : t.subtotal + t.tax)}{!online && t.tax > 0 ? <small className="ticket-profit"> · incl. tax</small> : null}{online && profit != null ? <small className="ticket-profit"> · profit {money(profit)}</small> : null}{t.needsMatch ? <small className="ticket-profit"> · needs SKU</small> : null}{t.commissionOverride ? <small className="ticket-profit"> · split overridden</small> : null}</strong>
        <span>{stamp(t.at)}{online && <b className="badge"> {(t.channel || 'online').toUpperCase()}</b>}{t.needsMatch && <b className="badge"> UNMATCHED</b>}{t.commissionOverride && <b className="badge badge-override"> SPLIT</b>}<span className="ticket-chevron" aria-hidden>{open ? '▴' : '▾'}</span></span>
      </div>
      <div className="ticket-items">{t.lines.map(l => <SaleItem key={`${t.key}-${l.id}-${l.sku}`} line={l} />)}
        <CommissionOverrideMark overridden={!!t.commissionOverride} />
      </div>
      <div className="ticket-bottom">
        <span>{t.needsMatch
          ? `${t.channel} · not linked to inventory yet${t.buyerName ? ` · ${t.buyerName}` : ''}${t.orderNo ? ` · ${t.orderNo}` : ''}`
          : online
          ? `${t.channel}${t.feeCents > 0 ? ` · fees ${money(t.feeCents)}${feeEst ? ' est.' : ''}` : ''}${t.shipCostCents > 0 ? ` · label ${formatLabelWithPending(money, t.shipCostCents, t.pendingLabelCreditCents)}` : ''}${t.shippingCents > 0 ? ` · buyer ship ${money(t.shippingCents)}` : ''}`
          : t.method === 'split' ? (t.lines[0].cash_cents === null ? 'Split amounts unavailable' : `Cash ${money(t.cash)} · Card ${money(t.card)}`)
            : t.method === 'card' ? `Card ${money(t.card)}` : t.method === 'cash' ? `Cash ${money(t.cash)}` : t.method}{!online && !t.needsMatch && t.processingFeeCents > 0 && ` · card fees ${money(t.processingFeeCents)}`}</span>
        <span>{online || t.needsMatch ? 'Online' : `Rang up by ${t.actor || 'Unassigned'}`}</span>
      </div>
    </button>
    {open && <div className="ticket-detail">
      {t.needsMatch && onMatchSku && (
        <div className="alert" role="status" style={{ marginBottom: 10 }}>
          This marketplace sale is in Live Sales / Orders but not linked to a Floor unit yet — so it will not hit inventory, profit, or payouts until you link a SKU.
          <button type="button" className="secondary" disabled={busy} onClick={onMatchSku}>Link SKU…</button>
        </div>
      )}
      <div className="ticket-detail-grid">
        <div><span>Item</span><strong>{money(t.subtotal)}</strong></div>
        {t.shippingCents > 0 && <div><span>Buyer shipping (buyer pays)</span><strong>{money(t.shippingCents)}</strong></div>}
        {t.feeCents > 0 && <div><span>Marketplace fees{feeEst ? ' (est.)' : ''}</span><strong>−{money(t.feeCents)}</strong></div>}
        {t.shipCostCents > 0 && <div><span>Shipping label</span><strong>−{formatLabelWithPending(money, t.shipCostCents, t.pendingLabelCreditCents)}</strong></div>}
        {online && t.shippingCents > 0 && (() => {
          const spread = t.shippingCents - t.shipCostCents;
          if (spread === 0) return null;
          return <div><span>Ship spread{t.shipCostCents === 0 ? ' (label pending)' : ''}</span><strong>{spread > 0 ? '+' : '−'}{money(Math.abs(spread))}</strong></div>;
        })()}
        {t.processingFeeCents > 0 && <div><span>Card fees</span><strong>−{money(t.processingFeeCents)}</strong></div>}
        {!online && t.tax > 0 && <div><span>Tax</span><strong>{money(t.tax)}</strong></div>}
        <div><span>Item cost{costEst ? ' (est.)' : ''}</span><strong>{t.cost === null ? 'Missing' : `−${money(t.cost)}`}</strong></div>
        <div><span>Profit</span><strong>{profit == null ? 'Pending' : money(profit)}</strong></div>
      </div>
      {online && !t.needsMatch && <p className="hint" style={{ margin: '8px 0 0' }}>Profit = item + buyer shipping − fees − label − processing − cost. Label totals keep voided eBay labels until the credit posts; pending refund shows in ().</p>}
      {!t.needsMatch && <CommissionOverrideControls
        client={sb}
        ticketKey={t.key}
        ticket={t}
        rules={rules}
        cfg={cfg}
        override={t.commissionOverride}
        personName={personName}
        stamp={stamp}
        money={money}
        busy={busy}
        onChanged={next => onCommissionChanged(t.key, next)}
      />}
    </div>}
  </div>;
}
function ExpenseAmount({cents,onCommit,disabled}:{cents:number;onCommit:(cents:number)=>void;disabled:boolean}) {
  const [text,setText] = useState((cents/100).toFixed(2));
  useEffect(() => setText((cents/100).toFixed(2)), [cents]);
  return <input disabled={disabled} aria-label="Amount" type="text" inputMode="decimal" value={text}
    onFocus={e => e.currentTarget.select()}
    onChange={e => { if (moneyEntry.test(e.target.value)) setText(e.target.value); }}
    onBlur={() => { const clean = cleanMoney(text); setText(clean); onCommit(Math.round(Number(clean)*100)); }} />;
}
type LedgerEntry = {
  at: string; kind: 'sale' | 'online' | 'reimbursement' | 'payment' | 'adjustment'; amount: number | null;
  detail: string; note?: string; ticketKey?: string; ticket?: Ticket; overridden?: boolean;
};
function PayoutsPage({allSales,ebayFees,staff,rules,payments,adjustments,expenses,cfg,personName,busy,recordPayment,onCommissionChanged,native,loading,frozen}:{allSales:Ticket[];ebayFees:number;staff:Person[];rules:Rule[];payments:Payment[];adjustments:PayoutAdjustment[];expenses:StoreExpense[];cfg:OnlineCfg;personName:(id:string)=>string;busy:boolean;recordPayment:(id:string,amount:number,paidAt:string,note:string)=>Promise<string | null>;onCommissionChanged:(ticketKey:string,next:CommissionOverride|null)=>void;native?:boolean;loading?:boolean;frozen?:FrozenMap}) {
  type CostFlag = { sale_id: number; ticket_key: string; sku: string; qty: number; unit_cost_cents: number; cost_source: string | null; confirmed_at: string | null };
  const [costFlags, setCostFlags] = useState<CostFlag[]>([]);
  const [costFlagError, setCostFlagError] = useState('');
  useEffect(() => {
    let current = true;
    void sb.from('sale_payout_cost_flags').select('sale_id,ticket_key,sku,qty,unit_cost_cents,cost_source,confirmed_at')
      .is('confirmed_at', null).order('sale_id', { ascending: true })
      .then(({ data }) => { if (current) setCostFlags((data || []) as CostFlag[]); });
    return () => { current = false; };
  }, []);
  async function confirmCostFlag(saleId: number) {
    const user = await sb.auth.getUser();
    const { error } = await sb.from('sale_payout_cost_flags').update({ confirmed_at: new Date().toISOString(), confirmed_by: user.data.user?.id || null })
      .eq('sale_id', saleId).is('confirmed_at', null);
    if (error) { setCostFlagError(error.message); return; }
    setCostFlags(rows => rows.filter(row => row.sale_id !== saleId));
    setCostFlagError('');
  }
  const hasReimburse = (id: string) => expenses.some(e => !e.voided_at && e.needs_reimbursement && e.employee_id === id);
  const hasAdjustment = (id: string) => adjustments.some(a => a.employee_id === id);
  const active = staff.filter(p => rules.some(r => r.employee_id === p.user_id) || hasReimburse(p.user_id) || hasAdjustment(p.user_id));
  // Frozen at sale time in the database (sale_commissions); browser math only for sales not yet frozen.
  const frozenTickets = new Set([...(frozen || new Map()).keys()].map(k => k.slice(0, k.lastIndexOf('|'))));
  const cut = (key: string, ticket: Parameters<typeof payout>[0], rule: Rule): number | null => {
    if (!frozen || !frozenTickets.has(key)) return payout(ticket, rule, cfg);
    const k = `${key}|${rule.employee_id}`;
    return frozen.has(k) ? frozen.get(k) ?? null : 0;
  };
  const needsCost = allSales.filter(t => t.cost === null).length;
  const cards = active.map(person => {
    const rule = rules.find(r => r.employee_id === person.user_id);
    const saleEntries: LedgerEntry[] = !rule ? [] : allSales.flatMap(t => {
      const online = isOnline(t,cfg);
      const ticket = { ...t, lines: t.lines.map(l => ({ sku: l.sku, price_cents: l.price_cents, cost_cents: l.cost_cents,
        shipping_cents: l.shipping_cents, channel_fee_cents: l.channel_fee_cents, ship_cost_cents: l.ship_cost_cents,
        processing_fee_cents: l.processing_fee_cents, tax_owed_cents: l.tax_owed_cents })), commissionOverride: t.commissionOverride };
      const amount = cut(t.key, ticket, rule);
      if (amount === null) return [];
      // Default online: only the online recipient. Override: anyone with a non-zero cut.
      if (online && !t.commissionOverride && person.user_id !== cfg.employeeId) return [];
      if (online && t.commissionOverride && person.user_id !== cfg.employeeId) {
        const rate = person.user_id === cfg.slots?.paul ? t.commissionOverride.paulPct
          : person.user_id === cfg.slots?.jacob ? t.commissionOverride.jacobPct
          : 0;
        if (!rate) return [];
      }
      const rp = (() => { const p = profit(ticket); if (p === null) return null; const cuts = rules.map(r => cut(t.key, ticket, r)); return cuts.some(x => x === null) ? null : p - cuts.reduce<number>((n, x) => n + (x || 0), 0); })();
      const overrideSkus = !t.commissionOverride
        ? t.lines.filter(l => inStoreOverrideRate(l.sku, person.user_id, cfg) != null).map(l => l.sku)
        : [];
      const rateLabel = t.commissionOverride
        ? `override Paul ${t.commissionOverride.paulPct}% / Jacob ${t.commissionOverride.jacobPct}% of net profit`
        : rule.method === 'flat_ticket'
          ? money(Math.round(Number(rule.rate)*100)) + ' flat'
          : overrideSkus.length > 0 && rule.method === 'percent_profit'
            ? `SKU rates on net profit (${overrideSkus.join(', ')})`
            : rule.rate + '% ' + (rule.method === 'percent_profit' ? 'of net profit' : 'of sale');
      return [{
        at: t.at, kind: online ? 'online' as const : 'sale' as const, amount,
        detail: t.lines.map(l => l.sku).join(', '),
        ticketKey: t.key, ticket: t, overridden: !!t.commissionOverride,
        note: online
          ? `${t.channel} · item ${money(t.subtotal)}${t.shippingCents ? ` + ship ${money(t.shippingCents)}` : ''} − ${t.cost === null ? 'cost missing' : money(t.cost) + ' cost'}${t.costEstimated ? ' (est.)' : ''} · ${t.commissionOverride ? rateLabel : `${cfg.pct}% of net profit`}`
          : `${money(t.subtotal)} merchandise · ${rateLabel} · Owner share ${rp === null ? 'pending' : money(rp)}`
      }];
    });
    // Paid-sale returns: void drops the sale from live commission. Add back the original
    // sale commission so the negative clawback line is the visible net change.
    const personAdjs = adjustments.filter(a => a.employee_id === person.user_id);
    const clawbackAddbacks: LedgerEntry[] = personAdjs
      .filter(a => a.amount_cents < 0 && a.return_id && (a.sale_commission_cents || 0) > 0)
      .map(a => ({
        at: a.created_at,
        kind: 'adjustment' as const,
        amount: a.sale_commission_cents || 0,
        detail: a.ticket_key || (a.sale_id != null ? `sale:${a.sale_id}` : 'returned sale'),
        note: 'Prior commission on returned sale (see clawback)',
      }));
    // Replacement adjustments are visible ledger lines only: the sale's commission already dropped, so each is paired with the opposite add-back.
    const replacementAddbacks: LedgerEntry[] = personAdjs
      .filter(a => replacementAddback(a) !== 0)
      .map(a => ({ at: a.created_at, kind: 'adjustment' as const, amount: replacementAddback(a), detail: a.ticket_key || (a.sale_id != null ? `sale:${a.sale_id}` : 'replaced sale'), note: 'Commission change already counted on the replaced sale (see adjustment)' }));
    const adjEntries: LedgerEntry[] = personAdjs.map(a => ({
      at: a.created_at,
      kind: 'adjustment' as const,
      amount: a.amount_cents,
      detail: a.reason,
      note: a.return_id ? `Return ${a.return_id.slice(0, 8)}…` : undefined,
      ticketKey: a.ticket_key || undefined,
    }));
    const reimburseEntries: LedgerEntry[] = expenses.filter(e => !e.voided_at && e.needs_reimbursement && e.employee_id === person.user_id).map(e => ({
      at: `${e.spent_on}T12:00:00`, kind: 'reimbursement' as const, amount: e.amount_cents,
      detail: e.description, note: e.category || undefined,
    }));
    const paid: LedgerEntry[] = payments.filter(p => p.employee_id === person.user_id).map(p => ({
      at: p.paid_at, kind: 'payment' as const, amount: -p.amount_cents,
      detail: `Recorded by ${personName(p.paid_by)}`, note: p.note || (p.legacy_ticket_key ? 'Previous per-sale payment' : undefined)
    }));
    const entries = [...saleEntries, ...clawbackAddbacks, ...replacementAddbacks, ...adjEntries, ...reimburseEntries, ...paid].sort((a,b)=>b.at.localeCompare(a.at));
    const commission = saleEntries.reduce((n,e)=>n+(e.amount || 0),0);
    const adjTotal = personAdjs.reduce((n, a) => n + a.amount_cents, 0);
    const addbackTotal = [...clawbackAddbacks, ...replacementAddbacks].reduce((n, e) => n + (e.amount || 0), 0);
    const reimburse = reimburseEntries.reduce((n,e)=>n+(e.amount || 0),0);
    const paidTotal = payments.filter(p => p.employee_id === person.user_id).reduce((n,p)=>n+p.amount_cents,0);
    // Unpaid voids: sale drops only. Paid voids: drop + addback + clawback net to −claw (already paid).
    const balance = commission + addbackTotal + adjTotal + reimburse - paidTotal;
    return {person,balance,commission,reimburse,paidTotal,adjTotal,addbackTotal,entries};
  });
  const totalCommission = cards.reduce((n,c)=>n+c.commission,0);
  const totalReimburse = cards.reduce((n,c)=>n+c.reimburse,0);
  const totalPaid = cards.reduce((n,c)=>n+c.paidTotal,0);
  const totalAdj = cards.reduce((n,c)=>n+(c.adjTotal || 0),0);
  // Payments apply to reimbursements (expenses) first, then commission — per person.
  const owedSplits = cards.map(c => {
    const earnedForPay = c.commission + (c.addbackTotal || 0) + (c.adjTotal || 0);
    const reimburseOwed = Math.max(0, c.reimburse - c.paidTotal);
    const commissionOwed = Math.max(0, earnedForPay - Math.max(0, c.paidTotal - c.reimburse));
    return { ...c, commissionOwed, reimburseOwed };
  });
  const commissionBalanceOwed = owedSplits.reduce((n, c) => n + c.commissionOwed, 0);
  const reimburseBalanceOwed = owedSplits.reduce((n, c) => n + c.reimburseOwed, 0);
  // Sale rows omit eBay insertion/subscription. Profit tab subtracts them once on the eBay channel.
  const saleProfit = allSales.every(t => t.profitCents != null)
    ? allSales.reduce((n, t) => n + (t.profitCents || 0), 0)
    : (() => {
      const parts = allSales.map(t => profit({ ...t, shippingCents: t.shippingCents, profitCents: t.profitCents }));
      return parts.some(x => x === null) ? null : parts.reduce<number>((n, x) => n + (x || 0), 0);
    })();
  const hasEbaySale = allSales.some(t => (t.channel || '').toLowerCase() === 'ebay');
  const profitAfterCosts = reportProfitCents(saleProfit, hasEbaySale ? ebayFees : 0);
  const ownerShare = profitAfterCosts === null ? null : profitAfterCosts - totalCommission;
  if (native) return <div className="native-report-body"><div className="native-report-hero"><small>Owed right now</small><strong>{loading ? <span className="native-skeleton" /> : money(commissionBalanceOwed + reimburseBalanceOwed)}</strong><span>{loading ? "Loading payouts…" : `${money(totalPaid)} paid out all time`}</span></div>{loading && <div className="native-report-group"><div className="native-report-row"><span>Loading balances…</span></div></div>}{!loading && owedSplits.map(card => <PayoutCard key={card.person.user_id} {...card} busy={busy} recordPayment={recordPayment} rules={rules} cfg={cfg} personName={personName} onCommissionChanged={onCommissionChanged} native />)}{!loading && <><h3 className="native-report-section">Totals</h3><div className="native-report-group"><div className="native-report-row"><span>Total paid</span><b>{money(totalPaid)}</b></div><div className="native-report-row"><span>Reimbursements</span><b>{money(totalReimburse)}</b></div><div className="native-report-row"><span>Reimbursements owed</span><b>{money(reimburseBalanceOwed)}</b></div><div className="native-report-row"><span>Return adjustments</span><b>{money(totalAdj)}</b></div><div className="native-report-row strong"><span>Owner share</span><b>{ownerShare === null ? 'Pending cost' : money(ownerShare)}</b></div></div>{needsCost > 0 && <p className="native-report-footnote">{needsCost} online sales need item cost before payout.</p>}</>}</div>;
  return <>
    <header><div><div className="eyebrow">TEAM EARNINGS</div><h1>Payouts</h1><p>Profit is sale price + buyer-paid shipping − fees − tax owed − cost. Label and card processing costs count as fees. Commissions are frozen per sale. Payments count against expense reimbursements first, then commission. Return adjustments stay separate; payment history is never rewritten.</p></div></header>
    <div className="stats payout-stats">
      <Stat name="Profit after costs" hint={hasEbaySale && ebayFees > 0 ? `includes ${money(ebayFees)} eBay insertion/subscription` : undefined} value={profitAfterCosts === null ? 'Pending cost' : money(profitAfterCosts)} />
      <Stat name="Commission earned" value={money(totalCommission)} />
      <Stat name="Reimbursements" value={money(totalReimburse)} />
      <Stat name="Return adjustments" value={money(totalAdj)} />
      <Stat name="Total paid" value={money(totalPaid)} />
      <Stat name="Commissions balance owed" value={money(commissionBalanceOwed)} />
      <Stat name="Reimbursement balance owed" value={money(reimburseBalanceOwed)} />
      <Stat name="Owner share" value={ownerShare === null ? 'Pending cost' : money(ownerShare)} />
      {needsCost > 0 && <Stat name="Sales needing cost" value={String(needsCost)} />}
    </div>
    {needsCost > 0 && <div className="alert" role="status">{needsCost} sale{needsCost === 1 ? '' : 's'} have cost missing. They are excluded from Payouts until you enter a real unit cost or mark the item collectible.</div>}
    {costFlags.length > 0 && <section className="panel"><h2>Old default costs to confirm</h2><p>These sold items have a recorded cost equal to an old default. No cost was changed automatically. Check the real cost in Inventory before confirming it here.</p>{costFlagError && <p className="error" role="alert">{costFlagError}</p>}<div className="ledger-list">{costFlags.map(flag => <div className="ledger-row" key={flag.sale_id}><div><strong>SKU {flag.sku} · {flag.qty} unit{flag.qty === 1 ? '' : 's'}</strong><span>Sale {flag.ticket_key} · {money(flag.unit_cost_cents)} per unit · {flag.cost_source || 'previous default'}</span></div><button type="button" className="secondary" onClick={() => void confirmCostFlag(flag.sale_id)}>Confirm cost</button></div>)}</div></section>}
    {owedSplits.length === 0 && <section className="panel"><Empty>No employee payout rules set.</Empty></section>}
    {owedSplits.map(card => <PayoutCard key={card.person.user_id} {...card} busy={busy} recordPayment={recordPayment} rules={rules} cfg={cfg} personName={personName} onCommissionChanged={onCommissionChanged} />)}
  </>;
}
function PayoutCard({person,balance,entries,commissionOwed,reimburseOwed,busy,recordPayment,rules,cfg,personName,onCommissionChanged,native}:{person:Person;balance:number;commission?:number;reimburse?:number;paidTotal?:number;entries:LedgerEntry[];commissionOwed:number;reimburseOwed:number;busy:boolean;recordPayment:(id:string,amount:number,paidAt:string,note:string)=>Promise<string | null>;rules:Rule[];cfg:OnlineCfg;personName:(id:string)=>string;onCommissionChanged:(ticketKey:string,next:CommissionOverride|null)=>void;native?:boolean}) {
  const [amount,setAmount] = useState('');
  const [paidOn,setPaidOn] = useState(today);
  const [note,setNote] = useState('');
  const [paymentError,setPaymentError] = useState('');
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPaymentError('');
    const cents = Math.round(Number(amount)*100);
    if (!Number.isFinite(cents) || cents <= 0) { setPaymentError('Enter an amount greater than zero.'); return; }
    if (!paidOn) { setPaymentError('Choose a payment date.'); return; }
    if (cents > balance && !window.confirm(`This payment exceeds ${person.display_name}'s ${money(balance)} balance. Record ${money(cents)} anyway?`)) return;
    const failure = await recordPayment(person.user_id,cents,paidOn,note);
    if (failure) setPaymentError(failure);
    else { setAmount(''); setNote(''); setPaidOn(today()); }
  }
  const pending = entries.filter(x => (x.kind === 'sale' || x.kind === 'online') && x.amount === null).length;
  const kindLabel = (k: LedgerEntry['kind']) => k === 'sale' ? 'In-store sale' : k === 'online' ? 'Online sale' : k === 'payment' ? 'Payment' : k === 'adjustment' ? 'Adjustment' : 'Reimbursement';
  if (native) {
    const rule = rules.find(r => r.employee_id === person.user_id);
    const rate = rule ? `${rule.rate}${rule.method === 'flat_ticket' ? ' flat per sale' : rule.method === 'percent_profit' ? '% of sale − cost' : '% of sale'}` : 'Reimbursements';
    return <section className="native-payout-card"><div className="native-payout-head"><span className="native-payout-avatar">{person.display_name.charAt(0)}</span><span className="native-payout-name"><strong>{person.display_name}</strong><small>{rate}{cfg.employeeId === person.user_id ? ` · ${cfg.pct}% online` : ''}</small></span><span className="native-payout-balance"><strong>{money(balance)}</strong><small>OWED</small></span></div><form className="native-payout-form" onSubmit={e => void submit(e)}><input aria-label={`Payment amount for ${person.display_name}`} placeholder="$ Amount" inputMode="decimal" value={amount} onChange={e => { if (moneyEntry.test(e.target.value)) setAmount(e.target.value); }} required /><input aria-label={`Payment date for ${person.display_name}`} type="date" value={paidOn} onChange={e => setPaidOn(e.target.value)} required /><button disabled={busy || !amount}>Pay</button></form>{paymentError && <p className="error" role="alert">{paymentError}</p>}<details className="native-payout-breakdown"><summary>Balance breakdown · {entries.filter(e => e.kind === 'sale' || e.kind === 'online').length} sales <span>›</span></summary><p className="native-report-footnote">Commission {money(commissionOwed)} · Reimbursement {money(reimburseOwed)}{pending ? ` · ${pending} need cost` : ''}</p><label className="native-payout-note">Payment note<input value={note} onChange={e => setNote(e.target.value.slice(0,500))} placeholder="Optional note for next payment" /></label><div className="ledger-list">{entries.map((e,i) => <div className="ledger-row" key={i}><div><strong>{kindLabel(e.kind)} · {stamp(e.at)}</strong><span>{e.detail}</span>{e.note && <small>{e.note}</small>}{e.ticketKey && e.ticket && (e.kind === 'sale' || e.kind === 'online') && <CommissionOverrideControls client={sb} ticketKey={e.ticketKey} ticket={e.ticket} rules={rules} cfg={cfg} override={e.ticket.commissionOverride} personName={personName} stamp={stamp} money={money} busy={busy} onChanged={next => onCommissionChanged(e.ticketKey!, next)} />}</div><b>{e.amount === null ? 'Needs cost' : (e.amount < 0 ? '−' : '+') + money(Math.abs(e.amount))}</b></div>)}</div></details></section>;
  }
  return <section className="panel payout-card"><div className="payout-card-top"><div><h2>{person.display_name}</h2><strong>{money(balance)} owed</strong><small className="payout-owed-split">Commission {money(commissionOwed)} · Reimbursement {money(reimburseOwed)}</small>{pending > 0 && <div className="hint">{pending} sale{pending === 1 ? '' : 's'} need cost</div>}</div><form className="payment-form" onSubmit={e=>void submit(e)}><label>Amount<input type="text" inputMode="decimal" value={amount} onChange={e=>{ if (moneyEntry.test(e.target.value)) setAmount(e.target.value); }} onBlur={() => { if (amount) setAmount(cleanMoney(amount)); }} required /></label><label>Date<input type="date" value={paidOn} onChange={e=>setPaidOn(e.target.value)} required /></label><label className="payment-note">Note<input type="text" value={note} onChange={e=>setNote(e.target.value.slice(0,500))} placeholder="Optional" /></label><button disabled={busy || !amount}>Paid</button></form></div>{paymentError && <p className="error" role="alert">{paymentError}</p>}<details><summary>Balance breakdown ({entries.length})</summary><div className="ledger-list">{entries.map((e,i)=><div className={`ledger-row${e.overridden ? ' ledger-override' : ''}${e.kind === 'adjustment' ? ' ledger-adjustment' : ''}`} key={i}><div><strong>{kindLabel(e.kind)} · {stamp(e.at)}{e.overridden ? ' · split overridden' : ''}</strong><span>{e.detail}</span>{e.note && <small>{e.note}</small>}{e.ticketKey && e.ticket && (e.kind === 'sale' || e.kind === 'online') && <CommissionOverrideControls client={sb} ticketKey={e.ticketKey} ticket={e.ticket} rules={rules} cfg={cfg} override={e.ticket.commissionOverride} personName={personName} stamp={stamp} money={money} busy={busy} onChanged={next => onCommissionChanged(e.ticketKey!, next)} />}</div><b>{e.amount === null ? 'Needs cost' : (e.amount < 0 ? '−' : '+') + money(Math.abs(e.amount))}</b></div>)}</div></details></section>;
}
function RuleEditor({person,rule,save,busy}:{person:Person;rule?:Rule;save:(id:string,m:Rule['method'],r:number)=>Promise<void>;busy:boolean}) { const [method,setMethod]=useState<Rule['method']>(rule?.method||'percent_sale'); const [rate,setRate]=useState(String(rule?.rate??'')); useEffect(()=>{setMethod(rule?.method||'percent_sale');setRate(String(rule?.rate??''));},[rule]); return <form className="rule-row" onSubmit={e=>{e.preventDefault();void save(person.user_id,method,Number(rate));}}><strong>{person.display_name}</strong><select aria-label={`Cut type for ${person.display_name}`} value={method} onChange={e=>setMethod(e.target.value as Rule['method'])}><option value="percent_sale">Percent of sale</option><option value="flat_ticket">Flat per sale</option><option value="percent_profit">Percent of profit</option></select><label><input type={method==='flat_ticket'?'text':'number'} inputMode="decimal" min={method==='flat_ticket'?undefined:0} max={method==='flat_ticket'?undefined:100} step="0.01" required value={rate} onChange={e=>{ if (method!=='flat_ticket' || moneyEntry.test(e.target.value)) setRate(e.target.value); }} onBlur={() => { if (method==='flat_ticket' && rate) setRate(cleanMoney(rate)); }} />{method==='flat_ticket'?'$':'%'}</label><button disabled={busy}>Save</button></form>; }

function OnlinePayoutSettings({cfg,staff,busy,save}:{cfg:OnlineCfg;staff:Person[];busy:boolean;save:(channels:string[],pct:number,who:string)=>Promise<void>}) {
  const [who,setWho]=useState(cfg.employeeId||''); const [pct,setPct]=useState(String(cfg.pct)); const [channels,setChannels]=useState(cfg.channels.join(', '));
  useEffect(()=>{setWho(cfg.employeeId||'');setPct(String(cfg.pct));setChannels(cfg.channels.join(', '));},[cfg]);
  return <section className="panel"><h2>Online sales payout</h2>
    <p className="hint">Online sales pay this percent of profit: item price + buyer-paid shipping − channel fees − label − card processing − tax owed − real item cost. A missing cost means no payout until you enter one.</p>
    <form className="rule-row" onSubmit={e=>{e.preventDefault();void save(channels.split(/[,\s]+/).map(x=>x.trim().toLowerCase()).filter(Boolean),Number(pct),who);}}>
      <label>Paid to<select value={who} onChange={e=>setWho(e.target.value)} required><option value="" disabled>Choose…</option>{staff.map(p=><option key={p.user_id} value={p.user_id}>{p.display_name}</option>)}</select></label>
      <label>Percent of profit<input type="number" min={0} max={100} step="0.01" required value={pct} onChange={e=>setPct(e.target.value)} />%</label>
      <label>Online channels (comma separated)<input value={channels} onChange={e=>setChannels(e.target.value)} placeholder="website, ebay, depop, amazon, tiktok" /></label>
      <button disabled={busy||!who}>Save</button></form></section>;
}
