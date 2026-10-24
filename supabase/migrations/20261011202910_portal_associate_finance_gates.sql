create or replace function public.portal_sales(p_from timestamp with time zone, p_to timestamp with time zone)
returns table (
  id bigint, ticket_key text, sku text, title text, qty integer,
  sold_at timestamp with time zone, price_cents integer, tax_cents integer,
  card_fee_cents integer, cost_cents integer, payment_method text,
  cash_cents integer, card_cents integer, actor_id uuid, actor_name text,
  channel text, receipt_no text, list_price_cents integer,
  override_price_cents integer, override_reason text, override_by_name text,
  ebay_fee_cents integer, baked_ship_cents integer,
  cost_source text, channel_fee_cents integer, fee_source text,
  ship_cost_cents integer, ship_cost_source text,
  processing_fee_cents integer, processing_fee_source text,
  tax_remitted_by text, tax_collected_cents integer, tax_owed_cents integer,
  ask_cents integer, variance_cents integer, profit_cents integer,
  shipping_cents integer
)
language plpgsql stable security definer set search_path to 'public'
as $function$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  perform public.portal_assert_admin();
  if p_from is null or p_to is null or p_to <= p_from or p_to > p_from + interval '93 days' then
    raise exception 'invalid_date_range' using errcode = '22023';
  end if;
  return query
    select s.id, coalesce(s.ticket_id::text, 'sale:' || s.id::text), s.sku,
      coalesce(nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), nullif(u.title, ''), 'Item')::text,
      s.qty, s.sold_at, s.price_cents, s.tax_cents, s.card_fee_cents,
      l.cost_cents, s.payment_method, x.cash_cents, x.card_cents,
      s.actor_id,
      case
        when lower(s.channel) is distinct from 'floor' then 'Online'
        when st.display_name is null or st.display_name in ('Admin', 'service') then 'Unassigned'
        else st.display_name
      end::text,
      s.channel, s.receipt_no,
      s.list_price_cents, s.override_price_cents, s.override_reason,
      coalesce(st_override.display_name, 'Unknown')::text,
      case when lower(s.channel) = 'ebay' then l.channel_fee_cents else 0 end,
      case when lower(s.channel) = 'ebay' then l.ship_cost_cents else 0 end,
      l.cost_source, l.channel_fee_cents, l.fee_source,
      l.ship_cost_cents, l.ship_cost_source,
      l.processing_fee_cents, l.processing_fee_source,
      l.tax_remitted_by, l.tax_collected_cents, l.tax_owed_cents,
      l.ask_cents, l.variance_cents, l.profit_cents,
      coalesce(l.shipping_cents, 0)
    from public.sales s
    join public.sale_ledger l on l.id = s.id
    left join public.units u on u.store_id = s.store_id and u.sku = s.sku
    left join public.staff st on st.store_id = s.store_id and st.user_id = s.actor_id
    left join public.staff st_override on st_override.store_id = s.store_id and st_override.user_id = s.override_by
    left join public.ticket_extras x on x.store_id = s.store_id and x.ticket_id = s.ticket_id
    where s.store_id = v_store and s.voided_at is null and s.sold_at >= p_from and s.sold_at < p_to
    order by s.sold_at desc, s.id desc;
end $function$;

create or replace function public.portal_voided_sales(p_from timestamp with time zone, p_to timestamp with time zone)
returns table (
  id bigint, ticket_key text, sku text, title text, qty integer,
  sold_at timestamp with time zone, voided_at timestamp with time zone,
  void_reason text, price_cents integer, tax_cents integer,
  card_fee_cents integer, cost_cents integer, payment_method text,
  cash_cents integer, card_cents integer, actor_id uuid, actor_name text,
  channel text, receipt_no text,
  channel_fee_cents integer, ship_cost_cents integer,
  processing_fee_cents integer, profit_cents integer,
  shipping_cents integer, order_no text, buyer_name text
)
language plpgsql stable security definer set search_path to 'public'
as $function$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  perform public.portal_assert_admin();
  if p_from is null or p_to is null or p_to <= p_from or p_to > p_from + interval '93 days' then
    raise exception 'invalid_date_range' using errcode = '22023';
  end if;
  return query
    select s.id, coalesce(s.ticket_id::text, 'sale:' || s.id::text), s.sku,
      coalesce(nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), nullif(u.title, ''), 'Item')::text,
      s.qty, s.sold_at, s.voided_at,
      coalesce(nullif(btrim(s.void_reason), ''), wo.cancel_reason, wo.cancel_source, 'Refunded / voided')::text,
      s.price_cents, s.tax_cents, s.card_fee_cents,
      l.cost_cents, s.payment_method, x.cash_cents, x.card_cents,
      s.actor_id,
      coalesce(st.display_name, case when s.channel = 'website'
        then 'Website ' || coalesce((select o.order_no from public.web_orders o where o.sale_id = s.id limit 1), 'order')
        else 'Unknown' end)::text,
      s.channel, s.receipt_no,
      l.channel_fee_cents, l.ship_cost_cents,
      l.processing_fee_cents, l.profit_cents,
      coalesce(l.shipping_cents, 0),
      coalesce(wo.order_no, replace(s.payment_id, 'ebay:', ''), s.receipt_no)::text,
      wo.buyer_name::text
    from public.sales s
    join public.sale_ledger l on l.id = s.id
    left join public.units u on u.store_id = s.store_id and u.sku = s.sku
    left join public.staff st on st.store_id = s.store_id and st.user_id = s.actor_id
    left join public.ticket_extras x on x.store_id = s.store_id and x.ticket_id = s.ticket_id
    left join lateral (
      select w.order_no, w.buyer_name, w.cancel_reason, w.cancel_source
      from public.web_orders w where w.sale_id = s.id order by w.created_at limit 1
    ) wo on true
    where s.store_id = v_store and s.voided_at is not null
      and s.voided_at >= p_from and s.voided_at < p_to
    order by s.voided_at desc, s.id desc;
end $function$;