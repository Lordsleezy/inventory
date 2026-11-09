import type { SupabaseClient } from '@supabase/supabase-js';
import { loadOwedPeople, type OwedPerson } from './homeDesk';

export type OwnerHomePayload = {
  salesTodayCents: number;
  salesTodayCount: number;
  safeCents: number | null;
  recentSales: { at: string; title: string; channel: string; price_cents: number }[];
  owed: OwedPerson[];
};

export async function loadOwnerHome(client: SupabaseClient, accessToken: string, storeId: string): Promise<OwnerHomePayload> {
  void accessToken;
  const [homeRes, owed] = await Promise.all([
    client.rpc('portal_owner_home'),
    loadOwedPeople(client, storeId).catch(() => [] as OwedPerson[]),
  ]);
  if (homeRes.error) throw homeRes.error;
  const body = (homeRes.data || {}) as {
    sales_today_cents?: number;
    sales_today_count?: number;
    safe_cents?: number | null;
    recent_sales?: { at: string; title: string; channel: string; price_cents: number }[];
  };
  return {
    salesTodayCents: Number(body.sales_today_cents || 0),
    salesTodayCount: Number(body.sales_today_count || 0),
    safeCents: body.safe_cents == null ? null : Number(body.safe_cents),
    recentSales: Array.isArray(body.recent_sales) ? body.recent_sales : [],
    owed,
  };
}
