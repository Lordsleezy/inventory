insert into public.store_settings (store_id, key, value)
select s.id, 'income_tax_commission_pct', '30'::jsonb
from public.stores s
where not exists (
  select 1 from public.store_settings x
  where x.store_id = s.id and x.key = 'income_tax_commission_pct'
);

create or replace function public.portal_income_tax_pct()
returns numeric language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return coalesce((public.store_setting(v_store, 'income_tax_pct', '25'::jsonb) #>> '{}')::numeric, 25);
end $$;
revoke all on function public.portal_income_tax_pct() from public, anon;
grant execute on function public.portal_income_tax_pct() to authenticated;

create or replace function public.portal_sale_tax_rows(p_start date, p_end date)
returns jsonb
language plpgsql
stable security definer
set search_path = public
as $$
declare
  v_store uuid := public.portal_store_id();
  v_from timestamptz;
  v_to timestamptz;
  v_pct numeric;
  v_comm numeric;
  v_remitted text[];
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  v_from := p_start::timestamp at time zone 'America/Los_Angeles';
  v_to := (p_end + 1)::timestamp at time zone 'America/Los_Angeles';
  v_pct := coalesce((public.store_setting(v_store, 'income_tax_pct', '25'::jsonb) #>> '{}')::numeric, 25);
  v_comm := coalesce((public.store_setting(v_store, 'income_tax_commission_pct', '30'::jsonb) #>> '{}')::numeric, 30);
  v_remitted := public.setting_text_array(v_store, 'tax_remitted_channels');

  return jsonb_build_object(
    'start', p_start,
    'end', p_end,
    'income_tax_pct', v_pct,
    'commission_pct', v_comm,
    'rows', coalesce((
      select jsonb_agg(r order by r.sold_at desc)
      from (
        select
          l.id,
          l.sold_at,
          lower(l.channel) as channel,
          l.sku,
          coalesce(
            nullif(btrim(concat_ws(' ', u.brand, u.model)), ''),
            nullif(btrim(u.title), ''),
            'SKU ' || l.sku
          ) as title,
          l.price_cents,
          coalesce(l.shipping_cents, 0) as shipping_cents,
          coalesce(l.cost_cents, 0) as cost_cents,
          coalesce(l.channel_fee_cents, 0) as fee_cents,
          coalesce(l.ship_cost_cents, 0) as label_cents,
          coalesce(l.processing_fee_cents, 0) as processing_cents,
          coalesce(l.profit_cents, 0) as profit_cents,
          greatest(0, round(greatest(coalesce(l.profit_cents, 0), 0) * v_comm / 100.0))::int as commission_cents,
          greatest(0, coalesce(l.profit_cents, 0)
            - greatest(0, round(greatest(coalesce(l.profit_cents, 0), 0) * v_comm / 100.0)))::int as owner_base_cents,
          coalesce(l.tax_cents, 0) as sales_tax_cents,
          case
            when lower(l.channel) = any (v_remitted)
              or coalesce(l.tax_remitted_by, '') = 'marketplace'
              then 'marketplace'
            when coalesce(l.tax_owed_cents, l.tax_cents, 0) > 0 then 'store'
            when coalesce(l.tax_cents, 0) = 0 then 'none'
            else 'store'
          end as sales_tax_who,
          case
            when lower(l.channel) = any (v_remitted)
              or coalesce(l.tax_remitted_by, '') = 'marketplace'
              then 0
            else coalesce(l.tax_owed_cents, l.tax_cents, 0)
          end as sales_tax_owed_cents,
          greatest(0, round(
            greatest(0, coalesce(l.profit_cents, 0)
              - greatest(0, round(greatest(coalesce(l.profit_cents, 0), 0) * v_comm / 100.0))
            ) * v_pct / 100.0
          ))::int as income_tax_cents
        from public.sale_ledger l
        left join public.units u on u.store_id = l.store_id and u.sku = l.sku
        where l.store_id = v_store
          and l.voided_at is null
          and l.sold_at >= v_from and l.sold_at < v_to
      ) r
    ), '[]'::jsonb)
  );
end $$;

-- Stop exposing income tax on Orders cards.
create or replace function public.portal_web_orders(p_days integer default 90)
returns jsonb
language plpgsql
stable security definer
set search_path = public
as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(x order by x.created_at desc) from (
    select o.id, o.order_no, o.sku, o.status, o.fulfillment, o.channel,
      o.buyer_name, o.buyer_email, o.buyer_phone,
      o.ship_line1, o.ship_line2, o.ship_city, o.ship_region, o.ship_postal,
      o.item_cents, o.shipping_cents, o.tax_cents, o.total_cents,
      o.payment_id, o.refund_id, o.payment_env, o.created_at, o.paid_at,
      o.pickup_deadline, o.picked_up_at, o.picked_up_by,
      o.boxed_at, o.shipped_at, o.delivered_at,
      o.tracking_number, o.tracking_url, o.carrier, o.service, o.shipping_rate, o.label_url,
      o.label_purchased_at, o.label_cost_cents, o.refund_requested_at,
      o.cancel_source, o.cancel_reason, o.canceled_at, o.ship_by,
      o.match_status, o.marketplace_fee_cents, o.marketplace_title,
      coalesce(nullif(btrim(o.marketplace_title), ''), nullif(btrim(u.title), ''),
        nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), 'Item') as title,
      coalesce(u.listed_on, '{}'::text[]) as listed_on,
      coalesce(co.fee_cents, o.marketplace_fee_cents, sl.channel_fee_cents) as fee_cents,
      coalesce(
        co.fee_source,
        case
          when co.fee_cents is null and o.marketplace_fee_cents is null and sl.fee_source is not null
            then sl.fee_source
          when co.fee_cents is null and o.marketplace_fee_cents is not null then 'estimated'
          else null
        end
      ) as fee_source,
      sl.cost_cents,
      sl.profit_cents,
      sl.tax_remitted_by,
      coalesce(sl.tax_collected_cents, o.tax_cents, 0) as tax_collected_cents,
      coalesce(sl.tax_owed_cents, 0) as tax_owed_cents,
      case when o.channel = 'ebay' and o.order_no is not null
        then 'https://www.ebay.com/mesh/ord/details?orderid=' || o.order_no
        else null end as marketplace_url,
      jsonb_build_object(
        'length_in', u.package_length_in,
        'width_in', u.package_width_in,
        'height_in', u.package_height_in,
        'weight_lb', u.package_weight_lb
      ) as package
    from public.web_orders o
    left join public.units u on u.store_id = o.store_id and u.sku = o.sku
    left join public.channel_orders co
      on co.store_id = o.store_id and co.provider = o.channel and co.order_id = o.order_no
    left join public.sale_ledger sl on sl.id = o.sale_id
    where o.store_id = v_store
      and o.created_at > now() - make_interval(days => greatest(p_days, 1))
      and (o.status in ('paid', 'refunded') or o.paid_at is not null)
      and coalesce(o.payment_env, 'production') <> 'sandbox'
      and lower(coalesce(o.order_no, '')) not like 'sandbox%'
  ) x), '[]'::jsonb);
end $$;