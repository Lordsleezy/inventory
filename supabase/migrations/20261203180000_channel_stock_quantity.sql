begin;

-- Available quantity is the only number a channel may show.
-- On-hand stays the ledger balance. Holds are unpaid website checkouts
-- (and any other live reservation). Register carts take stock when the
-- ticket finalizes; that row lock is what makes in-store win.

alter table public.reservations
  add column if not exists hold_qty integer not null default 1 check (hold_qty > 0),
  add column if not exists exclusive_hold boolean not null default true;

alter table public.web_orders
  add column if not exists line_qty integer not null default 1 check (line_qty > 0);

alter table public.returns
  add column if not exists return_qty integer not null default 0 check (return_qty >= 0);

-- One-of-one keeps a single live hold. Stocked SKUs can hold several checkouts.
drop index if exists public.ux_one_live_reservation_per_sku;
create unique index if not exists ux_one_live_reservation_per_sku
  on public.reservations (sku)
  where released_at is null and finalized_at is null and exclusive_hold;

create or replace function public.channel_available_qty(p_store uuid, p_sku text)
returns integer language plpgsql stable security definer set search_path=public as $$
declare on_hand integer; held integer;
begin
  select greatest(coalesce(u.qty_on_hand, 0), 0) into on_hand
    from public.units u where u.store_id = p_store and u.sku = p_sku;
  if on_hand is null then return 0; end if;
  select coalesce(sum(r.hold_qty), 0)::int into held
    from public.reservations r
   where r.store_id = p_store and r.sku = p_sku
     and r.released_at is null and r.finalized_at is null and r.expires_at > now();
  return greatest(on_hand - held, 0);
end $$;
revoke all on function public.channel_available_qty(uuid, text) from public, anon;
grant execute on function public.channel_available_qty(uuid, text) to authenticated, service_role;

-- One row per SKU per channel. The first change waits a minute; later
-- changes in that minute replace the quantity and do not extend the wait.
create table if not exists public.channel_qty_outbox (
  store_id uuid not null references public.stores(id) on delete cascade,
  sku text not null,
  channel text not null check (channel in ('ebay','amazon','tiktok','website','depop')),
  available_qty integer not null,
  not_before timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending','working','done','failed')),
  attempts integer not null default 0,
  last_error text,
  updated_at timestamptz not null default now(),
  primary key (store_id, sku, channel)
);
alter table public.channel_qty_outbox enable row level security;
revoke all on public.channel_qty_outbox from public, anon, authenticated;
grant all on public.channel_qty_outbox to service_role;

create or replace function public.enqueue_channel_qty(p_store uuid, p_sku text, p_qty integer)
returns void language plpgsql security definer set search_path=public as $$
declare ch text; live boolean;
begin
  foreach ch in array array['ebay','amazon','tiktok','website','depop'] loop
    live := exists(select 1 from public.listings l
      where l.store_id=p_store and l.sku=p_sku and l.channel=ch and l.status in ('listed','ended','delisted'));
    if ch = 'website' then
      live := live or exists(select 1 from public.units u
        where u.store_id=p_store and u.sku=p_sku and (u.show_on_website or coalesce(u.listing_specs->>'website_restore','') in ('true','1')));
    end if;
    if ch = 'depop' then
      live := exists(select 1 from public.listings l
        where l.store_id=p_store and l.sku=p_sku and l.channel='depop' and l.status='listed');
    end if;
    if not live then continue; end if;
    insert into public.channel_qty_outbox(store_id, sku, channel, available_qty, not_before, status, attempts, updated_at)
    values (p_store, p_sku, ch, p_qty, now() + interval '1 minute', 'pending', 0, now())
    on conflict (store_id, sku, channel) do update set
      available_qty = excluded.available_qty,
      status = case when public.channel_qty_outbox.status = 'working' then 'working' else 'pending' end,
      not_before = case
        when public.channel_qty_outbox.status = 'pending' and public.channel_qty_outbox.not_before > now()
          then public.channel_qty_outbox.not_before
        else now() + interval '1 minute' end,
      attempts = case when public.channel_qty_outbox.status = 'pending' then public.channel_qty_outbox.attempts else 0 end,
      last_error = case when public.channel_qty_outbox.status = 'pending' then public.channel_qty_outbox.last_error else null end,
      updated_at = now();
  end loop;
end $$;
revoke all on function public.enqueue_channel_qty(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.enqueue_channel_qty(uuid, text, integer) to service_role;

create or replace function public.stock_channel_visibility()
returns trigger language plpgsql security definer set search_path=public as $$
declare held integer; available integer; depop_live boolean;
begin
  if tg_op <> 'UPDATE' or new.qty_on_hand is not distinct from old.qty_on_hand then return new; end if;
  if coalesce(new.is_stocked, false) and new.qty_on_hand <= 0 and old.show_on_website then
    new.show_on_website := false;
    new.listing_specs := coalesce(new.listing_specs, '{}'::jsonb) || jsonb_build_object('website_restore', true);
  elsif coalesce(new.is_stocked, false) and new.qty_on_hand > 0 and coalesce(old.qty_on_hand, 0) <= 0
    and coalesce(new.listing_specs->>'website_restore','') in ('true','1') then
    new.show_on_website := true;
    new.listing_specs := new.listing_specs - 'website_restore';
  end if;
  if new.qty_on_hand > 0 and coalesce(old.qty_on_hand, 0) <= 0 and coalesce(new.is_stocked, false) then
    update public.sku_ledger set fate = 'issued'
     where store_id = new.store_id and sku = new.sku and fate = 'sold';
  end if;
  select coalesce(sum(r.hold_qty), 0)::int into held from public.reservations r
   where r.store_id = new.store_id and r.sku = new.sku
     and r.released_at is null and r.finalized_at is null and r.expires_at > now();
  available := greatest(coalesce(new.qty_on_hand, 0) - held, 0);
  select exists(select 1 from public.listings l
    where l.store_id = new.store_id and l.sku = new.sku and l.channel = 'depop' and l.status = 'listed')
    into depop_live;
  if depop_live then
    new.listing_specs := coalesce(new.listing_specs, '{}'::jsonb)
      || jsonb_build_object('depop_qty_stale', true, 'depop_qty_target', available);
  end if;
  return new;
end $$;
revoke all on function public.stock_channel_visibility() from public, anon, authenticated;
drop trigger if exists stock_channel_visibility on public.units;
create trigger stock_channel_visibility before update of qty_on_hand on public.units
for each row execute function public.stock_channel_visibility();

create or replace function public.stock_channel_qty_enqueue()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if tg_op = 'UPDATE' and new.qty_on_hand is not distinct from old.qty_on_hand then return new; end if;
  perform public.enqueue_channel_qty(new.store_id, new.sku, public.channel_available_qty(new.store_id, new.sku));
  return new;
end $$;
revoke all on function public.stock_channel_qty_enqueue() from public, anon, authenticated;
drop trigger if exists stock_channel_qty_enqueue on public.units;
create trigger stock_channel_qty_enqueue after insert or update of qty_on_hand on public.units
for each row execute function public.stock_channel_qty_enqueue();

-- Stocked sales keep the SKU available and decrement on-hand by N.
-- One-of-one still goes through finalize_sale unchanged.
create or replace function public.finalize_sale_qty(
  p_sku text, p_channel text, p_price_cents int, p_qty int default 1,
  p_payment_method text default null, p_payment_id text default null,
  p_customer_name text default null, p_customer_phone text default null,
  p_customer_email text default null, p_note text default null,
  p_reservation_id uuid default null, p_tax_cents int default 0, p_approval_id uuid default null
) returns public.sales language plpgsql security definer set search_path=public as $$
declare
  v_sale public.sales; v_unit public.units; v_store uuid := public.current_store_id();
  v_receipt text; v_seq int; v_floor int; v_available int; v_left int;
begin
  perform public.assert_staff_or_service();
  if p_qty is null or p_qty < 1 then raise exception 'invalid_qty' using errcode = '22023'; end if;
  if v_store is null then select store_id into v_store from public.units where sku = p_sku limit 1; end if;
  if v_store is null then raise exception 'no_store' using errcode = 'P0001'; end if;
  select * into v_unit from public.units where store_id = v_store and sku = p_sku for update;
  if not found then raise exception 'unit_not_sellable' using errcode = 'P0001'; end if;
  if not coalesce(v_unit.is_stocked, false) then
    if p_qty <> 1 then raise exception 'unit_not_sellable' using errcode = 'P0001'; end if;
    return public.finalize_sale(p_sku, p_channel, p_price_cents, p_payment_method, p_payment_id,
      p_customer_name, p_customer_phone, p_customer_email, p_note, p_reservation_id, p_tax_cents, p_approval_id);
  end if;
  if p_price_cents is null or p_price_cents < 0 then raise exception 'invalid_price' using errcode = '22023'; end if;
  if p_channel is null or btrim(p_channel) = '' then raise exception 'invalid_channel' using errcode = '22023'; end if;
  v_floor := v_unit.floor_cents;
  if v_floor is not null and (p_price_cents / p_qty) < v_floor then
    if p_approval_id is null or not exists (
      select 1 from public.approvals a where a.id = p_approval_id and a.store_id = v_store
        and a.action = 'below_floor' and a.sku = p_sku and a.consumed_at is null
        and a.created_at > now() - interval '10 minutes'
    ) then raise exception 'below_floor' using errcode = 'P0001'; end if;
    update public.approvals set consumed_at = now() where id = p_approval_id;
  end if;
  v_available := public.channel_available_qty(v_store, p_sku);
  if p_reservation_id is not null then
    v_available := v_available + coalesce((select hold_qty from public.reservations
      where id = p_reservation_id and store_id = v_store and sku = p_sku
        and released_at is null and finalized_at is null and expires_at > now()), 0);
  end if;
  if v_unit.state not in ('available','reserved') or v_unit.qty_on_hand < p_qty or v_available < p_qty then
    insert into public.incidents (store_id, kind, sku, detail)
    values (v_store, 'double_sell', p_sku, jsonb_build_object('channel', p_channel, 'payment_id', p_payment_id, 'qty', p_qty));
    perform public.enqueue_double_sell_alert(v_store, p_sku, jsonb_build_object('channel', p_channel, 'payment_id', p_payment_id, 'qty', p_qty));
    raise exception 'unit_not_sellable' using errcode = 'P0001';
  end if;
  v_left := v_unit.qty_on_hand - p_qty;
  perform set_config('floor.stock_movement_type', 'sold', true);
  perform set_config('floor.stock_movement_reason', 'Sale '||coalesce(p_payment_id, p_channel), true);
  update public.units set qty_on_hand = v_left,
    state = 'available',
    show_on_website = case when v_left = 0 then false else show_on_website end,
    updated_at = now()
   where store_id = v_store and sku = p_sku and qty_on_hand >= p_qty;
  if not found then raise exception 'unit_not_sellable' using errcode = 'P0001'; end if;
  perform set_config('floor.stock_movement_type', '', true);
  perform set_config('floor.stock_movement_reason', '', true);
  insert into public.store_settings (store_id, key, value) values (v_store, 'receipt_seq', '0'::jsonb)
  on conflict (store_id, key) do nothing;
  update public.store_settings set value = to_jsonb(coalesce((value #>> '{}')::int, 0) + 1)
   where store_id = v_store and key = 'receipt_seq' returning (value #>> '{}')::int into v_seq;
  v_receipt := 'R-' || lpad(v_seq::text, greatest(5, public.sku_digits()), '0');
  insert into public.sales (store_id, sku, price_cents, tax_cents, channel, payment_method, payment_id,
    customer_name, customer_phone, customer_email, note, sold_at, receipt_no, actor_id, qty)
  values (v_store, p_sku, p_price_cents, coalesce(p_tax_cents, 0), btrim(p_channel), p_payment_method, p_payment_id,
    p_customer_name, p_customer_phone, p_customer_email, p_note, now(), v_receipt, auth.uid(), p_qty)
  returning * into v_sale;
  update public.stock_movements m set movement_type = 'sold', reference_id = v_sale.id::text,
    reference_label = v_receipt, reason = 'Sale '||v_receipt
   where m.id = (select x.id from public.stock_movements x
     where x.store_id = v_store and x.sku = p_sku and x.quantity_delta = -p_qty
       and x.created_at > now() - interval '5 minutes'
     order by x.created_at desc, x.id desc limit 1);
  if v_left = 0 then
    update public.sku_ledger set fate = 'sold' where sku = p_sku and store_id is not distinct from v_store;
    perform public.open_delist_tasks(v_sale);
    perform public.enqueue_sale_alerts(v_sale);
  end if;
  if p_reservation_id is not null then
    update public.reservations set finalized_at = now(), sale_id = v_sale.id, payment_id = coalesce(p_payment_id, payment_id)
     where id = p_reservation_id;
  end if;
  insert into public.events (store_id, sku, kind, new_value, actor, actor_id, note)
  values (v_store, p_sku, 'sold', p_price_cents::text,
    coalesce((select display_name from public.staff where user_id = auth.uid()), 'service'),
    auth.uid(), btrim(p_channel)||' '||v_receipt||' qty '||p_qty);
  return v_sale;
end $$;
revoke all on function public.finalize_sale_qty(text, text, integer, integer, text, text, text, text, text, text, uuid, integer, uuid) from public, anon, authenticated;
grant execute on function public.finalize_sale_qty(text, text, integer, integer, text, text, text, text, text, text, uuid, integer, uuid) to service_role;

-- In-store wins on a stocked SKU: a register sale is not blocked by an online hold.
-- The later online payment fails the quantity check and is refunded.
create or replace function public.guard_online_checkout_hold()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.units u where u.store_id = new.store_id and u.sku = new.sku and u.is_stocked) then
    return new;
  end if;
  if new.channel is distinct from 'website' and (
    exists(select 1 from public.reservations r
            where r.store_id = new.store_id and r.sku = new.sku and r.channel = 'website'
              and r.released_at is null and r.finalized_at is null and r.expires_at > now())
    or exists(select 1 from public.web_orders o
            where o.store_id = new.store_id and o.sku = new.sku and o.status = 'claimed'
              and o.payment_started_at > now() - interval '30 minutes')
  ) then
    raise exception using errcode = 'P0001', message = format('held_by_online_order %s', new.sku);
  end if;
  return new;
end $$;

-- Stocked register sales stay available at zero so a later restock can relist.
do $$ declare src text; begin
  select pg_get_functiondef(p.oid) into src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'finalize_ticket'
     and pg_get_functiondef(p.oid) like '%qty_on_hand - v_qty <= 0 then ''sold''%'
   order by p.oid desc limit 1;
  if src is null then raise exception 'finalize_ticket quantity assignment not found'; end if;
  src := replace(src,
    'state = case when qty_on_hand - v_qty <= 0 then ''sold'' else ''available'' end,',
    'state = case when coalesce(is_stocked,false) then ''available'' when qty_on_hand - v_qty <= 0 then ''sold'' else ''available'' end, show_on_website = case when coalesce(is_stocked,false) and qty_on_hand - v_qty <= 0 then false else show_on_website end,');
  execute src;
end $$;

-- Website checkout quantity. The 7-argument function stays for quantity 1.
-- Callers that pass p_qty set floor.checkout_qty for that transaction.
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
  v_tax jsonb;
  v_customer jsonb;
  v_cust_id uuid;
  v_redeem int;
  v_quote jsonb;
  v_qty int := greatest(1, least(999, coalesce(nullif(current_setting('floor.checkout_qty', true), '')::int, 1)));
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
  if not found or coalesce(v_unit.ask_cents,0) <= 0
     or not exists(select 1 from public.storefront_items s where s.store_id = p_store and s.sku = p_sku) then
    raise exception 'held_or_unavailable' using errcode = 'P0001';
  end if;
  if coalesce(v_unit.is_stocked, false) then
    if v_unit.state not in ('available','reserved') or public.channel_available_qty(p_store, p_sku) < v_qty then
      raise exception 'held_or_unavailable' using errcode = 'P0001';
    end if;
  elsif v_unit.state <> 'available' or v_qty <> 1 then
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

  if coalesce(v_unit.is_stocked, false) then
    insert into public.reservations (store_id, sku, channel, actor_id, expires_at, hold_qty, exclusive_hold)
    values (p_store, p_sku, 'website', null, now() + public.web_hold_ttl(), v_qty, false)
    returning * into v_res;
  else
    update public.units set state = 'reserved', updated_at = now()
     where store_id = p_store and sku = p_sku and state = 'available';
    insert into public.reservations (store_id, sku, channel, actor_id, expires_at, hold_qty, exclusive_hold)
    values (p_store, p_sku, 'website', null, now() + public.web_hold_ttl(), 1, true)
    returning * into v_res;
  end if;

  v_tax := public.web_tax_decision(p_store, p_fulfillment, p_buyer->>'region');
  perform set_config('floor.tax_bps_override', v_tax->>'bps', true);
  v_customer := public.web_lookup_customer(p_store, p_buyer->>'phone');
  v_cust_id := (v_customer->>'id')::uuid;
  v_redeem := least(greatest(coalesce(p_redeem_points,0),0), coalesce((v_customer->>'points_balance')::int,0));
  v_quote := public.web_quote(p_store, jsonb_build_array(jsonb_build_object('sku',p_sku,'price_cents',v_unit.ask_cents,'qty',v_qty)), v_cust_id, v_redeem);
  if (v_tax->>'tax_shipping')::boolean then
    v_ship_tax := round(v_ship * (v_tax->>'bps')::int / 10000.0);
  end if;

  insert into public.web_orders (
    store_id, sku, reservation_id, status, fulfillment,
    buyer_name, buyer_email, buyer_phone,
    ship_line1, ship_line2, ship_city, ship_region, ship_postal, ship_country,
    item_cents, shipping_cents, tax_cents, total_cents,
    checkout_quote, customer_id, redeem_points, shipping_rate, carrier, service,
    tax_bps, tax_rule, shipping_tax_cents, line_qty
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
    v_quote, v_cust_id, v_redeem, v_rate, v_rate->>'carrier', v_rate->>'service',
    (v_tax->>'bps')::int, v_tax->>'rule', v_ship_tax, v_qty
  ) returning * into v_order;

  insert into public.events (store_id, sku, kind, actor, note)
  values (p_store, p_sku, 'reserved', 'website', 'web checkout hold (' || p_fulfillment || ', qty ' || v_qty || ')');

  return jsonb_build_object(
    'order_id', v_order.id, 'reservation_id', v_res.id, 'expires_at', v_res.expires_at,
    'sku', p_sku, 'fulfillment', p_fulfillment, 'qty', v_qty,
    'title', coalesce(nullif(btrim(v_unit.title),''), concat_ws(' ', v_unit.brand, v_unit.model)),
    'item_cents', v_unit.ask_cents * v_qty, 'unit_cents', v_unit.ask_cents, 'shipping_cents', v_ship, 'shipping_rate', v_rate,
    'tax_rule', v_tax->>'rule', 'tax_bps', (v_tax->>'bps')::int,
    'customer', v_customer,
    'quote', v_quote || jsonb_build_object('shipping_cents', v_ship,
      'tax_cents', (v_quote->>'tax_cents')::int + v_ship_tax,
      'total_cents', (v_quote->>'total_cents')::int + v_ship + v_ship_tax),
    'store_name', coalesce(public.store_setting(p_store,'display_name','"Store"'::jsonb) #>> '{}','Store'));
end $$;

create or replace function public.begin_online_checkout(
  p_store uuid, p_sku text, p_buyer jsonb, p_fulfillment text,
  p_quote uuid, p_rate text, p_redeem_points int, p_qty int)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform set_config('floor.checkout_qty', greatest(coalesce(p_qty, 1), 1)::text, true);
  return public.begin_online_checkout(p_store, p_sku, p_buyer, p_fulfillment, p_quote, p_rate, p_redeem_points);
end $$;
revoke all on function public.begin_online_checkout(uuid, text, jsonb, text, uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function public.begin_online_checkout(uuid, text, jsonb, text, uuid, text, integer, integer) to service_role;

create or replace function public.complete_shipping_checkout(p_store uuid, p_order uuid, p_payment text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare o public.web_orders; r public.reservations; v_quote jsonb; v_lines jsonb; v_summary jsonb; v_sale bigint; v_no text; v_qty int;
begin
  perform public.assert_service();
  perform set_config('floor.store_id', p_store::text, true);
  perform 1 from public.units where store_id=p_store and sku=(select sku from public.web_orders where id=p_order and store_id=p_store) for update;
  select * into o from public.web_orders where id=p_order and store_id=p_store for update;
  if not found then raise exception 'order_not_found'; end if;
  if o.status='paid' and o.payment_id=p_payment then return public.ticket_summary(p_store,o.reservation_id) || jsonb_build_object('total_cents',o.total_cents,'shipping_cents',o.shipping_cents,'order_no',o.order_no,'pickup_deadline',o.pickup_deadline); end if;
  if o.status <> 'claimed' or o.checkout_quote is null or nullif(p_payment,'') is null then raise exception 'order_not_payable'; end if;
  select * into r from public.reservations where id=o.reservation_id for update;
  if r.released_at is not null or r.finalized_at is not null or r.expires_at <= now() then raise exception 'reservation_expired'; end if;
  if o.customer_id is not null then perform 1 from public.customers where id=o.customer_id for update; end if;
  perform set_config('floor.tax_bps_override', coalesce(o.tax_bps, public.store_tax_rate_bps())::text, true);
  v_qty := greatest(coalesce(o.line_qty, 1), 1);
  v_lines := jsonb_build_array(jsonb_build_object('sku', o.sku, 'price_cents', o.item_cents, 'qty', v_qty));
  v_quote := public.web_quote(p_store, v_lines, o.customer_id, o.redeem_points);
  if v_quote is distinct from o.checkout_quote then raise exception 'quote_changed'; end if;
  v_no := 'OB-' || nextval('public.web_order_no_seq');
  v_summary := public.web_finalize_ticket(p_store, o.reservation_id, v_lines, p_payment, o.customer_id, o.redeem_points,
    'Online ' || case when o.fulfillment='pickup' then 'pickup' else 'shipping' end || ' order ' || v_no);
  v_sale := (v_summary->'lines'->0->>'sale_id')::bigint;
  if v_sale is null then raise exception 'sale_missing'; end if;
  update public.sales set shipping_cents=o.shipping_cents, tax_cents=o.tax_cents,
    customer_name=o.buyer_name, customer_email=o.buyer_email, customer_phone=o.buyer_phone where id=v_sale;
  update public.ticket_extras set card_cents=o.total_cents where store_id=p_store and ticket_id=o.reservation_id;
  update public.reservations set finalized_at=now(), sale_id=v_sale, payment_id=p_payment where id=o.reservation_id;
  update public.web_orders set status='paid', sale_id=v_sale, payment_id=p_payment, payment_source_id=null,
    order_no=v_no, paid_at=now(),
    pickup_deadline=case when fulfillment='pickup' then public.pickup_deadline_from(p_store, now()) end,
    updated_at=now() where id=o.id returning * into o;
  return public.ticket_summary(p_store, o.reservation_id) || jsonb_build_object('total_cents', o.total_cents,
    'shipping_cents', o.shipping_cents, 'order_no', o.order_no, 'fulfillment', o.fulfillment,
    'pickup_deadline', o.pickup_deadline, 'qty', v_qty);
end $$;

-- Partial return: put N back on the same SKU, or receive them as Defective.
create or replace function public.portal_return_partial(p_return_id uuid, p_qty integer, p_defective boolean default false)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  st uuid := public.portal_store_id();
  r public.returns; s public.sales; u public.units; already int; new_sku text; result jsonb;
begin
  if st is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode='42501'; end if;
  if p_qty is null or p_qty < 1 then raise exception 'invalid_qty' using errcode='22023'; end if;
  select * into r from public.returns where id = p_return_id and store_id = st for update;
  if not found or r.sale_id is null then raise exception 'return_sale_required' using errcode='P0001'; end if;
  select * into s from public.sales where id = r.sale_id and store_id = st for update;
  if not found or s.voided_at is not null then raise exception 'sale_not_open' using errcode='P0001'; end if;
  select coalesce(sum(x.return_qty), 0)::int into already from public.returns x
   where x.store_id = st and x.sale_id = s.id and x.id <> r.id;
  already := already + coalesce(r.return_qty, 0);
  if already + p_qty > greatest(coalesce(s.qty, 1), 1) then raise exception 'return_qty_exceeds_sale' using errcode='22023'; end if;
  select * into u from public.units where store_id = st and sku = s.sku for update;
  if not found then raise exception 'sku_not_found' using errcode='P0002'; end if;
  if coalesce(p_defective, false) then
    perform set_config('floor.stock_movement_type','received', true);
    perform set_config('floor.receive_not_for_sale','true', true);
    result := public.portal_receive_unit(1, u.brand, u.model, u.title, u.listing_body, 'Defective', u.test_status, u.ask_cents,
      u.acquisition_cost_cents, 'Partial return defective from SKU '||s.sku, u.upc,
      case when u.shippable then 'ship' else 'pickup' end,
      u.package_length_in, u.package_width_in, u.package_height_in, u.package_weight_lb, u.category);
    new_sku := result#>>'{skus,0}';
    update public.units set state='available', show_on_website=false, is_stocked=false,
      listing_specs=coalesce(listing_specs,'{}'::jsonb)||jsonb_build_object('do_not_list', true), updated_at=now()
     where store_id=st and sku=new_sku;
    perform set_config('floor.stock_movement_type','', true);
    perform set_config('floor.receive_not_for_sale','', true);
  elsif not coalesce(u.is_stocked, false) and greatest(coalesce(s.qty, 1), 1) = 1 then
    update public.units set state='available', qty_on_hand=1, updated_at=now() where store_id=st and sku=s.sku;
    perform public.enqueue_channel_qty(st, s.sku, public.channel_available_qty(st, s.sku));
  else
    perform set_config('floor.stock_movement_type','returned', true);
    perform set_config('floor.stock_movement_reason','Partial return '||p_qty||' of sale '||s.id, true);
    update public.units set qty_on_hand = qty_on_hand + p_qty,
      is_stocked = case when qty_on_hand + p_qty > 1 then true else is_stocked end,
      state='available', updated_at=now()
     where store_id=st and sku=s.sku;
    perform set_config('floor.stock_movement_type','', true);
    perform set_config('floor.stock_movement_reason','', true);
  end if;
  update public.returns set return_qty = coalesce(return_qty, 0) + p_qty,
    status = 'dispositioned', disposition = case when coalesce(p_defective, false) then 'write_off' else 'relist' end,
    updated_at = now()
   where id = r.id;
  if r.refund_cents > 0 and r.ledger_posted_at is null then
    perform public.return_post_ledger(r.id);
  end if;
  insert into public.events(store_id, sku, kind, actor, actor_id, note)
  values(st, s.sku, 'sale_void', public.disposition_actor_name(auth.uid()), auth.uid(),
    'Partial return '||p_qty||case when coalesce(p_defective, false) then ' defective' else ' restocked' end);
  return jsonb_build_object('sku', s.sku, 'qty', p_qty, 'defective_sku', new_sku,
    'on_hand', (select qty_on_hand from public.units where store_id=st and sku=s.sku));
end $$;
revoke all on function public.portal_return_partial(uuid, integer, boolean) from public, anon;
grant execute on function public.portal_return_partial(uuid, integer, boolean) to authenticated;

create or replace function public.portal_depop_quantity_hint(p_sku text)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare st uuid := public.portal_store_id(); u public.units; live boolean; available int;
begin
  if st is null or not public.is_staff() then raise exception 'portal_access_denied' using errcode='42501'; end if;
  select * into u from public.units where store_id=st and sku=p_sku;
  if not found then return jsonb_build_object('live', false); end if;
  live := exists(select 1 from public.listings l where l.store_id=st and l.sku=p_sku and l.channel='depop' and l.status='listed');
  available := public.channel_available_qty(st, p_sku);
  return jsonb_build_object('live', live, 'quantity', available,
    'stale', live and coalesce(u.listing_specs->>'depop_qty_stale','') in ('true','1'),
    'target', coalesce((u.listing_specs->>'depop_qty_target')::int, available));
end $$;
revoke all on function public.portal_depop_quantity_hint(text) from public, anon;
grant execute on function public.portal_depop_quantity_hint(text) to authenticated;

-- Mattress pads, toppers, and protectors are not mattresses.
create or replace function public.unit_dns_type(u public.units)
returns boolean language sql immutable as $$
 select concat_ws(' ',u.brand,u.model,u.title,u.category,u.internal_category) ~* '\m(refrigerators?|fridges?|freezers?|dishwashers?|deep\s*fryers?|mattress(es)?|bed\s*frames?|sofas?|couches|couch|scooters?)\M'
 and concat_ws(' ',u.brand,u.model,u.title,u.category) !~* '\m(filters?|covers?|protectors?|pads?|toppers?|sheets?|hoses?|parts?|magnets?|pillows?|cushions?|toys?|dollhouse)\M';
$$;

update public.listing_never_rules
   set value = '\mmattress(es)?\M(?!\s+(pads?|toppers?|protectors?))'
 where rule_type = 'pattern' and note = 'Mattresses' and value = '\mmattress(es)?\M';

-- Not listed is ready SKUs that are allowed on eBay. Never-list and DNS stay out.
create or replace function public.unit_inventory_bucket(u public.units)
returns text language sql stable set search_path=public as $$
 select case
  when u.state not in ('available','reserved','repair') then null
  when public.unit_dns(u.listing_specs) then 'dns'
  when public.unit_is_defective(u.listing_specs,u.condition) then 'defective'
  when exists(select 1 from public.listings l where l.store_id=u.store_id and l.sku=u.sku
    and l.channel='ebay' and l.status='listed' and nullif(btrim(l.listing_id),'') is not null
    and (l.ebay_account_id is null or exists(select 1 from public.ebay_accounts a
      where a.id=l.ebay_account_id and a.store_id=u.store_id and a.role='selling'))) then 'listed'
  when u.ebay_never_list
    or public.floor_unit_never_list_reason(u.store_id, u.sku, 'ebay') is not null then 'never_list'
  when public.unit_is_unfinished(public.unit_listing_gaps(u)) then 'not_ready'
  else 'not_listed' end;
$$;

create or replace function public.inventory_totals()
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_store uuid:=coalesce(public.portal_store_id(),public.current_store_id()); result jsonb;
begin
 if v_store is null or not(public.portal_is_admin() or exists(select 1 from public.staff s where s.user_id=auth.uid() and s.store_id=v_store and s.deactivated_at is null)) then
  raise exception 'inventory_access_denied' using errcode='42501'; end if;
 with counts as materialized (
  select greatest(coalesce(u.qty_on_hand,1),0) qty, public.unit_inventory_bucket(u) bucket
    from public.units u
   where u.store_id=v_store and u.state in ('available','reserved','repair')
 ) select jsonb_build_object(
  'total', coalesce(sum(qty),0)::int,
  'listed', coalesce(sum(qty) filter(where bucket='listed'),0)::int,
  'not_listed', coalesce(sum(qty) filter(where bucket='not_listed'),0)::int,
  'not_listed_skus', coalesce(count(*) filter(where bucket='not_listed'),0)::int,
  'not_listed_pieces', coalesce(sum(qty) filter(where bucket='not_listed'),0)::int,
  'not_ready', coalesce(sum(qty) filter(where bucket='not_ready'),0)::int,
  'dns', coalesce(sum(qty) filter(where bucket='dns'),0)::int,
  'never_list', coalesce(sum(qty) filter(where bucket='never_list'),0)::int,
  'defective', coalesce(sum(qty) filter(where bucket='defective'),0)::int) into result from counts;
 return result;
end $$;

-- Prefer a SKU that is already live, and do not open a second listing for the retired SKUs.
do $merge$ declare src text; begin
  select pg_get_functiondef('public.portal_stock_merge(text[])'::regprocedure) into src;
  if strpos(src, $old$select min(x::numeric)::text into keep_sku from unnest(p_skus) x;$old$) = 0 then
    raise exception 'portal_stock_merge keep_sku assignment changed';
  end if;
  src := replace(src,
    $old$select min(x::numeric)::text into keep_sku from unnest(p_skus) x;$old$,
    $new$select coalesce((select u.sku from public.units u where u.store_id=st and u.sku=any(p_skus) and exists(select 1 from public.listings l where l.store_id=u.store_id and l.sku=u.sku and l.channel='ebay' and l.status='listed') order by u.sku::numeric limit 1),(select min(x::numeric)::text from unnest(p_skus) x)) into keep_sku;$new$);
  src := replace(src,
    $old$return jsonb_build_object('sku',keep_sku,'quantity',total_qty,'merged_skus',p_skus,'cost_each_cents',average_cost);$old$,
    $new$insert into public.listing_queue(store_id,sku,channel,action,issue) select st,l.sku,l.channel,'end','Merged into '||keep_sku from public.listings l where l.store_id=st and l.sku=any(p_skus) and l.sku<>keep_sku and l.status='listed' and l.channel in ('ebay','amazon','tiktok') and not exists(select 1 from public.listing_queue q where q.store_id=st and q.sku=l.sku and q.channel=l.channel and q.status in ('queued','working','failed')); return jsonb_build_object('sku',keep_sku,'quantity',total_qty,'merged_skus',p_skus,'cost_each_cents',average_cost);$new$);
  execute src;
end $merge$;

create or replace function public.portal_stock_merge_candidates()
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare st uuid:=public.portal_store_id(); result jsonb;
begin
 if st is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode='42501'; end if;
 with eligible as (
   select u.*, coalesce((u.listing_specs->>'do_not_list')::boolean,false) dns,
     exists(select 1 from public.listings l where l.store_id=u.store_id and l.sku=u.sku and l.channel='ebay' and l.status='listed') live_ebay,
     case when nullif(btrim(u.upc),'') is not null then 'upc:'||btrim(u.upc)
       else 'title:'||lower(regexp_replace(btrim(coalesce(u.title,'')),'\s+',' ','g')) end identity
   from public.units u where u.store_id=st and u.state in ('available','reserved','repair') and u.qty_on_hand>0
     and not exists(select 1 from public.sales s where s.store_id=st and s.sku=u.sku and s.voided_at is null)
     and not exists(select 1 from public.web_orders w where w.store_id=st and w.sku=u.sku and w.status not in ('canceled','refunded','expired','stolen'))
     and not exists(select 1 from public.channel_orders c where c.store_id=st and c.sku=u.sku)
 ), groups as (
   select identity, ask_cents, condition, dns, count(*)::int sku_count, sum(qty_on_hand)::int unit_count,
      coalesce(min(sku::numeric) filter (where live_ebay), min(sku::numeric))::text keep_sku,
      (array_agg(title order by sku::numeric))[1] title,
      array_agg(sku order by sku::numeric) skus,
      bool_or(live_ebay) has_live_ebay,
      case when count(acquisition_cost_cents)=0 then null else round(avg(acquisition_cost_cents))::int end average_cost_cents
   from eligible where identity<>'title:' and (identity not like 'title:%' or nullif(btrim(title),'') is not null)
   group by identity, ask_cents, condition, dns having count(*)>1
 )
 select coalesce(jsonb_agg(jsonb_build_object('identity',identity,'title',title,'sku_count',sku_count,'unit_count',unit_count,
   'keep_sku',keep_sku,'skus',skus,'price_cents',ask_cents,'condition',condition,'cost_each_cents',average_cost_cents,
   'do_not_list',dns,'has_live_ebay',has_live_ebay)
   order by unit_count desc, keep_sku::numeric),'[]'::jsonb) into result from groups;
 return result;
end $$;

-- The public catalog shows one row per SKU and the quantity still for sale.
-- A hold or an earlier sale no longer hides a stocked SKU that still has pieces.
do $view$
declare v_sql text := pg_get_viewdef('public.storefront_items'::regclass, true);
  v_next text;
begin
  v_next := regexp_replace(v_sql,
    'OR NOT \(EXISTS \( SELECT 1\s+FROM sales s',
    'OR COALESCE(u.is_stocked, false) OR NOT (EXISTS ( SELECT 1 FROM sales s');
  if v_next = v_sql then raise exception 'storefront sale filter pattern changed'; end if;
  v_sql := v_next;
  v_next := regexp_replace(v_sql,
    'AND NOT \(EXISTS \( SELECT 1\s+FROM reservations r\s+WHERE r\.store_id = u\.store_id AND r\.sku = u\.sku AND r\.released_at IS NULL AND r\.finalized_at IS NULL AND r\.expires_at > now\(\)\)\)',
    'AND public.channel_available_qty(u.store_id, u.sku) > 0');
  if v_next = v_sql then raise exception 'storefront reservation filter pattern changed'; end if;
  v_sql := v_next;
  v_next := regexp_replace(v_sql, '(\s)FROM units u', E',\n    public.channel_available_qty(u.store_id, u.sku) AS quantity\\1FROM units u');
  if v_next = v_sql then raise exception 'storefront from-clause pattern changed'; end if;
  execute 'create or replace view public.storefront_items with (security_invoker=false,security_barrier=true) as '||v_next;
end
$view$;

do $$ declare src text; begin
  select pg_get_functiondef('public.web_unit_fulfillment(uuid,text)'::regprocedure) into src;
  if strpos(src, '''quantity''') = 0 then
    src := replace(src, '''ask_cents'', u.ask_cents', '''ask_cents'', u.ask_cents, ''quantity'', public.channel_available_qty(p_store, p_sku)');
    execute src;
  end if;
end $$;

commit;
