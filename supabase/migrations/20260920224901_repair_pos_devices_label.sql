-- Repair schema drift from pre-0025 pos_register tables.
-- CREATE TABLE IF NOT EXISTS in 0025 skipped when pos_devices / card_charges
-- already existed with different columns (display_name vs label, NOT NULLs, etc.).

-- ---------------------------------------------------------------------------
-- pos_devices → 0025 shape
-- ---------------------------------------------------------------------------
alter table public.pos_devices
  add column if not exists label text;

-- Backfill from legacy display_name when present.
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'pos_devices' and column_name = 'display_name'
  ) then
    execute $q$
      update public.pos_devices
         set label = coalesce(nullif(btrim(label), ''), nullif(btrim(display_name), ''), 'Phone reader')
       where label is null or btrim(label) = ''
    $q$;
  else
    update public.pos_devices
       set label = coalesce(nullif(btrim(label), ''), 'Phone reader')
     where label is null or btrim(label) = '';
  end if;
end;
$$;

-- Drop legacy upsert heartbeat that writes display_name (phone uses p_device_id uuid only).
drop function if exists public.heartbeat_pos_device(uuid, text, text, text);

alter table public.pos_devices alter column pair_code drop not null;
alter table public.pos_devices alter column last_seen drop not null;

-- Replace composite unique with 0025 partial unique on pair_code.
drop index if exists public.ux_pos_devices_pair_code;
create unique index if not exists ux_pos_devices_pair_code
  on public.pos_devices (pair_code)
  where pair_code is not null;

do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'pos_devices' and column_name = 'display_name'
  ) then
    alter table public.pos_devices drop column display_name;
  end if;
end;
$$;

-- Re-assert register_pos_reader / heartbeat against repaired columns.
create or replace function public.register_pos_reader(p_label text default 'Phone reader')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
  v_code text;
  v_id uuid;
begin
  perform public.assert_staff_or_service();
  if v_store is null then
    raise exception 'no_store' using errcode = 'P0001';
  end if;
  v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
  insert into public.pos_devices (store_id, kind, label, pair_code, last_seen)
  values (v_store, 'phone_reader', coalesce(nullif(btrim(p_label), ''), 'Phone reader'), v_code, now())
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'pair_code', v_code);
end;
$$;

create or replace function public.heartbeat_pos_device(p_device_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_staff_or_service();
  update public.pos_devices
     set last_seen = now()
   where id = p_device_id
     and store_id = public.current_store_id();
end;
$$;

grant execute on function public.register_pos_reader(text) to authenticated;
grant execute on function public.heartbeat_pos_device(uuid) to authenticated;

drop policy if exists staff_pos_devices on public.pos_devices;
drop policy if exists pos_devices_staff on public.pos_devices;
create policy pos_devices_staff on public.pos_devices for all to authenticated
  using (public.is_store_staff(store_id))
  with check (public.is_store_staff(store_id));

-- ---------------------------------------------------------------------------
-- card_charges → 0025/0028 nullability + checks
-- ---------------------------------------------------------------------------
alter table public.card_charges alter column device_id drop not null;
alter table public.card_charges alter column sku drop not null;
alter table public.card_charges alter column actor_id drop not null;
alter table public.card_charges alter column status set default 'pending';

alter table public.card_charges drop constraint if exists card_charges_amount_cents_check;
alter table public.card_charges
  add constraint card_charges_amount_cents_check check (amount_cents >= 0);

alter table public.card_charges drop constraint if exists card_charges_tax_cents_check;
alter table public.card_charges
  add constraint card_charges_tax_cents_check check (tax_cents >= 0);

alter table public.card_charges
  add column if not exists ticket_id uuid,
  add column if not exists reservation_id uuid,
  add column if not exists lines jsonb,
  add column if not exists card_brand text,
  add column if not exists card_last4 text;

alter table public.card_charges drop constraint if exists card_charges_status_check;
alter table public.card_charges
  add constraint card_charges_status_check
  check (status in ('pending', 'captured', 'finalized', 'failed', 'canceled', 'finalize_failed'));

drop index if exists public.ix_card_charges_device_pending;
create index if not exists ix_card_charges_device_pending
  on public.card_charges (device_id, status)
  where status = 'pending';

drop policy if exists staff_card_charges on public.card_charges;
drop policy if exists card_charges_staff on public.card_charges;
create policy card_charges_staff on public.card_charges for all to authenticated
  using (public.is_store_staff(store_id))
  with check (public.is_store_staff(store_id));

-- ---------------------------------------------------------------------------
-- square_connections: ensure location_name + lockdown (idempotent)
-- ---------------------------------------------------------------------------
alter table public.square_connections
  add column if not exists location_name text;

alter table public.square_connections enable row level security;
alter table public.square_connections force row level security;
revoke all on table public.square_connections from public, anon, authenticated;
grant all on table public.square_connections to postgres, service_role;

do $$
declare
  pol record;
begin
  for pol in
    select policyname
      from pg_policies
     where schemaname = 'public' and tablename = 'square_connections'
  loop
    execute format('drop policy if exists %I on public.square_connections', pol.policyname);
  end loop;
end;
$$;

-- Ensure status RPC exists (Settings "Not connected" reads this).
create or replace function public.my_square_connection_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
  r public.square_connections;
begin
  if v_store is null then
    return null;
  end if;
  select * into r from public.square_connections where store_id = v_store;
  if not found then
    return jsonb_build_object('connected', false);
  end if;
  return jsonb_build_object(
    'connected', true,
    'merchant_id', r.merchant_id,
    'location_id', r.location_id,
    'location_name', r.location_name,
    'expires_at', r.expires_at,
    'sandbox', r.sandbox,
    'updated_at', r.updated_at
  );
end;
$$;

grant execute on function public.my_square_connection_status() to authenticated;

-- ---------------------------------------------------------------------------
-- sales ticket / card columns (0024 + 0028) — idempotent
-- ---------------------------------------------------------------------------
alter table public.sales
  add column if not exists ticket_id uuid,
  add column if not exists list_price_cents int,
  add column if not exists override_reason text,
  add column if not exists override_by uuid references auth.users (id),
  add column if not exists card_brand text,
  add column if not exists card_last4 text;

alter table public.approvals
  add column if not exists ticket_id uuid;
