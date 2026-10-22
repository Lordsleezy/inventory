-- Marketplace-tab deletes run in the background worker as service_role.
-- service_role has no staff row, so current_store_id() is null and delete_unit
-- used to match zero rows (and skip the "void the sale first" guard).
-- Resolve the unit's store the same way finalize_sale already does.

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

  if exists (select 1 from public.sales where sku = p_sku and store_id = v_store and voided_at is null) then
    raise exception 'void_the_sale_first' using errcode = 'P0001';
  end if;

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
