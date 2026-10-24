begin;
alter table public.units add column if not exists internal_category text;
update public.units set internal_category = nullif(btrim(category),'')
where internal_category is null;
create index if not exists units_internal_category_idx on public.units(store_id,internal_category);

create table if not exists public.census_ecommerce_quarters (
  year int not null,
  quarter int not null check (quarter between 1 and 4),
  not_adjusted_millions numeric not null check (not_adjusted_millions > 0),
  source_url text not null,
  fetched_at timestamptz not null default now(),
  primary key(year,quarter)
);
alter table public.census_ecommerce_quarters enable row level security;
create policy census_quarters_read on public.census_ecommerce_quarters
  for select to authenticated using (true);
revoke all on public.census_ecommerce_quarters from public,anon,authenticated;
grant select on public.census_ecommerce_quarters to authenticated;
grant all on public.census_ecommerce_quarters to service_role;
-- Seed the latest complete years so projections have a seasonal shape before
-- the first monthly sync. Values are Census not-adjusted sales ($ millions).
insert into public.census_ecommerce_quarters
  (year,quarter,not_adjusted_millions,source_url)
values
  (2025,1,275715,'https://www.census.gov/retail/mrts/www/data/delimited/tsnadprectbl3.dat'),
  (2025,2,293140,'https://www.census.gov/retail/mrts/www/data/delimited/tsnadprectbl3.dat'),
  (2025,3,299717,'https://www.census.gov/retail/mrts/www/data/delimited/tsnadprectbl3.dat'),
  (2025,4,365160,'https://www.census.gov/retail/mrts/www/data/delimited/tsnadprectbl3.dat'),
  (2024,1,261108,'https://www.census.gov/retail/mrts/www/data/delimited/tsnadprectbl3.dat'),
  (2024,2,278255,'https://www.census.gov/retail/mrts/www/data/delimited/tsnadprectbl3.dat'),
  (2024,3,284795,'https://www.census.gov/retail/mrts/www/data/delimited/tsnadprectbl3.dat'),
  (2024,4,345872,'https://www.census.gov/retail/mrts/www/data/delimited/tsnadprectbl3.dat')
on conflict(year,quarter) do nothing;

create or replace function public.portal_insights(p_period text default 'month')
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null or not public.portal_financial_access() then
    raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if p_period not in ('week','month','quarter') then
    raise exception 'period_invalid' using errcode = '22023'; end if;
  return jsonb_build_object(
    'first_sale_on',(select min((sold_at at time zone 'America/Los_Angeles')::date)
      from public.sales where store_id=v_store and voided_at is null),
    'periods',coalesce((select jsonb_agg(to_jsonb(t) order by t.period_start,t.channel)
      from (
        select date_trunc(p_period,l.sold_at at time zone 'America/Los_Angeles')::date period_start,
          lower(l.channel) channel,
          coalesce(sum(l.price_cents+coalesce(l.shipping_cents,0)),0)::bigint sales_cents,
          coalesce(sum(l.profit_cents),0)::bigint profit_cents,
          count(*)::int units_sold
        from public.sale_ledger l
        where l.store_id=v_store and l.voided_at is null
          and l.sold_at>=now()-interval '2 years'
        group by 1,2
      ) t),'[]'::jsonb),
    'categories',coalesce((select jsonb_agg(to_jsonb(c) order by c.sold_units desc,c.category)
      from (
        select coalesce(nullif(btrim(u.internal_category),''),'Uncategorized') category,
          count(*)::int received_units,
          coalesce(sum(u.qty_on_hand),0)::int stock_units,
          coalesce(sum(s.qty),0)::int sold_units,
          coalesce(sum(s.sales_cents),0)::bigint revenue_cents,
          coalesce(sum(s.profit_cents),0)::bigint profit_cents,
          round(avg(s.days_to_sell)::numeric,1) avg_days_to_sell
        from public.units u
        left join lateral (
          select sum(l.qty)::int qty,
            sum(l.price_cents+coalesce(l.shipping_cents,0))::bigint sales_cents,
            sum(l.profit_cents)::bigint profit_cents,
            avg(extract(epoch from (l.sold_at-u.received_at))/86400) days_to_sell
          from public.sale_ledger l where l.store_id=u.store_id and l.sku=u.sku
            and l.voided_at is null
        ) s on true
        where u.store_id=v_store and u.state<>'voided'
        group by 1
      ) c),'[]'::jsonb),
    'aging',coalesce((select jsonb_build_object(
      'days_30',count(*) filter(where now()-u.received_at>=interval '30 days'
        and now()-u.received_at<interval '60 days'),
      'days_60',count(*) filter(where now()-u.received_at>=interval '60 days'
        and now()-u.received_at<interval '90 days'),
      'days_90_plus',count(*) filter(where now()-u.received_at>=interval '90 days')
    ) from public.units u where u.store_id=v_store
      and u.state in ('available','reserved','repair') and u.qty_on_hand>0),'{}'::jsonb)
  );
end $$;
revoke all on function public.portal_insights(text) from public,anon;
grant execute on function public.portal_insights(text) to authenticated,service_role;
commit;
