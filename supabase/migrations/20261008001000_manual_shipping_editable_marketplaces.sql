begin;

-- Conservative, editable USPS Ground Advantage retail Zone 8 rates from USPS Notice 123
-- effective 2026-10-04. Zone 8 is used as a lower-48 worst-case public rate estimate.
insert into public.store_settings(store_id,key,value)
select s.id, x.key, x.value from public.stores s cross join (values
 ('manual_shipping_tiers','[{"max_lb":1,"cents":1365},{"max_lb":2,"cents":1980},{"max_lb":3,"cents":2315},{"max_lb":5,"cents":2745},{"max_lb":10,"cents":4085},{"max_lb":20,"cents":7215},{"max_lb":30,"cents":12030},{"max_lb":40,"cents":14790},{"max_lb":50,"cents":17125},{"max_lb":60,"cents":19000},{"max_lb":70,"cents":20430}]'::jsonb),
 ('manual_oversize_cents','30175'::jsonb),
 ('marketplace_channels','[{"key":"vendoo","label":"Vendoo","aliases":["vendoo"]},{"key":"mercari","label":"Mercari","aliases":["mercari"]},{"key":"poshmark","label":"Poshmark","aliases":["poshmark"]},{"key":"facebook","label":"Facebook Marketplace","aliases":["facebook marketplace","facebook","meta"]},{"key":"depop","label":"Depop","aliases":["depop"]},{"key":"etsy","label":"Etsy","aliases":["etsy"]},{"key":"grailed","label":"Grailed","aliases":["grailed"]},{"key":"vinted","label":"Vinted","aliases":["vinted"]},{"key":"vestiaire_collective","label":"Vestiaire Collective","aliases":["vestiaire collective","vestiaire"]},{"key":"whatnot","label":"Whatnot","aliases":["whatnot"]},{"key":"shopify","label":"Shopify","aliases":["shopify"]},{"key":"other","label":"Other","aliases":[]}]'::jsonb)
) x(key,value) on conflict(store_id,key) do nothing;

-- Every configured marketplace participates in the existing online payout/report grouping.
update public.store_settings ss set value=(
 select jsonb_agg(to_jsonb(k) order by k) from (
  select distinct lower(btrim(x)) k from jsonb_array_elements_text(case when jsonb_typeof(public.store_setting(ss.store_id,'online_channels','[]'::jsonb))='array' then public.store_setting(ss.store_id,'online_channels','[]'::jsonb) else '[]'::jsonb end) x
  union select 'website'
  union select c->>'key' from jsonb_array_elements(public.store_setting(ss.store_id,'marketplace_channels','[]'::jsonb)) c
 ) q where k is not null
) where ss.key='online_channels';
insert into public.store_settings(store_id,key,value)
select s.id,'online_channels',(
 select jsonb_agg(to_jsonb(k) order by k) from (
  select 'website' k union select c->>'key' from jsonb_array_elements(public.store_setting(s.id,'marketplace_channels','[]'::jsonb)) c
 ) q)
from public.stores s on conflict(store_id,key) do nothing;

-- Shipping can go live now; if Shippo has a live key it is preferred automatically.
insert into public.store_settings(store_id,key,value)
select id,'shipping_enabled','true'::jsonb from public.stores
on conflict(store_id,key) do update set value='true'::jsonb;
update public.store_settings set value='70'::jsonb where key='ship_max_weight_lb';
update public.store_settings set value='108'::jsonb where key='ship_max_length_in';
update public.store_settings set value='130'::jsonb where key='ship_max_length_girth_in';

create or replace function public.portal_online_settings()
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_store uuid:=public.portal_store_id();
begin
 if v_store is null then raise exception 'portal_access_denied' using errcode='42501'; end if;
 return jsonb_build_object(
  'ship_excluded_categories',public.store_setting(v_store,'ship_excluded_categories','[]'::jsonb),
  'ship_excluded_keywords',public.store_setting(v_store,'ship_excluded_keywords','[]'::jsonb),
  'ship_max_weight_lb',public.store_setting(v_store,'ship_max_weight_lb','70'::jsonb),
  'ship_max_length_in',public.store_setting(v_store,'ship_max_length_in','108'::jsonb),
  'ship_max_length_girth_in',public.store_setting(v_store,'ship_max_length_girth_in','130'::jsonb),
  'pickup_hold_hours',public.store_setting(v_store,'pickup_hold_hours','48'::jsonb),
  'order_notify_emails',public.store_setting(v_store,'order_notify_emails','[]'::jsonb),
  'categories',public.store_setting(v_store,'categories','[]'::jsonb),
  'store_tax_bps',public.store_setting(v_store,'taxRateBps','0'::jsonb),
  'tax_origin_state',public.store_setting(v_store,'tax_origin_state','"CA"'::jsonb),
  'tax_out_of_state_bps',public.store_setting(v_store,'tax_out_of_state_bps','0'::jsonb),
  'tax_in_state_ship_bps',public.store_setting(v_store,'tax_in_state_ship_bps','null'::jsonb),
  'tax_shipping',public.store_setting(v_store,'tax_shipping','false'::jsonb),
  'manual_shipping_tiers',public.store_setting(v_store,'manual_shipping_tiers','[]'::jsonb),
  'manual_oversize_cents',public.store_setting(v_store,'manual_oversize_cents','30175'::jsonb),
  'marketplace_channels',public.store_setting(v_store,'marketplace_channels','[]'::jsonb),
  'counts',(select jsonb_build_object('listed',count(*),'shippable',count(*) filter(where s.shippable),'pickup_only',count(*) filter(where not s.shippable),'missing_dims',count(*) filter(where s.ship_note='Missing package dimensions or weight'),'ready_when_shipping_on',count(*) filter(where s.shippable)) from public.storefront_items s where s.store_id=v_store),
  'pickup_only_units',coalesce((select jsonb_agg(jsonb_build_object('sku',s.sku,'title',coalesce(nullif(btrim(s.title),''),concat_ws(' ',s.brand,s.model)),'category',s.category,'reason',s.ship_note) order by s.sku) from public.storefront_items s where s.store_id=v_store and not s.shippable),'[]'::jsonb));
end $$;
revoke all on function public.portal_online_settings() from public,anon;
grant execute on function public.portal_online_settings() to authenticated;

create or replace function public.portal_marketplace_channels()
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_store uuid:=public.portal_store_id();
begin
 if v_store is null then raise exception 'portal_access_denied' using errcode='42501'; end if;
 return public.store_setting(v_store,'marketplace_channels','[]'::jsonb);
end $$;
revoke all on function public.portal_marketplace_channels() from public,anon;
grant execute on function public.portal_marketplace_channels() to authenticated;

create or replace function public.portal_set_online_setting(p_key text,p_value jsonb)
returns void language plpgsql security definer set search_path=public as $$
declare v_store uuid:=public.portal_store_id();
begin
 if v_store is null then raise exception 'portal_access_denied' using errcode='42501'; end if;
 if p_key in ('ship_excluded_categories','ship_excluded_keywords') then
  if jsonb_typeof(p_value)<>'array' or exists(select 1 from jsonb_array_elements(p_value) x where jsonb_typeof(x)<>'string') then raise exception 'list_of_text_required' using errcode='22023'; end if;
 elsif p_key='ship_carriers' then
  if jsonb_typeof(p_value)<>'array' or jsonb_array_length(p_value)=0 or exists(select 1 from jsonb_array_elements(p_value) x where jsonb_typeof(x)<>'string' or btrim(x#>>'{}')='') then raise exception 'at_least_one_carrier_required' using errcode='22023'; end if;
  p_value:=(select jsonb_agg(upper(btrim(x))) from jsonb_array_elements_text(p_value) x);
 elsif p_key='order_notify_emails' then
  if jsonb_typeof(p_value)<>'array' or jsonb_array_length(p_value)=0 or exists(select 1 from jsonb_array_elements_text(p_value) x where x !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') then raise exception 'valid_emails_required' using errcode='22023'; end if;
 elsif p_key in ('ship_max_weight_lb','ship_max_length_in','ship_max_length_girth_in','pickup_hold_hours') then
  if jsonb_typeof(p_value)<>'number' or (p_value#>>'{}')::numeric<=0 then raise exception 'positive_number_required' using errcode='22023'; end if;
 elsif p_key='manual_shipping_tiers' then
  if jsonb_typeof(p_value)<>'array' or jsonb_array_length(p_value)=0 or exists(select 1 from jsonb_array_elements(p_value) x where jsonb_typeof(x)<>'object' or (x->>'max_lb') !~ '^([1-9]|[1-6][0-9]|70)$' or (x->>'cents') !~ '^[1-9][0-9]*$') then raise exception 'invalid_shipping_tiers' using errcode='22023'; end if;
 elsif p_key='marketplace_channels' then
  if jsonb_typeof(p_value)<>'array' or jsonb_array_length(p_value)=0 or exists(select 1 from jsonb_array_elements(p_value) x where jsonb_typeof(x)<>'object' or coalesce(x->>'key','') !~ '^[a-z][a-z0-9_]{1,39}$' or nullif(btrim(x->>'label'),'') is null or jsonb_typeof(x->'aliases')<>'array') then raise exception 'invalid_marketplace_channels' using errcode='22023'; end if;
  if (select count(*)<>count(distinct x->>'key') from jsonb_array_elements(p_value) x) then raise exception 'duplicate_marketplace_key' using errcode='22023'; end if;
 elsif p_key='tax_origin_state' then
  if jsonb_typeof(p_value)<>'string' or upper(p_value#>>'{}') !~ '^[A-Z]{2}$' then raise exception 'two_letter_state_required' using errcode='22023'; end if; p_value:=to_jsonb(upper(p_value#>>'{}'));
 elsif p_key='tax_out_of_state_bps' then
  if jsonb_typeof(p_value)<>'number' or (p_value#>>'{}')::numeric<0 or (p_value#>>'{}')::numeric>2500 then raise exception 'rate_0_to_2500_bps_required' using errcode='22023'; end if;
 elsif p_key='tax_in_state_ship_bps' then
  if jsonb_typeof(p_value) not in ('number','null') or (jsonb_typeof(p_value)='number' and ((p_value#>>'{}')::numeric<0 or (p_value#>>'{}')::numeric>2500)) then raise exception 'rate_0_to_2500_bps_or_blank_required' using errcode='22023'; end if;
 elsif p_key='tax_shipping' then
  if jsonb_typeof(p_value)<>'boolean' then raise exception 'true_or_false_required' using errcode='22023'; end if;
 else raise exception 'setting_not_editable' using errcode='22023'; end if;
 insert into public.store_settings(store_id,key,value) values(v_store,p_key,p_value) on conflict(store_id,key) do update set value=excluded.value;
end $$;
revoke all on function public.portal_set_online_setting(text,jsonb) from public,anon;
grant execute on function public.portal_set_online_setting(text,jsonb) to authenticated;

create or replace function public.portal_set_unit_listed_on(p_sku text,p_channels text[])
returns text[] language plpgsql security definer set search_path=public as $$
declare v_store uuid:=public.portal_store_id(); v_channels text[]; v_allowed text[];
begin
 if v_store is null then raise exception 'portal_access_denied' using errcode='42501'; end if;
 select coalesce(array_agg(x->>'key'),'{}'::text[]) into v_allowed from jsonb_array_elements(public.store_setting(v_store,'marketplace_channels','[]'::jsonb)) x;
 select coalesce(array_agg(distinct lower(btrim(x)) order by lower(btrim(x))),'{}'::text[]) into v_channels from unnest(coalesce(p_channels,'{}'::text[])) x where lower(btrim(x))=any(v_allowed);
 update public.units set listed_on=v_channels,updated_at=now() where store_id=v_store and sku=p_sku;
 if not found then raise exception 'unit_not_found' using errcode='P0002'; end if;
 update public.listings set status='delisted',delisted_at=now() where store_id=v_store and sku=p_sku and channel=any(v_allowed) and not(channel=any(v_channels)) and status='listed';
 insert into public.listings(store_id,sku,channel,status,listed_at,delisted_at) select v_store,p_sku,x,'listed',now(),null from unnest(v_channels) x on conflict(store_id,sku,channel) do update set status='listed',listed_at=coalesce(public.listings.listed_at,now()),delisted_at=null;
 return v_channels;
end $$;
revoke all on function public.portal_set_unit_listed_on(text,text[]) from public,anon;
grant execute on function public.portal_set_unit_listed_on(text,text[]) to authenticated;

create or replace function public.marketplace_ingest_sale(p_store uuid,p_sku text,p_channel text,p_price_cents int,p_order_number text,p_message_id text,p_marketplace text,p_item_title text,p_ship_by date,p_fulfillment text,p_buyer jsonb,p_confidence numeric)
returns bigint language plpgsql security definer set search_path=public as $$
declare v_sale public.sales; v_existing bigint; v_unit public.units; v_allowed boolean;
begin
 perform public.assert_service();
 select exists(select 1 from jsonb_array_elements(public.store_setting(p_store,'marketplace_channels','[]'::jsonb)) x where x->>'key'=lower(p_channel)) into v_allowed;
 if not v_allowed then raise exception 'invalid_marketplace'; end if;
 select sale_id into v_existing from public.marketplace_email_sales where store_id=p_store and message_id=p_message_id;
 if v_existing is not null then return v_existing; end if;
 select * into v_unit from public.units where store_id=p_store and sku=p_sku for update;
 if not found or v_unit.state<>'available' then raise exception 'unit_not_available'; end if;
 update public.listings set status='delisted',delisted_at=now() where store_id=p_store and sku=p_sku and channel=p_channel;
 v_sale:=public.finalize_sale(p_sku=>p_sku,p_channel=>p_channel,p_price_cents=>p_price_cents,p_payment_method=>'marketplace',p_payment_id=>'marketplace:'||p_marketplace||':'||coalesce(p_order_number,p_message_id),p_note=>'Marketplace order '||coalesce(p_order_number,p_message_id));
 insert into public.marketplace_email_sales(store_id,message_id,marketplace,state,sku,item_title,order_number,sale_price_cents,ship_by,fulfillment,buyer,confidence,sale_id)
 values(p_store,p_message_id,p_marketplace,'matched',p_sku,p_item_title,p_order_number,p_price_cents,p_ship_by,p_fulfillment,coalesce(p_buyer,'{}'::jsonb),p_confidence,v_sale.id)
 on conflict(store_id,message_id) do update set state='matched',sale_id=excluded.sale_id,sku=excluded.sku,reason=null;
 insert into public.web_orders(store_id,sku,sale_id,status,fulfillment,buyer_name,buyer_email,buyer_phone,ship_line1,ship_line2,ship_city,ship_region,ship_postal,ship_country,item_cents,shipping_cents,tax_cents,total_cents,payment_id,created_at,updated_at,order_no,paid_at,payment_env,channel,ship_by)
 values(p_store,p_sku,v_sale.id,'paid',case when p_fulfillment='pickup' then 'pickup' else 'ship' end,p_buyer->>'name',p_buyer->>'email',p_buyer->>'phone',p_buyer->>'line1',p_buyer->>'line2',p_buyer->>'city',p_buyer->>'region',p_buyer->>'postal',coalesce(p_buyer->>'country','US'),p_price_cents,0,0,p_price_cents,'marketplace:'||p_marketplace||':'||coalesce(p_order_number,p_message_id),now(),now(),upper(p_marketplace)||'-'||left(regexp_replace(coalesce(p_order_number,p_message_id),'[^A-Za-z0-9-]','','g'),32),now(),'production',lower(p_channel),p_ship_by) on conflict do nothing;
 return v_sale.id;
end $$;
revoke all on function public.marketplace_ingest_sale(uuid,text,text,int,text,text,text,text,date,text,jsonb,numeric) from public,anon,authenticated;
grant execute on function public.marketplace_ingest_sale(uuid,text,text,int,text,text,text,text,date,text,jsonb,numeric) to service_role;

select (select count(*) from public.storefront_items where shippable) as shippable_now,
       (select count(*) from public.storefront_items where not shippable and ship_note='Missing package dimensions or weight') as missing_package_dims,
       (select count(*) from public.marketplace_email_sales where state='needs_review') as marketplace_reviews;
commit;
