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
            join public.units u on u.store_id = l.store_id and u.sku = l.sku
            where l.store_id = v_store and l.status = 'listed' and lower(l.channel) = 'amazon'
              and u.state in ('available', 'reserved', 'repair')
          ), 0),
          coalesce((
            select count(*)::int from public.amazon_list_items a
            join public.units u on u.store_id = a.store_id and u.sku = a.sku
            where a.store_id = v_store and a.status = 'live'
              and u.state in ('available', 'reserved', 'repair')
          ), 0)
        )
        else coalesce((
          select count(*)::int from public.listings l
          join public.units u on u.store_id = l.store_id and u.sku = l.sku
          where l.store_id = v_store
            and l.status = 'listed'
            and lower(l.channel) = ch.channel
            and u.state in ('available', 'reserved', 'repair')
        ), 0)
      end as n
    from unnest(v_channels) as ch(channel)
  ) c;

  select count(distinct l.sku)::int into v_unique
  from public.listings l
  join public.units u on u.store_id = l.store_id and u.sku = l.sku
  where l.store_id = v_store
    and l.status = 'listed'
    and lower(l.channel) = any (v_channels)
    and u.state in ('available', 'reserved', 'repair');

  v_unique := v_unique + coalesce((
    select count(*)::int from public.amazon_list_items a
    join public.units u on u.store_id = a.store_id and u.sku = a.sku
    where a.store_id = v_store and a.status = 'live'
      and u.state in ('available', 'reserved', 'repair')
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

do $patch$
declare
  def text;
  old_board text := $old$
        and coalesce(cardinality(d.online_on), 0) > 0
        and (not d.is_lot or d.qty > 0)
$old$;
  new_board text := $new$
        and coalesce(cardinality(d.online_on), 0) > 0
        and (not d.is_lot or d.qty > 0)
        and (d.is_lot or d.state in ('available', 'reserved', 'repair'))
$new$;
  old_report_channel text := $old$select count(*)::int from public.listings l
              where l.store_id = v_store and l.status = 'listed' and lower(l.channel) = ch.channel$old$;
  new_report_channel text := $new$select count(*)::int from public.listings l
              join public.units u on u.store_id = l.store_id and u.sku = l.sku
              where l.store_id = v_store and l.status = 'listed' and lower(l.channel) = ch.channel
                and u.state in ('available', 'reserved', 'repair')$new$;
  old_report_total text := $old$select count(*)::int from public.listings l
        where l.store_id = v_store and l.status = 'listed'
          and lower(l.channel) = any (v_list_channels)$old$;
  new_report_total text := $new$select count(*)::int from public.listings l
        join public.units u on u.store_id = l.store_id and u.sku = l.sku
        where l.store_id = v_store and l.status = 'listed'
          and lower(l.channel) = any (v_list_channels)
          and u.state in ('available', 'reserved', 'repair')$new$;
begin
  select pg_get_functiondef('public.portal_online_board()'::regprocedure) into def;
  if position(old_board in def) = 0 then
    raise exception 'portal_online_board listed filter not found';
  end if;
  execute replace(def, old_board, new_board);

  select pg_get_functiondef('public.portal_online_report(integer, integer)'::regprocedure) into def;
  if position(old_report_channel in def) = 0 then
    raise exception 'portal_online_report channel listed count not found';
  end if;
  if position(old_report_total in def) = 0 then
    raise exception 'portal_online_report total listed count not found';
  end if;
  execute replace(replace(def, old_report_channel, new_report_channel), old_report_total, new_report_total);
end
$patch$;