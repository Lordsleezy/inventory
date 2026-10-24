-- Live Sales → Cancelled/refunded: voided ledger rows for a date range (by voided_at).

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

revoke all on function public.portal_voided_sales(timestamptz, timestamptz) from public, anon;
grant execute on function public.portal_voided_sales(timestamptz, timestamptz) to authenticated;