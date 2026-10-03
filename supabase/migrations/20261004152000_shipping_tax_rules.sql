-- Sales tax rules for website orders (editable in Floor Admin → Online selling):
--  * store pickup                 -> store rate (taxRateBps, same as the register: Penryn / Placer County)
--  * ship within the origin state -> store rate unless tax_in_state_ship_bps is set
--  * ship out of state            -> tax_out_of_state_bps (default 0: no California tax)
--  * the shipping charge itself   -> untaxed unless tax_shipping is true (carrier cost, separately stated)
begin;

alter table public.web_orders
  add column if not exists tax_bps int,
  add column if not exists tax_rule text,
  add column if not exists shipping_tax_cents int not null default 0;

insert into public.store_settings (store_id, key, value)
select s.id, d.key, d.value from public.stores s
cross join (values
  ('tax_origin_state', '"CA"'::jsonb),
  ('tax_out_of_state_bps', '0'::jsonb),
  ('tax_in_state_ship_bps', 'null'::jsonb),
  ('tax_shipping', 'false'::jsonb)
) d(key, value)
on conflict (store_id, key) do nothing;

-- Service-role callers can pin the rate for one transaction (set_config(..., true)).
-- Staff/anon cannot: the override is ignored unless auth.role() = 'service_role'.
create or replace function public.store_tax_rate_bps()
returns integer language plpgsql stable security definer set search_path to 'public' as $function$
declare
  v_store uuid := public.current_store_id();
  v_raw text;
  v_bps int;
  v_override text := nullif(current_setting('floor.tax_bps_override', true), '');
begin
  if v_store is null then return null; end if;
  if v_override is not null and auth.role() = 'service_role' and v_override ~ '^[0-9]{1,5}$' then
    return v_override::int;
  end if;
  v_raw := public.store_setting(v_store, 'taxRateBps', 'null'::jsonb) #>> '{}';
  if v_raw is null or v_raw = '' or v_raw = 'null' then return null; end if;
  begin v_bps := v_raw::int; exception when others then return null; end;
  if v_bps < 0 then return null; end if;
  return v_bps;
end;
$function$;

create or replace function public.web_tax_decision(p_store uuid, p_fulfillment text, p_region text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_store_bps int := coalesce(nullif(public.store_setting(p_store,'taxRateBps','0'::jsonb) #>> '{}','')::int, 0);
  v_origin text := upper(coalesce(nullif(btrim(public.store_setting(p_store,'tax_origin_state','"CA"'::jsonb) #>> '{}'),''),'CA'));
  v_out int := coalesce(nullif(public.store_setting(p_store,'tax_out_of_state_bps','0'::jsonb) #>> '{}',''),'0')::int;
  v_in_ship text := nullif(public.store_setting(p_store,'tax_in_state_ship_bps','null'::jsonb) #>> '{}','');
  v_ship_taxed boolean := coalesce((public.store_setting(p_store,'tax_shipping','false'::jsonb) #>> '{}')::boolean, false);
  v_region text := upper(btrim(coalesce(p_region,'')));
  v_bps int; v_rule text;
begin
  if p_fulfillment = 'pickup' then
    v_bps := v_store_bps; v_rule := 'pickup_store_rate';
  elsif v_region = v_origin then
    v_bps := coalesce(v_in_ship::int, v_store_bps); v_rule := 'ship_in_state';
  else
    v_bps := v_out; v_rule := 'ship_out_of_state';
  end if;
  return jsonb_build_object('bps', v_bps, 'rule', v_rule, 'tax_shipping', v_ship_taxed);
end $$;

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

  v_tax := public.web_tax_decision(p_store, p_fulfillment, p_buyer->>'region');
  perform set_config('floor.tax_bps_override', v_tax->>'bps', true);
  v_customer := public.web_lookup_customer(p_store, p_buyer->>'phone');
  v_cust_id := (v_customer->>'id')::uuid;
  v_redeem := least(greatest(coalesce(p_redeem_points,0),0), coalesce((v_customer->>'points_balance')::int,0));
  v_quote := public.web_quote(p_store, jsonb_build_array(jsonb_build_object('sku',p_sku,'price_cents',v_unit.ask_cents,'qty',1)), v_cust_id, v_redeem);
  if (v_tax->>'tax_shipping')::boolean then
    v_ship_tax := round(v_ship * (v_tax->>'bps')::int / 10000.0);
  end if;

  insert into public.web_orders (
    store_id, sku, reservation_id, status, fulfillment,
    buyer_name, buyer_email, buyer_phone,
    ship_line1, ship_line2, ship_city, ship_region, ship_postal, ship_country,
    item_cents, shipping_cents, tax_cents, total_cents,
    checkout_quote, customer_id, redeem_points, shipping_rate, carrier, service,
    tax_bps, tax_rule, shipping_tax_cents
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
    (v_tax->>'bps')::int, v_tax->>'rule', v_ship_tax
  ) returning * into v_order;

  insert into public.events (store_id, sku, kind, actor, note)
  values (p_store, p_sku, 'reserved', 'website', 'web checkout hold (' || p_fulfillment || ', tax ' || (v_tax->>'rule') || ')');

  return jsonb_build_object(
    'order_id', v_order.id, 'reservation_id', v_res.id, 'expires_at', v_res.expires_at,
    'sku', p_sku, 'fulfillment', p_fulfillment,
    'title', coalesce(nullif(btrim(v_unit.title),''), concat_ws(' ', v_unit.brand, v_unit.model)),
    'item_cents', v_unit.ask_cents, 'shipping_cents', v_ship, 'shipping_rate', v_rate,
    'tax_rule', v_tax->>'rule', 'tax_bps', (v_tax->>'bps')::int,
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
  -- Charge with the exact rate frozen at checkout, even if settings changed while the customer paid.
  perform set_config('floor.tax_bps_override', coalesce(o.tax_bps, public.store_tax_rate_bps())::text, true);
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

-- Admin portal settings: add the tax rules.
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
    'store_tax_bps', public.store_setting(v_store,'taxRateBps','0'::jsonb),
    'tax_origin_state', public.store_setting(v_store,'tax_origin_state','"CA"'::jsonb),
    'tax_out_of_state_bps', public.store_setting(v_store,'tax_out_of_state_bps','0'::jsonb),
    'tax_in_state_ship_bps', public.store_setting(v_store,'tax_in_state_ship_bps','null'::jsonb),
    'tax_shipping', public.store_setting(v_store,'tax_shipping','false'::jsonb),
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
  elsif p_key = 'tax_origin_state' then
    if jsonb_typeof(p_value) <> 'string' or upper(p_value #>> '{}') !~ '^[A-Z]{2}$' then
      raise exception 'two_letter_state_required' using errcode = '22023';
    end if;
    p_value := to_jsonb(upper(p_value #>> '{}'));
  elsif p_key = 'tax_out_of_state_bps' then
    if jsonb_typeof(p_value) <> 'number' or (p_value #>> '{}')::numeric < 0 or (p_value #>> '{}')::numeric > 2500 then
      raise exception 'rate_0_to_2500_bps_required' using errcode = '22023';
    end if;
  elsif p_key = 'tax_in_state_ship_bps' then
    if jsonb_typeof(p_value) not in ('number','null')
       or (jsonb_typeof(p_value) = 'number' and ((p_value #>> '{}')::numeric < 0 or (p_value #>> '{}')::numeric > 2500)) then
      raise exception 'rate_0_to_2500_bps_or_blank_required' using errcode = '22023';
    end if;
  elsif p_key = 'tax_shipping' then
    if jsonb_typeof(p_value) <> 'boolean' then raise exception 'true_or_false_required' using errcode = '22023'; end if;
  else
    raise exception 'setting_not_editable' using errcode = '22023';
  end if;
  insert into public.store_settings(store_id, key, value) values (v_store, p_key, p_value)
  on conflict (store_id, key) do update set value = excluded.value;
end $$;

revoke all on function public.web_tax_decision(uuid,text,text) from public, anon, authenticated;
grant execute on function public.web_tax_decision(uuid,text,text) to service_role;
commit;
