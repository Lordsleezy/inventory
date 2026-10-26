-- DNS = Do not ship. Separate store/pickup stock from shipping stock and deny all four marketplaces.
begin;
create or replace function public.unit_dns(p_specs jsonb)
returns boolean language sql immutable as $$ select lower(coalesce(p_specs->>'do_not_ship','false')) in ('true','1','yes'); $$;
create or replace function public.unit_dns_type(u public.units)
returns boolean language sql immutable as $$
 select concat_ws(' ',u.brand,u.model,u.title,u.category,u.internal_category) ~* '\m(refrigerators?|fridges?|freezers?|dishwashers?|deep\s*fryers?|mattress(es)?|bed\s*frames?|sofas?|couches|couch|scooters?)\M'
 and concat_ws(' ',u.brand,u.model,u.title) !~* '\m(filters?|covers?|protectors?|pads?|sheets?|hoses?|parts?|magnets?|pillows?|cushions?|toys?|dollhouse)\M';
$$;
create or replace function public.floor_dns_push_gate(p_store uuid,p_sku text,p_channel text)
returns void language plpgsql stable security definer set search_path=public as $$
begin
 if lower(p_channel) in ('ebay','amazon','tiktok','depop') and (
   exists(select 1 from public.units u where u.store_id=p_store and u.sku=p_sku and public.unit_dns(u.listing_specs))
   or exists(select 1 from public.floor_bundle_components c join public.units u on u.store_id=c.store_id and u.sku=c.component_sku
     join public.floor_bundles b on b.store_id=c.store_id and b.sku=c.bundle_sku and b.active
     where c.store_id=p_store and c.bundle_sku=p_sku and public.unit_dns(u.listing_specs))) then
   raise exception 'DNS: Do not ship - never list on eBay, Amazon, TikTok Shop or Depop' using errcode='P0001';
 end if;
end $$;
revoke all on function public.floor_dns_push_gate(uuid,text,text) from public,anon,authenticated;
grant execute on function public.floor_dns_push_gate(uuid,text,text) to service_role;

-- Retain all existing category, permission and bundle checks; DNS is checked first.
do $$ declare f record; v text; begin
 for f in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname in ('assert_channel_eligible','floor_category_pre_push','floor_bundle_push_gate') loop
   v:=pg_get_functiondef(f.oid);
   v:=regexp_replace(v,'\mbegin\M', E'begin\n  perform public.floor_dns_push_gate(p_store,p_sku,p_channel);','i');
   execute v;
 end loop;
end $$;

-- Always block selections too, including stores created after this migration.
do $$ declare src text; begin
 select prosrc into src from pg_proc where oid='public.floor_unit_never_list_reason(uuid,text,text)'::regprocedure;
 src:=regexp_replace(src,';\s*$','');
 execute format('create or replace function public.floor_unit_never_list_reason(p_store uuid,p_sku text,p_channel text) returns text language sql stable security definer set search_path=public as %L',
  'select case when lower(p_channel) in (''ebay'',''amazon'',''tiktok'',''depop'') and exists (select 1 from public.units u where u.store_id=p_store and u.sku=p_sku and public.unit_dns(u.listing_specs)) then ''DNS - Do not ship'' else ('||src||') end');
end $$;

create or replace function public.unit_dns_enforce()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 if public.unit_dns_type(new) then new.listing_specs:=coalesce(new.listing_specs,'{}'::jsonb)||'{"do_not_ship":true}'::jsonb; end if;
 if public.unit_dns(new.listing_specs) then new.shippable:=false; new.fulfillment_override:='pickup'; end if;
 return new;
end $$;
create trigger unit_dns_enforce before insert or update on public.units for each row execute function public.unit_dns_enforce();

create or replace function public.unit_dns_changed()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_old boolean:=false;
begin
 if tg_op='UPDATE' then v_old:=public.unit_dns(old.listing_specs); end if;
 if public.unit_dns(new.listing_specs) is not distinct from v_old then return null; end if;
 if public.unit_dns(new.listing_specs) then
   update public.unit_channel_selections set selected=false,updated_at=now() where store_id=new.store_id and sku=new.sku and selected;
   update public.listing_queue set status='cancelled',issue='DNS - Do not ship',updated_at=now()
     where store_id=new.store_id and sku=new.sku and action='list' and status in ('queued','failed');
   insert into public.listing_queue(store_id,sku,channel,action)
     select new.store_id,new.sku,l.channel,'end' from public.listings l where l.store_id=new.store_id and l.sku=new.sku
       and l.status='listed' and l.channel in ('ebay','amazon','tiktok') on conflict do nothing;
   insert into public.delist_tasks(store_id,sku,channel,created_at,nag_after)
     select new.store_id,new.sku,'depop',now(),now() where exists(select 1 from public.listings l
       where l.store_id=new.store_id and l.sku=new.sku and l.channel='depop' and l.status='listed')
       and not exists(select 1 from public.delist_tasks d where d.store_id=new.store_id and d.sku=new.sku and d.channel='depop' and d.completed_at is null);
 end if;
 insert into public.events(store_id,sku,kind,field,old_value,new_value,actor,actor_id,note)
 values(new.store_id,new.sku,'edit','DNS',v_old::text,public.unit_dns(new.listing_specs)::text,
   coalesce((select display_name from public.staff where user_id=auth.uid()),'system'),auth.uid(),
   'DNS - Do not ship. Store / website pickup only; never list on eBay, Amazon, TikTok Shop or Depop.');
 return null;
end $$;
create trigger unit_dns_changed after insert or update on public.units for each row execute function public.unit_dns_changed();

create or replace function public.portal_unit_dns(p_sku text)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_store uuid:=coalesce(public.portal_store_id(),public.current_store_id()); u public.units;
begin
 if v_store is null or not(public.portal_is_admin() or exists(select 1 from public.staff s where s.user_id=auth.uid() and s.store_id=v_store and s.deactivated_at is null)) then raise exception 'store_access_denied' using errcode='42501'; end if;
 select * into u from public.units where store_id=v_store and sku=p_sku;
 if not found then raise exception 'unit_not_found'; end if;
 return jsonb_build_object('dns',public.unit_dns(u.listing_specs),'required',public.unit_dns_type(u));
end $$;
create or replace function public.portal_set_unit_dns(p_sku text,p_dns boolean)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_store uuid:=coalesce(public.portal_store_id(),public.current_store_id()); u public.units;
begin
 if v_store is null or not(public.portal_is_admin() or exists(select 1 from public.staff s where s.user_id=auth.uid() and s.store_id=v_store and s.deactivated_at is null)) then raise exception 'store_access_denied' using errcode='42501'; end if;
 if p_dns is null then raise exception 'dns_required' using errcode='22023'; end if;
 select * into u from public.units where store_id=v_store and sku=p_sku for update;
 if not found then raise exception 'unit_not_found'; end if;
 if not p_dns and public.unit_dns_type(u) then raise exception 'DNS is required for this oversized item type'; end if;
 update public.units set listing_specs=jsonb_set(coalesce(listing_specs,'{}'::jsonb),'{do_not_ship}',to_jsonb(p_dns)),updated_at=now()
   where store_id=v_store and sku=p_sku;
 return public.portal_unit_dns(p_sku);
end $$;
revoke all on function public.portal_unit_dns(text),public.portal_set_unit_dns(text,boolean) from public,anon;
grant execute on function public.portal_unit_dns(text),public.portal_set_unit_dns(text,boolean) to authenticated;

insert into public.listing_never_rules(store_id,channel,rule_type,value,note)
select s.id,c,'flag','do_not_ship','DNS - Do not ship: never list on this marketplace' from public.stores s
cross join unnest(array['ebay','amazon','tiktok','depop']) c on conflict do nothing;

-- DNS is a separate stock group, never a shipping-readiness queue.
do $$ declare f record; v text; hits int:=0; src text; begin
 for f in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
   and p.proname in ('portal_inventory_list','portal_inventory_list_with_locations','staff_inventory_list') and p.pronargs>=6 loop
   v:=pg_get_functiondef(f.oid);
   v:=regexp_replace(v,'where\s*\(p_status\s*=\s*''all''',
     'where ((p_status=''dns'' and b.state in (''available'',''reserved'',''repair'') and public.unit_dns(b.listing_specs)) or p_status=''all''','i');
   v:=regexp_replace(v,'and\s*\(not p_unfinished',
     'and (p_status in (''dns'',''sold'',''all'',''voided'') or not public.unit_dns(b.listing_specs)) and (not p_unfinished or not public.unit_dns(b.listing_specs)) and (not p_unfinished','i');
   if v=pg_get_functiondef(f.oid) then raise exception 'DNS inventory filter patch failed'; end if;
   execute v;hits:=hits+1;
 end loop;
 if hits<>3 then raise exception 'Expected 3 inventory functions, got %',hits; end if;
 select p.prosrc into src from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='unit_listing_gaps';
 src:=regexp_replace(src,';\s*$','');
 execute format('create or replace function public.unit_listing_gaps(u public.units) returns text[] language sql stable set search_path=public as %L',
   'select case when public.unit_dns(u.listing_specs) then ''{}''::text[] else ('||src||') end');
end $$;

-- Existing oversized items, including sold history, keep their state, quantity, prices and sales.
update public.units u set listing_specs=coalesce(listing_specs,'{}'::jsonb)||'{"do_not_ship":true}'::jsonb
where public.unit_dns_type(u) and not public.unit_dns(listing_specs);

create or replace function public.inventory_totals()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  v_result jsonb;
begin
  if v_store is null or not (public.portal_is_admin() or exists (
    select 1 from public.staff s where s.user_id = auth.uid() and s.store_id = v_store and s.deactivated_at is null
  )) then raise exception 'inventory_access_denied' using errcode = '42501'; end if;
  with u as (
    select greatest(coalesce(x.qty_on_hand, 1), 0) qty,
      public.unit_is_defective(x.listing_specs, x.condition) defective, public.unit_dns(x.listing_specs) dns,
      exists (select 1 from public.listings l
        where l.store_id=x.store_id and l.sku=x.sku and l.channel='ebay' and l.status='listed'
          and nullif(btrim(l.listing_id),'') is not null
          and (l.ebay_account_id is null or exists(select 1 from public.ebay_accounts a
            where a.id=l.ebay_account_id and a.store_id=x.store_id and a.role='selling'))) live
    from public.units x
    where x.store_id = v_store and x.state in ('available', 'reserved', 'repair')
  )
  select jsonb_build_object(
    'total', coalesce(sum(qty), 0)::int,
    'listed', coalesce(sum(qty) filter (where not dns and not defective and live), 0)::int,
    'not_listed', coalesce(sum(qty) filter (where not dns and not defective and not live), 0)::int,
    'defective', coalesce(sum(qty) filter (where not dns and defective), 0)::int,
    'dns', coalesce(sum(qty) filter (where dns),0)::int
  ) into v_result from u;
  return v_result;
end $$;

commit;
