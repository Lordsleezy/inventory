begin;
-- One definition for the dashboard counts and the items behind every card.
create or replace function public.unit_inventory_bucket(u public.units)
returns text language sql stable set search_path=public as $$
 select case
  when u.state not in ('available','reserved','repair') then null
  when public.unit_dns(u.listing_specs) then 'dns'
  when public.unit_is_defective(u.listing_specs,u.condition) then 'defective'
  when exists(select 1 from public.listings l where l.store_id=u.store_id and l.sku=u.sku
    and l.channel='ebay' and l.status='listed' and nullif(btrim(l.listing_id),'') is not null
    and (l.ebay_account_id is null or exists(select 1 from public.ebay_accounts a
      where a.id=l.ebay_account_id and a.store_id=u.store_id and a.role='selling'))) then 'listed'
  when public.unit_is_unfinished(public.unit_listing_gaps(u)) then 'not_ready'
  else 'not_listed' end;
$$;
revoke all on function public.unit_inventory_bucket(public.units) from public,anon,authenticated;
grant execute on function public.unit_inventory_bucket(public.units) to service_role;

create or replace function public.inventory_totals()
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_store uuid:=coalesce(public.portal_store_id(),public.current_store_id()); result jsonb;
begin
 if v_store is null or not(public.portal_is_admin() or exists(select 1 from public.staff s where s.user_id=auth.uid() and s.store_id=v_store and s.deactivated_at is null)) then
  raise exception 'inventory_access_denied' using errcode='42501'; end if;
 with counts as materialized (
  select greatest(coalesce(u.qty_on_hand,1),0) qty,public.unit_inventory_bucket(u) bucket from public.units u
  where u.store_id=v_store and u.state in ('available','reserved','repair')
 ) select jsonb_build_object('total',coalesce(sum(qty),0)::int,
  'listed',coalesce(sum(qty) filter(where bucket='listed'),0)::int,
  'not_listed',coalesce(sum(qty) filter(where bucket='not_listed'),0)::int,
  'not_ready',coalesce(sum(qty) filter(where bucket='not_ready'),0)::int,
  'dns',coalesce(sum(qty) filter(where bucket='dns'),0)::int,
  'defective',coalesce(sum(qty) filter(where bucket='defective'),0)::int) into result from counts;
 return result;
end $$;

-- Keep the existing pagination, location filtering and clerk financial restrictions.
do $$ declare f record; v text; hits int:=0; begin
 for f in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
  and p.proname in ('portal_inventory_list','portal_inventory_list_with_locations','staff_inventory_list') and p.pronargs>=6 loop
  v:=pg_get_functiondef(f.oid);
  if position('where ((p_status=''dns''' in v)=0 then raise exception 'Unexpected inventory filter definition'; end if;
  v:=replace(v,'where ((p_status=''dns''',
   'where ((p_status=''inventory_total'' and b.state in (''available'',''reserved'',''repair'')) or (p_status in (''inventory_listed'',''inventory_not_listed'',''inventory_not_ready'') and exists(select 1 from public.units card_u where card_u.store_id=v_store and card_u.sku=b.sku and public.unit_inventory_bucket(card_u)=substring(p_status from 11))) or (p_status=''dns''');
  v:=replace(v,'p_status in (''dns'',''sold'',''all'',''voided'')','p_status in (''dns'',''sold'',''all'',''voided'',''inventory_total'')');
  v:=replace(v,'when p_unfinished or p_status = ''needs_check''','when p_unfinished or p_status in (''needs_check'',''inventory_not_ready'')');
  execute v; hits:=hits+1;
 end loop;
 if hits<>3 then raise exception 'Expected 3 inventory list definitions, found %',hits; end if;
end $$;
commit;
