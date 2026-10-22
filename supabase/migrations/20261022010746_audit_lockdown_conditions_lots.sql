-- Audit lockdown: anon must not read the ledger, service-only RPCs leave the
-- public API, clerks cannot read payout math, condition spellings collapse
-- to the store list, and listing_lots (already live) is captured here.
-- Also opens delist reminders for units already sold but still listed on
-- Depop or Whatnot, which have no delist API.

create or replace function public.portal_financial_access()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_manager()
      or exists (
        select 1
        from public.portal_admins a
        where a.user_id = auth.uid()
      );
$$;

revoke all on function public.portal_financial_access() from public, anon, authenticated;
grant execute on function public.portal_financial_access() to service_role;

do $$
declare
  fn text;
  def text;
begin
  foreach fn in array array['portal_payout_sales()', 'portal_payout_adjustments()', 'portal_payout_config()']
  loop
    def := pg_get_functiondef(fn::regprocedure);
    def := replace(
      def,
      'if v_store is null then raise exception ''portal_access_denied'' using errcode = ''42501''; end if;',
      'if v_store is null or not public.portal_financial_access() then raise exception ''portal_access_denied'' using errcode = ''42501''; end if;'
    );
    if def not like '%portal_financial_access%' then
      raise exception 'payout guard was not applied to %', fn;
    end if;
    execute def;
  end loop;
end $$;

revoke all on table public.sale_ledger from public, anon, authenticated;
grant select on table public.sale_ledger to service_role;

revoke all on table public.sale_receipts from anon;
revoke all on table public.units_pos from anon;

revoke all on table public.public_items from public, anon, authenticated;
grant select on table public.public_items to anon, authenticated;

revoke all on table public.public_categories from public, anon, authenticated;
grant select on table public.public_categories to anon, authenticated;

-- Internal helpers. Callers are security-definer functions (owner) or service_role.
do $$
declare
  r record;
begin
  for r in
    select p.proname, pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (
        pg_get_functiondef(p.oid) ilike '%if auth.role() <> ''service_role'' then raise exception%'
        or pg_get_functiondef(p.oid) ilike '%if auth.role() <> ''service_role'' then%raise exception%'
        or p.proname in (
          'steal_open_web_orders',
          'seed_store_settings',
          'adopt_orphan_inventory',
          'save_store_categories',
          'release_expired_reservations'
        )
      )
  loop
    execute format(
      'revoke all on function public.%I(%s) from public, anon, authenticated',
      r.proname,
      r.args
    );
    execute format(
      'grant execute on function public.%I(%s) to service_role',
      r.proname,
      r.args
    );
  end loop;
end $$;

create or replace function public.normalize_unit_condition()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.condition is null then
    return new;
  end if;
  new.condition := case lower(btrim(replace(new.condition, '_', ' ')))
    when 'open box' then 'Open box'
    when 'new' then 'New'
    when 'excellent' then 'Excellent'
    when 'good' then 'Good'
    when 'fair' then 'Fair'
    when 'for parts' then 'For parts'
    else new.condition
  end;
  return new;
end $$;

drop trigger if exists units_normalize_condition on public.units;
create trigger units_normalize_condition
before insert or update of condition on public.units
for each row execute function public.normalize_unit_condition();

update public.units
set condition = case lower(btrim(replace(condition, '_', ' ')))
  when 'open box' then 'Open box'
  when 'new' then 'New'
  when 'excellent' then 'Excellent'
  when 'good' then 'Good'
  when 'fair' then 'Fair'
  when 'for parts' then 'For parts'
  else condition
end
where condition is not null
  and condition is distinct from case lower(btrim(replace(condition, '_', ' ')))
    when 'open box' then 'Open box'
    when 'new' then 'New'
    when 'excellent' then 'Excellent'
    when 'good' then 'Good'
    when 'fair' then 'Fair'
    when 'for parts' then 'For parts'
    else condition
  end;

create table if not exists public.listing_lots (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  key text not null,
  title text not null,
  primary_sku text not null,
  channel text not null default 'ebay',
  listing_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint listing_lots_channel_ok check (channel = lower(btrim(channel))),
  constraint listing_lots_store_id_key_key unique (store_id, key)
);

create table if not exists public.listing_lot_members (
  lot_id uuid not null references public.listing_lots(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  sku text not null,
  primary key (lot_id, sku),
  constraint listing_lot_members_store_id_sku_key unique (store_id, sku)
);

create index if not exists listing_lot_members_store_sku_idx
  on public.listing_lot_members (store_id, sku);

alter table public.listing_lots enable row level security;
alter table public.listing_lot_members enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'listing_lots' and policyname = 'portal_listing_lots'
  ) then
    create policy portal_listing_lots on public.listing_lots
      for all to authenticated
      using (store_id = public.portal_store_id())
      with check (store_id = public.portal_store_id());
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'listing_lot_members' and policyname = 'portal_listing_lot_members'
  ) then
    create policy portal_listing_lot_members on public.listing_lot_members
      for all to authenticated
      using (store_id = public.portal_store_id())
      with check (store_id = public.portal_store_id());
  end if;
end $$;

insert into public.delist_tasks (store_id, sku, channel, nag_after)
select l.store_id, l.sku, l.channel, now()
from public.listings l
join public.units u on u.store_id = l.store_id and u.sku = l.sku
where l.status = 'listed'
  and u.state = 'sold'
  and l.channel in ('depop', 'whatnot')
  and not exists (
    select 1
    from public.delist_tasks d
    where d.store_id = l.store_id
      and d.sku = l.sku
      and d.channel = l.channel
      and d.completed_at is null
  );
