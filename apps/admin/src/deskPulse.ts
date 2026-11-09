import type { SupabaseClient } from '@supabase/supabase-js';
import { floorFunctionUrl } from './floorApi';
import { orderStage, type StageOrder } from './orderStage';
import { isReplacementReturn, type ReturnRow } from './returns/returnsShared';

export type DeskPulse = {
  toShip: number | null;
  needsLabel: number | null;
  openReturns: number | null;
  listingIssues: number | null;
  salesToday: number | null;
  salesCents: number | null;
  recentSales: { at: string; title: string; channel: string; price_cents: number }[];
  ebayListed: number | null;
  depopListed: number | null;
  dropship: string | null;
};

export function emptyPulse(): DeskPulse {
  return {
    toShip: null,
    needsLabel: null,
    openReturns: null,
    listingIssues: null,
    salesToday: null,
    salesCents: null,
    recentSales: [],
    ebayListed: null,
    depopListed: null,
    dropship: null,
  };
}

function laDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Counts the portal already knows how to load. A failed call leaves that number blank. */
export async function loadDeskPulse(
  client: SupabaseClient,
  accessToken: string,
  salesFrom: string,
  salesTo: string,
): Promise<DeskPulse> {
  const pulse = emptyPulse();
  const [orders, returns, issues, sales, counts, drop] = await Promise.allSettled([
    client.rpc('portal_web_orders', { p_days: 400 }),
    client.rpc('portal_return_desk', { p_filter: 'open', p_query: null, p_from: null, p_to: laDate() }),
    client.rpc('portal_listing_issues', { p_limit: 200 }),
    client.rpc('portal_sales', { p_from: salesFrom, p_to: salesTo }),
    client.rpc('portal_online_channel_counts'),
    fetch(floorFunctionUrl('dropship-admin'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'desk' }),
    }).then(async (res) => (res.ok ? res.json() : null)),
  ]);

  if (orders.status === 'fulfilled' && !orders.value.error && Array.isArray(orders.value.data)) {
    const rows = (orders.value.data as StageOrder[]).filter((o) => {
      const row = o as StageOrder & { payment_env?: string | null; order_no?: string | null };
      return row.payment_env !== 'sandbox' && !(row.order_no || '').toLowerCase().startsWith('sandbox');
    });
    pulse.toShip = rows.filter((o) => orderStage(o) === 'toShip').length;
    pulse.needsLabel = rows.filter((o) => orderStage(o) === 'needsLabel').length;
  }
  if (returns.status === 'fulfilled' && !returns.value.error) {
    const body = (returns.value.data || {}) as { rows?: ReturnRow[] };
    pulse.openReturns = (body.rows || []).filter((r) => !isReplacementReturn(r)).length;
  }
  if (issues.status === 'fulfilled' && !issues.value.error && Array.isArray(issues.value.data)) {
    pulse.listingIssues = issues.value.data.length;
  }
  if (sales.status === 'fulfilled' && !sales.value.error && Array.isArray(sales.value.data)) {
    const lines = sales.value.data as { ticket_key?: string; title?: string; channel?: string; price_cents?: number; sold_at?: string }[];
    const tickets = new Map<string, { at: string; title: string; channel: string; price_cents: number }>();
    for (const line of lines) {
      const key = line.ticket_key || '';
      if (!key) continue;
      const row = tickets.get(key) || { at: String(line.sold_at || ''), title: String(line.title || 'Sale'), channel: String(line.channel || ''), price_cents: 0 };
      row.price_cents += Number(line.price_cents || 0);
      if (String(line.sold_at || '') > row.at) row.at = String(line.sold_at || '');
      if (!row.title && line.title) row.title = line.title;
      tickets.set(key, row);
    }
    pulse.salesToday = tickets.size;
    pulse.salesCents = [...tickets.values()].reduce((n, row) => n + row.price_cents, 0);
    pulse.recentSales = [...tickets.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 4);
  }
  if (counts.status === 'fulfilled' && !counts.value.error && counts.value.data && typeof counts.value.data === 'object') {
    const row = counts.value.data as Record<string, number>;
    pulse.ebayListed = Number.isFinite(Number(row.ebay)) ? Number(row.ebay) : null;
    pulse.depopListed = Number.isFinite(Number(row.depop)) ? Number(row.depop) : null;
  }
  if (drop.status === 'fulfilled' && drop.value && typeof drop.value === 'object') {
    const desk = drop.value as { enabled?: boolean; paused?: boolean };
    pulse.dropship = !desk.enabled ? 'Off' : desk.paused ? 'Paused' : 'On';
  }
  return pulse;
}
