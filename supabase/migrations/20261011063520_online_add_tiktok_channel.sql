-- Add TikTok to Online channel arrays.
create or replace function public.portal_online_channel_counts()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_store uuid := public.portal_store_id();
  v_channels text[] := array['ebay', 'depop', 'whatnot', 'mercari', 'amazon', 'tiktok', 'facebook'];
  v_counts jsonb;
  v_unique int;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;

  select coalesce(jsonb_object_agg(c.channel, c.n), '{}'::jsonb)
  into v_counts
  from (
    select ch.channel,
      case
        when ch.channel = 'amazon' then greatest(
          coalesce((
            select count(*)::int from public.listings l
            where l.store_id = v_store and l.status = 'listed' and lower(l.channel) = 'amazon'
          ), 0),
          coalesce((
            select count(*)::int from public.amazon_list_items a
            where a.store_id = v_store and a.status = 'live'
          ), 0)
        )
        else coalesce((
          select count(*)::int from public.listings l
          where l.store_id = v_store
            and l.status = 'listed'
            and lower(l.channel) = ch.channel
        ), 0)
      end as n
    from unnest(v_channels) as ch(channel)
  ) c;

  select count(distinct l.sku)::int into v_unique
  from public.listings l
  where l.store_id = v_store
    and l.status = 'listed'
    and lower(l.channel) = any (v_channels);

  v_unique := v_unique + coalesce((
    select count(*)::int from public.amazon_list_items a
    where a.store_id = v_store and a.status = 'live'
      and not exists (
        select 1 from public.listings l
        where l.store_id = a.store_id and l.sku = a.sku and l.status = 'listed'
          and lower(l.channel) = any (v_channels)
      )
  ), 0);

  return v_counts || jsonb_build_object('listed_unique', v_unique);
end $$;

revoke all on function public.portal_online_channel_counts() from public, anon;
grant execute on function public.portal_online_channel_counts() to authenticated;

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

create or replace function public.portal_online_sold(p_limit int default 500)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_store uuid := public.portal_store_id();
  v_online text[] := array[
    'ebay', 'depop', 'whatnot', 'mercari', 'amazon', 'tiktok', 'facebook',
    'website', 'web', 'vendoo', 'offerup', 'craigslist', 'etsy', 'poshmark'
  ];
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;

  return coalesce((
    select jsonb_agg(x order by x->>'sold_at' desc)
    from (
      select jsonb_build_object(
        'sku', u.sku,
        'title', coalesce(nullif(btrim(u.title), ''), nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), 'Item'),
        'brand', u.brand,
        'model', u.model,
        'state', u.state,
        'ask_cents', u.ask_cents,
        'listed_on', to_jsonb(coalesce(u.listed_on, '{}'::text[])),
        'sold_at', s.sold_at,
        'sold_channel', lower(coalesce(s.channel, 'unknown')),
        'sold_price_cents', s.price_cents,
        'qty', 1,
        'is_lot', false
      ) as x
      from public.units u
      join lateral (
        select ss.sold_at, ss.channel, ss.price_cents
        from public.sales ss
        where ss.store_id = u.store_id and ss.sku = u.sku
          and ss.voided_at is null
        order by ss.sold_at desc nulls last
        limit 1
      ) s on true
      where u.store_id = v_store
        and u.state = 'sold'
        and lower(coalesce(nullif(btrim(s.channel), ''), '')) = any (v_online)
      order by s.sold_at desc nulls last
      limit greatest(coalesce(p_limit, 500), 1)
    ) q
  ), '[]'::jsonb);
end $$;

revoke all on function public.portal_online_sold(int) from public, anon;
grant execute on function public.portal_online_sold(int) to authenticated;

-- Board: only the channel array needs TikTok; reuse body via replace of declare line.
-- Full replace of portal_online_board with tiktok in v_channels:
do $patch$
declare
  v_def text;
begin
  select pg_get_functiondef(oid) into v_def from pg_proc where proname = 'portal_online_board' and pronamespace = 'public'::regnamespace;
  v_def := replace(
    v_def,
    $$array['ebay', 'depop', 'whatnot', 'mercari', 'amazon', 'facebook']$$,
    $$array['ebay', 'depop', 'whatnot', 'mercari', 'amazon', 'tiktok', 'facebook']$$
  );
  execute v_def;
end $patch$;