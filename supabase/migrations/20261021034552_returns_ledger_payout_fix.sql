-- Fix returns money bugs:
-- 1) Ledger: when a sale is voided, post ONLY extra return costs (label/fees/regrade), never the refund.
-- 2) Payouts: if commission was already paid, insert a negative adjustment (never rewrite payment history).

begin;

-- ---------------------------------------------------------------------------
-- Payout adjustments (clawbacks / credits). Positive = we owe them more;
-- negative = reduce running balance (return clawback).
-- ---------------------------------------------------------------------------
create table if not exists public.portal_payout_adjustments (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  employee_id uuid not null references auth.users(id),
  amount_cents int not null check (amount_cents <> 0),
  reason text not null,
  -- FK to returns added in 20261021034908 after public.returns exists (CI migrate order).
  return_id uuid,
  sale_id bigint references public.sales(id) on delete set null,
  ticket_key text,
  -- Full commission on the sale before refund fraction (for Payouts UI add-back).
  sale_commission_cents int,
  created_at timestamptz not null default now(),
  created_by uuid,
  unique (store_id, return_id, employee_id)
);

create index if not exists portal_payout_adjustments_employee_idx
  on public.portal_payout_adjustments (store_id, employee_id, created_at desc);

alter table public.portal_payout_adjustments enable row level security;
drop policy if exists portal_payout_adjustments_select on public.portal_payout_adjustments;
create policy portal_payout_adjustments_select on public.portal_payout_adjustments
  for select to authenticated
  using (store_id = public.portal_store_id());
revoke all on public.portal_payout_adjustments from public, anon;
grant select on public.portal_payout_adjustments to authenticated;
grant all on public.portal_payout_adjustments to service_role;

create or replace function public.portal_payout_adjustments()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null or not public.portal_financial_access() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(to_jsonb(a) order by a.created_at desc)
    from public.portal_payout_adjustments a
    where a.store_id = v_store
  ), '[]'::jsonb);
end $$;
revoke all on function public.portal_payout_adjustments() from public, anon;
grant execute on function public.portal_payout_adjustments() to authenticated;

-- ---------------------------------------------------------------------------
-- Commission owed on one sale for one employee (mirrors apps/admin payouts.ts).
-- ---------------------------------------------------------------------------
create or replace function public.sale_commission_cents(
  p_store uuid,
  p_sale_id bigint,
  p_employee uuid
) returns int language plpgsql stable security definer set search_path = public as $$
declare
  s public.sales;
  v_cost int;
  v_ship int;
  v_base int;
  v_ticket text;
  v_channel text;
  v_online_channels jsonb;
  v_online_pct numeric;
  v_online_emp uuid;
  v_is_online boolean := false;
  v_ov record;
  v_rule record;
  v_rate numeric;
  v_paul uuid := 'f17e6163-b10a-4fe1-a373-75c0094e5363'::uuid;
  v_jacob uuid := 'c851c8ee-2cc2-490f-935f-1e2d7e093d88'::uuid;
begin
  select * into s from public.sales where id = p_sale_id and store_id = p_store;
  if not found then return 0; end if;

  select coalesce(acquisition_cost_cents, case when is_collectible then 0 else null end)
    into v_cost from public.units where store_id = p_store and sku = s.sku;
  if v_cost is null then return null; end if; -- cannot compute

  v_ship := coalesce(s.shipping_cents, 0);
  v_base := greatest(0, s.price_cents + v_ship - v_cost);
  v_ticket := coalesce(s.ticket_id::text, 'sale:' || s.id::text);
  v_channel := lower(coalesce(s.channel, ''));

  select value into v_online_channels from public.store_settings
   where store_id = p_store and key = 'online_payout_channels';
  if v_online_channels is null then
    select value into v_online_channels from public.store_settings
     where store_id = p_store and key = 'online_channels';
  end if;
  v_online_pct := coalesce((public.store_setting(p_store, 'online_payout_pct', '0'::jsonb) #>> '{}')::numeric, 0);
  begin
    v_online_emp := nullif(public.store_setting(p_store, 'online_payout_employee_id', 'null'::jsonb) #>> '{}', '')::uuid;
  exception when others then v_online_emp := null;
  end;

  if v_online_channels is not null and jsonb_typeof(v_online_channels) = 'array' then
    select exists (
      select 1 from jsonb_array_elements_text(v_online_channels) x
      where lower(btrim(x)) = v_channel
    ) into v_is_online;
  end if;

  select * into v_ov from public.portal_commission_overrides
   where store_id = p_store and ticket_key = v_ticket;
  if found then
    if p_employee = v_paul then
      return round(v_base * coalesce(v_ov.paul_pct, 0) / 100.0)::int;
    elsif p_employee = v_jacob then
      return round(v_base * coalesce(v_ov.jacob_pct, 0) / 100.0)::int;
    else
      return 0;
    end if;
  end if;

  if v_is_online then
    if p_employee is distinct from v_online_emp then return 0; end if;
    return round(v_base * v_online_pct / 100.0)::int;
  end if;

  select * into v_rule from public.portal_payout_rules
   where store_id = p_store and employee_id = p_employee;
  if not found then return 0; end if;

  if v_rule.method = 'flat_ticket' then
    return round(v_rule.rate * 100)::int;
  end if;
  if v_rule.method = 'percent_profit' then
    v_rate := v_rule.rate;
    return round(v_base * v_rate / 100.0)::int;
  end if;
  -- percent_sale
  return round(s.price_cents * v_rule.rate / 100.0)::int;
end $$;

revoke all on function public.sale_commission_cents(uuid, bigint, uuid) from public, anon;
grant execute on function public.sale_commission_cents(uuid, bigint, uuid) to service_role;

commit;
