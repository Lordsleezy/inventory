-- Multi-store tenancy. Do not edit 0001–0005; this file is additive.
-- Seed still creates no store and no named identity. The first store is
-- created by signup_create_store in 0007.

create extension if not exists pgcrypto;

create table if not exists public.stores (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);

create table if not exists public.store_settings (
  store_id uuid not null references public.stores (id) on delete cascade,
  key      text not null,
  value    jsonb not null,
  primary key (store_id, key)
);

alter table public.staff add column if not exists store_id uuid references public.stores (id);
alter table public.staff drop constraint if exists staff_role_check;
alter table public.staff add constraint staff_role_check
  check (role in ('owner', 'manager', 'staff'));
alter table public.staff add column if not exists notify_email boolean not null default true;
alter table public.staff add column if not exists notify_push boolean not null default false;
alter table public.staff add column if not exists delist_duty boolean not null default true;

alter table public.sku_ledger add column if not exists store_id uuid references public.stores (id);
alter table public.units add column if not exists store_id uuid references public.stores (id);
alter table public.sales add column if not exists store_id uuid references public.stores (id);
alter table public.reservations add column if not exists store_id uuid references public.stores (id);
alter table public.events add column if not exists store_id uuid references public.stores (id);
alter table public.photos add column if not exists store_id uuid references public.stores (id);
alter table public.listings add column if not exists store_id uuid references public.stores (id);
alter table public.channel_config add column if not exists store_id uuid references public.stores (id);
alter table public.delist_tasks add column if not exists store_id uuid references public.stores (id);
alter table public.incidents add column if not exists store_id uuid references public.stores (id);
alter table public.device_tokens add column if not exists store_id uuid references public.stores (id);

alter table public.channel_config drop constraint if exists channel_config_pkey;
create unique index if not exists ux_channel_config_store
  on public.channel_config (store_id, channel);

alter table public.listings drop constraint if exists listings_pkey;
create unique index if not exists ux_listings_store
  on public.listings (store_id, sku, channel);

-- Live sale uniqueness is per store. Keep the old global index until orphans
-- (store_id is null) are adopted by the first signup.
drop index if exists public.ux_one_live_sale_per_sku;
create unique index if not exists ux_one_live_sale_per_store_sku
  on public.sales (store_id, sku) where voided_at is null and store_id is not null;
create unique index if not exists ux_orphan_live_sale_per_sku
  on public.sales (sku) where voided_at is null and store_id is null;

drop index if exists public.ux_one_live_reservation_per_sku;
create unique index if not exists ux_one_live_reservation_per_store_sku
  on public.reservations (store_id, sku)
  where released_at is null and finalized_at is null and store_id is not null;

create unique index if not exists ux_units_store_sku
  on public.units (store_id, sku) where store_id is not null;
create unique index if not exists ux_ledger_store_sku
  on public.sku_ledger (store_id, sku) where store_id is not null;

delete from public.settings where key = 'storeName';

create or replace function public.current_store_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select store_id from public.staff where user_id = auth.uid();
$$;

create or replace function public.staff_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.staff where user_id = auth.uid();
$$;

create or replace function public.is_store_staff(p_store uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.staff
     where user_id = auth.uid() and store_id = p_store
  );
$$;

create or replace function public.is_manager()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.staff_role() in ('owner', 'manager');
$$;

create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.staff_role() = 'owner';
$$;

create or replace function public.assert_staff_or_service()
returns void
language plpgsql
stable
as $$
begin
  if auth.role() = 'service_role' then
    return;
  end if;
  if public.is_staff() then
    return;
  end if;
  raise exception 'not_staff' using errcode = '42501';
end;
$$;

create or replace function public.assert_manager()
returns void
language plpgsql
stable
as $$
begin
  if auth.role() = 'service_role' then
    return;
  end if;
  if public.is_manager() then
    return;
  end if;
  raise exception 'not_manager' using errcode = '42501';
end;
$$;

create or replace function public.assert_owner()
returns void
language plpgsql
stable
as $$
begin
  if auth.role() = 'service_role' then
    return;
  end if;
  if public.is_owner() then
    return;
  end if;
  raise exception 'not_owner' using errcode = '42501';
end;
$$;

create or replace function public.store_setting(p_store uuid, p_key text, p_default jsonb default 'null'::jsonb)
returns jsonb
language sql
stable
as $$
  select coalesce(
    (select value from public.store_settings where store_id = p_store and key = p_key),
    p_default
  );
$$;

create or replace function public.sku_digits()
returns int
language sql
stable
as $$
  select coalesce(
    (public.store_setting(public.current_store_id(), 'skuDigits', '5'::jsonb) #>> '{}')::int,
    (select (value #>> '{}')::int from public.settings where key = 'skuDigits'),
    5
  );
$$;

create or replace function public.reservation_ttl()
returns interval
language sql
stable
as $$
  select make_interval(
    secs => coalesce(
      (public.store_setting(public.current_store_id(), 'reservationTtlSeconds', '180'::jsonb) #>> '{}')::int,
      180
    )
  );
$$;

-- POS view: never includes acquisition cost or floor. security_invoker = false
-- so staff RLS on units (which blocks staff from the table) does not hide rows.
-- Scoped to the caller's store.
create or replace view public.units_pos
with (security_invoker = false) as
select
  u.id,
  u.store_id,
  u.sku,
  u.brand,
  u.model,
  u.title,
  u.category,
  u.condition,
  u.test_status,
  u.location,
  u.mfr_serial,
  u.defect_notes,
  u.upc,
  u.lot,
  u.msrp_cents,
  u.ask_cents,
  u.state,
  u.show_on_website,
  u.received_at,
  u.updated_at
from public.units u
where u.store_id is not distinct from public.current_store_id();

-- CREATE OR REPLACE VIEW cannot rename or reorder columns. 0003/0005 defined
-- sku … photo_paths. store_id is appended so an upgrade from 0005 applies.
create or replace view public.public_items
with (security_invoker = false) as
select
  u.sku,
  u.brand,
  u.model,
  u.title,
  u.category,
  u.condition,
  u.test_status,
  u.defect_notes,
  u.ask_cents,
  u.msrp_cents,
  coalesce(
    (public.store_setting(u.store_id, 'currency', '"USD"'::jsonb) #>> '{}'),
    'USD'
  ) as currency,
  u.received_at,
  u.updated_at,
  (
    select p.path
      from public.photos p
     where p.store_id is not distinct from u.store_id and p.sku = u.sku
     order by p.is_primary desc, p.created_at asc
     limit 1
  ) as primary_photo_path,
  coalesce(
    (
      select json_agg(p.path order by p.is_primary desc, p.created_at)
        from public.photos p
       where p.store_id is not distinct from u.store_id and p.sku = u.sku
    ),
    '[]'::json
  ) as photo_paths,
  u.store_id
from public.units u
where u.show_on_website
  and u.state in ('available', 'reserved')
  and u.store_id is not null
  and not exists (
    select 1 from public.sales s
     where s.store_id = u.store_id and s.sku = u.sku and s.voided_at is null
  )
  and not exists (
    select 1 from public.reservations r
     where r.store_id = u.store_id
       and r.sku = u.sku
       and r.released_at is null
       and r.finalized_at is null
       and r.expires_at > now()
  );

comment on view public.public_items is
  'Public catalog. Filter by store_id. Sold and actively reserved items are absent.';

-- Photo keys are {store_id}/{sku}/{filename}. Old keys {sku}/{filename} are
-- rewritten by move_unit_photos_to_store_layout.
create or replace function public.anon_can_read_unit_photo(object_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    object_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9]+/.+'
    and exists (
      select 1
        from public.public_items i
       where i.store_id::text = split_part(object_name, '/', 1)
         and i.sku = split_part(object_name, '/', 2)
         and object_name like (i.store_id::text || '/' || i.sku || '/%')
    );
$$;

create or replace function public.move_unit_photos_to_store_layout(p_store uuid)
returns int
language plpgsql
security definer
set search_path = public, storage
as $$
declare
  n int := 0;
  r record;
  v_new text;
begin
  if auth.role() <> 'service_role' and public.current_store_id() is distinct from p_store then
    raise exception 'not_staff' using errcode = '42501';
  end if;
  for r in
    select p.id, p.sku, p.path
      from public.photos p
     where p.store_id = p_store
       and p.path is not null
       and p.path not like (p_store::text || '/%')
  loop
    if r.path like (r.sku || '/%') then
      v_new := p_store::text || '/' || r.path;
    elsif position('/' in r.path) = 0 then
      v_new := p_store::text || '/' || r.sku || '/' || r.path;
    else
      v_new := p_store::text || '/' || r.sku || '/' || regexp_replace(r.path, '^.*/', '');
    end if;

    update storage.objects
       set name = v_new
     where bucket_id = 'unit-photos'
       and name = r.path;
    if not found then
      if not exists (
        select 1 from storage.objects o
         where o.bucket_id = 'unit-photos' and o.name = v_new
      ) then
        raise exception 'photo_missing: %', r.path using errcode = 'P0001';
      end if;
    end if;

    update public.photos
       set path = v_new
     where id = r.id;

    n := n + 1;
  end loop;
  return n;
end;
$$;

create or replace function public.verify_unit_photos(p_store uuid)
returns table (photo_id bigint, sku text, path text, storage_ok boolean)
language plpgsql
stable
security definer
set search_path = public, storage
as $$
begin
  if auth.role() <> 'service_role' and public.current_store_id() is distinct from p_store then
    raise exception 'not_staff' using errcode = '42501';
  end if;
  return query
    select
      p.id,
      p.sku,
      p.path,
      exists (
        select 1 from storage.objects o
         where o.bucket_id = 'unit-photos' and o.name = p.path
      ) as storage_ok
    from public.photos p
    where p.store_id = p_store;
end;
$$;

create or replace function public.release_expired_reservations()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  update public.reservations
     set released_at = now()
   where released_at is null
     and finalized_at is null
     and expires_at <= now();
  get diagnostics n = row_count;

  update public.units u
     set state = 'available', updated_at = now()
   where u.state = 'reserved'
     and not exists (
       select 1 from public.reservations r
        where r.store_id is not distinct from u.store_id
          and r.sku = u.sku
          and r.released_at is null
          and r.finalized_at is null
     )
     and not exists (
       select 1 from public.sales s
        where s.store_id is not distinct from u.store_id
          and s.sku = u.sku and s.voided_at is null
     );

  return n;
end;
$$;

create or replace function public.reserve_unit(
  p_sku text,
  p_channel text default 'floor'
)
returns public.reservations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.reservations;
  v_store uuid := public.current_store_id();
begin
  perform public.assert_staff_or_service();
  perform public.release_expired_reservations();
  if v_store is null then
    raise exception 'no_store' using errcode = 'P0001';
  end if;

  update public.units
     set state = 'reserved', updated_at = now()
   where sku = p_sku
     and store_id = v_store
     and state = 'available';
  if not found then
    raise exception 'unit_not_sellable' using errcode = 'P0001';
  end if;

  insert into public.reservations (store_id, sku, channel, actor_id, expires_at)
  values (v_store, p_sku, p_channel, auth.uid(), now() + public.reservation_ttl())
  returning * into v_row;

  insert into public.events (store_id, sku, kind, actor, actor_id, note)
  values (
    v_store,
    p_sku,
    'reserved',
    coalesce((select display_name from public.staff where user_id = auth.uid()), 'service'),
    auth.uid(),
    p_channel
  );

  return v_row;
end;
$$;

create or replace function public.release_reservation(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sku text;
  v_store uuid;
begin
  perform public.assert_staff_or_service();

  update public.reservations
     set released_at = now()
   where id = p_id
     and released_at is null
     and finalized_at is null
     and (store_id = public.current_store_id() or auth.role() = 'service_role')
  returning sku, store_id into v_sku, v_store;
  if not found then
    return;
  end if;

  update public.units
     set state = 'available', updated_at = now()
   where sku = v_sku
     and store_id is not distinct from v_store
     and state = 'reserved'
     and not exists (
       select 1 from public.sales s
        where s.store_id is not distinct from v_store
          and s.sku = v_sku and s.voided_at is null
     );
end;
$$;

create or replace function public.open_delist_tasks(p_sale public.sales)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.delist_tasks (store_id, sku, channel, sale_id, nag_after)
  select p_sale.store_id, p_sale.sku, l.channel, p_sale.id,
         now() + make_interval(
           mins => coalesce(
             (public.store_setting(p_sale.store_id, 'delistNagMinutes', '15'::jsonb) #>> '{}')::int,
             15
           )
         )
    from public.listings l
   where l.store_id is not distinct from p_sale.store_id
     and l.sku = p_sale.sku
     and l.status = 'listed'
     and l.channel is distinct from p_sale.channel;
end;
$$;

create table if not exists public.approvals (
  id           uuid primary key default gen_random_uuid(),
  store_id     uuid not null references public.stores (id) on delete cascade,
  action       text not null check (action in ('void_sale', 'refund', 'below_floor', 'delete_unit')),
  sku          text,
  requested_by uuid not null references auth.users (id),
  approved_by  uuid not null references auth.users (id),
  created_at   timestamptz not null default now(),
  consumed_at  timestamptz
);

create table if not exists public.pin_attempts (
  id         bigint generated by default as identity primary key,
  store_id   uuid not null references public.stores (id) on delete cascade,
  user_id    uuid references auth.users (id),
  ok         boolean not null,
  created_at timestamptz not null default now()
);

create or replace function public.finalize_sale(
  p_sku text,
  p_channel text,
  p_price_cents int,
  p_payment_method text default null,
  p_payment_id text default null,
  p_customer_name text default null,
  p_customer_phone text default null,
  p_customer_email text default null,
  p_note text default null,
  p_reservation_id uuid default null,
  p_tax_cents int default 0,
  p_approval_id uuid default null
)
returns public.sales
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale public.sales;
  v_receipt text;
  v_seq int;
  v_store uuid := public.current_store_id();
  v_floor int;
begin
  perform public.assert_staff_or_service();
  perform public.release_expired_reservations();

  if v_store is null then
    select store_id into v_store from public.units where sku = p_sku limit 1;
  end if;
  if v_store is null then
    raise exception 'no_store' using errcode = 'P0001';
  end if;

  if p_price_cents is null or p_price_cents < 0 then
    raise exception 'invalid_price' using errcode = '22023';
  end if;
  if p_channel is null or btrim(p_channel) = '' then
    raise exception 'invalid_channel' using errcode = '22023';
  end if;

  select floor_cents into v_floor
    from public.units
   where sku = p_sku and store_id = v_store;
  if v_floor is not null and p_price_cents < v_floor then
    if p_approval_id is null or not exists (
      select 1 from public.approvals a
       where a.id = p_approval_id
         and a.store_id = v_store
         and a.action = 'below_floor'
         and a.sku = p_sku
         and a.consumed_at is null
         and a.created_at > now() - interval '10 minutes'
    ) then
      raise exception 'below_floor' using errcode = 'P0001';
    end if;
    update public.approvals set consumed_at = now() where id = p_approval_id;
  end if;

  if p_reservation_id is not null then
    update public.reservations
       set payment_id = coalesce(p_payment_id, payment_id)
     where id = p_reservation_id
       and sku = p_sku
       and store_id = v_store
       and released_at is null
       and finalized_at is null
       and expires_at > now();
    if not found then
      raise exception 'reservation_expired' using errcode = 'P0001';
    end if;
  end if;

  update public.units
     set state = 'sold', updated_at = now()
   where sku = p_sku
     and store_id = v_store
     and state in ('available', 'reserved');
  if not found then
    insert into public.incidents (store_id, kind, sku, detail)
    values (
      v_store,
      'double_sell',
      p_sku,
      jsonb_build_object('channel', p_channel, 'payment_id', p_payment_id)
    );
    raise exception 'unit_not_sellable' using errcode = 'P0001';
  end if;

  insert into public.store_settings (store_id, key, value)
  values (v_store, 'receipt_seq', '0'::jsonb)
  on conflict (store_id, key) do nothing;

  update public.store_settings
     set value = to_jsonb(coalesce((value #>> '{}')::int, 0) + 1)
   where store_id = v_store and key = 'receipt_seq'
  returning (value #>> '{}')::int into v_seq;
  v_receipt := 'R-' || lpad(v_seq::text, greatest(5, public.sku_digits()), '0');

  begin
    insert into public.sales (
      store_id, sku, price_cents, tax_cents, channel, payment_method, payment_id,
      customer_name, customer_phone, customer_email, note, sold_at, receipt_no, actor_id
    ) values (
      v_store, p_sku, p_price_cents, coalesce(p_tax_cents, 0), btrim(p_channel), p_payment_method, p_payment_id,
      p_customer_name, p_customer_phone, p_customer_email, p_note, now(), v_receipt, auth.uid()
    )
    returning * into v_sale;
  exception
    when unique_violation then
      insert into public.incidents (store_id, kind, sku, detail)
      values (
        v_store,
        'double_sell',
        p_sku,
        jsonb_build_object('channel', p_channel, 'payment_id', p_payment_id)
      );
      raise;
  end;

  update public.sku_ledger set fate = 'sold' where sku = p_sku and store_id is not distinct from v_store;

  if p_reservation_id is not null then
    update public.reservations
       set finalized_at = now(), sale_id = v_sale.id, payment_id = coalesce(p_payment_id, payment_id)
     where id = p_reservation_id;
  else
    update public.reservations
       set released_at = now()
     where store_id = v_store and sku = p_sku and released_at is null and finalized_at is null;
  end if;

  insert into public.events (store_id, sku, kind, new_value, actor, actor_id, note)
  values (
    v_store,
    p_sku,
    'sold',
    p_price_cents::text,
    coalesce((select display_name from public.staff where user_id = auth.uid()), 'service'),
    auth.uid(),
    btrim(p_channel) || ' ' || v_receipt
  );

  perform public.open_delist_tasks(v_sale);
  return v_sale;
end;
$$;
