begin;

-- Depop's listed listings row remains the source of truth. Keep links, price and
-- attribution on that same per-unit row so inventory counts stay in sync.
alter table public.listings
  add column if not exists depop_price_cents integer,
  add column if not exists depop_added_by text;

create or replace function public.portal_depop_live_listings()
returns table(
  sku text, title text, price_cents integer, listing_url text, listed_at timestamptz,
  added_by text, photo_path text, unit_state text, do_not_list boolean, defective boolean
)
language plpgsql stable security definer set search_path=public as $$
declare v_store uuid := public.portal_assert_admin_store();
begin
  if not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode='42501'; end if;
  return query
  select l.sku,
    coalesce(nullif(btrim(u.title),''), nullif(btrim(concat_ws(' ',u.brand,u.model)),''), 'Untitled unit'),
    l.depop_price_cents, l.listing_id, l.listed_at, l.depop_added_by,
    (select p.path from public.photos p where p.store_id=l.store_id and p.sku=l.sku
       order by p.is_primary desc, p.sort_order nulls last, p.created_at, p.id limit 1),
    u.state, public.unit_not_for_sale(u.listing_specs), public.unit_is_defective(u.listing_specs,u.condition)
  from public.listings l join public.units u on u.store_id=l.store_id and u.sku=l.sku
  where l.store_id=v_store and l.channel='depop' and l.status='listed'
  order by l.listed_at desc nulls last, l.sku;
end $$;

create or replace function public.portal_depop_find_listing_units(p_query text)
returns table(sku text,title text,photo_path text,unit_state text,do_not_list boolean,defective boolean)
language plpgsql stable security definer set search_path=public as $$
declare v_store uuid := public.portal_assert_admin_store(); v_q text := lower(btrim(coalesce(p_query,'')));
begin
  if length(v_q)<1 then return; end if;
  return query
  select u.sku, coalesce(nullif(btrim(u.title),''),nullif(btrim(concat_ws(' ',u.brand,u.model)),''),'Untitled unit'),
    (select p.path from public.photos p where p.store_id=u.store_id and p.sku=u.sku
      order by p.is_primary desc,p.sort_order nulls last,p.created_at,p.id limit 1),
    u.state, public.unit_not_for_sale(u.listing_specs), public.unit_is_defective(u.listing_specs,u.condition)
  from public.units u where u.store_id=v_store and
    (lower(u.sku) like '%'||v_q||'%' or lower(coalesce(u.title,'')) like '%'||v_q||'%'
      or lower(concat_ws(' ',u.brand,u.model)) like '%'||v_q||'%')
  order by (u.state in ('available','reserved','repair')) desc,u.sku limit 30;
end $$;

create or replace function public.portal_depop_add_listing(p_sku text,p_url text,p_price_cents integer,p_listed_at date default null)
returns void language plpgsql security definer set search_path=public as $$
declare v_store uuid := public.portal_assert_admin_store(); v_day date := coalesce(p_listed_at,(now() at time zone 'America/Los_Angeles')::date);
begin
  if nullif(btrim(p_url),'') is null or btrim(p_url) !~* '^https?://(www\.)?depop\.com/' then raise exception 'invalid_depop_url' using errcode='22023'; end if;
  if p_price_cents is null or p_price_cents<0 then raise exception 'invalid_depop_price' using errcode='22023'; end if;
  if v_day>(now() at time zone 'America/Los_Angeles')::date then raise exception 'listed_date_in_future' using errcode='22023'; end if;
  if not exists(select 1 from public.units where store_id=v_store and sku=btrim(p_sku)) then raise exception 'unit_not_found' using errcode='P0002'; end if;
  insert into public.listings(store_id,sku,channel,status,listing_id,listed_at,delisted_at,depop_price_cents,depop_added_by)
  values(v_store,btrim(p_sku),'depop','listed',btrim(p_url),v_day::timestamptz,null,p_price_cents,public.disposition_actor_name(auth.uid()))
  on conflict(store_id,sku,channel) do update set status='listed',listing_id=excluded.listing_id,
    listed_at=excluded.listed_at,delisted_at=null,depop_price_cents=excluded.depop_price_cents,
    depop_added_by=excluded.depop_added_by;
end $$;

create or replace function public.portal_depop_remove_listing(p_sku text)
returns void language plpgsql security definer set search_path=public as $$
declare v_store uuid := public.portal_assert_admin_store();
begin
  update public.listings set status='delisted',delisted_at=now()
  where store_id=v_store and sku=btrim(p_sku) and channel='depop' and status='listed';
end $$;

do $$ declare f text; begin
 foreach f in array array[
  'portal_depop_live_listings()', 'portal_depop_find_listing_units(text)',
  'portal_depop_add_listing(text,text,integer,date)', 'portal_depop_remove_listing(text)'
 ] loop execute format('revoke all on function public.%s from public, anon',f);
   execute format('grant execute on function public.%s to authenticated',f); end loop;
end $$;

commit;
