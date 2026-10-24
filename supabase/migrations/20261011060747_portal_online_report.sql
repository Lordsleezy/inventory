create or replace function public.portal_online_report()
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
  v_channels text[] := array['ebay', 'depop', 'whatnot', 'mercari', 'amazon', 'facebook'];
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;

  v_month_start := date_trunc('month', now() at time zone v_tz) at time zone v_tz;
  v_month_end := (date_trunc('month', now() at time zone v_tz) + interval '1 month') at time zone v_tz;

  return jsonb_build_object(
    'month_start', v_month_start,
    'month_end', v_month_end,
    'month_label', to_char(now() at time zone v_tz, 'FMMonth YYYY'),
    'listed_this_month', coalesce((
      select jsonb_agg(jsonb_build_object('channel', c.channel, 'count', c.n) order by c.channel)
      from (
        select lower(l.channel) as channel, count(*)::int as n
        from public.listings l
        where l.store_id = v_store
          and lower(l.channel) = any (v_channels)
          and l.listed_at is not null
          and l.listed_at >= v_month_start
          and l.listed_at < v_month_end
        group by 1
      ) c
    ), '[]'::jsonb),
    'sold_this_month', coalesce((
      select jsonb_agg(jsonb_build_object(
        'channel', c.channel,
        'count', c.n,
        'cents', c.cents
      ) order by c.n desc, c.channel)
      from (
        select lower(coalesce(nullif(btrim(s.channel), ''), 'unknown')) as channel,
          count(*)::int as n,
          coalesce(sum(s.price_cents), 0)::bigint as cents
        from public.sales s
        where s.store_id = v_store
          and s.sold_at >= v_month_start
          and s.sold_at < v_month_end
        group by 1
      ) c
    ), '[]'::jsonb),
    'currently_listed', coalesce((
      select jsonb_agg(jsonb_build_object('channel', c.channel, 'count', c.n) order by c.channel)
      from (
        select lower(l.channel) as channel, count(*)::int as n
        from public.listings l
        where l.store_id = v_store
          and l.status = 'listed'
          and lower(l.channel) = any (v_channels)
        group by 1
      ) c
    ), '[]'::jsonb),
    'sold_total_this_month', (
      select count(*)::int from public.sales s
      where s.store_id = v_store and s.sold_at >= v_month_start and s.sold_at < v_month_end
    ),
    'listed_total_this_month', (
      select count(*)::int from public.listings l
      where l.store_id = v_store
        and lower(l.channel) = any (v_channels)
        and l.listed_at is not null
        and l.listed_at >= v_month_start and l.listed_at < v_month_end
    ),
    'currently_listed_total', (
      select count(*)::int from public.listings l
      where l.store_id = v_store and l.status = 'listed'
        and lower(l.channel) = any (v_channels)
    )
  );
end $$;

revoke all on function public.portal_online_report() from public, anon;
grant execute on function public.portal_online_report() to authenticated;