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
      coalesce(st.display_name, case
        when s.channel = 'website' then 'Website ' || coalesce((select o.order_no || ' · ' || o.fulfillment from public.web_orders o where o.sale_id = s.id limit 1), 'order')
        when s.channel = 'ebay' then 'eBay'
        when s.channel is not null and s.channel <> 'floor' then initcap(replace(s.channel, '_', ' '))
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