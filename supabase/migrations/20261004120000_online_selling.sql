-- Online selling: every listed unit can be bought online for store pickup; shipping only when the
-- package dims/weight are known and the unit passes the adjustable size/category rules. Shipping
-- is charged from a live carrier quote saved server-side (never a client-supplied amount).
begin;

-- Package/product dimensions (same columns as the video-scan intake; idempotent).
alter table public.units
  add column if not exists product_height_in numeric(10,2),
  add column if not exists product_width_in numeric(10,2),
  add column if not exists product_depth_in numeric(10,2),
  add column if not exists product_weight_lb numeric(10,2),
  add column if not exists package_length_in numeric(10,2),
  add column if not exists package_width_in numeric(10,2),
  add column if not exists package_height_in numeric(10,2),
  add column if not exists package_weight_lb numeric(10,2),
  add column if not exists dims_source text,
  add column if not exists fulfillment_override text;

do $$
begin
  if not exists(select 1 from pg_constraint where conname='units_dims_source_allowed'
    and conrelid='public.units'::regclass) then
    alter table public.units add constraint units_dims_source_allowed
      check (dims_source is null or dims_source in ('verified','estimated'));
  end if;
  if not exists(select 1 from pg_constraint where conname='units_fulfillment_override_allowed'
    and conrelid='public.units'::regclass) then
    alter table public.units add constraint units_fulfillment_override_allowed
      check (fulfillment_override is null or fulfillment_override in ('ship','pickup'));
  end if;
end $$;

-- Adjustable rules (admin portal → Online selling). Limits default to real carrier limits:
-- UPS 108 in longest side / 165 in length+girth; 70 lb (USPS max) keeps heavy goods pickup-only.
insert into public.store_settings (store_id, key, value)
select s.id, d.key, d.value
  from public.stores s
 cross join (values
   ('ship_excluded_categories', '["Refrigerator","Freezer","Mattresses","Dishwasher","Washer","Dryer","Range","Oven","Living room furniture","Furniture"]'::jsonb),
   ('ship_excluded_keywords', '["refrigerator","fridge","freezer","mattress","box spring","dishwasher","washing machine","sofa","sectional","couch","recliner"]'::jsonb),
   ('ship_max_weight_lb', '70'::jsonb),
   ('ship_max_length_in', '108'::jsonb),
   ('ship_max_length_girth_in', '165'::jsonb),
   ('pickup_hold_hours', '48'::jsonb),
   ('order_notify_emails', '["paul@sentinelprime.org"]'::jsonb),
   ('store_hours', '{"0":["10:00","18:00"],"1":null,"2":null,"3":["11:00","18:30"],"4":["11:00","18:30"],"5":["11:00","18:30"],"6":["11:00","18:30"]}'::jsonb),
   ('ship_from', '{"name":"Open Box Industries","street1":"3121 Penryn Rd","street2":"Suite 320","city":"Penryn","state":"CA","zip":"95663","country":"US","phone":"+12799770722"}'::jsonb)
 ) as d(key, value)
on conflict (store_id, key) do nothing;

create or replace function public.setting_text_array(p_store uuid, p_key text)
returns text[] language sql stable set search_path = public as $$
  select coalesce(array(
    select lower(btrim(x)) from jsonb_array_elements_text(
      case when jsonb_typeof(public.store_setting(p_store, p_key, '[]'::jsonb)) = 'array'
        then public.store_setting(p_store, p_key, '[]'::jsonb) else '[]'::jsonb end) x
    where btrim(x) <> ''), '{}');
$$;

-- One place decides ship eligibility. Missing package data is always pickup-only:
-- shipping is never priced from a guess, even when staff force shipping on.
create or replace function public.unit_ship_check(u public.units)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_dims numeric[];
  v_text text;
  k text;
  v_max_lb numeric := coalesce(nullif(public.store_setting(u.store_id,'ship_max_weight_lb','70'::jsonb) #>> '{}','')::numeric, 70);
  v_max_len numeric := coalesce(nullif(public.store_setting(u.store_id,'ship_max_length_in','108'::jsonb) #>> '{}','')::numeric, 108);
  v_max_lg numeric := coalesce(nullif(public.store_setting(u.store_id,'ship_max_length_girth_in','165'::jsonb) #>> '{}','')::numeric, 165);
begin
  if u.fulfillment_override = 'pickup' then
    return jsonb_build_object('ship', false, 'reason', 'Pickup only (set by staff)');
  end if;
  if coalesce(u.package_weight_lb,0) <= 0 or coalesce(u.package_length_in,0) <= 0
     or coalesce(u.package_width_in,0) <= 0 or coalesce(u.package_height_in,0) <= 0 then
    return jsonb_build_object('ship', false, 'missing_dims', true,
      'reason', 'Missing package dimensions or weight');
  end if;
  if u.fulfillment_override = 'ship' then
    return jsonb_build_object('ship', true, 'reason', 'Shipping forced on by staff');
  end if;
  if lower(btrim(coalesce(u.category,''))) = any (public.setting_text_array(u.store_id,'ship_excluded_categories')) then
    return jsonb_build_object('ship', false, 'reason', format('%s is a pickup-only category', u.category));
  end if;
  v_text := lower(concat_ws(' ', u.title, u.brand, u.model, u.category));
  foreach k in array public.setting_text_array(u.store_id,'ship_excluded_keywords') loop
    if v_text ~ ('\m' || regexp_replace(k, '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g') || '\M') then
      return jsonb_build_object('ship', false, 'reason', format('Large item ("%s")', k));
    end if;
  end loop;
  v_dims := array(select x from unnest(array[u.package_length_in,u.package_width_in,u.package_height_in]) x order by x desc);
  if u.package_weight_lb > v_max_lb then
    return jsonb_build_object('ship', false, 'reason', format('Package %s lb is over the %s lb limit', u.package_weight_lb, v_max_lb));
  end if;
  if v_dims[1] > v_max_len then
    return jsonb_build_object('ship', false, 'reason', format('Longest side %s in is over the %s in limit', v_dims[1], v_max_len));
  end if;
  if v_dims[1] + 2 * (v_dims[2] + v_dims[3]) > v_max_lg then
    return jsonb_build_object('ship', false, 'reason', format('Length + girth %s in is over the %s in limit',
      v_dims[1] + 2 * (v_dims[2] + v_dims[3]), v_max_lg));
  end if;
  return jsonb_build_object('ship', true, 'reason', 'Ships');
end $$;
revoke all on function public.unit_ship_check(public.units) from public, anon;
grant execute on function public.unit_ship_check(public.units) to authenticated, service_role;

-- Public catalog: same listing rules; ship flag now comes from unit_ship_check, every row is
-- buyable online (pickup always), and no flat shipping price is published.
create or replace view public.storefront_items
with (security_invoker=false,security_barrier=true) as
select
  u.store_id,u.sku,u.brand,u.model,u.title,u.category,u.condition,
  u.test_status,u.defect_notes,u.defect_notes as unit_defect_notes,
  u.ask_cents,u.msrp_cents,
  coalesce(public.store_setting(u.store_id,'currency','"USD"'::jsonb) #>> '{}','USD') as currency,
  u.received_at,u.updated_at,
  ph.primary_photo_path,ph.photo_paths,
  coalesce(to_jsonb(u)->>'listing_body',to_jsonb(i)->>'listing_body') as listing_body,
  case when spec.raw is null then null else jsonb_strip_nulls(jsonb_build_object(
    'matched_model',spec.raw->'matched_model',
    'height_in',spec.raw->'height_in','width_in',spec.raw->'width_in','depth_in',spec.raw->'depth_in',
    'depth_without_handles_in',spec.raw->'depth_without_handles_in',
    'depth_without_doors_in',spec.raw->'depth_without_doors_in',
    'capacity_cu_ft',spec.raw->'capacity_cu_ft','fridge_cu_ft',spec.raw->'fridge_cu_ft',
    'freezer_cu_ft',spec.raw->'freezer_cu_ft','configuration',spec.raw->'configuration',
    'finish',spec.raw->'finish','ice_maker',spec.raw->'ice_maker',
    'water_dispenser',spec.raw->'water_dispenser','energy',spec.raw->'energy',
    'features',spec.raw->'features','catalog_msrp',spec.raw->'catalog_msrp',
    'weight_lb',spec.raw->'weight_lb')) end as listing_specs,
  coalesce((select jsonb_agg(jsonb_build_object('id',mp.id,'path',mp.path,
      'source_url',mp.source_url,'sort_order',mp.sort_order) order by mp.sort_order,mp.id)
    from public.manufacturer_photos mp where lower(mp.brand)=lower(u.brand)
      and lower(mp.model)=lower(coalesce(u.listing_specs->>'matched_model',u.model))),
    '[]'::jsonb) ||
  coalesce((select jsonb_agg(jsonb_build_object('id',1000000+path.ordinality,
      'path',path.value,'source_url',asset.source_url,'sort_order',path.ordinality-1)
      order by path.ordinality)
    from jsonb_array_elements_text(coalesce(asset.public_paths,'[]'::jsonb))
      with ordinality as path(value,ordinality)), '[]'::jsonb) as manufacturer_photos,
  u.state as listing_state,null::timestamptz as sold_at,
  coalesce((ship.v->>'ship')::boolean,false) as shippable,
  u.package_weight_lb::numeric as weight_lb,
  true as web_buyable,
  null::integer as shipping_cents,
  coalesce(asset.description,m.description) as model_description,
  coalesce(asset.specs,m.specs) as model_specs,
  coalesce(asset.source_url,m.source_url) as model_source_url,
  true as pickup_available,
  ship.v->>'reason' as ship_note
from public.units u
cross join lateral (
  select count(*)::int as photo_count,
    (array_agg(p.path order by p.is_primary desc,p.created_at,p.id))[1] as primary_photo_path,
    coalesce(jsonb_agg(p.path order by p.is_primary desc,p.created_at,p.id),'[]'::jsonb) as photo_paths
  from public.photos p
  join storage.objects o on o.bucket_id='unit-photos' and o.name=p.path
  where p.store_id=u.store_id and p.sku=u.sku
) ph
cross join lateral (select public.unit_ship_check(u) as v) ship
left join public.public_items i on i.store_id=u.store_id and i.sku=u.sku
left join public.model_enrichment m on m.brand_key=lower(btrim(u.brand)) and m.model_key=lower(btrim(u.model))
left join public.photo_enrichment_suggestions approved on approved.store_id=u.store_id
  and approved.sku=u.sku and approved.status='approved'
left join public.photo_enrichment_assets asset on asset.id=approved.asset_id and asset.status='published'
cross join lateral (select coalesce(to_jsonb(u)->'listing_specs',to_jsonb(i)->'listing_specs') as raw) spec
where u.store_id is not null and u.state='available' and u.ask_cents>0 and ph.photo_count>0
  and (u.show_on_website or not exists(select 1 from public.events e where e.store_id=u.store_id
    and e.sku=u.sku and e.kind='edit' and e.field='show_on_website' and e.new_value in ('false','0')))
  and not exists(select 1 from public.listings l where l.store_id=u.store_id and l.sku=u.sku
    and l.channel='website' and l.status in ('delisted','pending_delist'))
  and not exists(select 1 from public.sales s where s.store_id=u.store_id and s.sku=u.sku and s.voided_at is null)
  and not exists(select 1 from public.reservations r where r.store_id=u.store_id and r.sku=u.sku
    and r.released_at is null and r.finalized_at is null and r.expires_at>now());
grant select on public.storefront_items to anon, authenticated;

-- Orders: pickup + live-rate shipping + label + cancel/refund lifecycle.
create sequence if not exists public.web_order_no_seq start 1001;
alter table public.web_orders
  add column if not exists fulfillment text not null default 'ship',
  add column if not exists order_no text,
  add column if not exists paid_at timestamptz,
  add column if not exists pickup_deadline timestamptz,
  add column if not exists pickup_reminder_sent_at timestamptz,
  add column if not exists picked_up_at timestamptz,
  add column if not exists picked_up_by text,
  add column if not exists shipping_rate jsonb,
  add column if not exists carrier text,
  add column if not exists service text,
  add column if not exists tracking_url text,
  add column if not exists label_url text,
  add column if not exists label_transaction_id text,
  add column if not exists label_cost_cents int,
  add column if not exists label_purchased_at timestamptz,
  add column if not exists refund_requested_at timestamptz,
  add column if not exists cancel_source text,
  add column if not exists cancel_reason text,
  add column if not exists canceled_at timestamptz,
  add column if not exists payment_env text;
do $$
begin
  if not exists(select 1 from pg_constraint where conname='web_orders_fulfillment_allowed'
    and conrelid='public.web_orders'::regclass) then
    alter table public.web_orders add constraint web_orders_fulfillment_allowed
      check (fulfillment in ('ship','pickup'));
  end if;
end $$;
create unique index if not exists web_orders_order_no_key on public.web_orders(order_no) where order_no is not null;
create index if not exists web_orders_open_pickups on public.web_orders(pickup_deadline)
  where fulfillment = 'pickup' and status = 'paid' and picked_up_at is null;
grant select (fulfillment,order_no,paid_at,pickup_deadline,picked_up_at,picked_up_by,carrier,service,
  tracking_url,label_url,label_purchased_at,refund_requested_at,cancel_source,cancel_reason,canceled_at)
  on public.web_orders to authenticated;

-- Live-rate quotes are stored server-side; checkout can only charge one of these amounts.
create table if not exists public.shipping_quotes (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  sku text not null,
  postal text not null,
  region text not null,
  rates jsonb not null,
  source text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '45 minutes'
);
alter table public.shipping_quotes enable row level security;
revoke all on public.shipping_quotes from anon, authenticated;
grant all on public.shipping_quotes to service_role;

create or replace function public.save_shipping_quote(p_store uuid, p_sku text, p_postal text, p_region text, p_rates jsonb, p_source text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform public.assert_service();
  if jsonb_typeof(p_rates) <> 'array' or jsonb_array_length(p_rates) = 0
     or exists(select 1 from jsonb_array_elements(p_rates) r where coalesce((r->>'amount_cents')::int,0) <= 0) then
    raise exception 'invalid_rates' using errcode = 'P0001';
  end if;
  delete from public.shipping_quotes where expires_at < now() - interval '1 day';
  insert into public.shipping_quotes(store_id, sku, postal, region, rates, source)
  values (p_store, p_sku, left(regexp_replace(p_postal,'\D','','g'),5), upper(btrim(p_region)), p_rates, p_source)
  returning id into v_id;
  return v_id;
end $$;

-- Ship flag for one SKU (checkout uses this before calling the carrier).
create or replace function public.web_unit_fulfillment(p_store uuid, p_sku text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare u public.units;
begin
  perform public.assert_service();
  select * into u from public.units where store_id = p_store and sku = p_sku;
  if not found or not exists(select 1 from public.storefront_items s where s.store_id = p_store and s.sku = p_sku) then
    return jsonb_build_object('listed', false);
  end if;
  return public.unit_ship_check(u) || jsonb_build_object('listed', true, 'sku', u.sku,
    'title', coalesce(nullif(btrim(u.title),''), concat_ws(' ', u.brand, u.model)),
    'ask_cents', u.ask_cents, 'shipping_cents_override', u.shipping_cents,
    'package', jsonb_build_object('length_in', u.package_length_in, 'width_in', u.package_width_in,
      'height_in', u.package_height_in, 'weight_lb', u.package_weight_lb),
    'ship_from', public.store_setting(p_store, 'ship_from', '{}'::jsonb));
end $$;

-- Pickup deadline: N hours after payment, extended to closing time of the first open day.
create or replace function public.pickup_deadline_from(p_store uuid, p_from timestamptz)
returns timestamptz language plpgsql stable set search_path = public as $$
declare
  v_hours int := coalesce(nullif(public.store_setting(p_store,'pickup_hold_hours','48'::jsonb) #>> '{}','')::int, 48);
  v_hours_map jsonb := public.store_setting(p_store,'store_hours','{}'::jsonb);
  t timestamptz := p_from + make_interval(hours => v_hours);
  v_local timestamp;
  v_day jsonb;
  v_close timestamptz;
  i int;
begin
  for i in 1..14 loop
    v_local := t at time zone 'America/Los_Angeles';
    v_day := v_hours_map -> (extract(dow from v_local)::int)::text;
    if jsonb_typeof(v_day) = 'array' then
      v_close := (v_local::date + (v_day->>1)::time) at time zone 'America/Los_Angeles';
      if t <= v_close then return v_close; end if;
    end if;
    t := ((v_local::date + 1)::timestamp) at time zone 'America/Los_Angeles';
  end loop;
  return p_from + make_interval(hours => v_hours);
end $$;

-- Register/phone cannot sell a unit while someone is paying for it online.
create or replace function public.guard_online_checkout_hold()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.channel is distinct from 'website' and (
    exists(select 1 from public.reservations r
            where r.store_id = new.store_id and r.sku = new.sku and r.channel = 'website'
              and r.released_at is null and r.finalized_at is null and r.expires_at > now())
    or exists(select 1 from public.web_orders o
            where o.store_id = new.store_id and o.sku = new.sku and o.status = 'claimed'
              and o.payment_started_at > now() - interval '30 minutes')
  ) then
    raise exception 'held_by_online_order' using errcode = 'P0001',
      message = format('held_by_online_order %s', new.sku);
  end if;
  return new;
end $$;
drop trigger if exists sales_online_hold_guard on public.sales;
create trigger sales_online_hold_guard before insert on public.sales
  for each row execute function public.guard_online_checkout_hold();

-- Online checkout (ship or pickup). Replaces the shipping-only claim path.
drop function if exists public.begin_shipping_checkout(uuid,text,jsonb,int);
drop function if exists public.claim_web_checkout(uuid,text,jsonb);
create or replace function public.begin_online_checkout(
  p_store uuid, p_sku text, p_buyer jsonb, p_fulfillment text,
  p_quote uuid default null, p_rate text default null, p_redeem_points int default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_unit public.units;
  v_res public.reservations;
  v_order public.web_orders;
  v_rate jsonb := null;
  v_ship int := 0;
  v_ship_tax int := 0;
  v_customer jsonb;
  v_cust_id uuid;
  v_redeem int;
  v_quote jsonb;
  v_postal text := left(regexp_replace(coalesce(p_buyer->>'postal',''),'\D','','g'),5);
begin
  perform public.assert_service();
  perform set_config('floor.store_id', p_store::text, true);
  if p_fulfillment not in ('ship','pickup') then raise exception 'fulfillment_required'; end if;
  if coalesce(p_buyer->>'email','') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or coalesce(btrim(p_buyer->>'name'),'') = '' or length(regexp_replace(coalesce(p_buyer->>'phone',''),'\D','','g')) < 10 then
    raise exception 'buyer_contact_required';
  end if;
  if p_fulfillment = 'ship' and (coalesce(btrim(p_buyer->>'line1'),'') = '' or coalesce(btrim(p_buyer->>'city'),'') = ''
     or coalesce(btrim(p_buyer->>'region'),'') = '' or v_postal = '') then
    raise exception 'buyer_address_required';
  end if;
  perform public.release_expired_reservations();

  select * into v_unit from public.units where store_id = p_store and sku = p_sku for update;
  if not found or v_unit.state <> 'available' or coalesce(v_unit.ask_cents,0) <= 0
     or not exists(select 1 from public.storefront_items s where s.store_id = p_store and s.sku = p_sku) then
    raise exception 'held_or_unavailable' using errcode = 'P0001';
  end if;

  if p_fulfillment = 'ship' then
    if not coalesce((public.unit_ship_check(v_unit)->>'ship')::boolean, false) then
      raise exception 'not_shippable' using errcode = 'P0001';
    end if;
    select r.value into v_rate
      from public.shipping_quotes q, jsonb_array_elements(q.rates) as r(value)
     where q.id = p_quote and q.store_id = p_store and q.sku = p_sku and q.expires_at > now()
       and q.postal = v_postal and q.region = upper(btrim(p_buyer->>'region'))
       and r.value->>'id' = p_rate
     limit 1;
    v_ship := coalesce((v_rate->>'amount_cents')::int, 0);
    if v_rate is null or v_ship <= 0 then
      raise exception 'shipping_rate_invalid' using errcode = 'P0001';
    end if;
  end if;

  update public.units set state = 'reserved', updated_at = now()
   where store_id = p_store and sku = p_sku and state = 'available';
  insert into public.reservations (store_id, sku, channel, actor_id, expires_at)
  values (p_store, p_sku, 'website', null, now() + public.web_hold_ttl())
  returning * into v_res;

  v_customer := public.web_lookup_customer(p_store, p_buyer->>'phone');
  v_cust_id := (v_customer->>'id')::uuid;
  v_redeem := least(greatest(coalesce(p_redeem_points,0),0), coalesce((v_customer->>'points_balance')::int,0));
  v_quote := public.web_quote(p_store, jsonb_build_array(jsonb_build_object('sku',p_sku,'price_cents',v_unit.ask_cents,'qty',1)), v_cust_id, v_redeem);
  -- Existing rule kept as-is: shipping is taxed at the store rate (see report before changing).
  v_ship_tax := round(v_ship * public.store_tax_rate_bps() / 10000.0);

  insert into public.web_orders (
    store_id, sku, reservation_id, status, fulfillment,
    buyer_name, buyer_email, buyer_phone,
    ship_line1, ship_line2, ship_city, ship_region, ship_postal, ship_country,
    item_cents, shipping_cents, tax_cents, total_cents,
    checkout_quote, customer_id, redeem_points, shipping_rate, carrier, service
  ) values (
    p_store, p_sku, v_res.id, 'claimed', p_fulfillment,
    btrim(p_buyer->>'name'), lower(btrim(p_buyer->>'email')), btrim(p_buyer->>'phone'),
    case when p_fulfillment = 'ship' then nullif(btrim(p_buyer->>'line1'),'') end,
    case when p_fulfillment = 'ship' then nullif(btrim(p_buyer->>'line2'),'') end,
    case when p_fulfillment = 'ship' then nullif(btrim(p_buyer->>'city'),'') end,
    case when p_fulfillment = 'ship' then upper(nullif(btrim(p_buyer->>'region'),'')) end,
    case when p_fulfillment = 'ship' then nullif(btrim(p_buyer->>'postal'),'') end,
    'US',
    v_unit.ask_cents, v_ship, (v_quote->>'tax_cents')::int + v_ship_tax,
    (v_quote->>'total_cents')::int + v_ship + v_ship_tax,
    v_quote, v_cust_id, v_redeem, v_rate, v_rate->>'carrier', v_rate->>'service'
  ) returning * into v_order;

  insert into public.events (store_id, sku, kind, actor, note)
  values (p_store, p_sku, 'reserved', 'website', 'web checkout hold (' || p_fulfillment || ')');

  return jsonb_build_object(
    'order_id', v_order.id, 'reservation_id', v_res.id, 'expires_at', v_res.expires_at,
    'sku', p_sku, 'fulfillment', p_fulfillment,
    'title', coalesce(nullif(btrim(v_unit.title),''), concat_ws(' ', v_unit.brand, v_unit.model)),
    'item_cents', v_unit.ask_cents, 'shipping_cents', v_ship, 'shipping_rate', v_rate,
    'customer', v_customer,
    'quote', v_quote || jsonb_build_object('shipping_cents', v_ship,
      'tax_cents', (v_quote->>'tax_cents')::int + v_ship_tax,
      'total_cents', (v_quote->>'total_cents')::int + v_ship + v_ship_tax),
    'store_name', coalesce(public.store_setting(p_store,'display_name','"Store"'::jsonb) #>> '{}','Store'));
end $$;

create or replace function public.complete_shipping_checkout(p_store uuid,p_order uuid,p_payment text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare o public.web_orders; r public.reservations; v_quote jsonb; v_lines jsonb; v_summary jsonb; v_sale bigint; v_no text;
begin
  perform public.assert_service();
  perform set_config('floor.store_id',p_store::text,true);
  perform 1 from public.units where store_id=p_store and sku=(select sku from public.web_orders where id=p_order and store_id=p_store) for update;
  select * into o from public.web_orders where id=p_order and store_id=p_store for update;
  if not found then raise exception 'order_not_found'; end if;
  if o.status='paid' and o.payment_id=p_payment then return public.ticket_summary(p_store,o.reservation_id) || jsonb_build_object('total_cents',o.total_cents,'shipping_cents',o.shipping_cents,'order_no',o.order_no,'pickup_deadline',o.pickup_deadline); end if;
  if o.status <> 'claimed' or o.checkout_quote is null or nullif(p_payment,'') is null then raise exception 'order_not_payable'; end if;
  select * into r from public.reservations where id=o.reservation_id for update;
  if r.released_at is not null or r.finalized_at is not null or r.expires_at <= now() then raise exception 'reservation_expired'; end if;
  if o.customer_id is not null then perform 1 from public.customers where id=o.customer_id for update; end if;
  v_lines:=jsonb_build_array(jsonb_build_object('sku',o.sku,'price_cents',o.item_cents,'qty',1));
  v_quote:=public.web_quote(p_store,v_lines,o.customer_id,o.redeem_points);
  if v_quote is distinct from o.checkout_quote then raise exception 'quote_changed'; end if;
  v_no := 'OB-' || nextval('public.web_order_no_seq');
  v_summary:=public.web_finalize_ticket(p_store,o.reservation_id,v_lines,p_payment,o.customer_id,o.redeem_points,
    'Online ' || case when o.fulfillment='pickup' then 'pickup' else 'shipping' end || ' order ' || v_no);
  v_sale:=(v_summary->'lines'->0->>'sale_id')::bigint;
  if v_sale is null then raise exception 'sale_missing'; end if;
  update public.sales set shipping_cents=o.shipping_cents,tax_cents=o.tax_cents,
    customer_name=o.buyer_name,customer_email=o.buyer_email,customer_phone=o.buyer_phone where id=v_sale;
  update public.ticket_extras set card_cents=o.total_cents where store_id=p_store and ticket_id=o.reservation_id;
  update public.reservations set finalized_at=now(),sale_id=v_sale,payment_id=p_payment where id=o.reservation_id;
  update public.web_orders set status='paid',sale_id=v_sale,payment_id=p_payment,payment_source_id=null,
    order_no=v_no, paid_at=now(),
    pickup_deadline=case when fulfillment='pickup' then public.pickup_deadline_from(p_store, now()) end,
    updated_at=now() where id=o.id returning * into o;
  return public.ticket_summary(p_store,o.reservation_id) || jsonb_build_object('total_cents',o.total_cents,
    'shipping_cents',o.shipping_cents,'order_no',o.order_no,'fulfillment',o.fulfillment,'pickup_deadline',o.pickup_deadline);
end $$;

-- Cancel & refund. Step 1 locks the order against pickup/shipping; the caller then refunds
-- through Square (idempotent key) and step 2 reverses the sale so the unit is back on sale.
create or replace function public.request_web_order_refund(p_store uuid, p_order uuid, p_source text, p_reason text)
returns public.web_orders language plpgsql security definer set search_path = public as $$
declare o public.web_orders;
begin
  perform public.assert_service();
  select * into o from public.web_orders where id = p_order and store_id = p_store for update;
  if not found then raise exception 'order_not_found' using errcode = 'P0001'; end if;
  if o.refund_requested_at is not null and o.status = 'paid' then return o; end if;
  if o.status <> 'paid' then raise exception 'order_not_cancellable' using errcode = 'P0001'; end if;
  if o.picked_up_at is not null then raise exception 'already_picked_up' using errcode = 'P0001'; end if;
  if o.shipped_at is not null then raise exception 'already_shipped' using errcode = 'P0001'; end if;
  if p_source = 'pickup_expired' and (o.fulfillment <> 'pickup' or o.pickup_deadline > now()) then
    raise exception 'pickup_not_expired' using errcode = 'P0001';
  end if;
  update public.web_orders set refund_requested_at = now(), cancel_source = p_source,
    cancel_reason = nullif(btrim(p_reason),''), updated_at = now() where id = o.id returning * into o;
  return o;
end $$;

create or replace function public.finish_web_order_refund(p_store uuid, p_order uuid, p_refund text)
returns public.web_orders language plpgsql security definer set search_path = public as $$
declare o public.web_orders;
begin
  perform public.assert_service();
  perform set_config('floor.store_id', p_store::text, true);
  select * into o from public.web_orders where id = p_order and store_id = p_store for update;
  if not found then raise exception 'order_not_found' using errcode = 'P0001'; end if;
  if o.status = 'refunded' then return o; end if;
  if o.status <> 'paid' or o.refund_requested_at is null or nullif(p_refund,'') is null then
    raise exception 'refund_not_requested' using errcode = 'P0001';
  end if;
  -- Voids the sale (reports/payouts drop it), restores the unit, reverses points, relists.
  perform public.void_ticket(o.reservation_id,
    'Online order ' || coalesce(o.order_no, o.id::text) || ' refunded: ' || coalesce(o.cancel_reason, o.cancel_source), null);
  update public.web_orders set status = 'refunded', refund_id = p_refund, canceled_at = now(), updated_at = now()
   where id = o.id returning * into o;
  insert into public.events (store_id, sku, kind, actor, note)
  values (p_store, o.sku, 'web_order_refunded', 'website', coalesce(o.order_no,'') || ' ' || coalesce(o.cancel_source,''));
  return o;
end $$;

-- Staff/admin pickup handoff.
create or replace function public.pickup_orders_store()
returns uuid language sql stable security definer set search_path = public as $$
  select coalesce(public.current_store_id(), public.portal_store_id());
$$;

create or replace function public.open_pickup_orders()
returns table(id uuid, order_no text, sku text, title text, buyer_name text, buyer_phone text, buyer_email text,
  total_cents int, paid_at timestamptz, pickup_deadline timestamptz, picked_up_at timestamptz, picked_up_by text, status text)
language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.pickup_orders_store();
begin
  if v_store is null then raise exception 'not_staff' using errcode = '42501'; end if;
  return query
    select o.id, o.order_no, o.sku,
      coalesce(nullif(btrim(u.title),''), nullif(btrim(concat_ws(' ', u.brand, u.model)),''), 'Item')::text,
      o.buyer_name, o.buyer_phone, o.buyer_email, o.total_cents, o.paid_at, o.pickup_deadline,
      o.picked_up_at, o.picked_up_by,
      case when o.picked_up_at is not null then 'picked_up' when o.refund_requested_at is not null then 'canceling' else 'awaiting' end
    from public.web_orders o
    left join public.units u on u.store_id = o.store_id and u.sku = o.sku
    where o.store_id = v_store and o.fulfillment = 'pickup' and o.status = 'paid'
      and (o.picked_up_at is null or o.picked_up_at > now() - interval '2 days')
    order by (o.picked_up_at is not null), o.pickup_deadline;
end $$;

create or replace function public.mark_pickup_complete(p_order uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.pickup_orders_store();
  v_who text := coalesce((select display_name from public.staff where user_id = auth.uid()),
                         (select email from auth.users where id = auth.uid()), 'staff');
  o public.web_orders;
begin
  if v_store is null then raise exception 'not_staff' using errcode = '42501'; end if;
  update public.web_orders set picked_up_at = now(), picked_up_by = v_who, updated_at = now()
   where id = p_order and store_id = v_store and fulfillment = 'pickup' and status = 'paid'
     and picked_up_at is null and refund_requested_at is null
  returning * into o;
  if not found then raise exception 'pickup_not_open' using errcode = 'P0001'; end if;
  insert into public.events (store_id, sku, kind, actor, actor_id, note)
  values (v_store, o.sku, 'picked_up', v_who, auth.uid(), o.order_no);
  return jsonb_build_object('id', o.id, 'order_no', o.order_no, 'picked_up_at', o.picked_up_at, 'picked_up_by', o.picked_up_by);
end $$;

-- Admin portal: orders, settings, per-unit shipping data.
create or replace function public.portal_web_orders(p_days int default 90)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(x order by x.created_at desc) from (
    select o.id, o.order_no, o.sku, o.status, o.fulfillment, o.buyer_name, o.buyer_email, o.buyer_phone,
      o.ship_line1, o.ship_line2, o.ship_city, o.ship_region, o.ship_postal,
      o.item_cents, o.shipping_cents, o.tax_cents, o.total_cents, o.payment_id, o.refund_id, o.payment_env,
      o.created_at, o.paid_at, o.pickup_deadline, o.picked_up_at, o.picked_up_by,
      o.boxed_at, o.shipped_at, o.tracking_number, o.tracking_url, o.carrier, o.service, o.shipping_rate,
      o.label_url, o.label_purchased_at, o.label_cost_cents, o.refund_requested_at, o.cancel_source,
      o.cancel_reason, o.canceled_at,
      coalesce(nullif(btrim(u.title),''), nullif(btrim(concat_ws(' ', u.brand, u.model)),''), 'Item') as title,
      jsonb_build_object('length_in',u.package_length_in,'width_in',u.package_width_in,
        'height_in',u.package_height_in,'weight_lb',u.package_weight_lb) as package
    from public.web_orders o
    left join public.units u on u.store_id = o.store_id and u.sku = o.sku
    where o.store_id = v_store and o.created_at > now() - make_interval(days => greatest(p_days,1))
      and (o.status in ('paid','refunded') or o.paid_at is not null)
  ) x), '[]'::jsonb);
end $$;

create or replace function public.portal_online_settings()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return jsonb_build_object(
    'ship_excluded_categories', public.store_setting(v_store,'ship_excluded_categories','[]'::jsonb),
    'ship_excluded_keywords', public.store_setting(v_store,'ship_excluded_keywords','[]'::jsonb),
    'ship_max_weight_lb', public.store_setting(v_store,'ship_max_weight_lb','70'::jsonb),
    'ship_max_length_in', public.store_setting(v_store,'ship_max_length_in','108'::jsonb),
    'ship_max_length_girth_in', public.store_setting(v_store,'ship_max_length_girth_in','165'::jsonb),
    'pickup_hold_hours', public.store_setting(v_store,'pickup_hold_hours','48'::jsonb),
    'order_notify_emails', public.store_setting(v_store,'order_notify_emails','[]'::jsonb),
    'categories', public.store_setting(v_store,'categories','[]'::jsonb),
    'counts', (select jsonb_build_object(
        'listed', count(*),
        'shippable', count(*) filter (where s.shippable),
        'pickup_only', count(*) filter (where not s.shippable),
        'missing_dims', count(*) filter (where s.ship_note = 'Missing package dimensions or weight'))
      from public.storefront_items s where s.store_id = v_store),
    'pickup_only_units', coalesce((select jsonb_agg(jsonb_build_object('sku',s.sku,'title',
        coalesce(nullif(btrim(s.title),''), concat_ws(' ', s.brand, s.model)),'category',s.category,'reason',s.ship_note) order by s.sku)
      from public.storefront_items s where s.store_id = v_store and not s.shippable), '[]'::jsonb));
end $$;

create or replace function public.portal_set_online_setting(p_key text, p_value jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if p_key in ('ship_excluded_categories','ship_excluded_keywords') then
    if jsonb_typeof(p_value) <> 'array' or exists(select 1 from jsonb_array_elements(p_value) x where jsonb_typeof(x) <> 'string') then
      raise exception 'list_of_text_required' using errcode = '22023';
    end if;
  elsif p_key = 'order_notify_emails' then
    if jsonb_typeof(p_value) <> 'array' or jsonb_array_length(p_value) = 0 or exists(select 1 from jsonb_array_elements_text(p_value) x
        where x !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') then
      raise exception 'valid_emails_required' using errcode = '22023';
    end if;
  elsif p_key in ('ship_max_weight_lb','ship_max_length_in','ship_max_length_girth_in','pickup_hold_hours') then
    if jsonb_typeof(p_value) <> 'number' or (p_value #>> '{}')::numeric <= 0 then
      raise exception 'positive_number_required' using errcode = '22023';
    end if;
  else
    raise exception 'setting_not_editable' using errcode = '22023';
  end if;
  insert into public.store_settings(store_id, key, value) values (v_store, p_key, p_value)
  on conflict (store_id, key) do update set value = excluded.value;
end $$;

create or replace function public.portal_unit_shipping(p_sku text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id(); u public.units;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  select * into u from public.units where store_id = v_store and sku = p_sku;
  if not found then return null; end if;
  return jsonb_build_object('override', u.fulfillment_override, 'check', public.unit_ship_check(u),
    'listed', exists(select 1 from public.storefront_items s where s.store_id = v_store and s.sku = p_sku),
    'package_length_in', u.package_length_in, 'package_width_in', u.package_width_in,
    'package_height_in', u.package_height_in, 'package_weight_lb', u.package_weight_lb, 'dims_source', u.dims_source);
end $$;

create or replace function public.portal_set_unit_shipping(p_sku text, p_override text, p_length numeric,
  p_width numeric, p_height numeric, p_weight numeric)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id(); v_who text := (select email from auth.users where id = auth.uid());
  u public.units;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if nullif(p_override,'') is not null and p_override not in ('ship','pickup') then raise exception 'invalid_override' using errcode = '22023'; end if;
  if least(coalesce(p_length,1),coalesce(p_width,1),coalesce(p_height,1),coalesce(p_weight,1)) <= 0 then
    raise exception 'dimensions_must_be_positive' using errcode = '22023';
  end if;
  select * into u from public.units where store_id = v_store and sku = p_sku for update;
  if not found then raise exception 'unit_not_found' using errcode = 'P0001'; end if;
  update public.units set fulfillment_override = nullif(p_override,''),
    package_length_in = p_length, package_width_in = p_width, package_height_in = p_height, package_weight_lb = p_weight,
    dims_source = case when (p_length, p_width, p_height, p_weight) is distinct from
      (u.package_length_in, u.package_width_in, u.package_height_in, u.package_weight_lb)
      and p_weight is not null then 'verified' else dims_source end,
    updated_at = now()
   where store_id = v_store and sku = p_sku;
  insert into public.events (store_id, sku, kind, field, old_value, new_value, actor, actor_id)
  values (v_store, p_sku, 'edit', 'shipping', jsonb_build_object('override',u.fulfillment_override,'l',u.package_length_in,
    'w',u.package_width_in,'h',u.package_height_in,'lb',u.package_weight_lb)::text,
    jsonb_build_object('override',nullif(p_override,''),'l',p_length,'w',p_width,'h',p_height,'lb',p_weight)::text,
    coalesce(v_who,'admin'), auth.uid());
  return public.portal_unit_shipping(p_sku);
end $$;

-- Phone/register unit edits gain the override and package fields.
create or replace function public.update_unit_field(p_sku text, p_field text, p_value text)
returns void language plpgsql security definer set search_path to 'public' as $function$
declare v_store uuid := public.current_store_id(); v_old text; v_cost_fields text[] := array['acquisition_cost_cents', 'floor_cents'];
  v_num_fields text[] := array['package_length_in','package_width_in','package_height_in','package_weight_lb',
    'product_height_in','product_width_in','product_depth_in','product_weight_lb'];
begin
  perform public.assert_staff_or_service();
  if p_field = any (v_cost_fields) and not public.is_manager() then raise exception 'not_manager' using errcode = '42501'; end if;
  if p_field not in ('brand','model','title','category','condition','test_status','location','mfr_serial','defect_notes','upc','lot',
      'acquisition_cost_cents','msrp_cents','ask_cents','floor_cents','listing_body','listing_specs','show_on_website','shippable',
      'shipping_cents','fulfillment_override','dims_source') and not (p_field = any (v_num_fields)) then
    raise exception 'invalid_field' using errcode = '22023';
  end if;
  execute format('select %I::text from public.units where sku = $1 and store_id = $2', p_field) into v_old using p_sku, v_store;
  if p_field like '%_cents' then
    execute format('update public.units set %I = $1::int, updated_at = now() where sku = $2 and store_id = $3', p_field) using nullif(p_value, ''), p_sku, v_store;
  elsif p_field = any (v_num_fields) then
    if nullif(p_value,'') is not null and p_value::numeric <= 0 then raise exception 'must_be_positive' using errcode = '22023'; end if;
    execute format('update public.units set %I = $1::numeric, dims_source = case when $1 is null then dims_source else ''verified'' end, updated_at = now() where sku = $2 and store_id = $3', p_field)
      using nullif(p_value, ''), p_sku, v_store;
  elsif p_field = 'listing_specs' then
    update public.units set listing_specs = nullif(p_value, '')::jsonb, updated_at = now() where sku = p_sku and store_id = v_store;
  elsif p_field in ('show_on_website', 'shippable') then
    execute format('update public.units set %I = $1, updated_at = now() where sku = $2 and store_id = $3', p_field)
      using (lower(coalesce(p_value, '')) in ('true', '1', 't', 'yes', 'on')), p_sku, v_store;
  elsif p_field in ('fulfillment_override','dims_source') then
    execute format('update public.units set %I = $1, updated_at = now() where sku = $2 and store_id = $3', p_field)
      using nullif(btrim(p_value), ''), p_sku, v_store;
  else
    execute format('update public.units set %I = $1, updated_at = now() where sku = $2 and store_id = $3', p_field) using p_value, p_sku, v_store;
  end if;
  insert into public.events (store_id, sku, kind, field, old_value, new_value, actor, actor_id)
  values (v_store, p_sku, 'edit', p_field, v_old, p_value, coalesce((select display_name from public.staff where user_id = auth.uid()), 'staff'), auth.uid());
end; $function$;

-- Ship check for the phone/register unit screen.
create or replace function public.unit_ship_status(p_sku text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare u public.units;
begin
  perform public.assert_staff_or_service();
  select * into u from public.units where store_id = public.current_store_id() and sku = p_sku;
  if not found then return null; end if;
  return public.unit_ship_check(u) || jsonb_build_object('override', u.fulfillment_override);
end $$;

-- Website orders show as "Website" in Live Sales instead of an unknown clerk.
create or replace function public.portal_sales(p_from timestamp with time zone, p_to timestamp with time zone)
 returns table(id bigint, ticket_key text, sku text, title text, qty integer, sold_at timestamp with time zone, price_cents integer, tax_cents integer, card_fee_cents integer, cost_cents integer, payment_method text, cash_cents integer, card_cents integer, actor_id uuid, actor_name text, channel text, receipt_no text, list_price_cents integer, override_price_cents integer, override_reason text, override_by_name text)
 language plpgsql stable security definer set search_path to 'public'
as $function$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to > p_from + interval '93 days' then
    raise exception 'invalid_date_range' using errcode = '22023';
  end if;
  return query
    select s.id, coalesce(s.ticket_id::text, 'sale:' || s.id::text), s.sku,
      coalesce(nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), nullif(u.title, ''), 'Item')::text,
      s.qty, s.sold_at, s.price_cents, s.tax_cents, s.card_fee_cents,
      u.acquisition_cost_cents, s.payment_method, x.cash_cents, x.card_cents,
      s.actor_id,
      coalesce(st.display_name, case when s.channel = 'website'
        then 'Website ' || coalesce((select o.order_no || ' · ' || o.fulfillment from public.web_orders o where o.sale_id = s.id limit 1), 'order')
        else 'Unknown' end)::text,
      s.channel, s.receipt_no,
      s.list_price_cents, s.override_price_cents, s.override_reason,
      coalesce(st_override.display_name, 'Unknown')::text
    from public.sales s
    left join public.units u on u.store_id = s.store_id and u.sku = s.sku
    left join public.staff st on st.store_id = s.store_id and st.user_id = s.actor_id
    left join public.staff st_override on st_override.store_id = s.store_id and st_override.user_id = s.override_by
    left join public.ticket_extras x on x.store_id = s.store_id and x.ticket_id = s.ticket_id
    where s.store_id = v_store and s.voided_at is null and s.sold_at >= p_from and s.sold_at < p_to
    order by s.sold_at desc, s.id desc;
end $function$;

-- Emails: tracking goes out when a tracking number is saved; cancel/refund notices added.
alter table public.web_order_emails drop constraint if exists web_order_emails_kind_check;
alter table public.web_order_emails add constraint web_order_emails_kind_check
  check (kind in ('owner','confirmation','tracking','pickup_reminder','canceled','owner_canceled'));
create or replace function public.queue_web_order_emails()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_title text; v_payload jsonb;
begin
  select coalesce(nullif(title,''),concat_ws(' ',brand,model),new.sku) into v_title from public.units where store_id=new.store_id and sku=new.sku;
  v_payload := to_jsonb(new) - 'payment_source_id' || jsonb_build_object('title', v_title);
  if new.status='paid' and (tg_op='INSERT' or old.status is distinct from 'paid') then
    insert into public.web_order_emails(order_id,kind,payload)
      select new.id,k,v_payload from unnest(array['owner','confirmation']) k on conflict do nothing;
  end if;
  if new.tracking_number is not null and (tg_op='INSERT' or old.tracking_number is null) then
    insert into public.web_order_emails(order_id,kind,payload) values(new.id,'tracking',v_payload) on conflict do nothing;
  end if;
  if new.status='refunded' and new.canceled_at is not null and (tg_op='INSERT' or old.canceled_at is null) then
    insert into public.web_order_emails(order_id,kind,payload)
      select new.id,k,v_payload from unnest(array['canceled','owner_canceled']) k on conflict do nothing;
  end if;
  return new;
end $$;

-- Daily listing check results (admin portal shows the latest).
create table if not exists public.listing_checks (
  id bigint generated always as identity primary key,
  store_id uuid not null references public.stores(id) on delete cascade,
  ran_at timestamptz not null default now(),
  ok boolean not null,
  counts jsonb not null,
  problems jsonb not null default '[]'::jsonb,
  healed jsonb not null default '[]'::jsonb,
  emailed_at timestamptz,
  error text
);
alter table public.listing_checks enable row level security;
drop policy if exists portal_listing_checks on public.listing_checks;
create policy portal_listing_checks on public.listing_checks for select to authenticated
  using (store_id = public.portal_store_id());
revoke all on public.listing_checks from anon;
grant select on public.listing_checks to authenticated;
grant all on public.listing_checks to service_role;

-- Floor side of the check: every unit that should be live, with why it is not (if not).
create or replace function public.listing_check_floor(p_store uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.assert_service();
  return coalesce((select jsonb_agg(jsonb_build_object('sku', u.sku,
      'title', coalesce(nullif(btrim(u.title),''), concat_ws(' ', u.brand, u.model)),
      'state', u.state,
      'in_view', exists(select 1 from public.storefront_items s where s.store_id = u.store_id and s.sku = u.sku),
      'reason', case
        when exists(select 1 from public.sales s where s.store_id = u.store_id and s.sku = u.sku and s.voided_at is null)
          then 'Has an un-voided sale but the unit is still marked available'
        when exists(select 1 from public.reservations r where r.store_id = u.store_id and r.sku = u.sku
          and r.released_at is null and r.finalized_at is null and r.expires_at > now())
          then 'Held by an active checkout/reservation'
        when u.state = 'reserved' then 'Stuck in reserved state after its hold expired'
        when not exists(select 1 from public.photos p join storage.objects o on o.bucket_id = 'unit-photos' and o.name = p.path
          where p.store_id = u.store_id and p.sku = u.sku) then 'Photo record exists but the photo file is missing'
        when not u.show_on_website and exists(select 1 from public.events e where e.store_id = u.store_id and e.sku = u.sku
          and e.kind = 'edit' and e.field = 'show_on_website' and e.new_value in ('false','0')) then 'List online is turned off for this unit'
        when exists(select 1 from public.listings l where l.store_id = u.store_id and l.sku = u.sku
          and l.channel = 'website' and l.status in ('delisted','pending_delist')) then 'Website listing is marked delisted'
        else null end) order by u.sku)
    from public.units u
    where u.store_id = p_store and coalesce(u.ask_cents,0) > 0
      and (u.state = 'available' or (u.state = 'reserved' and not exists(select 1 from public.reservations r
        where r.store_id = u.store_id and r.sku = u.sku and r.released_at is null and r.finalized_at is null and r.expires_at > now())))
      and exists(select 1 from public.photos p where p.store_id = u.store_id and p.sku = u.sku)), '[]'::jsonb);
end $$;

revoke all on function public.save_shipping_quote(uuid,text,text,text,jsonb,text),
  public.web_unit_fulfillment(uuid,text),
  public.begin_online_checkout(uuid,text,jsonb,text,uuid,text,int),
  public.complete_shipping_checkout(uuid,uuid,text),
  public.request_web_order_refund(uuid,uuid,text,text),
  public.finish_web_order_refund(uuid,uuid,text),
  public.listing_check_floor(uuid) from public, anon, authenticated;
grant execute on function public.save_shipping_quote(uuid,text,text,text,jsonb,text),
  public.web_unit_fulfillment(uuid,text),
  public.begin_online_checkout(uuid,text,jsonb,text,uuid,text,int),
  public.complete_shipping_checkout(uuid,uuid,text),
  public.request_web_order_refund(uuid,uuid,text,text),
  public.finish_web_order_refund(uuid,uuid,text),
  public.listing_check_floor(uuid) to service_role;
revoke all on function public.open_pickup_orders(), public.mark_pickup_complete(uuid), public.portal_web_orders(int),
  public.portal_online_settings(), public.portal_set_online_setting(text,jsonb), public.portal_unit_shipping(text),
  public.portal_set_unit_shipping(text,text,numeric,numeric,numeric,numeric), public.unit_ship_status(text),
  public.pickup_orders_store(), public.pickup_deadline_from(uuid,timestamptz), public.setting_text_array(uuid,text)
  from public, anon;
grant execute on function public.open_pickup_orders(), public.mark_pickup_complete(uuid), public.portal_web_orders(int),
  public.portal_online_settings(), public.portal_set_online_setting(text,jsonb), public.portal_unit_shipping(text),
  public.portal_set_unit_shipping(text,text,numeric,numeric,numeric,numeric), public.unit_ship_status(text),
  public.pickup_orders_store(), public.pickup_deadline_from(uuid,timestamptz), public.setting_text_array(uuid,text)
  to authenticated, service_role;
commit;
