import type { SupabaseClient } from '@supabase/supabase-js';
import type { CommissionOverride, OnlineCfg, Rule } from '../payouts';
import type { BooksPayoutContext, FrozenMap } from './types';

export async function loadFrozenCommissions(client: SupabaseClient): Promise<FrozenMap> {
  const map: FrozenMap = new Map();
  for (let offset = 0;; offset += 1000) {
    const res = await client.rpc('portal_payout_commissions').range(offset, offset + 999);
    if (res.error) {
      if (/portal_payout_commissions|PGRST202|404|does not exist/i.test(res.error.message)) return map;
      throw res.error;
    }
    const batch = (res.data || []) as { ticket_key: string; employee_id: string; amount_cents: number | null }[];
    for (const row of batch) map.set(`${row.ticket_key}|${row.employee_id}`, row.amount_cents);
    if (batch.length < 1000) return map;
  }
}

export async function loadCommissionOverrides(client: SupabaseClient, storeId: string): Promise<Map<string, CommissionOverride>> {
  const map = new Map<string, CommissionOverride>();
  for (let offset = 0;; offset += 1000) {
    const res = await client.from('portal_commission_overrides').select('ticket_key,paul_pct,jacob_pct').eq('store_id', storeId).range(offset, offset + 999);
    if (res.error) {
      if (/portal_commission_overrides|does not exist/i.test(res.error.message || '')) return map;
      throw res.error;
    }
    for (const row of (res.data || []) as { ticket_key: string; paul_pct: number; jacob_pct: number }[]) {
      map.set(row.ticket_key, { paulPct: Number(row.paul_pct), jacobPct: Number(row.jacob_pct) });
    }
    if ((res.data || []).length < 1000) return map;
  }
}

export async function loadBooksPayoutContext(client: SupabaseClient, storeId: string): Promise<BooksPayoutContext> {
  const [cfgRes, rulesRes, peopleRes, staffRes, frozen] = await Promise.all([
    client.rpc('portal_payout_config'),
    client.from('portal_payout_rules').select('employee_id,method,rate').eq('store_id', storeId),
    client.from('store_payout_people').select('slot,employee_id').eq('store_id', storeId),
    client.from('staff').select('user_id,display_name').eq('store_id', storeId),
    loadFrozenCommissions(client),
  ]);
  if (cfgRes.error) throw cfgRes.error;
  if (rulesRes.error) throw rulesRes.error;
  const cfgRaw = cfgRes.data as { online_channels: string[]; online_payout_pct: number; online_payout_employee_id: string | null; absorb_fees?: boolean };
  const slots = Object.fromEntries(((peopleRes.data || []) as { slot: string; employee_id: string }[]).map((x) => [x.slot, x.employee_id]));
  const cfg: OnlineCfg = {
    channels: (cfgRaw.online_channels || []).map((s) => String(s).toLowerCase()),
    pct: Number(cfgRaw.online_payout_pct) || 0,
    employeeId: cfgRaw.online_payout_employee_id,
    slots,
    absorbFees: cfgRaw.absorb_fees !== false,
  };
  if (staffRes.error) throw staffRes.error;
  const rules = (rulesRes.data || []) as Rule[];
  const staff = (staffRes.data || []) as { user_id: string; display_name: string; email?: string | null }[];
  const peopleSlots = (peopleRes.data || []) as { slot: string; employee_id: string | null }[];
  return { rules, cfg, frozen, staff, peopleSlots };
}
