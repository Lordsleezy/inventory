create or replace function public.portal_online_channel_counts()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_store uuid := public.portal_store_id();
  v_channels text[] := array['ebay', 'depop', 'whatnot', 'mercari', 'amazon', 'facebook'];
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

  -- Also count Amazon live SKUs not already in listings
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