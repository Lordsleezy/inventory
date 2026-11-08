-- Sales tax: a void is not a refund. Voided sales drop out of the month
-- entirely. The refund rows are return_refunds on a sale that still stands.

create or replace function public.portal_tax_report(p_month date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_from timestamptz; v_to timestamptz;
  v_month_start date; v_month_end date;
  v_origin text;
  v_channels text[];
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  v_from := (date_trunc('month', p_month)::timestamp) at time zone 'America/Los_Angeles';
  v_to := ((date_trunc('month', p_month) + interval '1 month')::timestamp) at time zone 'America/Los_Angeles';
  v_month_start := date_trunc('month', p_month)::date;
  v_month_end := (date_trunc('month', p_month) + interval '1 month')::date;
  v_origin := upper(coalesce(nullif(btrim(public.store_setting(v_store,'tax_origin_state','"CA"'::jsonb) #>> '{}'),''),'CA'));
  v_channels := public.setting_text_array(v_store,'online_channels');
  return jsonb_build_object('month', to_char(date_trunc('month', p_month), 'YYYY-MM'), 'origin_state', v_origin,
    'rows', coalesce((select jsonb_agg(r order by r.sort) from (
      with refunded as (
        select ret.sale_id, f.amount_cents
        from public.return_refunds f
        join public.returns ret on ret.id = f.return_id and ret.store_id = v_store
        where f.store_id = v_store
          and f.refunded_on >= v_month_start
          and f.refunded_on < v_month_end
      ),
      classified as (
        select l.id, l.price_cents, l.tax_cents, l.tax_collected_cents,
          coalesce(l.shipping_cents, 0) as shipping_cents, l.sold_at, l.voided_at,
          case
            when l.tax_remitted_by = 'marketplace' then 'marketplace_remitted'
            when o.id is null and lower(l.channel) = any (v_channels) then 'other_online'
            when o.id is null then 'in_store'
            when o.fulfillment = 'pickup' then 'pickup'
            when upper(coalesce(o.ship_region, '')) = v_origin then 'ship_in_state'
            else 'ship_out_of_state' end as cat
        from public.sale_ledger l
        left join lateral (
          select * from public.web_orders w where w.sale_id = l.id order by w.created_at limit 1
        ) o on true
        where l.store_id = v_store
          and l.voided_at is null
          and (
            (l.sold_at >= v_from and l.sold_at < v_to)
            or l.id in (select sale_id from refunded where sale_id is not null)
          )
      ),
      sales as (
        select c.cat,
          count(*) as sales_count,
          coalesce(sum(c.price_cents), 0) as sales_cents,
          coalesce(sum(c.price_cents) filter (where c.tax_cents > 0), 0) as taxable_cents,
          coalesce(sum(c.tax_cents), 0) as tax_cents,
          coalesce(sum(c.tax_collected_cents), 0) as tax_collected_cents,
          coalesce(sum(c.shipping_cents), 0) as shipping_cents
        from classified c
        where c.sold_at >= v_from and c.sold_at < v_to
        group by c.cat
      ),
      refs as (
        select c.cat,
          count(*) as refund_count,
          coalesce(sum(f.amount_cents), 0) as refund_sales_cents
        from refunded f
        join classified c on c.id = f.sale_id
        group by c.cat
      )
      select coalesce(s.cat, r.cat) as category,
        case coalesce(s.cat, r.cat)
          when 'in_store' then 1 when 'pickup' then 2 when 'ship_in_state' then 3
          when 'ship_out_of_state' then 4 when 'other_online' then 5 else 6 end as sort,
        coalesce(s.sales_count, 0) as sales_count,
        coalesce(s.sales_cents, 0) as sales_cents,
        coalesce(s.taxable_cents, 0) as taxable_cents,
        coalesce(s.tax_cents, 0) as tax_cents,
        coalesce(s.tax_collected_cents, 0) as tax_collected_cents,
        coalesce(s.shipping_cents, 0) as shipping_cents,
        coalesce(r.refund_count, 0) as refund_count,
        coalesce(r.refund_sales_cents, 0) as refund_sales_cents,
        0 as refund_taxable_cents,
        0 as refund_tax_cents,
        0 as refund_shipping_cents
      from sales s
      full outer join refs r on r.cat = s.cat
    ) r), '[]'::jsonb));
end $$;
