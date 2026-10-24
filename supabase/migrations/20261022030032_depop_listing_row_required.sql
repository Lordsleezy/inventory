-- Depop is manual (no listing API). A unit counts as on Depop only when a listings
-- row exists (status=listed). Clear orphaned listed_on checklist flags, and block
-- portal_set_unit_listed_on from adding depop without that row.
-- Historical Vendoo/Mercari labels and sale rows are left alone.

update public.units u
set listed_on = coalesce(
      (select array_agg(c order by c)
         from unnest(u.listed_on) c
        where c is distinct from 'depop'),
      '{}'::text[]
    ),
    updated_at = now()
where u.state = 'available'
  and 'depop' = any (coalesce(u.listed_on, '{}'::text[]))
  and not exists (
    select 1
      from public.listings l
     where l.store_id = u.store_id
       and l.sku = u.sku
       and l.channel = 'depop'
       and l.status = 'listed'
  );

create or replace function public.portal_set_unit_listed_on(p_sku text, p_channels text[])
returns text[] language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_channels text[];
  v_allowed text[];
  v_prev text[];
  v_ch text;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  select coalesce(array_agg(x->>'key'), '{}'::text[]) into v_allowed
    from jsonb_array_elements(public.store_setting(v_store, 'marketplace_channels', '[]'::jsonb)) x
   where x->>'key' not in ('vendoo', 'mercari');
  select coalesce(array_agg(distinct lower(btrim(x)) order by lower(btrim(x))), '{}'::text[]) into v_channels
    from unnest(coalesce(p_channels, '{}'::text[])) x
   where lower(btrim(x)) = any (v_allowed)
     and lower(btrim(x)) not in ('vendoo', 'mercari');

  select coalesce(listed_on, '{}'::text[]) into v_prev from public.units where store_id = v_store and sku = p_sku;
  if not found then raise exception 'unit_not_found' using errcode = 'P0002'; end if;

  foreach v_ch in array v_channels
  loop
    if not (v_ch = any (coalesce(v_prev, '{}'::text[]))) then
      if v_ch = 'depop' then
        if not exists (
          select 1 from public.listings l
           where l.store_id = v_store and l.sku = p_sku
             and l.channel = 'depop' and l.status = 'listed'
        ) then
          raise exception 'depop_requires_listing_row — use Marketplaces → Listing manager → Depop (Push to Depop), then paste the listing link'
            using errcode = 'P0001';
        end if;
      end if;
      perform public.assert_channel_eligible(v_store, p_sku, v_ch);
    end if;
  end loop;

  update public.units set listed_on = v_channels, updated_at = now() where store_id = v_store and sku = p_sku;
  update public.listings set status = 'delisted', delisted_at = now()
    where store_id = v_store and sku = p_sku and channel = any (v_allowed)
      and not (channel = any (v_channels)) and status = 'listed';
  insert into public.listings(store_id, sku, channel, status, listed_at, delisted_at)
    select v_store, p_sku, x, 'listed', now(), null from unnest(v_channels) x
    on conflict(store_id, sku, channel) do update
      set status = 'listed', listed_at = coalesce(public.listings.listed_at, now()), delisted_at = null;
  return v_channels;
end $$;

revoke all on function public.portal_set_unit_listed_on(text, text[]) from public, anon;
grant execute on function public.portal_set_unit_listed_on(text, text[]) to authenticated;