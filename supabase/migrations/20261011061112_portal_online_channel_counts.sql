-- Active listing counts per channel from listings (matches marketplace "active" counts).
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
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;

  return (
    select coalesce(jsonb_object_agg(c.channel, c.n), '{}'::jsonb)
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
    ) c
  );
end $$;

revoke all on function public.portal_online_channel_counts() from public, anon;
grant execute on function public.portal_online_channel_counts() to authenticated;