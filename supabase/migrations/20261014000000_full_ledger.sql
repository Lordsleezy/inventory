-- Full ledger: every sale on every channel carries its real economics.
-- profit = sale price - channel fees - label cost - processing fee - item cost (tax is pass-through).
-- channel_orders becomes the per-order ledger for ALL marketplaces (not just eBay):
-- actual fee/label/tax/payout when known; estimates come from editable channel_fee_rates.
-- Cost: real unit cost > collectible $0 > category default > "other" default; always flagged.

begin;

-- ── Columns ────────────────────────────────────────────────────────────────

-- channel_orders was eBay/Amazon-only; every marketplace channel is allowed now.
alter table public.channel_orders drop constraint if exists channel_orders_provider_check;
alter table public.channel_orders
  add constraint channel_orders_provider_check check (provider ~ '^[a-z][a-z0-9_]{0,39}$');

alter table public.channel_orders
  add column if not exists fee_source text not null default 'estimated'
    check (fee_source in ('estimated','actual')),
  add column if not exists ship_label_cents int,
  add column if not exists ship_label_source text,
  add column if not exists tax_cents int,
  add column if not exists tax_remitted boolean,
  add column if not exists payout_cents int;

-- Square processing fee on card sales: filled by the reconciler, estimated until then.
-- Parsed money fields from marketplace sale emails, kept for review-approve ingest.
alter table public.marketplace_email_sales
  add column if not exists fee_cents int,
  add column if not exists ship_label_cents int,
  add column if not exists tax_cents int,
  add column if not exists payout_cents int;

-- Collectible flag on the unit: locks ledger cost at $0 (update_unit_field already writes it).
alter table public.units add column if not exists is_collectible boolean not null default false;

alter table public.sales
  add column if not exists processing_fee_cents int,
  add column if not exists processing_fee_source text
    check (processing_fee_source is null or processing_fee_source in ('estimated','actual'));

-- ── Editable settings ──────────────────────────────────────────────────────

insert into public.store_settings (store_id, key, value)
select s.id, d.key, d.value from public.stores s cross join (values
  -- Channel fee fallbacks, used only when no actual fee was captured. Editable in Admin → Settings.
  ('channel_fee_rates', '{
     "ebay":          {"pct":13.25,"fixed_cents":40},
     "mercari":       {"pct":10,   "fixed_cents":0},
     "depop":         {"pct":3.3,  "fixed_cents":45},
     "whatnot":       {"pct":10.9, "fixed_cents":30},
     "poshmark":      {"pct":20,   "fixed_cents":0,"min_fee_cents":295},
     "facebook":      {"pct":5,    "fixed_cents":40},
     "etsy":          {"pct":9.5,  "fixed_cents":45},
     "grailed":       {"pct":9,    "fixed_cents":30},
     "vinted":        {"pct":0,    "fixed_cents":0},
     "amazon":        {"pct":15,   "fixed_cents":0},
     "tiktok":        {"pct":6,    "fixed_cents":30},
     "other":         {"pct":0,    "fixed_cents":0},
     "card_in_store": {"pct":2.6,  "fixed_cents":15},
     "card_online":   {"pct":3.3,  "fixed_cents":30}
   }'::jsonb),
  -- Channels where the marketplace collects & remits sales tax (we owe nothing on them).
  ('tax_remitted_channels', '["ebay","mercari","depop","whatnot","poshmark","facebook","etsy","grailed","vinted","vestiaire_collective","amazon","tiktok","shopify","vendoo","other"]'::jsonb)
) d(key, value)
on conflict (store_id, key) do nothing;

-- ── Cost resolution: unit > collectible > category default > other default ──

create or replace function public.unit_cost_json(p_store uuid, p_category text, p_collectible boolean, p_acq int)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_map jsonb := coalesce(public.store_setting(p_store, 'cost_defaults', '{}'::jsonb), '{}'::jsonb);
  v_cat text := lower(btrim(coalesce(p_category, '')));
  v_key text;
  v_c int;
begin
  if coalesce(p_collectible, false) then return jsonb_build_object('cost_cents', 0, 'source', 'collectible'); end if;
  if p_acq is not null then return jsonb_build_object('cost_cents', p_acq, 'source', 'unit'); end if;
  if jsonb_typeof(v_map) = 'object' then
    for v_key in select k from jsonb_object_keys(v_map) k where k <> 'other' loop
      if v_cat <> '' and (v_cat = v_key or v_cat || 's' = v_key or v_cat = v_key || 's'
                          or v_cat like '%' || v_key || '%' or v_key like '%' || v_cat || '%') then
        v_c := nullif(v_map ->> v_key, '')::int;
        if v_c is not null and v_c >= 0 then
          return jsonb_build_object('cost_cents', v_c, 'source', 'default', 'matched', v_key);
        end if;
      end if;
    end loop;
    v_c := nullif(v_map ->> 'other', '')::int;
    if v_c is not null and v_c >= 0 then return jsonb_build_object('cost_cents', v_c, 'source', 'default', 'matched', 'other'); end if;
  end if;
  return jsonb_build_object('cost_cents', 900, 'source', 'default', 'matched', 'builtin');
end $$;
revoke all on function public.unit_cost_json(uuid, text, boolean, int) from public, anon;
grant execute on function public.unit_cost_json(uuid, text, boolean, int) to authenticated, service_role;

-- Estimated channel fee: pct of price + fixed, never below min_fee. null = channel has no rate.
create or replace function public.channel_fee_estimate(p_store uuid, p_channel text, p_price_cents int)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_rates jsonb := coalesce(public.store_setting(p_store, 'channel_fee_rates', '{}'::jsonb), '{}'::jsonb);
  v_r jsonb; v_fee int;
begin
  v_r := v_rates -> lower(btrim(coalesce(p_channel, '')));
  if v_r is null or jsonb_typeof(v_r) <> 'object' then return null; end if;
  v_fee := round(coalesce(p_price_cents, 0) * coalesce((v_r ->> 'pct')::numeric, 0) / 100.0)::int
         + coalesce((v_r ->> 'fixed_cents')::int, 0);
  v_fee := greatest(v_fee, coalesce((v_r ->> 'min_fee_cents')::int, 0), 0);
  return jsonb_build_object('fee_cents', v_fee, 'source', 'estimated');
end $$;
revoke all on function public.channel_fee_estimate(uuid, text, int) from public, anon;
grant execute on function public.channel_fee_estimate(uuid, text, int) to authenticated, service_role;

-- ── The ledger view: one row per sale with every money field resolved ──────

create or replace view public.sale_ledger as
select
  s.id, s.store_id, s.sku, s.qty, s.sold_at, s.voided_at, s.ticket_id, s.receipt_no,
  s.channel, s.payment_method, s.payment_id, s.actor_id, st.display_name as actor_name,
  s.price_cents, s.tax_cents, s.card_fee_cents, coalesce(s.shipping_cents, 0) as shipping_cents,
  x.cash_cents, x.card_cents,
  u.brand, u.model, u.category, u.ask_cents, coalesce(u.is_collectible, false) as is_collectible,
  u.acquisition_cost_cents as unit_cost_cents,
  (cost.val ->> 'cost_cents')::int as cost_unit_cents,
  (cost.val ->> 'cost_cents')::int * greatest(s.qty, 1) as cost_cents,
  cost.val ->> 'source' as cost_source,
  -- Channel fee: actual (channel_orders marked actual) > recorded estimate > rate estimate > none
  coalesce(co.fee_cents, wo.marketplace_fee_cents, (fe.val ->> 'fee_cents')::int, 0) as channel_fee_cents,
  case
    when co.fee_cents is not null then co.fee_source
    when wo.marketplace_fee_cents is not null then 'estimated'
    when fe.val is not null then 'estimated'
    else 'none' end as fee_source,
  -- Label/ship cost actually paid by us
  greatest(coalesce(wo.label_cost_cents, 0), coalesce(lbl.cents, 0), coalesce(man.cents, 0),
           coalesce(co.ship_label_cents, 0), coalesce(co.baked_ship_cents, 0), 0) as ship_cost_cents,
  case
    when coalesce(wo.label_cost_cents, lbl.cents, 0) > 0 then 'shippo'
    when man.cents is not null then 'manual'
    when coalesce(co.ship_label_cents, 0) > 0 then coalesce(co.ship_label_source, 'marketplace')
    when coalesce(co.baked_ship_cents, 0) > 0 then 'estimated'
    else 'none' end as ship_cost_source,
  -- Square processing fee on card sales
  coalesce(s.processing_fee_cents,
    case when s.payment_method in ('card','split')
      then (cfe.val ->> 'fee_cents')::int end, 0) as processing_fee_cents,
  case
    when s.processing_fee_cents is not null then coalesce(s.processing_fee_source, 'actual')
    when s.payment_method in ('card','split') and cfe.val is not null then 'estimated'
    else 'none' end as processing_fee_source,
  -- Sales tax: who remits it
  case when lower(s.channel) = any (taxch.val) then 'marketplace' else 'us' end as tax_remitted_by,
  s.tax_cents + coalesce(co.tax_cents, 0) as tax_collected_cents,
  case when lower(s.channel) = any (taxch.val) then 0 else s.tax_cents end as tax_owed_cents,
  -- Sold vs asking (store ask; visibility only)
  case when u.ask_cents is not null then s.price_cents - u.ask_cents * greatest(s.qty, 1) end as variance_cents,
  s.price_cents - u.ask_cents * greatest(s.qty, 1) as raw_variance_cents,
  -- Profit: the number payouts and reports are built on
  s.price_cents
    - coalesce(co.fee_cents, wo.marketplace_fee_cents, (fe.val ->> 'fee_cents')::int, 0)
    - greatest(coalesce(wo.label_cost_cents, 0), coalesce(lbl.cents, 0), coalesce(man.cents, 0),
               coalesce(co.ship_label_cents, 0), coalesce(co.baked_ship_cents, 0), 0)
    - coalesce(s.processing_fee_cents,
        case when s.payment_method in ('card','split') then (cfe.val ->> 'fee_cents')::int end, 0)
    - (cost.val ->> 'cost_cents')::int * greatest(s.qty, 1) as profit_cents
from public.sales s
left join public.units u on u.store_id = s.store_id and u.sku = s.sku
left join public.staff st on st.store_id = s.store_id and st.user_id = s.actor_id
left join public.ticket_extras x on x.store_id = s.store_id and x.ticket_id = s.ticket_id
left join lateral (
  select * from public.channel_orders c where c.sale_id = s.id order by c.created_at desc limit 1
) co on true
left join lateral (
  select * from public.web_orders w where w.sale_id = s.id order by w.created_at limit 1
) wo on true
left join lateral (
  select sum(l.cost_cents)::int as cents from public.web_order_labels l
  where l.order_id = wo.id and l.voided_at is null
) lbl on true
left join lateral (
  select sum(e.amount_cents)::int as cents from public.portal_expenses e
  where e.order_id = wo.id and e.source = 'manual_label' and e.voided_at is null
) man on true
cross join lateral (select public.unit_cost_json(s.store_id, u.category, u.is_collectible, u.acquisition_cost_cents) as val) cost
cross join lateral (select public.channel_fee_estimate(s.store_id, s.channel, s.price_cents) as val) fe
cross join lateral (select public.channel_fee_estimate(s.store_id,
    case when s.channel = 'website' then 'card_online' else 'card_in_store' end,
    s.price_cents + s.tax_cents + coalesce(s.card_fee_cents, 0)) as val) cfe
cross join lateral (select public.setting_text_array(s.store_id, 'tax_remitted_channels') as val) taxch;

grant select on public.sale_ledger to authenticated, service_role;

-- ── portal_payout_sales: same shape plus the full ledger fields ────────────

drop function if exists public.portal_payout_sales();
create function public.portal_payout_sales()
returns table (
  id bigint, ticket_key text, sku text, title text, qty int, sold_at timestamptz,
  price_cents int, tax_cents int, card_fee_cents int, cost_cents int,
  payment_method text, cash_cents int, card_cents int, actor_id uuid,
  actor_name text, channel text, receipt_no text,
  ebay_fee_cents int, baked_ship_cents int,
  cost_source text, channel_fee_cents int, fee_source text,
  ship_cost_cents int, ship_cost_source text,
  processing_fee_cents int, processing_fee_source text,
  tax_remitted_by text, tax_collected_cents int, tax_owed_cents int,
  ask_cents int, variance_cents int, profit_cents int
) language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return query
    select l.id, coalesce(l.ticket_id::text, 'sale:' || l.id::text), l.sku,
      coalesce(nullif(btrim(concat_ws(' ', l.brand, l.model)), ''), 'Item')::text,
      l.qty, l.sold_at, l.price_cents, l.tax_cents, l.card_fee_cents,
      l.cost_cents, l.payment_method, l.cash_cents, l.card_cents,
      l.actor_id, coalesce(l.actor_name, 'Unknown')::text, l.channel, l.receipt_no,
      case when lower(l.channel) = 'ebay' then l.channel_fee_cents else 0 end,
      case when lower(l.channel) = 'ebay' then l.ship_cost_cents else 0 end,
      l.cost_source, l.channel_fee_cents, l.fee_source,
      l.ship_cost_cents, l.ship_cost_source,
      l.processing_fee_cents, l.processing_fee_source,
      l.tax_remitted_by, l.tax_collected_cents, l.tax_owed_cents,
      l.ask_cents, l.variance_cents, l.profit_cents
    from public.sale_ledger l
    where l.store_id = v_store and l.voided_at is null
    order by l.id;
end $$;
revoke all on function public.portal_payout_sales() from public, anon;
grant execute on function public.portal_payout_sales() to authenticated;

-- ── Marketplace ingest: record actual fee / label / tax / payout when known ─

create or replace function public.marketplace_ingest_sale(
  p_store uuid, p_sku text, p_channel text, p_price_cents int, p_order_number text,
  p_message_id text, p_marketplace text, p_item_title text, p_ship_by date,
  p_fulfillment text, p_buyer jsonb, p_confidence numeric,
  p_fee_cents int default null, p_ship_label_cents int default null,
  p_tax_cents int default null, p_payout_cents int default null)
returns bigint language plpgsql security definer set search_path=public as $$
declare v_sale public.sales; v_existing bigint; v_unit public.units; v_allowed boolean; v_dup uuid;
  v_order_id text;
begin
  perform public.assert_service();
  select exists(select 1 from jsonb_array_elements(public.store_setting(p_store,'marketplace_channels','[]'::jsonb)) x where x->>'key'=lower(p_channel)) into v_allowed;
  if not v_allowed and lower(p_channel) <> 'ebay' then raise exception 'invalid_marketplace'; end if;
  select sale_id into v_existing from public.marketplace_email_sales where store_id=p_store and message_id=p_message_id;
  if v_existing is not null then return v_existing; end if;

  if p_order_number is not null then
    select id into v_dup from public.web_orders
      where store_id=p_store and (
        order_no = p_order_number
        or payment_id = 'ebay:' || p_order_number
        or payment_id = 'marketplace:' || lower(p_marketplace) || ':' || p_order_number
      )
      limit 1;
    if v_dup is not null then
      insert into public.marketplace_email_sales(store_id,message_id,marketplace,state,sku,item_title,order_number,sale_price_cents,ship_by,fulfillment,buyer,confidence,reason)
      values(p_store,p_message_id,p_marketplace,'matched',p_sku,p_item_title,p_order_number,p_price_cents,p_ship_by,p_fulfillment,coalesce(p_buyer,'{}'::jsonb),p_confidence,'Duplicate of existing order')
      on conflict(store_id,message_id) do update set state='matched', reason=excluded.reason;
      return null;
    end if;
    if exists(select 1 from public.channel_orders where store_id=p_store and provider='ebay' and order_id=p_order_number) then
      insert into public.marketplace_email_sales(store_id,message_id,marketplace,state,sku,item_title,order_number,sale_price_cents,ship_by,fulfillment,buyer,confidence,reason)
      values(p_store,p_message_id,p_marketplace,'matched',p_sku,p_item_title,p_order_number,p_price_cents,p_ship_by,p_fulfillment,coalesce(p_buyer,'{}'::jsonb),p_confidence,'Duplicate of eBay API order')
      on conflict(store_id,message_id) do update set state='matched', reason=excluded.reason;
      return null;
    end if;
  end if;

  select * into v_unit from public.units where store_id=p_store and sku=p_sku for update;
  if not found or v_unit.state<>'available' then raise exception 'unit_not_available'; end if;
  update public.listings set status='delisted',delisted_at=now() where store_id=p_store and sku=p_sku and channel=p_channel;
  v_sale:=public.finalize_sale(p_sku=>p_sku,p_channel=>p_channel,p_price_cents=>p_price_cents,p_payment_method=>'marketplace',p_payment_id=>'marketplace:'||p_marketplace||':'||coalesce(p_order_number,p_message_id),p_note=>'Marketplace order '||coalesce(p_order_number,p_message_id),p_tax_cents=>0);
  insert into public.marketplace_email_sales(store_id,message_id,marketplace,state,sku,item_title,order_number,sale_price_cents,ship_by,fulfillment,buyer,confidence,sale_id)
  values(p_store,p_message_id,p_marketplace,'matched',p_sku,p_item_title,p_order_number,p_price_cents,p_ship_by,p_fulfillment,coalesce(p_buyer,'{}'::jsonb),p_confidence,v_sale.id)
  on conflict(store_id,message_id) do update set state='matched',sale_id=excluded.sale_id,sku=excluded.sku,reason=null;
  insert into public.web_orders(store_id,sku,sale_id,status,fulfillment,buyer_name,buyer_email,buyer_phone,ship_line1,ship_line2,ship_city,ship_region,ship_postal,ship_country,item_cents,shipping_cents,tax_cents,total_cents,payment_id,created_at,updated_at,order_no,paid_at,payment_env,channel,ship_by,match_status,marketplace_fee_cents,marketplace_title)
  values(p_store,p_sku,v_sale.id,'paid',case when p_fulfillment='pickup' then 'pickup' else 'ship' end,p_buyer->>'name',p_buyer->>'email',p_buyer->>'phone',p_buyer->>'line1',p_buyer->>'line2',p_buyer->>'city',p_buyer->>'region',p_buyer->>'postal',coalesce(p_buyer->>'country','US'),p_price_cents,0,0,p_price_cents,'marketplace:'||p_marketplace||':'||coalesce(p_order_number,p_message_id),now(),now(),upper(p_marketplace)||'-'||left(regexp_replace(coalesce(p_order_number,p_message_id),'[^A-Za-z0-9-]','','g'),32),now(),'production',lower(p_channel),p_ship_by,'matched',p_fee_cents,left(coalesce(p_item_title,''),250)) on conflict do nothing;
  -- Per-order ledger row: actual fee/label/tax when supplied, else the row exists for later reconciliation.
  v_order_id := coalesce(p_order_number, 'msg:' || p_message_id);
  insert into public.channel_orders(store_id,provider,order_id,sku,sale_id,item_cents,fee_cents,fee_source,ship_label_cents,ship_label_source,tax_cents,tax_remitted,payout_cents)
  values(p_store, lower(p_channel), v_order_id, p_sku, v_sale.id, p_price_cents,
         p_fee_cents, case when p_fee_cents is not null then 'actual' else 'estimated' end,
         p_ship_label_cents, case when p_ship_label_cents is not null then 'marketplace' end,
         p_tax_cents, case when p_tax_cents is not null then true end,
         p_payout_cents)
  on conflict (store_id, provider, order_id) do update set
    sku = excluded.sku, sale_id = excluded.sale_id,
    fee_cents = coalesce(public.channel_orders.fee_cents, excluded.fee_cents),
    fee_source = case when public.channel_orders.fee_cents is not null then public.channel_orders.fee_source else excluded.fee_source end,
    ship_label_cents = coalesce(public.channel_orders.ship_label_cents, excluded.ship_label_cents),
    ship_label_source = coalesce(public.channel_orders.ship_label_source, excluded.ship_label_source),
    tax_cents = coalesce(public.channel_orders.tax_cents, excluded.tax_cents),
    payout_cents = coalesce(public.channel_orders.payout_cents, excluded.payout_cents);
  return v_sale.id;
end $$;
drop function if exists public.marketplace_ingest_sale(uuid,text,text,int,text,text,text,text,date,text,jsonb,numeric);
revoke all on function public.marketplace_ingest_sale(uuid,text,text,int,text,text,text,text,date,text,jsonb,numeric,int,int,int,int) from public,anon,authenticated;
grant execute on function public.marketplace_ingest_sale(uuid,text,text,int,text,text,text,text,date,text,jsonb,numeric,int,int,int,int) to service_role;

-- Reconcile an order's actual numbers after the fact (fee sync, manual fix).
-- Inserts the ledger row when missing, resolving the sale from 'ebay:<order>' style payment ids.
create or replace function public.channel_order_update(
  p_store uuid, p_provider text, p_order_id text,
  p_fee_cents int default null, p_fee_source text default null,
  p_ship_label_cents int default null, p_tax_cents int default null,
  p_tax_remitted boolean default null, p_payout_cents int default null)
returns void language plpgsql security definer set search_path=public as $$
declare v_sale bigint; v_sku text;
begin
  perform public.assert_service();
  select s.id, s.sku into v_sale, v_sku from public.sales s
   where s.store_id = p_store and s.payment_id = lower(p_provider) || ':' || p_order_id
   order by s.id desc limit 1;
  if v_sale is null then
    select o.sale_id, o.sku into v_sale, v_sku from public.web_orders o
     where o.store_id = p_store and o.payment_id = lower(p_provider) || ':' || p_order_id
     limit 1;
  end if;
  update public.channel_orders set
    sale_id = coalesce(sale_id, v_sale), sku = coalesce(sku, v_sku),
    fee_cents = coalesce(p_fee_cents, fee_cents),
    fee_source = coalesce(p_fee_source, fee_source),
    ship_label_cents = coalesce(p_ship_label_cents, ship_label_cents),
    tax_cents = coalesce(p_tax_cents, tax_cents),
    tax_remitted = coalesce(p_tax_remitted, tax_remitted),
    payout_cents = coalesce(p_payout_cents, payout_cents)
  where store_id = p_store and provider = lower(p_provider) and order_id = p_order_id;
  if not found and v_sale is not null then
    insert into public.channel_orders(store_id, provider, order_id, sku, sale_id, fee_cents, fee_source,
      ship_label_cents, tax_cents, tax_remitted, payout_cents)
    values (p_store, lower(p_provider), p_order_id, v_sku, v_sale, p_fee_cents, coalesce(p_fee_source, 'actual'),
      p_ship_label_cents, p_tax_cents, p_tax_remitted, p_payout_cents);
  end if;
end $$;
revoke all on function public.channel_order_update(uuid,text,text,int,text,int,int,boolean,int) from public,anon,authenticated;
grant execute on function public.channel_order_update(uuid,text,text,int,text,int,int,boolean,int) to service_role;

-- Square processing fee on a sale, written by the fee reconciler.
create or replace function public.sale_set_processing_fee(p_store uuid, p_sale bigint, p_fee_cents int, p_source text)
returns void language plpgsql security definer set search_path=public as $$
begin
  perform public.assert_service();
  if p_fee_cents is null or p_fee_cents < 0 then raise exception 'invalid_fee'; end if;
  if p_source not in ('actual','estimated') then raise exception 'invalid_source'; end if;
  update public.sales set processing_fee_cents = p_fee_cents, processing_fee_source = p_source
   where id = p_sale and store_id = p_store
     and (processing_fee_cents is null or processing_fee_source = 'estimated');
end $$;
revoke all on function public.sale_set_processing_fee(uuid,bigint,int,text) from public,anon,authenticated;
grant execute on function public.sale_set_processing_fee(uuid,bigint,int,text) to service_role;

-- ── portal_sales: same rows, now with resolved cost (per line) + ledger fields ─

drop function if exists public.portal_sales(timestamptz, timestamptz);
create function public.portal_sales(p_from timestamp with time zone, p_to timestamp with time zone)
returns table(id bigint, ticket_key text, sku text, title text, qty integer, sold_at timestamp with time zone, price_cents integer, tax_cents integer, card_fee_cents integer, cost_cents integer, payment_method text, cash_cents integer, card_cents integer, actor_id uuid, actor_name text, channel text, receipt_no text, list_price_cents integer, override_price_cents integer, override_reason text, override_by_name text, cost_source text, fee_source text, ship_cost_source text, profit_cents integer, variance_cents integer)
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
      l.cost_cents, s.payment_method, x.cash_cents, x.card_cents,
      s.actor_id,
      coalesce(st.display_name, case when s.channel = 'website'
        then 'Website ' || coalesce((select o.order_no || ' · ' || o.fulfillment from public.web_orders o where o.sale_id = s.id limit 1), 'order')
        else 'Unknown' end)::text,
      s.channel, s.receipt_no,
      s.list_price_cents, s.override_price_cents, s.override_reason,
      coalesce(st_override.display_name, 'Unknown')::text,
      l.cost_source, l.fee_source, l.ship_cost_source, l.profit_cents, l.variance_cents
    from public.sales s
    join public.sale_ledger l on l.id = s.id
    left join public.units u on u.store_id = s.store_id and u.sku = s.sku
    left join public.staff st on st.store_id = s.store_id and st.user_id = s.actor_id
    left join public.staff st_override on st_override.store_id = s.store_id and st_override.user_id = s.override_by
    left join public.ticket_extras x on x.store_id = s.store_id and x.ticket_id = s.ticket_id
    where s.store_id = v_store and s.voided_at is null and s.sold_at >= p_from and s.sold_at < p_to
    order by s.sold_at desc, s.id desc;
end $function$;
revoke all on function public.portal_sales(timestamptz, timestamptz) from public, anon;
grant execute on function public.portal_sales(timestamptz, timestamptz) to authenticated;

-- ── Tax report: marketplace-remitted tax is listed but never owed ──────────

create or replace function public.portal_tax_report(p_month date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_from timestamptz; v_to timestamptz;
  v_origin text;
  v_channels text[];
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  v_from := (date_trunc('month', p_month)::timestamp) at time zone 'America/Los_Angeles';
  v_to := ((date_trunc('month', p_month) + interval '1 month')::timestamp) at time zone 'America/Los_Angeles';
  v_origin := upper(coalesce(nullif(btrim(public.store_setting(v_store,'tax_origin_state','"CA"'::jsonb) #>> '{}'),''),'CA'));
  v_channels := public.setting_text_array(v_store,'online_channels');
  return jsonb_build_object('month', to_char(date_trunc('month', p_month), 'YYYY-MM'), 'origin_state', v_origin,
    'rows', coalesce((select jsonb_agg(r order by r.sort) from (
      with cls as (
        select l.id, l.price_cents, l.tax_cents, l.tax_collected_cents, l.tax_remitted_by,
          coalesce(l.shipping_cents,0) as shipping_cents, l.sold_at, l.voided_at,
          case
            when l.tax_remitted_by = 'marketplace' then 'marketplace_remitted'
            when o.id is null and lower(l.channel) = any (v_channels) then 'other_online'
            when o.id is null then 'in_store'
            when o.fulfillment = 'pickup' then 'pickup'
            when upper(coalesce(o.ship_region,'')) = v_origin then 'ship_in_state'
            else 'ship_out_of_state' end as cat
        from public.sale_ledger l
        left join lateral (select * from public.web_orders w where w.sale_id = l.id order by w.created_at limit 1) o on true
        where l.store_id = v_store
          and ((l.sold_at >= v_from and l.sold_at < v_to) or (l.voided_at >= v_from and l.voided_at < v_to)))
      select c.cat as category,
        case c.cat when 'in_store' then 1 when 'pickup' then 2 when 'ship_in_state' then 3 when 'ship_out_of_state' then 4 when 'other_online' then 5 else 6 end as sort,
        count(*) filter (where c.sold_at >= v_from and c.sold_at < v_to) as sales_count,
        coalesce(sum(c.price_cents) filter (where c.sold_at >= v_from and c.sold_at < v_to), 0) as sales_cents,
        coalesce(sum(c.price_cents) filter (where c.sold_at >= v_from and c.sold_at < v_to and c.tax_cents > 0), 0) as taxable_cents,
        coalesce(sum(c.tax_cents) filter (where c.sold_at >= v_from and c.sold_at < v_to), 0) as tax_cents,
        coalesce(sum(c.tax_collected_cents) filter (where c.sold_at >= v_from and c.sold_at < v_to), 0) as tax_collected_cents,
        coalesce(sum(c.shipping_cents) filter (where c.sold_at >= v_from and c.sold_at < v_to), 0) as shipping_cents,
        count(*) filter (where c.voided_at >= v_from and c.voided_at < v_to) as refund_count,
        coalesce(sum(c.price_cents) filter (where c.voided_at >= v_from and c.voided_at < v_to), 0) as refund_sales_cents,
        coalesce(sum(c.price_cents) filter (where c.voided_at >= v_from and c.voided_at < v_to and c.tax_cents > 0), 0) as refund_taxable_cents,
        coalesce(sum(c.tax_cents) filter (where c.voided_at >= v_from and c.voided_at < v_to), 0) as refund_tax_cents,
        coalesce(sum(c.shipping_cents) filter (where c.voided_at >= v_from and c.voided_at < v_to), 0) as refund_shipping_cents
      from cls c group by c.cat) r), '[]'::jsonb));
end $$;

-- ── Per-channel profit report ──────────────────────────────────────────────

create or replace function public.portal_channel_report(p_start date, p_end date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_from timestamptz; v_to timestamptz;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  v_from := p_start::timestamp at time zone 'America/Los_Angeles';
  v_to := p_end::timestamp at time zone 'America/Los_Angeles';
  return jsonb_build_object(
    'start', p_start, 'end', p_end,
    'channels', coalesce((select jsonb_agg(r order by r.profit_cents desc nulls last) from (
      select lower(l.channel) as channel,
        count(*) as sales_count,
        sum(l.price_cents)::int as gross_cents,
        sum(l.channel_fee_cents)::int as fee_cents,
        sum(l.channel_fee_cents) filter (where l.fee_source = 'actual')::int as fee_actual_cents,
        sum(l.channel_fee_cents) filter (where l.fee_source = 'estimated')::int as fee_estimated_cents,
        sum(l.ship_cost_cents)::int as ship_cost_cents,
        sum(l.processing_fee_cents)::int as processing_fee_cents,
        sum(l.tax_collected_cents)::int as tax_collected_cents,
        sum(l.tax_owed_cents)::int as tax_owed_cents,
        sum(l.cost_cents)::int as cost_cents,
        count(*) filter (where l.cost_source <> 'unit') as cost_estimated_count,
        sum(l.variance_cents)::int as variance_cents,
        sum(l.profit_cents)::int as profit_cents
      from public.sale_ledger l
      where l.store_id = v_store and l.voided_at is null and l.sold_at >= v_from and l.sold_at < v_to
      group by lower(l.channel)) r), '[]'::jsonb),
    'refunds', coalesce((select jsonb_agg(r) from (
      select lower(l.channel) as channel, count(*) as count,
        sum(l.price_cents)::int as sales_cents, sum(l.profit_cents)::int as profit_reversed_cents
      from public.sale_ledger l
      where l.store_id = v_store and l.voided_at is not null and l.voided_at >= v_from and l.voided_at < v_to
      group by lower(l.channel)) r), '[]'::jsonb),
    'expenses', coalesce((select jsonb_agg(jsonb_build_object('category', e.category, 'cents', e.cents) order by e.cents desc) from (
      select e.category, sum(e.amount_cents)::int cents from public.portal_expenses e
      where e.store_id = v_store and e.voided_at is null and e.spent_on >= p_start and e.spent_on < p_end
      group by e.category) e), '[]'::jsonb),
    'expense_cents', coalesce((select sum(e.amount_cents) from public.portal_expenses e
      where e.store_id = v_store and e.voided_at is null and e.spent_on >= p_start and e.spent_on < p_end), 0)::int,
    'label_expense_cents', coalesce((select sum(e.amount_cents) from public.portal_expenses e
      where e.store_id = v_store and e.voided_at is null and e.source in ('label','manual_label')
        and e.spent_on >= p_start and e.spent_on < p_end), 0)::int
  );
end $$;
revoke all on function public.portal_channel_report(date, date) from public, anon;
grant execute on function public.portal_channel_report(date, date) to authenticated;

-- ── Ledger settings editor (Admin → Payout Settings) ───────────────────────

create or replace function public.portal_ledger_config()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return jsonb_build_object(
    'channel_fee_rates', public.store_setting(v_store, 'channel_fee_rates', '{}'::jsonb),
    'cost_defaults', public.store_setting(v_store, 'cost_defaults', '{}'::jsonb),
    'tax_remitted_channels', public.store_setting(v_store, 'tax_remitted_channels', '[]'::jsonb),
    'marketplace_channels', public.store_setting(v_store, 'marketplace_channels', '[]'::jsonb));
end $$;
revoke all on function public.portal_ledger_config() from public, anon;
grant execute on function public.portal_ledger_config() to authenticated;

create or replace function public.portal_set_channel_fee_rate(p_channel text, p_pct numeric, p_fixed_cents int, p_min_fee_cents int default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id(); v_rates jsonb; v_key text;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  v_key := lower(btrim(coalesce(p_channel, '')));
  if v_key !~ '^[a-z][a-z0-9_]{0,39}$' then raise exception 'invalid_channel'; end if;
  if p_pct is null or p_pct < 0 or p_pct >= 100 then raise exception 'percent_0_to_100_required' using errcode = '22023'; end if;
  v_rates := coalesce(public.store_setting(v_store, 'channel_fee_rates', '{}'::jsonb), '{}'::jsonb);
  v_rates := v_rates || jsonb_build_object(v_key, jsonb_strip_nulls(jsonb_build_object(
    'pct', p_pct, 'fixed_cents', coalesce(p_fixed_cents, 0), 'min_fee_cents', p_min_fee_cents)));
  insert into public.store_settings (store_id, key, value) values (v_store, 'channel_fee_rates', v_rates)
  on conflict (store_id, key) do update set value = excluded.value;
end $$;

create or replace function public.portal_delete_channel_fee_rate(p_channel text)
returns void language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id(); v_rates jsonb;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  v_rates := coalesce(public.store_setting(v_store, 'channel_fee_rates', '{}'::jsonb), '{}'::jsonb) - lower(btrim(p_channel));
  insert into public.store_settings (store_id, key, value) values (v_store, 'channel_fee_rates', v_rates)
  on conflict (store_id, key) do update set value = excluded.value;
end $$;

create or replace function public.portal_set_cost_default(p_category text, p_cents int)
returns void language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id(); v_map jsonb; v_key text;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  v_key := lower(btrim(coalesce(p_category, '')));
  if v_key !~ '^[a-z][a-z0-9_ ]{0,39}$' then raise exception 'invalid_category'; end if;
  if p_cents is null or p_cents < 0 then raise exception 'cost_must_not_be_negative' using errcode = '22023'; end if;
  v_map := coalesce(public.store_setting(v_store, 'cost_defaults', '{}'::jsonb), '{}'::jsonb) || jsonb_build_object(v_key, p_cents);
  insert into public.store_settings (store_id, key, value) values (v_store, 'cost_defaults', v_map)
  on conflict (store_id, key) do update set value = excluded.value;
end $$;

create or replace function public.portal_delete_cost_default(p_category text)
returns void language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id(); v_map jsonb;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  v_map := coalesce(public.store_setting(v_store, 'cost_defaults', '{}'::jsonb), '{}'::jsonb) - lower(btrim(p_category));
  insert into public.store_settings (store_id, key, value) values (v_store, 'cost_defaults', v_map)
  on conflict (store_id, key) do update set value = excluded.value;
end $$;

create or replace function public.portal_set_tax_remitted(p_channel text, p_remitted boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id(); v_list jsonb; v_key text;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  v_key := lower(btrim(coalesce(p_channel, '')));
  v_list := coalesce(public.store_setting(v_store, 'tax_remitted_channels', '[]'::jsonb), '[]'::jsonb);
  if p_remitted then
    if not exists (select 1 from jsonb_array_elements_text(v_list) x where x = v_key) then
      v_list := v_list || to_jsonb(v_key);
    end if;
  else
    v_list := coalesce((select jsonb_agg(x) from jsonb_array_elements_text(v_list) x where x <> v_key), '[]'::jsonb);
  end if;
  insert into public.store_settings (store_id, key, value) values (v_store, 'tax_remitted_channels', v_list)
  on conflict (store_id, key) do update set value = excluded.value;
end $$;

revoke all on function public.portal_set_channel_fee_rate(text, numeric, int, int),
  public.portal_delete_channel_fee_rate(text), public.portal_set_cost_default(text, int),
  public.portal_delete_cost_default(text), public.portal_set_tax_remitted(text, boolean)
  from public, anon;
grant execute on function public.portal_set_channel_fee_rate(text, numeric, int, int),
  public.portal_delete_channel_fee_rate(text), public.portal_set_cost_default(text, int),
  public.portal_delete_cost_default(text), public.portal_set_tax_remitted(text, boolean)
  to authenticated;

-- ── Payout rules: in-store is percent of PROFIT — owner 20%, Jacob 10% ─────

insert into public.portal_payout_rules (store_id, employee_id, method, rate, updated_by)
select st.store_id, st.user_id, 'percent_profit', 20, st.user_id
from public.staff st
where st.role = 'owner' and st.deactivated_at is null
on conflict (store_id, employee_id) do update set method = 'percent_profit', rate = 20, updated_at = now();

insert into public.portal_payout_rules (store_id, employee_id, method, rate, updated_by)
select st.store_id, st.user_id, 'percent_profit', 10, st.user_id
from public.staff st
where lower(st.display_name) like 'jacob%' and st.deactivated_at is null
on conflict (store_id, employee_id) do update set method = 'percent_profit', rate = 10, updated_at = now();

commit;
