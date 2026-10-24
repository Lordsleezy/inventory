drop function if exists public.portal_payout_sales();
create function public.portal_payout_sales()
returns table (
  id bigint, ticket_key text, sku text, title text, qty int, sold_at timestamptz,
  price_cents int, tax_cents int, card_fee_cents int, cost_cents int,
  payment_method text, cash_cents int, card_cents int, actor_id uuid,
  actor_name text, channel text, receipt_no text,
  ebay_fee_cents int, baked_ship_cents int,
  marketplace_fee_cents int, shipping_cost_cents int,
  cost_source text, is_collectible boolean, tax_remitted_by text,
  order_no text, voided boolean
) language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return query
    select s.id, coalesce(s.ticket_id::text, 'sale:' || s.id::text), s.sku,
      coalesce(nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), nullif(u.title, ''), 'Item')::text,
      s.qty, s.sold_at, s.price_cents, s.tax_cents, s.card_fee_cents,
      lc.cost_cents, s.payment_method, x.cash_cents, x.card_cents,
      s.actor_id,
      coalesce(st.display_name,
        case when s.channel = 'website' then 'Website' when s.channel = 'ebay' then 'eBay'
          when s.channel is not null and s.channel <> 'floor' then initcap(replace(s.channel, '_', ' ')) else 'Unknown' end)::text,
      s.channel, s.receipt_no,
      coalesce(co.fee_cents, 0), coalesce(co.baked_ship_cents, 0),
      coalesce(co.fee_cents, wo.marketplace_fee_cents, 0),
      coalesce(wo.label_cost_cents, co.baked_ship_cents, 0),
      lc.cost_source, lc.is_collectible,
      coalesce(wo.tax_remitted_by,
        case when s.channel in ('ebay','amazon','tiktok','mercari','depop','whatnot','facebook','poshmark','etsy') then 'marketplace'
          when s.channel = 'website' then 'store' when s.channel = 'floor' or s.channel is null then 'store' else 'marketplace' end),
      coalesce(wo.order_no, co.order_id), (s.voided_at is not null)
    from public.sales s
    left join public.units u on u.store_id = s.store_id and u.sku = s.sku
    left join lateral public.unit_ledger_cost(s.store_id, s.sku) lc on true
    left join public.staff st on st.store_id = s.store_id and st.user_id = s.actor_id
    left join public.ticket_extras x on x.store_id = s.store_id and x.ticket_id = s.ticket_id
    left join public.channel_orders co on co.sale_id = s.id
    left join public.web_orders wo on wo.sale_id = s.id
    where s.store_id = v_store and s.voided_at is null
    order by s.id;
end $$;
revoke all on function public.portal_payout_sales() from public, anon;
grant execute on function public.portal_payout_sales() to authenticated;

drop function if exists public.portal_ledger_sales(timestamptz, timestamptz);
create function public.portal_ledger_sales(p_from timestamptz, p_to timestamptz)
returns table (
  id bigint, ticket_key text, sku text, title text, qty int, sold_at timestamptz,
  price_cents int, tax_cents int, card_fee_cents int, cost_cents int,
  payment_method text, cash_cents int, card_cents int, actor_id uuid,
  actor_name text, channel text, receipt_no text,
  marketplace_fee_cents int, shipping_cost_cents int,
  cost_source text, is_collectible boolean, tax_remitted_by text, order_no text
) language plpgsql stable security definer set search_path = public as $$
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
      lc.cost_cents, s.payment_method, x.cash_cents, x.card_cents,
      s.actor_id,
      coalesce(st.display_name,
        case when s.channel = 'website' then 'Website' when s.channel = 'ebay' then 'eBay'
          when s.channel is not null and s.channel <> 'floor' then initcap(replace(s.channel, '_', ' ')) else 'Unknown' end)::text,
      s.channel, s.receipt_no,
      coalesce(co.fee_cents, wo.marketplace_fee_cents, 0),
      coalesce(wo.label_cost_cents, co.baked_ship_cents, 0),
      lc.cost_source, lc.is_collectible,
      coalesce(wo.tax_remitted_by,
        case when s.channel in ('ebay','amazon','tiktok','mercari','depop','whatnot','facebook','poshmark','etsy') then 'marketplace'
          when s.channel = 'website' then 'store' when s.channel = 'floor' or s.channel is null then 'store' else 'marketplace' end),
      coalesce(wo.order_no, co.order_id)
    from public.sales s
    left join public.units u on u.store_id = s.store_id and u.sku = s.sku
    left join lateral public.unit_ledger_cost(s.store_id, s.sku) lc on true
    left join public.staff st on st.store_id = s.store_id and st.user_id = s.actor_id
    left join public.ticket_extras x on x.store_id = s.store_id and x.ticket_id = s.ticket_id
    left join public.channel_orders co on co.sale_id = s.id
    left join public.web_orders wo on wo.sale_id = s.id
    where s.store_id = v_store and s.voided_at is null and s.sold_at >= p_from and s.sold_at < p_to
    order by s.sold_at desc, s.id desc;
end $$;
revoke all on function public.portal_ledger_sales(timestamptz, timestamptz) from public, anon;
grant execute on function public.portal_ledger_sales(timestamptz, timestamptz) to authenticated;