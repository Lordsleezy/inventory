begin;
alter table public.listings add column if not exists depop_confirmed_at timestamptz;
-- Depop has no automatic shop-listing sync. Owner/agent confirmations are durable;
-- an older generic import must not overwrite them or revive a Sold-tab SKU.
create or replace function public.depop_tracker_ownership_guard()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_trusted boolean:=coalesce(current_setting('floor.depop_tracker_record',true),'')='on'; v_store uuid; v_sku text; v_old text; v_attempt text;
begin
 if tg_op='DELETE' then
  if old.channel<>'depop' or old.depop_confirmed_at is null or v_trusted then return old; end if;
  v_store:=old.store_id;v_sku:=old.sku;v_old:=old.status;v_attempt:='deleted';
 else
  if new.channel<>'depop' then return new; end if;
  if new.status='listed' and exists(select 1 from public.units u where u.store_id=new.store_id and u.sku=new.sku and u.state='sold') then
   new.status:='delisted';new.delisted_at:=coalesce(new.delisted_at,now());new.depop_confirmed_at:=now();return new;
  end if;
  if v_trusted then new.depop_confirmed_at:=now();return new; end if;
  if tg_op='INSERT' or old.depop_confirmed_at is null then return new; end if;
  if row(new.status,new.listing_id,new.listed_at,new.delisted_at,new.depop_price_cents,new.depop_added_by)
    is not distinct from row(old.status,old.listing_id,old.listed_at,old.delisted_at,old.depop_price_cents,old.depop_added_by) then
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
create trigger aaa_depop_tracker_ownership before insert or update or delete on public.listings
 for each row execute function public.depop_tracker_ownership_guard();

-- A legacy flag importer must not undo the canonical Depop channel flag either.
create or replace function public.depop_tracker_unit_flag_guard()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_status text;
begin
 select status into v_status from public.listings where store_id=new.store_id and sku=new.sku and channel='depop' and depop_confirmed_at is not null;
 if found then
  new.listed_on:=array_remove(coalesce(new.listed_on,'{}'::text[]),'depop');
  if v_status='listed' then new.listed_on:=array_append(new.listed_on,'depop');end if;
 end if;
 return new;
end $$;
create trigger aaa_depop_tracker_unit_flag before insert or update on public.units
 for each row execute function public.depop_tracker_unit_flag_guard();

create or replace function public.floor_depop_remove_listing(p_store uuid,p_sku text,p_actor text default 'listing agent')
returns void language plpgsql security definer set search_path=public as $$
declare v_prior text:=current_setting('floor.depop_tracker_record',true);
begin
 if p_store is null or nullif(btrim(p_sku),'') is null then raise exception 'store_and_sku_required' using errcode='22023';end if;
 perform set_config('floor.depop_tracker_record','on',true);
 update public.listings set status='delisted',delisted_at=coalesce(delisted_at,now()),depop_confirmed_at=now()
 where store_id=p_store and sku=btrim(p_sku) and channel='depop';
 perform set_config('floor.depop_tracker_record',coalesce(v_prior,''),true);
exception when others then perform set_config('floor.depop_tracker_record',coalesce(v_prior,''),true);raise;
end $$;
revoke all on function public.floor_depop_remove_listing(uuid,text,text) from public,anon,authenticated;
grant execute on function public.floor_depop_remove_listing(uuid,text,text) to service_role;
create or replace function public.portal_depop_remove_listing(p_sku text)
returns void language plpgsql security definer set search_path=public as $$
begin perform public.floor_depop_remove_listing(public.portal_assert_admin_store(),p_sku,public.disposition_actor_name(auth.uid()));end $$;

create or replace function public.depop_sale_clear_live_listing()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 if lower(new.channel)='depop' and new.voided_at is null then
  perform public.floor_depop_remove_listing(new.store_id,new.sku,'Depop sale recorded');
 end if;
 return new;
end $$;
-- Preserve the owner's already-confirmed Sold-tab removals as tombstones.
select public.floor_depop_remove_listing(u.store_id,u.sku,'Owner confirmed sold-item removal')
from public.units u join public.listings l using(store_id,sku)
where u.store_id='5487ca47-6147-4fe8-bc6d-46b6472726ba' and u.state='sold' and l.channel='depop';
commit;
