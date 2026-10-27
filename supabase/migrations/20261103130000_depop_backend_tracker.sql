begin;
-- The live tracker records confirmed Depop publications, not requests to publish.
-- Only the service-only confirmation function sets this transaction-local flag.
create or replace function public.floor_bundle_listing_guard()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.status='listed' then
  if new.channel='depop' and current_setting('floor.depop_tracker_record',true)='on' then
   perform public.floor_dns_push_gate(new.store_id,new.sku,'depop');
  else perform public.floor_bundle_push_gate(new.store_id,new.sku,new.channel); end if;
 end if;
 return new;
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
 if exists(select 1 from public.sales s where s.store_id=p_store and s.sku=v_sku and lower(s.channel)='depop' and s.voided_at is null) then raise exception 'depop_unit_already_sold' using errcode='22023'; end if;
 perform public.floor_dns_push_gate(p_store,v_sku,'depop');
 select status into v_old from public.listings where store_id=p_store and sku=v_sku and channel='depop';
 perform set_config('floor.depop_tracker_record','on',true);
 insert into public.listings(store_id,sku,channel,status,listing_id,listed_at,delisted_at,depop_price_cents,depop_added_by)
 values(p_store,v_sku,'depop','listed',v_url,p_listed_at,null,p_price_cents,left(coalesce(nullif(btrim(p_actor),''),'listing agent'),160))
 on conflict(store_id,sku,channel) do update set status='listed',delisted_at=null,
  listing_id=coalesce(excluded.listing_id,listings.listing_id),
  listed_at=coalesce(case when listings.status='listed' then listings.listed_at end,excluded.listed_at),
  depop_price_cents=coalesce(excluded.depop_price_cents,listings.depop_price_cents),
  depop_added_by=coalesce(listings.depop_added_by,excluded.depop_added_by);
 perform set_config('floor.depop_tracker_record',coalesce(v_prior,''),true);
 if v_old is distinct from 'listed' then
  insert into public.events(store_id,sku,kind,field,old_value,new_value,actor,actor_id,note)
  values(p_store,v_sku,'edit','depop_listing',v_old,'listed',left(coalesce(nullif(btrim(p_actor),''),'listing agent'),160),auth.uid(),'Confirmed live on Depop; tracker only, no inventory or sale change.');
 end if;
 return jsonb_build_object('sku',v_sku,'channel','depop','status','listed');
exception when others then
 perform set_config('floor.depop_tracker_record',coalesce(v_prior,''),true);raise;
end $$;
revoke all on function public.floor_depop_record_listing(uuid,text,text,integer,timestamptz,text) from public,anon,authenticated;
grant execute on function public.floor_depop_record_listing(uuid,text,text,integer,timestamptz,text) to service_role;

-- The signed-in form keeps its admin-only authorization and original signature.
create or replace function public.portal_depop_add_listing(p_sku text,p_url text,p_price_cents integer,p_listed_at date default null)
returns void language plpgsql security definer set search_path=public as $$
declare v_store uuid:=public.portal_assert_admin_store();
begin
 if nullif(btrim(p_url),'') is null then raise exception 'invalid_depop_url' using errcode='22023'; end if;
 if p_price_cents is null then raise exception 'invalid_depop_price' using errcode='22023'; end if;
 perform public.floor_depop_record_listing(v_store,p_sku,p_url,p_price_cents,
  coalesce(p_listed_at,(now() at time zone 'America/Los_Angeles')::date)::timestamp at time zone 'America/Los_Angeles',public.disposition_actor_name(auth.uid()));
end $$;

-- All Depop sales, including the existing manual-entry RPC, atomically clear the tracker.
create or replace function public.depop_sale_clear_live_listing()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 if lower(new.channel)='depop' and new.voided_at is null then
  update public.listings set status='delisted',delisted_at=now()
  where store_id=new.store_id and sku=new.sku and channel='depop' and status='listed';
 end if;
 return new;
end $$;
create trigger depop_sale_clear_live_listing after insert or update of sku,channel,voided_at on public.sales
 for each row execute function public.depop_sale_clear_live_listing();

-- Owner confirmed the Sold-tab items have already been removed from the shop.
update public.listings l set status='delisted',delisted_at=now()
from public.units u where u.store_id=l.store_id and u.sku=l.sku and l.channel='depop' and l.status='listed' and u.state='sold' and u.store_id='5487ca47-6147-4fe8-bc6d-46b6472726ba';
update public.delist_tasks d set completed_at=now()
from public.units u where u.store_id=d.store_id and u.sku=d.sku and d.channel='depop' and d.completed_at is null and u.state='sold' and u.store_id='5487ca47-6147-4fe8-bc6d-46b6472726ba';
commit;
