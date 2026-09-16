-- Signup, invites, manager PIN lockout, receive/edit RPCs, RLS per store/role.

create or replace function public.seed_store_settings(p_store uuid, p_display_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.store_settings (store_id, key, value) values
    (p_store, 'display_name', to_jsonb(coalesce(nullif(btrim(p_display_name), ''), 'Store'))),
    (p_store, 'skuStart', '10000'::jsonb),
    (p_store, 'skuDigits', '5'::jsonb),
    (p_store, 'taxRateBps', '0'::jsonb),
    (p_store, 'currency', '"USD"'::jsonb),
    (p_store, 'reservationTtlSeconds', '180'::jsonb),
    (p_store, 'delistNagMinutes', '15'::jsonb),
    (p_store, 'card_payments_enabled', 'false'::jsonb),
    (p_store, 'pin_failed_count', '0'::jsonb),
    (p_store, 'receipt_seq', '0'::jsonb),
    (p_store, 'categories', '["Uncategorized"]'::jsonb),
    (p_store, 'conditions', '["New","Open box","Excellent","Good","Fair","For parts"]'::jsonb),
    (p_store, 'testStatuses', '["untested","passed","failed","partial"]'::jsonb),
    (p_store, 'locations', '["Floor","Back room","Repair bench"]'::jsonb),
    (p_store, 'channels', '["floor","ebay","facebook","offerup","amazon","tiktok","website","wholesale"]'::jsonb),
    (p_store, 'paymentMethods', '["cash","card","other"]'::jsonb)
  on conflict (store_id, key) do nothing;

  insert into public.channel_config (store_id, channel, mode) values
    (p_store, 'floor', 'manual'),
    (p_store, 'website', 'manual'),
    (p_store, 'ebay', 'off'),
    (p_store, 'amazon', 'off'),
    (p_store, 'facebook', 'off'),
    (p_store, 'tiktok', 'off')
  on conflict (store_id, channel) do nothing;
end;
$$;

-- If inventory was imported before tenancy, attach it to the first store
-- and rewrite photo keys. Safe to call on an empty database (n = 0).
create or replace function public.adopt_orphan_inventory(p_store uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  n int := 0;
begin
  update public.sku_ledger set store_id = p_store where store_id is null;
  get diagnostics n = row_count;
  update public.units set store_id = p_store where store_id is null;
  update public.sales set store_id = p_store where store_id is null;
  update public.reservations set store_id = p_store where store_id is null;
  update public.events set store_id = p_store where store_id is null;
  update public.photos set store_id = p_store where store_id is null;
  update public.listings set store_id = p_store where store_id is null;
  update public.delist_tasks set store_id = p_store where store_id is null;
  update public.incidents set store_id = p_store where store_id is null;
  perform public.move_unit_photos_to_store_layout(p_store);
  if exists (
    select 1 from public.verify_unit_photos(p_store) v where not v.storage_ok
  ) then
    raise exception 'photo_verify_failed' using errcode = 'P0001';
  end if;
  return n;
end;
$$;

create or replace function public.signup_create_store(p_display_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid;
  v_name text := coalesce(nullif(btrim(p_display_name), ''), 'Store');
begin
  if auth.uid() is null then
    raise exception 'not_signed_in' using errcode = '42501';
  end if;
  if exists (select 1 from public.staff where user_id = auth.uid()) then
    raise exception 'already_on_a_store' using errcode = 'P0001';
  end if;

  insert into public.stores default values returning id into v_store;
  insert into public.staff (user_id, store_id, display_name, role, delist_duty)
  values (auth.uid(), v_store, v_name, 'owner', true);
  perform public.seed_store_settings(v_store, v_name);

  -- First store in a project that already has inventory from 0001–0005.
  if (select count(*) from public.stores) = 1 then
    perform public.adopt_orphan_inventory(v_store);
  end if;

  insert into public.events (store_id, kind, actor, actor_id, note)
  values (v_store, 'store_created', v_name, auth.uid(), v_store::text);

  return v_store;
end;
$$;

create table if not exists public.staff_invites (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null references public.stores (id) on delete cascade,
  email      text not null,
  role       text not null check (role in ('manager', 'staff')),
  token      text not null unique default encode(gen_random_bytes(24), 'hex'),
  invited_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  accepted_at timestamptz
);

create or replace function public.invite_staff(p_email text, p_role text)
returns public.staff_invites
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.staff_invites;
  v_role text := lower(btrim(p_role));
begin
  perform public.assert_manager();
  if v_role = 'owner' then
    raise exception 'cannot_invite_owner' using errcode = '22023';
  end if;
  if v_role = 'manager' then
    perform public.assert_owner();
  end if;
  if v_role not in ('manager', 'staff') then
    raise exception 'invalid_role' using errcode = '22023';
  end if;

  insert into public.staff_invites (store_id, email, role, invited_by)
  values (public.current_store_id(), lower(btrim(p_email)), v_role, auth.uid())
  returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.accept_invite(p_token text, p_display_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inv public.staff_invites;
begin
  if auth.uid() is null then
    raise exception 'not_signed_in' using errcode = '42501';
  end if;
  if exists (select 1 from public.staff where user_id = auth.uid()) then
    raise exception 'already_on_a_store' using errcode = 'P0001';
  end if;

  select * into v_inv from public.staff_invites
   where token = p_token and accepted_at is null;
  if not found then
    raise exception 'invite_invalid' using errcode = 'P0001';
  end if;

  insert into public.staff (user_id, store_id, display_name, role, delist_duty)
  values (
    auth.uid(),
    v_inv.store_id,
    coalesce(nullif(btrim(p_display_name), ''), split_part(v_inv.email, '@', 1)),
    v_inv.role,
    v_inv.role <> 'staff'
  );
  update public.staff_invites set accepted_at = now() where id = v_inv.id;
  return v_inv.store_id;
end;
$$;

create or replace function public.set_manager_pin(p_pin text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_owner();
  if p_pin is null or char_length(p_pin) < 4 then
    raise exception 'pin_too_short' using errcode = '22023';
  end if;
  insert into public.store_settings (store_id, key, value)
  values (public.current_store_id(), 'manager_pin_hash', to_jsonb(crypt(p_pin, gen_salt('bf'))))
  on conflict (store_id, key) do update set value = excluded.value;
  insert into public.store_settings (store_id, key, value)
  values (public.current_store_id(), 'pin_failed_count', '0'::jsonb)
  on conflict (store_id, key) do update set value = '0'::jsonb;
  delete from public.store_settings
   where store_id = public.current_store_id() and key = 'pin_locked_until';
end;
$$;

create or replace function public.approve_with_pin(p_action text, p_sku text, p_pin text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
  v_hash text;
  v_fails int;
  v_until timestamptz;
  v_id uuid;
begin
  perform public.assert_staff_or_service();
  if v_store is null then
    raise exception 'no_store' using errcode = 'P0001';
  end if;

  v_until := (public.store_setting(v_store, 'pin_locked_until', 'null'::jsonb) #>> '{}')::timestamptz;
  if v_until is not null and v_until > now() then
    insert into public.pin_attempts (store_id, user_id, ok) values (v_store, auth.uid(), false);
    insert into public.events (store_id, sku, kind, actor, actor_id, note)
    values (v_store, p_sku, 'pin_locked', coalesce((select display_name from public.staff where user_id = auth.uid()), 'staff'), auth.uid(), 'attempt while locked');
    raise exception 'pin_locked' using errcode = 'P0001';
  end if;

  v_hash := public.store_setting(v_store, 'manager_pin_hash', 'null'::jsonb) #>> '{}';
  if v_hash is null or v_hash = 'null' then
    raise exception 'pin_not_set' using errcode = 'P0001';
  end if;

  if crypt(p_pin, v_hash) <> v_hash then
    v_fails := coalesce((public.store_setting(v_store, 'pin_failed_count', '0'::jsonb) #>> '{}')::int, 0) + 1;
    insert into public.store_settings (store_id, key, value)
    values (v_store, 'pin_failed_count', to_jsonb(v_fails))
    on conflict (store_id, key) do update set value = to_jsonb(v_fails);
    insert into public.pin_attempts (store_id, user_id, ok) values (v_store, auth.uid(), false);
    insert into public.events (store_id, sku, kind, actor, actor_id, note)
    values (v_store, p_sku, 'pin_failed', coalesce((select display_name from public.staff where user_id = auth.uid()), 'staff'), auth.uid(), v_fails::text);
    if v_fails >= 5 then
      insert into public.store_settings (store_id, key, value)
      values (v_store, 'pin_locked_until', to_jsonb(now() + interval '5 minutes'))
      on conflict (store_id, key) do update set value = to_jsonb(now() + interval '5 minutes');
      insert into public.events (store_id, sku, kind, actor, actor_id, note)
      values (v_store, p_sku, 'pin_lockout', coalesce((select display_name from public.staff where user_id = auth.uid()), 'staff'), auth.uid(), '5 failures');
    end if;
    raise exception 'pin_wrong' using errcode = 'P0001';
  end if;

  insert into public.store_settings (store_id, key, value)
  values (v_store, 'pin_failed_count', '0'::jsonb)
  on conflict (store_id, key) do update set value = '0'::jsonb;
  delete from public.store_settings where store_id = v_store and key = 'pin_locked_until';
  insert into public.pin_attempts (store_id, user_id, ok) values (v_store, auth.uid(), true);

  insert into public.approvals (store_id, action, sku, requested_by, approved_by)
  values (v_store, p_action, p_sku, auth.uid(), auth.uid())
  returning id into v_id;

  insert into public.events (store_id, sku, kind, actor, actor_id, note)
  values (
    v_store,
    p_sku,
    'approval',
    coalesce((select display_name from public.staff where user_id = auth.uid()), 'staff'),
    auth.uid(),
    p_action
  );
  return v_id;
end;
$$;

create or replace function public.void_sale(p_sale_id bigint, p_reason text, p_approval_id uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sku text;
  v_store uuid := public.current_store_id();
begin
  perform public.assert_staff_or_service();
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'void_needs_reason' using errcode = '22023';
  end if;

  if not public.is_manager() and auth.role() <> 'service_role' then
    if p_approval_id is null or not exists (
      select 1 from public.approvals a
       where a.id = p_approval_id
         and a.store_id = v_store
         and a.action = 'void_sale'
         and a.consumed_at is null
         and a.created_at > now() - interval '10 minutes'
    ) then
      raise exception 'manager_approval_required' using errcode = 'P0001';
    end if;
    update public.approvals set consumed_at = now() where id = p_approval_id;
  end if;

  update public.sales
     set voided_at = now(), void_reason = btrim(p_reason)
   where id = p_sale_id
     and store_id is not distinct from v_store
     and voided_at is null
  returning sku into v_sku;
  if not found then
    raise exception 'sale_not_voidable' using errcode = 'P0001';
  end if;

  update public.units
     set state = 'available', updated_at = now()
   where sku = v_sku and store_id is not distinct from v_store;
  update public.sku_ledger set fate = 'issued'
   where sku = v_sku and store_id is not distinct from v_store;

  insert into public.events (store_id, sku, kind, actor, actor_id, note)
  values (
    v_store,
    v_sku,
    'sale_void',
    coalesce((select display_name from public.staff where user_id = auth.uid()), 'service'),
    auth.uid(),
    btrim(p_reason)
  );
end;
$$;

create or replace function public.receive_unit(
  p_sku text,
  p_brand text default '',
  p_model text default '',
  p_title text default '',
  p_category text default null,
  p_condition text default null,
  p_test_status text default null,
  p_location text default null,
  p_ask_cents int default null,
  p_msrp_cents int default null,
  p_cost_cents int default null,
  p_floor_cents int default null,
  p_notes text default null,
  p_upc text default null,
  p_lot text default null,
  p_mfr_serial text default null
)
returns public.units
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
  v_sku text := btrim(p_sku);
  v_row public.units;
  v_cost int;
  v_floor int;
begin
  perform public.assert_staff_or_service();
  if v_store is null then
    raise exception 'no_store' using errcode = 'P0001';
  end if;
  if not public.is_sku(v_sku) then
    raise exception 'invalid_sku' using errcode = '22023';
  end if;

  v_cost := case when public.is_manager() then p_cost_cents else null end;
  v_floor := case when public.is_manager() then p_floor_cents else null end;

  insert into public.sku_ledger (store_id, sku, issued_at, label, fate)
  values (v_store, v_sku, now(), coalesce(p_title, ''), 'issued');

  insert into public.units (
    store_id, sku, brand, model, title, category, condition, test_status, location,
    mfr_serial, defect_notes, upc, lot, acquisition_cost_cents, msrp_cents, ask_cents,
    floor_cents, state, show_on_website, received_at, updated_at
  ) values (
    v_store, v_sku, coalesce(p_brand,''), coalesce(p_model,''), coalesce(p_title,''),
    p_category, p_condition, p_test_status, p_location, p_mfr_serial, p_notes, p_upc, p_lot,
    v_cost, p_msrp_cents, p_ask_cents, v_floor, 'available', true, now(), now()
  )
  returning * into v_row;

  insert into public.events (store_id, sku, kind, actor, actor_id, note)
  values (
    v_store, v_sku, 'received',
    coalesce((select display_name from public.staff where user_id = auth.uid()), 'staff'),
    auth.uid(),
    null
  );
  return v_row;
end;
$$;

create or replace function public.next_sku()
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
  v_start int;
  v_digits int;
  v_max bigint;
begin
  perform public.assert_staff_or_service();
  v_digits := public.sku_digits();
  v_start := coalesce((public.store_setting(v_store, 'skuStart', '10000'::jsonb) #>> '{}')::int, 10000);
  select coalesce(max(sku::bigint), v_start - 1) into v_max
    from public.sku_ledger
   where store_id = v_store;
  if v_max + 1 > (10 ^ v_digits) - 1 then
    raise exception 'sku_exhausted' using errcode = 'P0001';
  end if;
  return lpad((v_max + 1)::text, v_digits, '0');
end;
$$;

create or replace function public.update_unit_field(p_sku text, p_field text, p_value text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
  v_old text;
  v_cost_fields text[] := array['acquisition_cost_cents', 'floor_cents'];
begin
  perform public.assert_staff_or_service();
  if p_field = any (v_cost_fields) and not public.is_manager() then
    raise exception 'not_manager' using errcode = '42501';
  end if;
  if p_field not in (
    'brand','model','title','category','condition','test_status','location',
    'mfr_serial','defect_notes','upc','lot','acquisition_cost_cents','msrp_cents',
    'ask_cents','floor_cents'
  ) then
    raise exception 'invalid_field' using errcode = '22023';
  end if;

  execute format('select %I::text from public.units where sku = $1 and store_id = $2', p_field)
    into v_old using p_sku, v_store;

  if p_field like '%_cents' then
    execute format(
      'update public.units set %I = $1::int, updated_at = now() where sku = $2 and store_id = $3',
      p_field
    ) using nullif(p_value, ''), p_sku, v_store;
  else
    execute format(
      'update public.units set %I = $1, updated_at = now() where sku = $2 and store_id = $3',
      p_field
    ) using p_value, p_sku, v_store;
  end if;

  insert into public.events (store_id, sku, kind, field, old_value, new_value, actor, actor_id)
  values (
    v_store, p_sku, 'edit', p_field, v_old, p_value,
    coalesce((select display_name from public.staff where user_id = auth.uid()), 'staff'),
    auth.uid()
  );
end;
$$;

create or replace function public.set_unit_state(p_sku text, p_state text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
  v_old text;
begin
  perform public.assert_staff_or_service();
  select state into v_old from public.units where sku = p_sku and store_id = v_store;
  update public.units
     set state = p_state, updated_at = now()
   where sku = p_sku and store_id = v_store
     and state <> 'sold';
  if not found then
    raise exception 'cannot_move' using errcode = 'P0001';
  end if;
  insert into public.events (store_id, sku, kind, field, old_value, new_value, actor, actor_id)
  values (
    v_store, p_sku, 'state', 'state', v_old, p_state,
    coalesce((select display_name from public.staff where user_id = auth.uid()), 'staff'),
    auth.uid()
  );
end;
$$;

create or replace function public.delete_unit(p_sku text, p_approval_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
begin
  perform public.assert_staff_or_service();
  if not public.is_manager() and auth.role() <> 'service_role' then
    if p_approval_id is null or not exists (
      select 1 from public.approvals a
       where a.id = p_approval_id and a.store_id = v_store
         and a.action = 'delete_unit' and a.sku = p_sku
         and a.consumed_at is null and a.created_at > now() - interval '10 minutes'
    ) then
      raise exception 'manager_approval_required' using errcode = 'P0001';
    end if;
    update public.approvals set consumed_at = now() where id = p_approval_id;
  end if;

  if exists (select 1 from public.sales where sku = p_sku and store_id = v_store and voided_at is null) then
    raise exception 'void_the_sale_first' using errcode = 'P0001';
  end if;

  delete from public.photos where sku = p_sku and store_id = v_store;
  delete from public.units where sku = p_sku and store_id = v_store;
  update public.sku_ledger set fate = 'hard-deleted' where sku = p_sku and store_id = v_store;
  insert into public.events (store_id, sku, kind, actor, actor_id)
  values (
    v_store, p_sku, 'deleted',
    coalesce((select display_name from public.staff where user_id = auth.uid()), 'staff'),
    auth.uid()
  );
end;
$$;

create or replace function public.mark_listed(p_sku text, p_channel text, p_listing_id text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
begin
  perform public.assert_staff_or_service();
  insert into public.listings (store_id, sku, channel, status, listing_id, listed_at)
  values (v_store, p_sku, btrim(p_channel), 'listed', p_listing_id, now())
  on conflict (store_id, sku, channel) do update
    set status = 'listed',
        listing_id = coalesce(excluded.listing_id, public.listings.listing_id),
        listed_at = now(),
        store_id = v_store,
        delisted_at = null;
end;
$$;

create or replace function public.complete_delist_task(p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_staff_or_service();
  update public.delist_tasks
     set completed_at = now(), completed_by = auth.uid()
   where id = p_id
     and store_id = public.current_store_id()
     and completed_at is null;
  update public.listings l
     set status = 'delisted', delisted_at = now()
    from public.delist_tasks t
   where t.id = p_id
     and l.store_id = t.store_id
     and l.sku = t.sku
     and l.channel = t.channel;
end;
$$;

create or replace function public.resolve_incident(p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_manager();
  update public.incidents
     set resolved_at = now(), resolved_by = auth.uid()
   where id = p_id and store_id = public.current_store_id();
end;
$$;

create or replace function public.set_store_setting(p_key text, p_value jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_manager();
  if p_key in ('manager_pin_hash', 'pin_failed_count', 'pin_locked_until') then
    raise exception 'use_pin_rpc' using errcode = '42501';
  end if;
  insert into public.store_settings (store_id, key, value)
  values (public.current_store_id(), p_key, p_value)
  on conflict (store_id, key) do update set value = excluded.value;
end;
$$;

create or replace function public.set_notify_prefs(p_email boolean, p_push boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_staff_or_service();
  update public.staff
     set notify_email = coalesce(p_email, notify_email),
         notify_push = coalesce(p_push, notify_push)
   where user_id = auth.uid();
end;
$$;

-- RLS: drop the "any staff, any row" policies and scope by store + role.
drop policy if exists staff_all_meta on public.meta;
drop policy if exists staff_all_settings on public.settings;
drop policy if exists staff_read_staff on public.staff;
drop policy if exists staff_all_ledger on public.sku_ledger;
drop policy if exists staff_all_units on public.units;
drop policy if exists staff_all_sales on public.sales;
drop policy if exists staff_all_reservations on public.reservations;
drop policy if exists staff_all_events on public.events;
drop policy if exists staff_all_photos on public.photos;
drop policy if exists staff_all_listings on public.listings;
drop policy if exists staff_all_channels on public.channel_config;
drop policy if exists staff_all_delist on public.delist_tasks;
drop policy if exists staff_all_incidents on public.incidents;
drop policy if exists staff_own_tokens on public.device_tokens;
drop policy if exists unit_photos_staff_all on storage.objects;

alter table public.stores enable row level security;
alter table public.store_settings enable row level security;
alter table public.approvals enable row level security;
alter table public.pin_attempts enable row level security;
alter table public.staff_invites enable row level security;

create policy owner_read_store on public.stores for select to authenticated
  using (public.is_store_staff(id));

create policy staff_read_store_settings on public.store_settings for select to authenticated
  using (
    public.is_store_staff(store_id)
    and key not in ('manager_pin_hash', 'pin_failed_count', 'pin_locked_until')
  );

create policy manager_store_settings on public.store_settings for all to authenticated
  using (public.is_store_staff(store_id) and public.is_manager())
  with check (public.is_store_staff(store_id) and public.is_manager());

create policy staff_read_own_staff on public.staff for select to authenticated
  using (user_id = auth.uid() or (public.is_store_staff(store_id) and public.is_manager()));

create policy staff_update_self on public.staff for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy staff_ledger on public.sku_ledger for select to authenticated
  using (public.is_store_staff(store_id));

create policy manager_units on public.units for select to authenticated
  using (public.is_store_staff(store_id) and public.is_manager());

create policy staff_sales on public.sales for select to authenticated
  using (
    public.is_store_staff(store_id)
    and (public.is_manager() or actor_id = auth.uid())
  );

create policy staff_reservations on public.reservations for select to authenticated
  using (public.is_store_staff(store_id));

create policy staff_events on public.events for select to authenticated
  using (
    public.is_store_staff(store_id)
    and (
      public.is_manager()
      or kind is distinct from 'edit'
      or coalesce(field, '') not in ('acquisition_cost_cents', 'floor_cents')
    )
  );

create policy staff_photos on public.photos for select to authenticated
  using (public.is_store_staff(store_id));

create policy staff_listings on public.listings for select to authenticated
  using (public.is_store_staff(store_id));

create policy staff_channels on public.channel_config for select to authenticated
  using (store_id = public.current_store_id() or store_id is null);

create policy staff_delist on public.delist_tasks for select to authenticated
  using (public.is_store_staff(store_id));

create policy staff_incidents on public.incidents for select to authenticated
  using (public.is_store_staff(store_id));

create policy staff_tokens on public.device_tokens for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy staff_approvals on public.approvals for select to authenticated
  using (public.is_store_staff(store_id) and public.is_manager());

create policy owner_invites on public.staff_invites for select to authenticated
  using (public.is_store_staff(store_id) and public.is_manager());

-- Staff never read cost/floor via the table. They use units_pos.
-- Storage: staff of that store, prefix {store_id}/
create policy unit_photos_staff_all on storage.objects
  for all
  to authenticated
  using (
    bucket_id = 'unit-photos'
    and public.is_staff()
    and split_part(name, '/', 1) = public.current_store_id()::text
  )
  with check (
    bucket_id = 'unit-photos'
    and public.is_staff()
    and split_part(name, '/', 1) = public.current_store_id()::text
  );

grant select on public.public_items to anon, authenticated;
grant select on public.units_pos to authenticated;
grant select on public.channel_config to authenticated;
grant execute on function public.signup_create_store(text) to authenticated;
grant execute on function public.invite_staff(text, text) to authenticated;
grant execute on function public.accept_invite(text, text) to authenticated;
grant execute on function public.set_manager_pin(text) to authenticated;
grant execute on function public.approve_with_pin(text, text, text) to authenticated;
grant execute on function public.void_sale(bigint, text, uuid) to authenticated;
grant execute on function public.receive_unit(text, text, text, text, text, text, text, text, int, int, int, int, text, text, text, text) to authenticated;
grant execute on function public.next_sku() to authenticated;
grant execute on function public.update_unit_field(text, text, text) to authenticated;
grant execute on function public.set_unit_state(text, text) to authenticated;
grant execute on function public.delete_unit(text, uuid) to authenticated;
grant execute on function public.mark_listed(text, text, text) to authenticated;
grant execute on function public.complete_delist_task(bigint) to authenticated;
grant execute on function public.resolve_incident(bigint) to authenticated;
grant execute on function public.set_store_setting(text, jsonb) to authenticated;
grant execute on function public.set_notify_prefs(boolean, boolean) to authenticated;
grant execute on function public.move_unit_photos_to_store_layout(uuid) to authenticated;
grant execute on function public.verify_unit_photos(uuid) to authenticated;
grant execute on function public.current_store_id() to authenticated;
grant execute on function public.staff_role() to authenticated;
grant execute on function public.reserve_unit(text, text) to authenticated;
grant execute on function public.release_reservation(uuid) to authenticated;
grant execute on function public.finalize_sale(text, text, int, text, text, text, text, text, text, uuid, int, uuid) to authenticated;
grant execute on function public.anon_can_read_unit_photo(text) to anon, authenticated;

create or replace function public.add_unit_photo(p_sku text, p_path text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
begin
  perform public.assert_staff_or_service();
  if p_path not like (v_store::text || '/' || p_sku || '/%') then
    raise exception 'bad_photo_path' using errcode = '22023';
  end if;
  insert into public.photos (store_id, sku, path, original_path, created_at, is_primary)
  values (v_store, p_sku, p_path, p_path, now(), not exists (
    select 1 from public.photos where store_id = v_store and sku = p_sku
  ));
  insert into public.events (store_id, sku, kind, actor, actor_id)
  values (v_store, p_sku, 'photo', coalesce((select display_name from public.staff where user_id = auth.uid()), 'staff'), auth.uid());
end;
$$;

grant execute on function public.add_unit_photo(text, text) to authenticated;
