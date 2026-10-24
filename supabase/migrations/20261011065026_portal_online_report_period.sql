drop function if exists public.portal_online_report();

create or replace function public.portal_online_report(
  p_year int default null,
  p_month int default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_store uuid := public.portal_store_id();
  v_tz text := 'America/Los_Angeles';
  v_month_start timestamptz;
  v_month_end timestamptz;
  v_all_time boolean := (p_year is null or p_month is null);
  v_label text;
  v_channels text[] := array['ebay', 'depop', 'whatnot', 'mercari', 'amazon', 'tiktok', 'facebook'];
  v_online_sold text[] := array[
    'ebay', 'depop', 'whatnot', 'mercari', 'amazon', 'tiktok', 'facebook',
    'website', 'web', 'vendoo', 'offerup', 'craigslist', 'etsy', 'poshmark'
  ];
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;

  if v_all_time then
    v_month_start := timestamptz '1970-01-01';
    v_month_end := timestamptz '2100-01-01';
    v_label := 'All time';
  else
    if p_month < 1 or p_month > 12 then
      raise exception 'invalid_month' using errcode = '22023';
    end if;
    v_month_start := make_timestamptz(p_year, p_month, 1, 0, 0, 0, v_tz);
    v_month_end := v_month_start + interval '1 month';
    v_label := to_char(v_month_start at time zone v_tz, 'FMMonth YYYY');
  end if;

  return jsonb_build_object(
    'all_time', v_all_time,
    'year', p_year,
    'month', p_month,
    'month_start', v_month_start,
    'month_end', v_month_end,
    'month_label', v_label,
    'by_platform', coalesce((
      select jsonb_agg(jsonb_build_object(
        'channel', p.channel,
        'listed', p.listed,
        'sold', p.sold,
        'sold_cents', p.sold_cents
      ) order by p.channel)
      from (
        select ch.channel,
          coalesce((
            select count(*)::int from public.listings l
            where l.store_id = v_store and l.status = 'listed' and lower(l.channel) = ch.channel
          ), 0) as listed,
          coalesce((
            select count(*)::int from public.sales s
            where s.store_id = v_store and s.voided_at is null
              and lower(coalesce(nullif(btrim(s.channel), ''), '')) = ch.channel
              and s.sold_at >= v_month_start and s.sold_at < v_month_end
          ), 0) as sold,
          coalesce((
            select coalesce(sum(s.price_cents), 0)::bigint from public.sales s
            where s.store_id = v_store and s.voided_at is null
              and lower(coalesce(nullif(btrim(s.channel), ''), '')) = ch.channel
              and s.sold_at >= v_month_start and s.sold_at < v_month_end
          ), 0) as sold_cents
        from unnest(v_channels) as ch(channel)
      ) p
    ), '[]'::jsonb),
    'sold_this_month', coalesce((
      select jsonb_agg(jsonb_build_object(
        'channel', c.channel, 'count', c.n, 'cents', c.cents
      ) order by c.n desc, c.channel)
      from (
        select lower(coalesce(nullif(btrim(s.channel), ''), 'unknown')) as channel,
          count(*)::int as n,
          coalesce(sum(s.price_cents), 0)::bigint as cents
        from public.sales s
        where s.store_id = v_store and s.voided_at is null
          and s.sold_at >= v_month_start and s.sold_at < v_month_end
          and lower(coalesce(nullif(btrim(s.channel), ''), '')) = any (v_online_sold)
        group by 1
      ) c
    ), '[]'::jsonb),
    'currently_listed', coalesce((
      select jsonb_agg(jsonb_build_object('channel', c.channel, 'count', c.n) order by c.channel)
      from (
        select lower(l.channel) as channel, count(*)::int as n
        from public.listings l
        where l.store_id = v_store and l.status = 'listed'
          and lower(l.channel) = any (v_channels)
        group by 1
      ) c
    ), '[]'::jsonb),
    'sold_total_this_month', (
      select count(*)::int from public.sales s
      where s.store_id = v_store and s.voided_at is null
        and s.sold_at >= v_month_start and s.sold_at < v_month_end
        and lower(coalesce(nullif(btrim(s.channel), ''), '')) = any (v_online_sold)
    ),
    'sold_cents_total', (
      select coalesce(sum(s.price_cents), 0)::bigint from public.sales s
      where s.store_id = v_store and s.voided_at is null
        and s.sold_at >= v_month_start and s.sold_at < v_month_end
        and lower(coalesce(nullif(btrim(s.channel), ''), '')) = any (v_online_sold)
    ),
    'currently_listed_total', (
      select count(*)::int from public.listings l
      where l.store_id = v_store and l.status = 'listed'
        and lower(l.channel) = any (v_channels)
    ),
    -- available years that have online sales (plus current year)
    'available_years', coalesce((
      select jsonb_agg(y order by y desc)
      from (
        select distinct extract(year from s.sold_at at time zone v_tz)::int as y
        from public.sales s
        where s.store_id = v_store and s.voided_at is null
          and lower(coalesce(nullif(btrim(s.channel), ''), '')) = any (v_online_sold)
        union
        select extract(year from now() at time zone v_tz)::int
      ) yrs
    ), '[]'::jsonb)
  );
end $$;

revoke all on function public.portal_online_report(int, int) from public, anon;
grant execute on function public.portal_online_report(int, int) to authenticated;