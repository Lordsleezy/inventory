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
  v_channels text[] := array['ebay', 'depop', 'whatnot', 'mercari', 'amazon', 'tiktok', 'facebook'];
  v_online_sold text[] := array[
    'ebay', 'depop', 'whatnot', 'mercari', 'amazon', 'tiktok', 'facebook',
    'website', 'web', 'vendoo', 'offerup', 'craigslist', 'etsy', 'poshmark'
  ];
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;

  v_month_start := date_trunc('month', now() at time zone v_tz) at time zone v_tz;
  v_month_end := (date_trunc('month', now() at time zone v_tz) + interval '1 month') at time zone v_tz;

  return jsonb_build_object(
    'month_start', v_month_start,
    'month_end', v_month_end,
    'month_label', to_char(now() at time zone v_tz, 'FMMonth YYYY'),
    -- Per-platform rows that reconcile: put_up ≈ live_now + ended (same listed_at month cohort)
    'by_platform', coalesce((
      select jsonb_agg(jsonb_build_object(
        'channel', p.channel,
        'live_now', p.live_now,
        'put_up', p.put_up,
        'sold', p.sold,
        'ended', p.ended,
        'sold_cents', p.sold_cents
      ) order by p.channel)
      from (
        select ch.channel,
          coalesce((
            select count(*)::int from public.listings l
            where l.store_id = v_store and l.status = 'listed' and lower(l.channel) = ch.channel
          ), 0) as live_now,
          coalesce((
            select count(*)::int from public.listings l
            where l.store_id = v_store and lower(l.channel) = ch.channel
              and l.listed_at is not null
              and l.listed_at >= v_month_start and l.listed_at < v_month_end
          ), 0) as put_up,
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
          ), 0) as sold_cents,
          coalesce((
            select count(*)::int from public.listings l
            where l.store_id = v_store and lower(l.channel) = ch.channel
              and l.status = 'delisted'
              and l.listed_at is not null
              and l.listed_at >= v_month_start and l.listed_at < v_month_end
          ), 0) as ended
        from unnest(v_channels) as ch(channel)
      ) p
    ), '[]'::jsonb),
    -- Legacy keys kept for older UI; totals use reconciled definitions
    'listed_this_month', coalesce((
      select jsonb_agg(jsonb_build_object('channel', x.channel, 'count', x.put_up) order by x.channel)
      from jsonb_to_recordset(
        (select coalesce(jsonb_agg(jsonb_build_object('channel', ch.channel,
          'put_up', coalesce((select count(*)::int from public.listings l
            where l.store_id = v_store and lower(l.channel) = ch.channel
              and l.listed_at >= v_month_start and l.listed_at < v_month_end), 0)
        )), '[]'::jsonb)
        from unnest(v_channels) as ch(channel))
      ) as x(channel text, put_up int)
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
    'listed_total_this_month', (
      select count(*)::int from public.listings l
      where l.store_id = v_store
        and lower(l.channel) = any (v_channels)
        and l.listed_at is not null
        and l.listed_at >= v_month_start and l.listed_at < v_month_end
    ),
    'ended_total_this_month', (
      select count(*)::int from public.listings l
      where l.store_id = v_store
        and lower(l.channel) = any (v_channels)
        and l.status = 'delisted'
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