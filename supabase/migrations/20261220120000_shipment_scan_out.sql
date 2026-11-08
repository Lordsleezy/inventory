begin;

-- Carrier pickup scan-out: one row per normalized tracking number (idempotent rescans).
create table if not exists public.shipment_scan_events (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  order_id uuid not null references public.web_orders(id) on delete cascade,
  tracking_raw text not null,
  tracking_normalized text not null,
  carrier text,
  scan_mode text not null default 'ship' check (scan_mode in ('ship', 'package')),
  scanned_at timestamptz not null default now(),
  scanned_by uuid,
  scanned_by_name text,
  unique (store_id, tracking_normalized)
);

create index if not exists shipment_scan_events_store_scanned
  on public.shipment_scan_events(store_id, scanned_at desc);

create table if not exists public.shipment_pickup_closeouts (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  closed_at timestamptz not null default now(),
  closed_by uuid,
  closed_by_name text,
  scanned_count integer not null default 0 check (scanned_count >= 0),
  packaged_count integer not null default 0 check (packaged_count >= 0),
  left_behind jsonb not null default '[]'::jsonb,
  note text
);

create index if not exists shipment_pickup_closeouts_store_closed
  on public.shipment_pickup_closeouts(store_id, closed_at desc);

alter table public.web_orders
  add column if not exists scanned_out_at timestamptz,
  add column if not exists scanned_out_by uuid,
  add column if not exists scanned_out_by_name text;

alter table public.shipment_scan_events enable row level security;
alter table public.shipment_pickup_closeouts enable row level security;
revoke all on public.shipment_scan_events, public.shipment_pickup_closeouts from public, anon;
grant all on public.shipment_scan_events, public.shipment_pickup_closeouts to service_role;

create or replace function public.floor_normalize_tracking(p_raw text)
returns text language sql immutable as $$
  select case
    when v ~ '^420\d{5}(9[2-5]\d{18,24})$' then substring(v from '9[2-5]\d{18,24}$')
    when v ~ '^420\d{9}(9[2-5]\d{18,24})$' then substring(v from '9[2-5]\d{18,24}$')
    else v
  end
  from (select upper(regexp_replace(btrim(coalesce(p_raw, '')), '\s+', '', 'g')) as v) s
  where nullif(v, '') is not null;
$$;

create or replace function public.portal_scan_out_stats()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  v_packaged int; v_scanned int; v_day date := (now() at time zone 'America/Los_Angeles')::date;
begin
  if v_store is null or not public.is_staff() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  select count(*)::int into v_packaged from public.web_orders o
   where o.store_id = v_store and o.status = 'paid' and o.fulfillment = 'ship'
     and o.packaged_at is not null and o.shipped_at is null and o.delivered_at is null
     and o.refund_requested_at is null and o.canceled_at is null;
  select count(*)::int into v_scanned from public.shipment_scan_events e
   where e.store_id = v_store and (e.scanned_at at time zone 'America/Los_Angeles')::date = v_day;
  return jsonb_build_object('packaged', v_packaged, 'scanned_today', v_scanned, 'day', v_day);
end $$;

create or replace function public.portal_scan_out_lookup(p_barcode text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  v_norm text := public.floor_normalize_tracking(p_barcode);
  v_suffix text;
  o public.web_orders;
  prior public.shipment_scan_events;
begin
  if v_store is null or not public.is_staff() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if v_norm is null then return jsonb_build_object('ok', false, 'error', 'empty_barcode'); end if;
  v_suffix := right(v_norm, 12);
  select e.* into prior from public.shipment_scan_events e
   where e.store_id = v_store and e.tracking_normalized = v_norm;
  if found then
    return jsonb_build_object('ok', false, 'error', 'already_scanned', 'scanned_at', prior.scanned_at,
      'scanned_by_name', prior.scanned_by_name, 'order_id', prior.order_id);
  end if;
  select * into o from public.web_orders wo
   where wo.store_id = v_store
     and wo.status in ('paid', 'refunded')
     and wo.fulfillment = 'ship'
     and (
       public.floor_normalize_tracking(wo.tracking_number) = v_norm
       or public.floor_normalize_tracking(wo.marketplace_tracking_number) = v_norm
       or right(regexp_replace(upper(coalesce(wo.tracking_number, '')), '\s+', '', 'g'), 12) = v_suffix
       or right(regexp_replace(upper(coalesce(wo.marketplace_tracking_number, '')), '\s+', '', 'g'), 12) = v_suffix
     )
   order by wo.paid_at desc nulls last, wo.created_at desc
   limit 1;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if o.canceled_at is not null or o.refund_requested_at is not null then
    return jsonb_build_object('ok', false, 'error', 'not_shippable', 'order_id', o.id);
  end if;
  return jsonb_build_object('ok', true, 'order', jsonb_build_object(
    'id', o.id, 'order_no', o.order_no, 'sku', o.sku, 'title', o.marketplace_title,
    'channel', o.channel, 'packaged_at', o.packaged_at, 'shipped_at', o.shipped_at,
    'tracking_number', o.tracking_number, 'carrier', o.carrier));
end $$;

create or replace function public.portal_scan_out_commit(p_barcode text, p_mode text default 'ship')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  v_norm text := public.floor_normalize_tracking(p_barcode);
  v_suffix text;
  v_name text := public.disposition_actor_name(auth.uid());
  o public.web_orders;
  prior public.shipment_scan_events;
  v_mode text := lower(btrim(coalesce(p_mode, 'ship')));
begin
  if v_store is null or not public.is_staff() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if v_norm is null then raise exception 'empty_barcode' using errcode = '22023'; end if;
  if v_mode not in ('ship', 'package') then raise exception 'invalid_scan_mode' using errcode = '22023'; end if;
  select e.* into prior from public.shipment_scan_events e
   where e.store_id = v_store and e.tracking_normalized = v_norm;
  if found then
    return jsonb_build_object('ok', false, 'error', 'already_scanned', 'scanned_at', prior.scanned_at,
      'scanned_by_name', prior.scanned_by_name, 'order_id', prior.order_id);
  end if;
  v_suffix := right(v_norm, 12);
  select * into o from public.web_orders wo
   where wo.store_id = v_store and wo.fulfillment = 'ship' and wo.status = 'paid'
     and (
       public.floor_normalize_tracking(wo.tracking_number) = v_norm
       or public.floor_normalize_tracking(wo.marketplace_tracking_number) = v_norm
       or right(regexp_replace(upper(coalesce(wo.tracking_number, '')), '\s+', '', 'g'), 12) = v_suffix
       or right(regexp_replace(upper(coalesce(wo.marketplace_tracking_number, '')), '\s+', '', 'g'), 12) = v_suffix
     )
   order by wo.paid_at desc nulls last, wo.created_at desc
   for update;
  if not found then raise exception 'scan_not_found' using errcode = 'P0002'; end if;
  if o.refund_requested_at is not null or o.canceled_at is not null then raise exception 'order_not_shippable' using errcode = 'P0001'; end if;
  if v_mode = 'package' then
    if o.packaged_at is null then
      update public.web_orders set packaged_at = now(), packaged_by = auth.uid(), packaged_by_name = v_name,
        boxed_at = coalesce(boxed_at, now()), updated_at = now()
       where id = o.id;
    end if;
    insert into public.shipment_scan_events(store_id, order_id, tracking_raw, tracking_normalized, carrier, scan_mode, scanned_by, scanned_by_name)
    values (v_store, o.id, btrim(p_barcode), v_norm, o.carrier, 'package', auth.uid(), v_name);
    return jsonb_build_object('ok', true, 'mode', 'package', 'order_id', o.id, 'packaged', true);
  end if;
  if o.packaged_at is null then
    return jsonb_build_object('ok', false, 'error', 'not_packaged', 'order_id', o.id, 'can_mark_packaged', true);
  end if;
  insert into public.shipment_scan_events(store_id, order_id, tracking_raw, tracking_normalized, carrier, scan_mode, scanned_by, scanned_by_name)
  values (v_store, o.id, btrim(p_barcode), v_norm, o.carrier, 'ship', auth.uid(), v_name);
  update public.web_orders set
    shipped_at = coalesce(shipped_at, now()),
    scanned_out_at = now(),
    scanned_out_by = auth.uid(),
    scanned_out_by_name = v_name,
  updated_at = now()
  where id = o.id;
  return jsonb_build_object('ok', true, 'mode', 'ship', 'order_id', o.id, 'shipped', true);
end $$;

create or replace function public.portal_scan_out_packaged_open()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
begin
  if v_store is null or not public.is_staff() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', o.id, 'order_no', o.order_no, 'sku', o.sku, 'title', o.marketplace_title,
      'tracking_number', o.tracking_number, 'packaged_at', o.packaged_at, 'channel', o.channel
    ) order by o.packaged_at desc nulls last)
    from public.web_orders o
    where o.store_id = v_store and o.status = 'paid' and o.fulfillment = 'ship'
      and o.packaged_at is not null and o.shipped_at is null and o.scanned_out_at is null
      and o.canceled_at is null and o.refund_requested_at is null), '[]'::jsonb);
end $$;

create or replace function public.portal_scan_out_today()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  v_day date := (now() at time zone 'America/Los_Angeles')::date;
begin
  if v_store is null or not public.is_staff() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', e.id, 'order_id', e.order_id, 'sku', o.sku, 'title', o.marketplace_title,
      'tracking_normalized', e.tracking_normalized, 'scanned_at', e.scanned_at,
      'scanned_by_name', e.scanned_by_name, 'scan_mode', e.scan_mode)
    order by e.scanned_at desc)
    from public.shipment_scan_events e
    join public.web_orders o on o.id = e.order_id
    where e.store_id = v_store and (e.scanned_at at time zone 'America/Los_Angeles')::date = v_day), '[]'::jsonb);
end $$;

create or replace function public.portal_close_pickup(p_note text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  v_name text := public.disposition_actor_name(auth.uid());
  v_day date := (now() at time zone 'America/Los_Angeles')::date;
  v_scanned int; v_packaged int; v_left jsonb; v_id uuid;
begin
  if v_store is null or not public.is_staff() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  select count(*)::int into v_scanned from public.shipment_scan_events e
   where e.store_id = v_store and e.scan_mode = 'ship'
     and (e.scanned_at at time zone 'America/Los_Angeles')::date = v_day;
  select count(*)::int into v_packaged from public.web_orders o
   where o.store_id = v_store and o.status = 'paid' and o.fulfillment = 'ship'
     and o.packaged_at is not null and o.shipped_at is null and o.scanned_out_at is null;
  select coalesce(jsonb_agg(jsonb_build_object('order_id', o.id, 'sku', o.sku, 'title', o.marketplace_title,
      'tracking_number', o.tracking_number, 'packaged_at', o.packaged_at)), '[]'::jsonb)
    into v_left
    from public.web_orders o
   where o.store_id = v_store and o.status = 'paid' and o.fulfillment = 'ship'
     and o.packaged_at is not null and o.shipped_at is null and o.scanned_out_at is null;
  insert into public.shipment_pickup_closeouts(store_id, closed_by, closed_by_name, scanned_count, packaged_count, left_behind, note)
  values (v_store, auth.uid(), v_name, v_scanned, v_packaged, coalesce(v_left, '[]'::jsonb), nullif(btrim(coalesce(p_note, '')), ''))
  returning id into v_id;
  return v_id;
end $$;

revoke all on function public.floor_normalize_tracking(text) from public, anon;
grant execute on function public.floor_normalize_tracking(text) to authenticated, service_role;
revoke all on function public.portal_scan_out_stats() from public, anon;
grant execute on function public.portal_scan_out_stats() to authenticated;
revoke all on function public.portal_scan_out_lookup(text) from public, anon;
grant execute on function public.portal_scan_out_lookup(text) to authenticated;
revoke all on function public.portal_scan_out_commit(text,text) from public, anon;
grant execute on function public.portal_scan_out_commit(text,text) to authenticated;
revoke all on function public.portal_scan_out_packaged_open() from public, anon;
grant execute on function public.portal_scan_out_packaged_open() to authenticated;
revoke all on function public.portal_scan_out_today() from public, anon;
grant execute on function public.portal_scan_out_today() to authenticated;
revoke all on function public.portal_close_pickup(text) from public, anon;
grant execute on function public.portal_close_pickup(text) to authenticated;

commit;
