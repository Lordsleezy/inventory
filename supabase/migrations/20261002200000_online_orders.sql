-- Production shipping checkout: one atomic claim, frozen quote, atomic sale + packing row.
begin;
alter table public.web_orders add column if not exists checkout_quote jsonb;
alter table public.web_orders add column if not exists customer_id uuid references public.customers(id);
alter table public.web_orders add column if not exists redeem_points int not null default 0;
alter table public.web_orders add column if not exists payment_source_id text;
alter table public.web_orders add column if not exists payment_attempt_id uuid not null default gen_random_uuid();
alter table public.web_orders add column if not exists payment_started_at timestamptz;
alter table public.sales add column if not exists shipping_cents int not null default 0;
create or replace function public.ticket_summary(p_store uuid, p_ticket uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_lines jsonb := '[]'::jsonb;
  v_sub int := 0;
  v_tax int := 0;
  v_fee int := 0;
  v_shipping int := 0;
  r record;
  x public.ticket_extras;
  v_cust jsonb := null;
begin
  for r in
    select id, sku, receipt_no, price_cents, tax_cents, card_fee_cents, shipping_cents, list_price_cents,
           override_reason, payment_method, sold_at, card_brand, card_last4, qty
      from public.sales
     where store_id = p_store and ticket_id = p_ticket and voided_at is null
     order by id
  loop
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'sale_id', r.id,
      'sku', r.sku,
      'receipt_no', r.receipt_no,
      'price_cents', r.price_cents,
      'tax_cents', coalesce(r.tax_cents, 0),
      'card_fee_cents', coalesce(r.card_fee_cents, 0),
      'shipping_cents', r.shipping_cents,
      'list_price_cents', r.list_price_cents,
      'override_reason', r.override_reason,
      'payment_method', r.payment_method,
      'card_brand', r.card_brand,
      'card_last4', r.card_last4,
      'qty', r.qty
    ));
    v_shipping := v_shipping + r.shipping_cents;
    v_sub := v_sub + r.price_cents;
    v_tax := v_tax + coalesce(r.tax_cents, 0);
    v_fee := v_fee + coalesce(r.card_fee_cents, 0);
  end loop;
  if jsonb_array_length(v_lines) = 0 then
    return null;
  end if;

  select * into x from public.ticket_extras
   where ticket_id = p_ticket and store_id = p_store;

  if x.customer_id is not null then
    select jsonb_build_object(
      'id', c.id,
      'phone', c.phone,
      'name', c.name,
      'email', c.email,
      'points_balance', public.customer_points_balance_internal(p_store, c.id)
    ) into v_cust
      from public.customers c
     where c.id = x.customer_id;
  end if;

  return jsonb_build_object(
    'ticket_id', p_ticket,
    'lines', v_lines,
    'subtotal_cents', v_sub,
    'tax_cents', v_tax,
    'card_fee_bps', coalesce(x.card_fee_bps, 0),
    'card_fee_cents', coalesce(x.card_fee_cents, v_fee),
    'shipping_cents', v_shipping,
    'total_cents', v_sub + v_tax + v_shipping + coalesce(x.card_fee_cents, v_fee),
    'payment_method', v_lines->0->>'payment_method',
    'card_brand', v_lines->0->>'card_brand',
    'card_last4', v_lines->0->>'card_last4',
    'discount_bps', coalesce(x.discount_bps, 0),
    'discount_cents', coalesce(x.discount_cents, 0),
    'signup_discount_cents', coalesce(x.signup_discount_cents, 0),
    'points_redeemed', coalesce(x.points_redeemed, 0),
    'points_earned', coalesce(x.points_earned, 0),
    'points_balance', case when x.customer_id is not null then v_cust->'points_balance' else null end,
    'customer_id', x.customer_id,
    'customer', v_cust,
    'cash_cents', coalesce(x.cash_cents, 0),
    'card_cents', coalesce(x.card_cents, 0),
    'amount_tendered_cents', x.amount_tendered_cents,
    'note', x.note
  );
end;
$$;

-- Never expose card tokens through the existing staff SELECT grant.
revoke select on public.web_orders from authenticated;
grant select (id,store_id,sku,reservation_id,sale_id,status,buyer_name,buyer_email,buyer_phone,
 ship_line1,ship_line2,ship_city,ship_region,ship_postal,ship_country,item_cents,shipping_cents,
 tax_cents,total_cents,payment_id,refund_id,boxed_at,shipped_at,tracking_number,apology_sent_at,
 created_at,updated_at) on public.web_orders to authenticated;

create or replace function public.claim_web_checkout(
  p_store_id uuid,
  p_sku text,
  p_buyer jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_unit public.units;
  v_res public.reservations;
  v_order public.web_orders;
  v_ship int;
  v_tax_bps int;
  v_item int;
  v_tax int;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not_service' using errcode = '42501';
  end if;
  perform public.release_expired_reservations();

  update public.units
     set state = 'reserved', updated_at = now()
   where sku = p_sku
     and store_id = p_store_id
     and ask_cents > 0
     and shippable
     and show_on_website
     and public.unit_web_buyable(p_store_id, shippable, listing_specs)
     and state = 'available'
     and not exists (
       select 1 from public.sales s
        where s.store_id = p_store_id and s.sku = p_sku and s.voided_at is null
     )
     and not exists (
       select 1 from public.reservations r
        where r.store_id = p_store_id
          and r.sku = p_sku
          and r.released_at is null
          and r.finalized_at is null
          and r.expires_at > now()
     )
  returning * into v_unit;
  if not found then
    raise exception 'held_or_unavailable' using errcode = 'P0001';
  end if;

  insert into public.reservations (store_id, sku, channel, actor_id, expires_at)
  values (p_store_id, p_sku, 'website', null, now() + public.web_hold_ttl())
  returning * into v_res;

  v_item := coalesce(v_unit.ask_cents, 0);
  v_ship := public.unit_shipping_cents(p_store_id, v_unit.shipping_cents, v_unit.listing_specs, v_item);
  if v_ship is null then
    update public.reservations set released_at = now() where id = v_res.id;
    update public.units
       set state = 'available', updated_at = now()
     where sku = p_sku and store_id = p_store_id and state = 'reserved';
    raise exception 'held_or_unavailable' using errcode = 'P0001';
  end if;
  v_tax_bps := coalesce(
    nullif(public.store_setting(p_store_id, 'taxRateBps', '0'::jsonb) #>> '{}', '')::int,
    0
  );
  v_tax := round((v_item + v_ship) * v_tax_bps / 10000.0);

  insert into public.web_orders (
    store_id, sku, reservation_id, status,
    buyer_name, buyer_email, buyer_phone,
    ship_line1, ship_line2, ship_city, ship_region, ship_postal, ship_country,
    item_cents, shipping_cents, tax_cents, total_cents
  ) values (
    p_store_id,
    p_sku,
    v_res.id,
    'claimed',
    nullif(btrim(p_buyer->>'name'), ''),
    nullif(btrim(p_buyer->>'email'), ''),
    nullif(btrim(p_buyer->>'phone'), ''),
    nullif(btrim(p_buyer->>'line1'), ''),
    nullif(btrim(p_buyer->>'line2'), ''),
    nullif(btrim(p_buyer->>'city'), ''),
    nullif(btrim(p_buyer->>'region'), ''),
    nullif(btrim(p_buyer->>'postal'), ''),
    coalesce(nullif(btrim(p_buyer->>'country'), ''), 'US'),
    v_item, v_ship, v_tax, v_item + v_ship + v_tax
  )
  returning * into v_order;

  insert into public.events (store_id, sku, kind, actor, note)
  values (p_store_id, p_sku, 'reserved', 'website', 'web checkout hold');

  return jsonb_build_object(
    'order_id', v_order.id,
    'reservation_id', v_res.id,
    'expires_at', v_res.expires_at,
    'sku', v_unit.sku,
    'title', coalesce(nullif(btrim(v_unit.title), ''), concat_ws(' ', v_unit.brand, v_unit.model)),
    'item_cents', v_item,
    'shipping_cents', v_ship,
    'tax_cents', v_tax,
    'total_cents', v_item + v_ship + v_tax,
    'store_name', coalesce(public.store_setting(p_store_id, 'display_name', '"Store"'::jsonb) #>> '{}', 'Store')
  );
end;
$$;


create or replace function public.begin_shipping_checkout(p_store uuid, p_sku text, p_buyer jsonb, p_redeem_points int default 0)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_claim jsonb; v_customer jsonb; v_quote jsonb; v_lines jsonb; v_ship int; v_ship_tax int;
  v_redeem int; v_id uuid;
begin
  perform public.assert_service();
  perform set_config('floor.store_id',p_store::text,true);
  if coalesce(p_buyer->>'email','') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or coalesce(btrim(p_buyer->>'name'),'') = '' or coalesce(btrim(p_buyer->>'line1'),'') = ''
    or coalesce(btrim(p_buyer->>'city'),'') = '' or coalesce(btrim(p_buyer->>'region'),'') = ''
    or coalesce(btrim(p_buyer->>'postal'),'') = '' or coalesce(btrim(p_buyer->>'phone'),'') = '' then raise exception 'buyer_address_required'; end if;
  v_claim := public.claim_web_checkout(p_store,p_sku,p_buyer);
  v_customer := public.web_lookup_customer(p_store,p_buyer->>'phone');
  v_id := (v_customer->>'id')::uuid;
  v_redeem := least(greatest(coalesce(p_redeem_points,0),0),coalesce((v_customer->>'points_balance')::int,0));
  v_lines := jsonb_build_array(jsonb_build_object('sku',p_sku,'price_cents',(v_claim->>'item_cents')::int,'qty',1));
  v_quote := public.web_quote(p_store,v_lines,v_id,v_redeem);
  v_ship := (v_claim->>'shipping_cents')::int;
  v_ship_tax := round(v_ship * public.store_tax_rate_bps() / 10000.0);
  -- Existing item quote includes rewards and item card fee; shipping is added exactly once.
  update public.web_orders set checkout_quote=v_quote, customer_id=v_id, redeem_points=v_redeem,
    tax_cents=(v_quote->>'tax_cents')::int+v_ship_tax,
    total_cents=(v_quote->>'total_cents')::int+v_ship+v_ship_tax
    where id=(v_claim->>'order_id')::uuid;
  return v_claim || jsonb_build_object('customer',v_customer,'quote',v_quote || jsonb_build_object(
    'shipping_cents',v_ship,'tax_cents',(v_quote->>'tax_cents')::int+v_ship_tax,
    'total_cents',(v_quote->>'total_cents')::int+v_ship+v_ship_tax));
end $$;

create or replace function public.prepare_shipping_payment(p_store uuid,p_order uuid,p_reservation uuid,p_sku text,p_source text)
returns public.web_orders language plpgsql security definer set search_path=public as $$
declare o public.web_orders; r public.reservations;
begin
  perform public.assert_service();
  -- Match the unit-first lock order used by claim/finalize.
  perform 1 from public.units where store_id=p_store and sku=p_sku for update;
  select * into o from public.web_orders where id=p_order and store_id=p_store and sku=p_sku and reservation_id=p_reservation for update;
  if not found then raise exception 'order_not_found'; end if;
  if o.status='paid' then return o; end if;
  if o.status <> 'claimed' or o.checkout_quote is null then raise exception 'order_not_payable'; end if;
  select * into r from public.reservations where id=p_reservation for update;
  if o.payment_started_at is null and (r.released_at is not null or r.finalized_at is not null or r.expires_at <= now()) then raise exception 'reservation_expired'; end if;
  if nullif(btrim(p_source),'') is null then raise exception 'source_required'; end if;
  update public.web_orders set payment_source_id=coalesce(payment_source_id,p_source),
    payment_started_at=coalesce(payment_started_at,now()) where id=o.id returning * into o;
  return o;
end $$;

create or replace function public.complete_shipping_checkout(p_store uuid,p_order uuid,p_payment text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare o public.web_orders; r public.reservations; v_quote jsonb; v_lines jsonb; v_summary jsonb; v_sale bigint;
begin
  perform public.assert_service();
  perform set_config('floor.store_id',p_store::text,true);
  perform 1 from public.units where store_id=p_store and sku=(select sku from public.web_orders where id=p_order and store_id=p_store) for update;
  select * into o from public.web_orders where id=p_order and store_id=p_store for update;
  if not found then raise exception 'order_not_found'; end if;
  if o.status='paid' and o.payment_id=p_payment then return public.ticket_summary(p_store,o.reservation_id) || jsonb_build_object('total_cents',o.total_cents,'shipping_cents',o.shipping_cents); end if;
  if o.status <> 'claimed' or o.checkout_quote is null or nullif(p_payment,'') is null then raise exception 'order_not_payable'; end if;
  select * into r from public.reservations where id=o.reservation_id for update;
  if r.released_at is not null or r.finalized_at is not null or r.expires_at <= now() then raise exception 'reservation_expired'; end if;
  if o.customer_id is not null then perform 1 from public.customers where id=o.customer_id for update; end if;
  v_lines:=jsonb_build_array(jsonb_build_object('sku',o.sku,'price_cents',o.item_cents,'qty',1));
  v_quote:=public.web_quote(p_store,v_lines,o.customer_id,o.redeem_points);
  if v_quote is distinct from o.checkout_quote then raise exception 'quote_changed'; end if;
  v_summary:=public.web_finalize_ticket(p_store,o.reservation_id,v_lines,p_payment,o.customer_id,o.redeem_points,'Online shipping order ' || o.id);
  v_sale:=(v_summary->'lines'->0->>'sale_id')::bigint;
  if v_sale is null then raise exception 'sale_missing'; end if;
  update public.sales set shipping_cents=o.shipping_cents,tax_cents=o.tax_cents,
    customer_name=o.buyer_name,customer_email=o.buyer_email,customer_phone=o.buyer_phone where id=v_sale;
  update public.ticket_extras set card_cents=o.total_cents where store_id=p_store and ticket_id=o.reservation_id;
  update public.reservations set finalized_at=now(),sale_id=v_sale,payment_id=p_payment where id=o.reservation_id;
  update public.web_orders set status='paid',sale_id=v_sale,payment_id=p_payment,payment_source_id=null,updated_at=now() where id=o.id;
  return public.ticket_summary(p_store,o.reservation_id) || jsonb_build_object('total_cents',o.total_cents,'shipping_cents',o.shipping_cents);
end $$;

create or replace function public.release_shipping_checkout(p_store uuid,p_reservation uuid)
returns void language plpgsql security definer set search_path=public as $$
declare o public.web_orders;
begin
  perform public.assert_service();
  perform 1 from public.units where store_id=p_store and sku=(select sku from public.web_orders where reservation_id=p_reservation and store_id=p_store limit 1) for update;
  select * into o from public.web_orders where store_id=p_store and reservation_id=p_reservation for update;
  if not found then return; end if;
  if o.payment_started_at is not null or o.status='paid' then raise exception 'payment_in_progress'; end if;
  perform public.web_release_reservation(p_store,p_reservation);
  update public.web_orders set status='canceled' where id=o.id and status='claimed';
end $$;
revoke all on function public.release_shipping_checkout(uuid,uuid) from public,anon,authenticated;
grant execute on function public.release_shipping_checkout(uuid,uuid) to service_role;

-- Durable mail queue; a temporary Resend failure must not lose a paid order notification.
create table if not exists public.web_order_emails (
 id uuid primary key default gen_random_uuid(), order_id uuid not null references public.web_orders(id),
 kind text not null check (kind in ('owner','confirmation','tracking')), payload jsonb not null,
 sent_at timestamptz, last_error text, created_at timestamptz not null default now(),
 unique(order_id,kind)
);
alter table public.web_order_emails enable row level security;
revoke all on public.web_order_emails from anon,authenticated;
grant all on public.web_order_emails to service_role;
create or replace function public.queue_web_order_emails()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_title text;
begin
  select coalesce(nullif(title,''),concat_ws(' ',brand,model),new.sku) into v_title from public.units where store_id=new.store_id and sku=new.sku;
  if new.status='paid' and (tg_op='INSERT' or old.status is distinct from 'paid') then
    insert into public.web_order_emails(order_id,kind,payload)
      select new.id,k,to_jsonb(new)-'payment_source_id' || jsonb_build_object('title',v_title)
      from unnest(array['owner','confirmation']) k on conflict do nothing;
  end if;
  if new.shipped_at is not null and (tg_op='INSERT' or old.shipped_at is null) then
    insert into public.web_order_emails(order_id,kind,payload)
      values(new.id,'tracking',to_jsonb(new)-'payment_source_id' || jsonb_build_object('title',v_title)) on conflict do nothing;
  end if;
  return new;
end $$;
drop trigger if exists web_order_email_queue on public.web_orders;
create trigger web_order_email_queue after insert or update on public.web_orders for each row execute function public.queue_web_order_emails();
revoke all on function public.claim_web_checkout(uuid,text,jsonb),
 public.begin_shipping_checkout(uuid,text,jsonb,int),
 public.prepare_shipping_payment(uuid,uuid,uuid,text,text),
 public.complete_shipping_checkout(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.claim_web_checkout(uuid,text,jsonb),
 public.begin_shipping_checkout(uuid,text,jsonb,int),
 public.prepare_shipping_payment(uuid,uuid,uuid,text,text),
 public.complete_shipping_checkout(uuid,uuid,text) to service_role;
commit;
