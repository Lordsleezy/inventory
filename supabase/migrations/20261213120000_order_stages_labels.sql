-- Orders: To ship → Packaged → Shipped → Delivered, plus label files and carrier events.
-- Pickup rows stay in the table. The app stops offering a Pickup tab; this does not delete them.
-- Depop uploads are not a shipping expense (the buyer pays Depop). Bought labels already post one.

begin;

alter table public.web_orders
  add column if not exists packaged_at timestamptz,
  add column if not exists packaged_by uuid,
  add column if not exists packaged_by_name text,
  add column if not exists label_storage_path text,
  add column if not exists label_file_name text,
  add column if not exists label_mime text,
  add column if not exists label_uploaded_at timestamptz,
  add column if not exists label_origin text,
  add column if not exists tracking_status text,
  add column if not exists tracking_exception text,
  add column if not exists tracking_needs_entry boolean not null default false,
  add column if not exists shippo_track_id text;

alter table public.web_orders drop constraint if exists web_orders_label_origin_check;
alter table public.web_orders add constraint web_orders_label_origin_check
  check (label_origin is null or label_origin in ('bought', 'upload'));

alter table public.portal_expenses add column if not exists sku text;
comment on column public.portal_expenses.sku is 'Unit the shipping label (or other order expense) belongs to. Books and the sale ledger both read the order.';

create index if not exists web_orders_tracking_number_idx on public.web_orders (tracking_number);

create table if not exists public.order_tracking_events (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  order_id uuid not null references public.web_orders(id) on delete cascade,
  status text not null,
  status_detail text,
  location text,
  carrier text,
  occurred_at timestamptz not null,
  raw jsonb,
  created_at timestamptz not null default now()
);
create unique index if not exists order_tracking_events_dedupe
  on public.order_tracking_events (order_id, occurred_at, status, md5(coalesce(status_detail, '')));
create index if not exists order_tracking_events_order on public.order_tracking_events (order_id, occurred_at);

alter table public.order_tracking_events enable row level security;
drop policy if exists order_tracking_events_read on public.order_tracking_events;
create policy order_tracking_events_read on public.order_tracking_events
  for select to authenticated
  using (store_id = coalesce(public.portal_store_id(), public.current_store_id()));
revoke all on public.order_tracking_events from public, anon, authenticated;
grant select on public.order_tracking_events to authenticated;
grant all on public.order_tracking_events to service_role;

insert into storage.buckets (id, name, public, file_size_limit)
values ('order-labels', 'order-labels', false, 8388608)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists order_labels_read on storage.objects;
create policy order_labels_read on storage.objects for select to authenticated
  using (bucket_id = 'order-labels' and split_part(name, '/', 1) = coalesce(public.portal_store_id(), public.current_store_id())::text);
drop policy if exists order_labels_upload on storage.objects;
create policy order_labels_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'order-labels' and split_part(name, '/', 1) = coalesce(public.portal_store_id(), public.current_store_id())::text);

-- Derived stage. Pickup data is still a stage so nothing is deleted; the app just does not show that tab.
create or replace function public.order_fulfillment_stage(
  p_status text, p_fulfillment text,
  p_packaged_at timestamptz, p_shipped_at timestamptz, p_delivered_at timestamptz, p_picked_up_at timestamptz
) returns text
language sql immutable as $$
  select case
    when p_status in ('canceled', 'refunded') then 'canceled'
    when p_fulfillment = 'pickup' and p_picked_up_at is null then 'pickup'
    when p_delivered_at is not null or (p_fulfillment = 'pickup' and p_picked_up_at is not null) then 'delivered'
    when p_shipped_at is not null then 'shipped'
    when p_packaged_at is not null then 'packaged'
    else 'to_ship'
  end
$$;

-- Warehouse tap. Clerks and the store phone are staff, so this uses current_store_id()
-- when portal_store_id() is empty (that helper is admin-only).
create or replace function public.portal_mark_order_packaged(p_order uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  o public.web_orders;
  v_at timestamptz;
  v_name text;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  select * into o from public.web_orders where id = p_order and store_id = v_store for update;
  if not found then raise exception 'order_not_found' using errcode = 'P0001'; end if;
  if o.status <> 'paid' or o.fulfillment <> 'ship' or o.refund_requested_at is not null then
    raise exception 'order_not_packable' using errcode = 'P0001';
  end if;
  if o.delivered_at is not null or o.shipped_at is not null then
    raise exception 'order_already_shipped' using errcode = 'P0001';
  end if;
  if lower(coalesce(o.channel, '')) in ('amazon', 'tiktok')
     and nullif(btrim(coalesce(o.pack_proof_photo_path, '')), '') is null then
    raise exception 'pack_proof_required' using errcode = 'P0001';
  end if;
  if o.packaged_at is not null then
    return jsonb_build_object('id', o.id, 'packaged_at', o.packaged_at, 'packaged_by_name', o.packaged_by_name, 'already', true);
  end if;
  v_name := public.disposition_actor_name(auth.uid());
  update public.web_orders set
    packaged_at = now(),
    packaged_by = auth.uid(),
    packaged_by_name = v_name,
    boxed_at = coalesce(boxed_at, now()),
    updated_at = now()
  where id = o.id
  returning packaged_at into v_at;
  return jsonb_build_object('id', o.id, 'packaged_at', v_at, 'packaged_by_name', v_name, 'already', false);
end $$;

create or replace function public.portal_order_timeline(p_order uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if not exists (select 1 from public.web_orders o where o.id = p_order and o.store_id = v_store) then
    raise exception 'order_not_found' using errcode = 'P0001';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'status', e.status,
      'status_detail', e.status_detail,
      'location', e.location,
      'carrier', e.carrier,
      'occurred_at', e.occurred_at
    ) order by e.occurred_at)
    from public.order_tracking_events e
    where e.order_id = p_order and e.store_id = v_store
  ), '[]'::jsonb);
end $$;

revoke all on function public.order_fulfillment_stage(text, text, timestamptz, timestamptz, timestamptz, timestamptz) from public, anon;
grant execute on function public.order_fulfillment_stage(text, text, timestamptz, timestamptz, timestamptz, timestamptz) to authenticated, service_role;
revoke all on function public.portal_mark_order_packaged(uuid) from public, anon;
grant execute on function public.portal_mark_order_packaged(uuid) to authenticated, service_role;
revoke all on function public.portal_order_timeline(uuid) from public, anon;
grant execute on function public.portal_order_timeline(uuid) to authenticated, service_role;

-- Undo also clears a Packaged tap. Shipped still steps back to whatever packaged_at already says.
create or replace function public.portal_order_step_back(p_order uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_assert_admin_store(); v_order public.web_orders; v_from text; v_to text; v_name text;
begin
  if not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  select * into v_order from public.web_orders where id = p_order and store_id = v_store for update;
  if not found then raise exception 'order_not_found' using errcode = 'P0002'; end if;
  if v_order.status <> 'paid' then raise exception 'order_not_paid' using errcode = '22023'; end if;
  if v_order.delivered_at is not null then
    v_from := 'delivered'; v_to := 'shipped';
    update public.web_orders set delivered_at = null, updated_at = now() where id = p_order;
  elsif v_order.fulfillment = 'ship' and v_order.shipped_at is not null then
    v_from := 'shipped'; v_to := case when v_order.packaged_at is not null then 'packaged' else 'to_ship' end;
    update public.web_orders set shipped_at = null, updated_at = now() where id = p_order;
  elsif v_order.packaged_at is not null then
    v_from := 'packaged'; v_to := 'to_ship';
    update public.web_orders set packaged_at = null, packaged_by = null, packaged_by_name = null, updated_at = now() where id = p_order;
  elsif v_order.fulfillment = 'pickup' and v_order.picked_up_at is not null then
    v_from := 'picked_up'; v_to := 'awaiting_pickup';
    update public.web_orders set picked_up_at = null, picked_up_by = null, updated_at = now() where id = p_order;
  else
    raise exception 'no_completed_step_to_undo' using errcode = '22023';
  end if;
  v_name := public.disposition_actor_name(auth.uid());
  insert into public.events(store_id, sku, kind, field, old_value, new_value, actor, actor_id, note)
  values(v_store, v_order.sku, 'edit', 'order_fulfillment_step', v_from, v_to, v_name, auth.uid(),
    format('Order %s moved back one fulfillment step; sale and money unchanged.', coalesce(v_order.order_no, p_order::text)));
  return jsonb_build_object('order_id', p_order, 'from', v_from, 'to', v_to, 'actor', v_name);
end $$;

-- Newest portal_web_orders body is the live baseline, plus the packaged / label / tracking fields.
create or replace function public.portal_web_orders(p_days integer default 90)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  v_income_pct numeric;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  v_income_pct := coalesce(
    (public.store_setting(v_store, 'income_tax_pct', '25'::jsonb) #>> '{}')::numeric,
    25
  );
  return coalesce((select jsonb_agg(x order by x.created_at desc) from (
    select o.id, o.order_no, o.sku, o.status, o.fulfillment, o.channel,
      o.buyer_name, o.buyer_email, o.buyer_phone,
      o.ship_line1, o.ship_line2, o.ship_city, o.ship_region, o.ship_postal,
      o.item_cents, o.shipping_cents, o.tax_cents, o.total_cents,
      o.payment_id, o.refund_id, o.payment_env, o.created_at, o.paid_at,
      o.pickup_deadline, o.picked_up_at, o.picked_up_by,
      o.boxed_at, o.shipped_at, o.delivered_at,
      o.packaged_at, o.packaged_by, o.packaged_by_name,
      o.tracking_number, o.tracking_url, o.carrier, o.service, o.shipping_rate, o.label_url,
      o.label_purchased_at, o.label_cost_cents, o.refund_requested_at,
      o.label_storage_path, o.label_file_name, o.label_mime, o.label_uploaded_at, o.label_origin,
      o.tracking_status, o.tracking_exception, o.tracking_needs_entry, o.shippo_track_id,
      o.cancel_source, o.cancel_reason, o.canceled_at, o.ship_by,
      o.pack_condition, o.pack_condition_at,
      o.pack_proof_photo_path, o.pack_proof_serial, o.pack_proof_at,
      o.match_status, o.marketplace_fee_cents, o.marketplace_title,
      o.sale_id,
      case when o.sale_id is not null
        then coalesce(sl.ticket_id::text, 'sale:' || o.sale_id::text)
        else null end as ticket_key,
      coalesce(nullif(btrim(o.marketplace_title), ''), nullif(btrim(u.title), ''),
        nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), 'Item') as title,
      coalesce(u.listed_on, '{}'::text[]) as listed_on,
      coalesce(co.fee_cents, o.marketplace_fee_cents, sl.channel_fee_cents) as fee_cents,
      coalesce(
        co.fee_source,
        case
          when co.fee_cents is null and o.marketplace_fee_cents is null and sl.fee_source is not null
            then sl.fee_source
          when co.fee_cents is null and o.marketplace_fee_cents is not null then 'estimated'
          else null
        end
      ) as fee_source,
      sl.cost_cents,
      sl.profit_cents,
      case when sl.profit_cents is null then null
        else greatest(0, round(sl.profit_cents * v_income_pct / 100.0))::int end as income_tax_cents,
      sl.tax_remitted_by,
      coalesce(sl.tax_collected_cents, o.tax_cents, 0) as tax_collected_cents,
      coalesce(sl.tax_owed_cents, 0) as tax_owed_cents,
      case
        when lower(o.channel) = 'ebay' and o.order_no is not null
          then 'https://www.ebay.com/mesh/ord/details?orderid=' || o.order_no
        when lower(o.channel) = 'amazon' and o.order_no is not null
          then 'https://sellercentral.amazon.com/orders-v3/order/' || o.order_no
        when lower(o.channel) = 'tiktok' and o.order_no is not null
          then 'https://seller-us.tiktok.com/order/detail?order_no=' || o.order_no
        when lower(o.channel) = 'depop' and o.order_no is not null
          then 'https://www.depop.com/sellinghub/sold/'
        when lower(o.channel) = 'mercari' and o.order_no is not null
          then 'https://www.mercari.com/mypage/listings/completed/'
        when lower(o.channel) in ('website','web') and o.order_no is not null
          then 'https://openboxindustries.com/account/orders/' || o.order_no
        else null
      end as marketplace_url,
      jsonb_build_object(
        'length_in', u.package_length_in,
        'width_in', u.package_width_in,
        'height_in', u.package_height_in,
        'weight_lb', u.package_weight_lb
      ) as package
    from public.web_orders o
    left join public.units u on u.store_id = o.store_id and u.sku = o.sku
    left join public.channel_orders co
      on co.store_id = o.store_id and co.provider = o.channel and co.order_id = o.order_no
    left join public.sale_ledger sl on sl.id = o.sale_id
    where o.store_id = v_store
      and o.created_at > now() - make_interval(days => greatest(p_days, 1))
      and (o.status in ('paid', 'refunded', 'canceled') or o.paid_at is not null)
      and coalesce(o.payment_env, 'production') <> 'sandbox'
      and lower(coalesce(o.order_no, '')) not like 'sandbox%'
  ) x), '[]'::jsonb);
end $$;

-- Same signature as 20261102090000. Adds order_id so the sale form can attach a label.
create or replace function public.portal_depop_record_sale(
  p_sku text, p_sale_cents int, p_fee_cents int, p_payout_cents int default null, p_sold_on date default null, p_note text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  v_admin text; v_id uuid := gen_random_uuid(); v_day date; v_payout int; v_sale public.sales; v_deduct int; v_cost int; v_was_sold boolean := false;
  v_order uuid;
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if p_sale_cents is null or p_sale_cents <= 0 then raise exception 'invalid_sale_price' using errcode = '22023'; end if;
  if p_fee_cents is null or p_fee_cents < 0 then raise exception 'invalid_fee' using errcode = '22023'; end if;
  v_payout := coalesce(p_payout_cents, p_sale_cents - p_fee_cents);
  if v_payout < 0 or v_payout > p_sale_cents then raise exception 'invalid_payout' using errcode = '22023'; end if;
  v_day := coalesce(p_sold_on, (now() at time zone 'America/Los_Angeles')::date);
  if v_day > (now() at time zone 'America/Los_Angeles')::date then raise exception 'sale_date_in_future' using errcode = '22023'; end if;
  v_was_sold := exists (select 1 from public.units u where u.store_id = v_store and u.sku = p_sku and u.state = 'sold'
    and not exists (select 1 from public.sales s where s.store_id = u.store_id and s.sku = u.sku and s.voided_at is null));
  if not v_was_sold and not exists (select 1 from public.units where store_id = v_store and sku = p_sku and state in ('available', 'reserved')) then
    raise exception 'unit_not_sellable' using errcode = 'P0001';
  end if;
  v_admin := public.disposition_actor_name(auth.uid());
  perform set_config('floor.depop_manual', 'on', true);
  if v_was_sold then update public.units set state = 'available' where store_id = v_store and sku = p_sku and state = 'sold'; end if;
  v_sale := public.finalize_sale(p_sku, 'depop', p_sale_cents, 'depop', 'depop-manual:' || v_id::text,
    null, null, null, coalesce(nullif(btrim(p_note), ''), 'Depop sale (entered by hand)'), null, 0, null);
  if v_was_sold then delete from public.delist_tasks where sale_id = v_sale.id; end if;
  v_deduct := p_sale_cents - v_payout;
  update public.sales set sold_at = public.depop_sold_at(v_day) where id = v_sale.id;
  insert into public.channel_orders (store_id, provider, order_id, sku, sale_id, item_cents, fee_cents, fee_source, baked_ship_cents)
    values (v_store, 'depop', 'manual:' || v_id::text, p_sku, v_sale.id, p_sale_cents, v_deduct, 'actual', 0);
  insert into public.web_orders (store_id, sku, sale_id, status, channel, fulfillment, order_no, paid_at, buyer_name,
      item_cents, shipping_cents, tax_cents, total_cents, payment_id, payment_env, match_status, marketplace_fee_cents,
      marketplace_title)
    select v_store, p_sku, v_sale.id, 'paid', 'depop', 'ship', 'DEPOP-' || v_sale.receipt_no, public.depop_sold_at(v_day), 'Depop buyer',
      p_sale_cents, 0, 0, p_sale_cents, 'depop-manual:' || v_id::text, 'production', 'matched', v_deduct,
      left(coalesce(nullif(u.title, ''), concat_ws(' ', u.brand, u.model), 'Depop sale'), 250)
    from public.units u where u.store_id = v_store and u.sku = p_sku
    returning id into v_order;
  update public.web_order_emails set sent_at = now(), last_error = 'manual Depop entry'
    where order_id in (select id from public.web_orders where sale_id = v_sale.id) and sent_at is null;
  update public.listings set status = 'delisted', delisted_at = now()
    where store_id is not distinct from v_store and sku = p_sku and channel = 'depop' and status <> 'delisted';
  insert into public.depop_sale_entries (id, store_id, sale_id, sku, sale_cents, fee_cents, payout_cents, sold_on, note, created_by, created_by_name, unit_was_sold)
    values (v_id, v_store, v_sale.id, p_sku, p_sale_cents, p_fee_cents, v_payout, v_day, nullif(btrim(p_note), ''), auth.uid(), v_admin, v_was_sold);
  perform public.portal_payout_refreeze(coalesce(v_sale.ticket_id::text, 'sale:' || v_sale.id::text));
  v_cost := public.disposition_unit_cost(v_store, p_sku);
  return jsonb_build_object('id', v_id, 'sale_id', v_sale.id, 'order_id', v_order, 'receipt_no', v_sale.receipt_no, 'payout_cents', v_payout,
    'cost_cents', v_cost, 'cost_missing', v_cost is null);
end $$;

-- Compact tracking numbers so Shippo webhooks match the stored value.
update public.web_orders
  set tracking_number = regexp_replace(tracking_number, '\s+', '', 'g')
  where tracking_number ~ '\s';

-- Backfill stages from timestamps that already exist. Do not invent packaged_at.
-- Orders with a tracking number that are already shipped or delivered keep that stage.
-- Orders with no tracking number are not moved.
update public.web_orders
  set tracking_status = 'delivered'
  where delivered_at is not null
    and nullif(btrim(coalesce(tracking_number, '')), '') is not null
    and tracking_status is null;

update public.web_orders
  set tracking_status = 'transit'
  where shipped_at is not null
    and delivered_at is null
    and nullif(btrim(coalesce(tracking_number, '')), '') is not null
    and tracking_status is null;

do $$
declare v_delivered int; v_transit int; v_open_track int; v_no_track int;
begin
  select count(*) into v_delivered from public.web_orders
    where delivered_at is not null and nullif(btrim(coalesce(tracking_number, '')), '') is not null;
  select count(*) into v_transit from public.web_orders
    where shipped_at is not null and delivered_at is null and nullif(btrim(coalesce(tracking_number, '')), '') is not null;
  select count(*) into v_open_track from public.web_orders
    where delivered_at is null and shipped_at is null and nullif(btrim(coalesce(tracking_number, '')), '') is not null;
  select count(*) into v_no_track from public.web_orders
    where status = 'paid' and fulfillment = 'ship' and nullif(btrim(coalesce(tracking_number, '')), '') is null;
  raise notice 'order tracking backfill: % delivered with tracking, % shipped with tracking, % still to-ship/packaged with tracking (left in place), % paid ship orders with no tracking (left in place)',
    v_delivered, v_transit, v_open_track, v_no_track;
end $$;

commit;
