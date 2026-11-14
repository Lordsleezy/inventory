begin;

-- The admin Depop list was one row per SKU. The shop counts every live product
-- URL, including a second post of the same SKU and a post with no Floor SKU.
-- A shop snapshot makes the portal list those posts. Until a store has one,
-- the portal keeps reading the canonical per-SKU listings rows.

create table public.depop_live_posts (
  store_id uuid not null references public.stores(id) on delete cascade,
  listing_url text not null,
  sku text,
  price_cents integer,
  primary key (store_id, listing_url),
  constraint depop_live_posts_url check (listing_url ~* '^https://(www\.)?depop\.com/products/[^/?#]+/$'),
  constraint depop_live_posts_sku check (sku is null or btrim(sku) <> ''),
  constraint depop_live_posts_price check (price_cents is null or price_cents >= 0)
);
create index depop_live_posts_store_sku on public.depop_live_posts (store_id, sku);

create table public.depop_shop_snapshot (
  store_id uuid primary key references public.stores(id) on delete cascade,
  captured_at timestamptz not null default now()
);

alter table public.depop_live_posts enable row level security;
alter table public.depop_shop_snapshot enable row level security;
revoke all on public.depop_live_posts from public, anon, authenticated;
revoke all on public.depop_shop_snapshot from public, anon, authenticated;
grant select, insert, update, delete on public.depop_live_posts to service_role;
grant select, insert, update, delete on public.depop_shop_snapshot to service_role;

create or replace function public.floor_depop_record_listing(
 p_store uuid,p_sku text,p_url text default null,p_price_cents integer default null,
 p_listed_at timestamptz default now(),p_actor text default 'listing agent'
) returns jsonb language plpgsql security definer set search_path=public as $$
declare u public.units; v_sku text:=btrim(p_sku); v_url text:=nullif(btrim(p_url),'');
 v_prior text:=current_setting('floor.depop_tracker_record',true); v_old text;
begin
 if p_store is null or nullif(v_sku,'') is null then raise exception 'store_and_sku_required' using errcode='22023'; end if;
 if v_url is not null and v_url !~* '^https://(www\.)?depop\.com/products/[^/?#]+' then raise exception 'invalid_depop_url' using errcode='22023'; end if;
 if v_url is not null then v_url := regexp_replace(v_url, '/+$', '') || '/'; end if;
 if p_price_cents is not null and p_price_cents<0 then raise exception 'invalid_depop_price' using errcode='22023'; end if;
 if p_listed_at is not null and (p_listed_at at time zone 'America/Los_Angeles')::date>(now() at time zone 'America/Los_Angeles')::date then raise exception 'listed_date_in_future' using errcode='22023'; end if;
 select * into u from public.units where store_id=p_store and sku=v_sku for update;
 if not found then raise exception 'unit_not_found' using errcode='P0002'; end if;
 if u.state not in ('available','reserved','repair') then raise exception 'depop_unit_not_available: %',u.state using errcode='22023'; end if;
 if exists(select 1 from public.sales s where s.store_id=p_store and s.sku=v_sku and lower(s.channel)='depop' and s.voided_at is null)
    and not (coalesce(u.is_stocked,false) and coalesce(u.qty_on_hand,0)>0) then
  raise exception 'depop_unit_already_sold' using errcode='22023';
 end if;
 perform public.floor_dns_push_gate(p_store,v_sku,'depop'::text);
 select status into v_old from public.listings where store_id=p_store and sku=v_sku and channel='depop';
 perform set_config('floor.depop_tracker_record','on',true);
 insert into public.listings(store_id,sku,channel,status,listing_id,listed_at,delisted_at,depop_price_cents,depop_added_by,depop_needs_removal)
 values(p_store,v_sku,'depop','listed',v_url,p_listed_at,null,p_price_cents,left(coalesce(nullif(btrim(p_actor),''),'listing agent'),160),false)
 on conflict(store_id,sku,channel) do update set status='listed',delisted_at=null,depop_needs_removal=false,
  listing_id=coalesce(excluded.listing_id,listings.listing_id),
  listed_at=coalesce(case when listings.status='listed' then listings.listed_at end,excluded.listed_at),
  depop_price_cents=coalesce(excluded.depop_price_cents,listings.depop_price_cents),
  depop_added_by=coalesce(listings.depop_added_by,excluded.depop_added_by);
 if v_url is not null then
  insert into public.depop_live_posts(store_id,listing_url,sku,price_cents)
  values(p_store,v_url,v_sku,p_price_cents)
  on conflict(store_id,listing_url) do update set sku=excluded.sku,
   price_cents=coalesce(excluded.price_cents,depop_live_posts.price_cents);
 end if;
 update public.units set listed_on=case when 'depop'=any(coalesce(listed_on,'{}'::text[])) then listed_on else array_append(coalesce(listed_on,'{}'::text[]),'depop') end,updated_at=now()
 where store_id=p_store and sku=v_sku;
 perform set_config('floor.depop_tracker_record',coalesce(v_prior,''),true);
 if v_old is distinct from 'listed' then
  insert into public.events(store_id,sku,kind,field,old_value,new_value,actor,actor_id,note)
  values(p_store,v_sku,'edit','depop_listing',v_old,'listed',left(coalesce(nullif(btrim(p_actor),''),'listing agent'),160),auth.uid(),'Confirmed live on Depop; tracker only, no inventory or sale change.');
 end if;
 return jsonb_build_object('sku',v_sku,'channel','depop','status','listed');
exception when others then perform set_config('floor.depop_tracker_record',coalesce(v_prior,''),true);raise;
end $$;

create or replace function public.floor_depop_remove_listing(p_store uuid,p_sku text,p_actor text default 'listing agent')
returns void language plpgsql security definer set search_path=public as $$
declare v_prior text:=current_setting('floor.depop_tracker_record',true);
begin
 if p_store is null or nullif(btrim(p_sku),'') is null then raise exception 'store_and_sku_required' using errcode='22023';end if;
 perform set_config('floor.depop_tracker_record','on',true);
 delete from public.depop_live_posts where store_id=p_store and sku=btrim(p_sku);
 update public.listings set status='delisted',delisted_at=coalesce(delisted_at,now()),depop_confirmed_at=now(),depop_needs_removal=false
 where store_id=p_store and sku=btrim(p_sku) and channel='depop';
 update public.units set listed_on=array_remove(coalesce(listed_on,'{}'::text[]),'depop'),updated_at=now()
 where store_id=p_store and sku=btrim(p_sku);
 perform set_config('floor.depop_tracker_record',coalesce(v_prior,''),true);
exception when others then perform set_config('floor.depop_tracker_record',coalesce(v_prior,''),true);raise;
end $$;

create or replace function public.portal_depop_live_listings()
returns table(
  sku text, title text, price_cents integer, listing_url text, listed_at timestamptz,
  added_by text, photo_path text, unit_state text, do_not_list boolean, defective boolean,
  needs_removal boolean
)
language plpgsql stable security definer set search_path=public as $$
declare v_store uuid := public.portal_assert_admin_store();
begin
  if not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode='42501'; end if;
  if exists(select 1 from public.depop_shop_snapshot where store_id=v_store) then
    return query
    select coalesce(post.sku,''),
      coalesce(nullif(btrim(u.title),''), nullif(btrim(concat_ws(' ',u.brand,u.model)),''),
        nullif(initcap(replace(regexp_replace(post.listing_url, '^.*/([^/]+)/$', '\1'), '-', ' ')),''), 'Untitled listing'),
      coalesce(post.price_cents, l.depop_price_cents),
      post.listing_url, l.listed_at, l.depop_added_by,
      (select ph.path from public.photos ph where ph.store_id=post.store_id and ph.sku=post.sku
         order by ph.is_primary desc, ph.sort_order nulls last, ph.created_at, ph.id limit 1),
      coalesce(u.state,''),
      public.unit_not_for_sale(u.listing_specs),
      public.unit_is_defective(u.listing_specs, u.condition),
      coalesce(l.depop_needs_removal,false) or coalesce(u.state,'') in ('sold','voided','replaced','given_away')
    from public.depop_live_posts post
    left join public.units u on u.store_id=post.store_id and u.sku=post.sku
    left join public.listings l on l.store_id=post.store_id and l.sku=post.sku and l.channel='depop' and l.status='listed'
    where post.store_id=v_store
    order by (coalesce(l.depop_needs_removal,false) or coalesce(u.state,'') in ('sold','voided','replaced','given_away')) desc,
      l.listed_at desc nulls last, post.sku nulls last, post.listing_url;
    return;
  end if;
  return query
  select l.sku,
    coalesce(nullif(btrim(u.title),''), nullif(btrim(concat_ws(' ',u.brand,u.model)),''), 'Untitled unit'),
    l.depop_price_cents, l.listing_id, l.listed_at, l.depop_added_by,
    (select ph.path from public.photos ph where ph.store_id=l.store_id and ph.sku=l.sku
       order by ph.is_primary desc, ph.sort_order nulls last, ph.created_at, ph.id limit 1),
    u.state, public.unit_not_for_sale(u.listing_specs), public.unit_is_defective(u.listing_specs,u.condition),
    l.depop_needs_removal
  from public.listings l join public.units u on u.store_id=l.store_id and u.sku=l.sku
  where l.store_id=v_store and l.channel='depop' and l.status='listed'
  order by l.depop_needs_removal desc, l.listed_at desc nulls last, l.sku;
end $$;

create or replace function public.portal_depop_remove_post(p_url text)
returns void language plpgsql security definer set search_path=public as $$
declare v_store uuid := public.portal_assert_admin_store();
 v_url text := nullif(btrim(p_url),'');
 v_sku text;
 v_n integer;
begin
 if not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode='42501'; end if;
 if v_url is null or v_url !~* '^https://(www\.)?depop\.com/products/[^/?#]+' then raise exception 'invalid_depop_url' using errcode='22023'; end if;
 v_url := regexp_replace(v_url, '/+$', '') || '/';
 delete from public.depop_live_posts where store_id=v_store and listing_url=v_url returning sku into v_sku;
 get diagnostics v_n = row_count;
 if v_n = 0 then
  select l.sku into v_sku from public.listings l
   where l.store_id=v_store and l.channel='depop' and l.status='listed'
     and regexp_replace(coalesce(l.listing_id,''), '/+$', '') || '/' = v_url
   limit 1;
  if v_sku is not null then
   perform public.floor_depop_remove_listing(v_store, v_sku, public.disposition_actor_name(auth.uid()));
  end if;
  return;
 end if;
 if v_sku is not null and not exists(select 1 from public.depop_live_posts where store_id=v_store and sku=v_sku) then
  perform public.floor_depop_remove_listing(v_store, v_sku, public.disposition_actor_name(auth.uid()));
 end if;
end $$;

revoke all on function public.portal_depop_remove_post(text) from public, anon;
grant execute on function public.portal_depop_remove_post(text) to authenticated, service_role;

commit;
