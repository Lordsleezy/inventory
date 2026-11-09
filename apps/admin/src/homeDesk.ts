import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeReport, monthLabel } from './books/booksMath';
import { loadBooksPayoutContext, loadCommissionOverrides } from './books/loadPayoutContext';
import { canonicalPersonKey, mergeEmployeeIds } from './books/personMerge';
import { computePayoutPersonBalances, loadPayoutLedgerData } from './books/payoutLedger';
import type { InventorySummary, Period, ReceivedItem, Report } from './books/types';
import { buildBooksWorkbook, loadBooksMoney } from './books/workbook';
import type { DeskPulse } from './deskPulse';
import { floorFunctionUrl } from './floorApi';
import { isBuyerKeeps, isReplacementReturn, type ReturnRow } from './returns/returnsShared';

export type OwedPerson = { name: string; cents: number };
export type ChannelLine = { name: string; detail: string; when: string };
export type HomeDesk = {
  missingCost: number | null;
  returnsUntracked: number | null;
  owed: OwedPerson[];
  channels: ChannelLine[];
  booksIssues: { count: number; month: string } | null;
};

const emptyInventory = (): InventorySummary => ({
  start_unit_count: 0, end_unit_count: 0, start_source: 'approximate', end_source: 'approximate',
  sold_units: 0, received_units: 0, return_to_stock_units: 0, giveaway_units: 0, replacement_units: 0, return_count: 0, defective_units: 0,
  giveaways: [], replacements: [], returns: [], defective_moves: [],
});

function laToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

function whenLabel(iso: string | null | undefined) {
  if (!iso) return '—';
  const day = new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  if (day === laToday()) return 'Today';
  return `Synced ${new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' })}`;
}

async function catalog(token: string, channel: string) {
  const res = await fetch(floorFunctionUrl('listing-manager'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'board_catalog', channel }),
  });
  if (!res.ok) return null;
  return await res.json() as {
    listed?: unknown[];
    not_listed?: unknown[];
    connected?: boolean;
    last_synced?: { at?: string } | null;
  };
}

async function booksIssues(client: SupabaseClient, storeId: string) {
  const today = laToday();
  const listed = await client.rpc('portal_books_list', { p_from: '2026-01-01', p_to: today });
  if (listed.error) return null;
  const periods = ((listed.data || []) as Period[]).filter((p) => p.period_type === 'month');
  const current = periods.find((p) => p.period_start <= today && p.period_end >= today) || periods.sort((a, b) => b.period_start.localeCompare(a.period_start))[0];
  if (!current) return null;
  const reportRes = await client.rpc('portal_books_report', { p_period: current.id });
  if (reportRes.error) return null;
  const [invRes, recRes, money, ctx, overrides] = await Promise.all([
    client.rpc('portal_books_inventory_summary', { p_period: current.id }),
    client.rpc('portal_books_items_received', { p_period: current.id }),
    loadBooksMoney(client, current.period_start),
    loadBooksPayoutContext(client, storeId),
    loadCommissionOverrides(client, storeId),
  ]);
  const inventory = { ...emptyInventory(), ...((invRes.data || {}) as InventorySummary) };
  const received = (recRes.data || []) as ReceivedItem[];
  const report = { ...normalizeReport(reportRes.data as Report), inventory_summary: inventory, items_received: received };
  const ledgerRaw = await loadPayoutLedgerData(client, storeId, overrides);
  const balances = computePayoutPersonBalances({
    staff: ctx.staff,
    peopleSlots: ctx.peopleSlots,
    rules: ctx.rules,
    cfg: ctx.cfg,
    frozen: ctx.frozen,
    ...ledgerRaw,
  });
  const ids = mergeEmployeeIds(ctx.staff, ctx.peopleSlots);
  const paulIds = ctx.staff.filter((s) => canonicalPersonKey(s.display_name, s.email) === 'paul').map((s) => s.user_id);
  const jacobIds = ctx.staff.filter((s) => canonicalPersonKey(s.display_name, s.email) === 'jacob').map((s) => s.user_id);
  if (ids.paulId && !paulIds.includes(ids.paulId)) paulIds.push(ids.paulId);
  if (ids.jacobId && !jacobIds.includes(ids.jacobId)) jacobIds.push(ids.jacobId);
  const workbook = buildBooksWorkbook({
    report, inventory, received, payoutCtx: ctx, overrides, money,
    duplicateHidden: new Set(), duplicateDecisions: {},
    ledgerBalances: balances, paulIds, jacobIds,
  });
  const issues = [
    ...(workbook.integrity && !workbook.integrity.ok ? workbook.integrity.issues : []),
    ...(workbook.exportTieIssues || []),
  ];
  return { count: issues.length, month: monthLabel(current.period_start).replace(/\s+\d{4}$/, '') };
}

export async function loadHomeDesk(client: SupabaseClient, token: string, storeId: string, pulse: DeskPulse): Promise<HomeDesk> {
  const [missing, returns, owed, ebay, amazon, tiktok, books] = await Promise.all([
    client.rpc('portal_units_missing_cost', { p_limit: 1, p_offset: 0 }).then((res) => res.error ? null : Number((res.data as { total?: number })?.total || 0)),
    client.rpc('portal_return_desk', { p_filter: 'open', p_query: null, p_from: null, p_to: laToday() }).then((res) => {
      if (res.error) return null;
      const rows = ((res.data as { rows?: ReturnRow[] })?.rows || []);
      return rows.filter((row) => !isReplacementReturn(row) && !isBuyerKeeps(row) && !String(row.tracking_number || '').trim()).length;
    }),
    loadOwed(client, storeId),
    catalog(token, 'ebay').catch(() => null),
    catalog(token, 'amazon').catch(() => null),
    catalog(token, 'tiktok').catch(() => null),
    booksIssues(client, storeId).catch(() => null),
  ]);

  const ebayListed = ebay?.listed?.length ?? pulse.ebayListed;
  const amazonListed = amazon?.listed?.length ?? 0;
  const amazonReady = amazon?.not_listed?.length ?? 0;
  const channels: ChannelLine[] = [
    { name: 'eBay', detail: ebayListed == null ? '—' : `${ebayListed.toLocaleString('en-US')} listed`, when: whenLabel(ebay?.last_synced?.at) },
    { name: 'Depop', detail: pulse.depopListed == null ? '—' : `${pulse.depopListed.toLocaleString('en-US')} live`, when: '—' },
    {
      name: 'Amazon',
      detail: amazon?.connected === false ? 'Not connected' : `${amazonListed.toLocaleString('en-US')} live · ${amazonReady.toLocaleString('en-US')} ready`,
      when: amazon?.connected === false ? '—' : whenLabel(amazon?.last_synced?.at),
    },
    { name: 'TikTok', detail: tiktok?.connected === false ? 'Not connected' : `${(tiktok?.listed?.length || 0).toLocaleString('en-US')} live`, when: tiktok?.connected === false ? '—' : whenLabel(tiktok?.last_synced?.at) },
    { name: 'Dropship', detail: pulse.dropship || '—', when: '—' },
  ];
  return { missingCost: missing, returnsUntracked: returns, owed, channels, booksIssues: books };
}

async function loadOwed(client: SupabaseClient, storeId: string): Promise<OwedPerson[]> {
  const [ctx, overrides] = await Promise.all([
    loadBooksPayoutContext(client, storeId),
    loadCommissionOverrides(client, storeId),
  ]);
  const ledger = await loadPayoutLedgerData(client, storeId, overrides);
  const balances = computePayoutPersonBalances({
    staff: ctx.staff, peopleSlots: ctx.peopleSlots, rules: ctx.rules, cfg: ctx.cfg, frozen: ctx.frozen, ...ledger,
  });
  const names = new Map(ctx.staff.map((s) => [s.user_id, s.display_name]));
  const rank = (name: string) => {
    const key = canonicalPersonKey(name);
    return key === 'paul' ? 0 : key === 'jacob' ? 1 : 2;
  };
  return balances
    .map((row) => ({ name: names.get(row.user_id) || 'Staff', cents: row.balance }))
    .filter((row) => row.cents !== 0)
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}
