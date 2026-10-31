begin;

-- delete_unit must clear bin allocation rows (and related inventory-only children) before units.
create or replace function public.delete_unit(p_sku text, p_approval_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
begin
  perform public.assert_staff_or_service();
  if v_store is null and auth.role() = 'service_role' then
    select store_id into v_store from public.units where sku = p_sku limit 1;
  end if;
  if v_store is null then
    raise exception 'no_store' using errcode = 'P0001';
  end if;

  if not exists(select 1 from public.units where store_id = v_store and sku = p_sku) then
    raise exception 'sku_not_found' using errcode = 'P0002';
  end if;

  if not public.is_manager() and auth.role() <> 'service_role' then
    if p_approval_id is null or not exists (
      select 1 from public.approvals a
       where a.id = p_approval_id and a.store_id = v_store
         and a.action = 'delete_unit' and a.sku = p_sku
         and a.consumed_at is null and a.created_at > now() - interval '10 minutes'
    ) then
      raise exception 'manager_approval_required' using errcode = 'P0001';
    end if;
    update public.approvals set consumed_at = now() where id = p_approval_id;
  end if;

  if exists(select 1 from public.sales where sku = p_sku and store_id = v_store) then
    raise exception 'unit_has_sales_history' using errcode = 'P0001';
  end if;

  if exists(
    select 1 from public.floor_bundles b
     where b.store_id = v_store and (b.sku = p_sku or b.main_sku = p_sku)
  ) or exists(
    select 1 from public.floor_bundle_components c
     where c.store_id = v_store and c.component_sku = p_sku
  ) then
    raise exception 'unit_in_bundle' using errcode = 'P0001';
  end if;

  delete from public.unit_location_stock where sku = p_sku and store_id = v_store;
  delete from public.unit_pick_locations where sku = p_sku and store_id = v_store;
  delete from public.floor_listing_push_intents where sku = p_sku and store_id = v_store;
  delete from public.listings where sku = p_sku and store_id = v_store;
  delete from public.photos where sku = p_sku and store_id = v_store;
  delete from public.units where sku = p_sku and store_id = v_store;
  update public.sku_ledger set fate = 'hard-deleted' where sku = p_sku and store_id = v_store;
  insert into public.events (store_id, sku, kind, actor, actor_id)
  values (
    v_store, p_sku, 'deleted',
    coalesce((select display_name from public.staff where user_id = auth.uid()), 'staff'),
    auth.uid()
  );
end;
$$;

commit;
