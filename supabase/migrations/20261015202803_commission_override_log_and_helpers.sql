create table public.portal_commission_override_log (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  ticket_key text not null,
  changed_at timestamptz not null default now(),
  changed_by uuid not null references auth.users(id),
  action text not null check (action in ('set', 'flip', 'reset')),
  old_paul_pct numeric(10,2),
  old_jacob_pct numeric(10,2),
  new_paul_pct numeric(10,2),
  new_jacob_pct numeric(10,2),
  was_override boolean not null default false,
  reason text
);

create index portal_commission_override_log_ticket_idx
  on public.portal_commission_override_log(store_id, ticket_key, changed_at desc);

alter table public.portal_commission_overrides enable row level security;
alter table public.portal_commission_override_log enable row level security;

revoke all on public.portal_commission_overrides from public, anon, authenticated;
revoke all on public.portal_commission_override_log from public, anon, authenticated;

grant select on public.portal_commission_overrides to authenticated;
grant select on public.portal_commission_override_log to authenticated;

drop policy if exists portal_commission_override_select on public.portal_commission_overrides;
create policy portal_commission_override_select on public.portal_commission_overrides
  for select to authenticated
  using (store_id = public.portal_store_id());

drop policy if exists portal_commission_override_log_select on public.portal_commission_override_log;
create policy portal_commission_override_log_select on public.portal_commission_override_log
  for select to authenticated
  using (store_id = public.portal_store_id());

create or replace function public.portal_ticket_exists(p_store uuid, p_ticket_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.sales s
    where s.store_id = p_store
      and s.voided_at is null
      and coalesce(s.ticket_id::text, 'sale:' || s.id::text) = p_ticket_key
  );
$$;
revoke all on function public.portal_ticket_exists(uuid, text) from public, anon;
grant execute on function public.portal_ticket_exists(uuid, text) to authenticated;

create or replace function public.portal_default_commission_split(p_store uuid, p_ticket_key text)
returns table (paul_pct numeric, jacob_pct numeric, online boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_channel text;
  v_online_pct numeric;
  v_paul uuid := 'f17e6163-b10a-4fe1-a373-75c0094e5363'::uuid;
  v_jacob uuid := 'c851c8ee-2cc2-490f-935f-1e2d7e093d88'::uuid;
  v_paul_rate numeric := 0;
  v_jacob_rate numeric := 0;
  v_is_online boolean := false;
begin
  select lower(s.channel) into v_channel
  from public.sales s
  where s.store_id = p_store and s.voided_at is null
    and coalesce(s.ticket_id::text, 'sale:' || s.id::text) = p_ticket_key
  order by s.id
  limit 1;

  if v_channel is null then
    raise exception 'invalid_payout_ticket' using errcode = '22023';
  end if;

  v_online_pct := coalesce((public.store_setting(p_store, 'online_payout_pct', '0'::jsonb) #>> '{}')::numeric, 0);
  v_is_online := v_channel = any (public.setting_text_array(p_store, 'online_channels'));

  if v_is_online then
    return query select v_online_pct, 0::numeric, true;
    return;
  end if;

  select coalesce(r.rate, 0) into v_paul_rate
  from public.portal_payout_rules r
  where r.store_id = p_store and r.employee_id = v_paul;

  select coalesce(r.rate, 0) into v_jacob_rate
  from public.portal_payout_rules r
  where r.store_id = p_store and r.employee_id = v_jacob;

  return query select coalesce(v_paul_rate, 0), coalesce(v_jacob_rate, 0), false;
end;
$$;
revoke all on function public.portal_default_commission_split(uuid, text) from public, anon;
grant execute on function public.portal_default_commission_split(uuid, text) to authenticated;