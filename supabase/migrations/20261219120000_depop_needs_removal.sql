begin;

-- A Depop sale used to drop the SKU off the live list. Keep it listed and flag it
-- so the shop listing can be pulled. Remove is the only thing that takes it off.
alter table public.listings add column if not exists depop_needs_removal boolean not null default false;

create or replace function public.depop_tracker_ownership_guard()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_trusted boolean:=coalesce(current_setting('floor.depop_tracker_record',true),'')='on'; v_store uuid; v_sku text; v_old text; v_attempt text;
begin
 if tg_op='DELETE' then
  if old.channel<>'depop' or old.depop_confirmed_at is null or v_trusted then return old; end if;
  v_store:=old.store_id;v_sku:=old.sku;v_old:=old.status;v_attempt:='deleted';
 else
  if new.channel<>'depop' then return new; end if;
  -- A sold unit can stay listed only while it is waiting to be pulled off Depop.
  if new.status='listed' and coalesce(new.depop_needs_removal,false)=false
     and exists(select 1 from public.units u where u.store_id=new.store_id and u.sku=new.sku and u.state='sold') then
   new.status:='delisted';new.delisted_at:=coalesce(new.delisted_at,now());new.depop_confirmed_at:=now();return new;
  end if;
  if v_trusted then new.depop_confirmed_at:=now();return new; end if;
  if tg_op='INSERT' or old.depop_confirmed_at is null then return new; end if;
  if row(new.status,new.listing_id,new.listed_at,new.delisted_at,new.depop_price_cents,new.depop_added_by,new.depop_needs_removal)
    is not distinct from row(old.status,old.listing_id,old.listed_at,old.delisted_at,old.depop_price_cents,old.depop_added_by,old.depop_needs_removal) then
   new.depop_confirmed_at:=old.depop_confirmed_at;return new;
  end if;
  v_store:=old.store_id;v_sku:=old.sku;v_old:=old.status;v_attempt:=new.status;
 end if;
 if not exists(select 1 from public.events e where e.store_id=v_store and e.sku=v_sku and e.field='depop_tracker_rejected_write' and e.at>now()-interval '10 minutes') then
  insert into public.events(store_id,sku,kind,field,old_value,new_value,actor,note)
  values(v_store,v_sku,'edit','depop_tracker_rejected_write',v_old,v_attempt,'backend guard',
   left('Ignored unconfirmed overwrite. client='||coalesce(nullif(current_setting('request.headers',true),'')::jsonb->>'user-agent','database')||'; application='||coalesce(current_setting('application_name',true),''),500));
 end if;
 return null;
end $$;

create or replace function public.floor_depop_record_listing(
 p_store uuid,p_sku text,p_url text default null,p_price_cents integer default null,
 p_listed_at timestamptz default now(),p_actor text default 'listing agent'
) returns jsonb language plpgsql security definer set search_path=public as $$
declare u public.units; v_sku text:=btrim(p_sku); v_url text:=nullif(btrim(p_url),'');
 v_prior text:=current_setting('floor.depop_tracker_record',true); v_old text;
begin
 if p_store is null or nullif(v_sku,'') is null then raise exception 'store_and_sku_required' using errcode='22023'; end if;
 if v_url is not null and v_url !~* '^https://(www\.)?depop\.com/products/[^/?#]+' then raise exception 'invalid_depop_url' using errcode='22023'; end if;
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
 update public.listings set status='delisted',delisted_at=coalesce(delisted_at,now()),depop_confirmed_at=now(),depop_needs_removal=false
 where store_id=p_store and sku=btrim(p_sku) and channel='depop';
 update public.units set listed_on=array_remove(coalesce(listed_on,'{}'::text[]),'depop'),updated_at=now()
 where store_id=p_store and sku=btrim(p_sku);
 perform set_config('floor.depop_tracker_record',coalesce(v_prior,''),true);
exception when others then perform set_config('floor.depop_tracker_record',coalesce(v_prior,''),true);raise;
end $$;

-- Sale keeps a live row at the top of the Depop list. Quantity still on hand stays a normal listing.
create or replace function public.depop_sale_clear_live_listing()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_prior text:=current_setting('floor.depop_tracker_record',true);
begin
 if lower(coalesce(new.channel,''))<>'depop' then return new; end if;
 if new.voided_at is not null then
  if not exists(select 1 from public.sales s where s.store_id=new.store_id and s.sku=new.sku and s.id is distinct from new.id and lower(s.channel)='depop' and s.voided_at is null) then
   perform set_config('floor.depop_tracker_record','on',true);
   update public.listings set depop_needs_removal=false
    where store_id=new.store_id and sku=new.sku and channel='depop' and depop_needs_removal;
   perform set_config('floor.depop_tracker_record',coalesce(v_prior,''),true);
  end if;
  return new;
 end if;
 if exists(select 1 from public.units u where u.store_id=new.store_id and u.sku=new.sku
    and coalesce(u.is_stocked,false) and coalesce(u.qty_on_hand,0)>0 and u.state in ('available','reserved','repair')) then
  return new;
 end if;
 perform set_config('floor.depop_tracker_record','on',true);
 update public.listings set status='listed',delisted_at=null,depop_needs_removal=true
  where store_id=new.store_id and sku=new.sku and channel='depop' and status='listed';
 perform set_config('floor.depop_tracker_record',coalesce(v_prior,''),true);
 return new;
exception when others then perform set_config('floor.depop_tracker_record',coalesce(v_prior,''),true);raise;
end $$;

-- The sale form used to delist after the trigger. Leave the row listed.
do $$
declare src text; v_old text := $old$
  update public.listings set status = 'delisted', delisted_at = now()
    where store_id is not distinct from v_store and sku = p_sku and channel = 'depop' and status <> 'delisted';
$old$;
begin
 select pg_get_functiondef('public.portal_depop_record_sale(text,integer,integer,integer,date,text)'::regprocedure) into src;
 if position(v_old in src)=0 then raise exception 'portal_depop_record_sale delist statement not found'; end if;
 src := replace(src, v_old, '  perform 1;');
 execute src;
end $$;

drop function public.portal_depop_live_listings();
create function public.portal_depop_live_listings()
returns table(
  sku text, title text, price_cents integer, listing_url text, listed_at timestamptz,
  added_by text, photo_path text, unit_state text, do_not_list boolean, defective boolean,
  needs_removal boolean
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
    u.state, public.unit_not_for_sale(u.listing_specs), public.unit_is_defective(u.listing_specs,u.condition),
    l.depop_needs_removal
  from public.listings l join public.units u on u.store_id=l.store_id and u.sku=l.sku
  where l.store_id=v_store and l.channel='depop' and l.status='listed'
  order by l.depop_needs_removal desc, l.listed_at desc nulls last, l.sku;
end $$;
revoke all on function public.portal_depop_live_listings() from public, anon;
grant execute on function public.portal_depop_live_listings() to authenticated, service_role;

-- Sales already took these off the list without a Remove click. Put them back at the top.
-- A stocked SKU with quantity left stays a normal live row.
select set_config('floor.depop_tracker_record','on',true);
update public.listings l
set status='listed', delisted_at=null,
    depop_needs_removal = not (
      coalesce(u.is_stocked,false) and coalesce(u.qty_on_hand,0)>0 and u.state in ('available','reserved','repair')
    )
from public.units u
where u.store_id=l.store_id and u.sku=l.sku and l.channel='depop'
  and exists(select 1 from public.sales s where s.store_id=l.store_id and s.sku=l.sku and lower(s.channel)='depop' and s.voided_at is null);
update public.units u
set updated_at=now()
where exists(select 1 from public.listings l where l.store_id=u.store_id and l.sku=u.sku and l.channel='depop' and l.status='listed')
  and exists(select 1 from public.sales s where s.store_id=u.store_id and s.sku=u.sku and lower(s.channel)='depop' and s.voided_at is null)
  and not ('depop'=any(coalesce(u.listed_on,'{}'::text[])));
select set_config('floor.depop_tracker_record','',true);

commit;
