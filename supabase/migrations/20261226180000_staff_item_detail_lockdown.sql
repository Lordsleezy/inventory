begin;

-- Clerks set UPC (or mark Does not apply) on the item page without portal_store_id.
create or replace function public.staff_set_unit_upc(p_sku text, p_upc text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_store uuid := public.current_store_id();
  v_unit public.units;
  v_upc text := nullif(btrim(coalesce(p_upc, '')), '');
  v_specs jsonb;
  v_old text;
  v_actor text;
begin
  if v_store is null or not exists (
    select 1 from public.staff s
    where s.user_id = auth.uid() and s.store_id = v_store and s.deactivated_at is null
  ) then
    raise exception 'staff_access_denied' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_sku, '')), '') is null then
    raise exception 'sku_required' using errcode = '22023';
  end if;

  select * into v_unit from public.units where store_id = v_store and sku = p_sku for update;
  if not found then raise exception 'unit_not_found' using errcode = 'P0001'; end if;
  v_old := v_unit.upc;
  v_specs := coalesce(v_unit.listing_specs, '{}'::jsonb);

  select coalesce(st.display_name, split_part(au.email, '@', 1), 'staff') into v_actor
    from auth.users au
    left join public.staff st on st.user_id = au.id and st.store_id = v_store
   where au.id = auth.uid();

  if v_upc is not null and v_upc ~* '^(does not apply|n/?a)$' then
    v_specs := jsonb_set(
      v_specs,
      '{ebay_aspects}',
      coalesce(v_specs->'ebay_aspects', '{}'::jsonb)
        || jsonb_build_object('UPC', to_jsonb('Does not apply'::text)),
      true
    );
    v_specs := v_specs || jsonb_build_object('upc', 'Does not apply');
    update public.units
      set upc = null, listing_specs = v_specs, updated_at = now()
      where store_id = v_store and sku = p_sku
      returning * into v_unit;
    insert into public.events (store_id, sku, kind, field, old_value, new_value, actor, actor_id)
    values (v_store, p_sku, 'edit', 'upc', left(coalesce(v_old, ''), 200), 'Does not apply',
      coalesce(v_actor, 'staff'), auth.uid());
    return jsonb_build_object('sku', v_unit.sku, 'upc', null, 'upc_does_not_apply', true);
  end if;

  if v_upc is null then
    raise exception 'upc_required' using errcode = '22023';
  end if;
  if not public.valid_gtin(v_upc) then
    raise exception 'invalid_gtin' using errcode = '22023';
  end if;

  v_specs := v_specs - 'upc';
  if v_specs ? 'ebay_aspects' then
    v_specs := jsonb_set(v_specs, '{ebay_aspects}', (v_specs->'ebay_aspects') - 'UPC', true);
  end if;

  update public.units
    set upc = v_upc, listing_specs = v_specs, updated_at = now()
    where store_id = v_store and sku = p_sku
    returning * into v_unit;
  insert into public.events (store_id, sku, kind, field, old_value, new_value, actor, actor_id)
  values (v_store, p_sku, 'edit', 'upc', left(coalesce(v_old, ''), 200), left(v_upc, 200),
    coalesce(v_actor, 'staff'), auth.uid());
  return jsonb_build_object('sku', v_unit.sku, 'upc', v_unit.upc, 'upc_does_not_apply', false);
end;
$$;

revoke all on function public.staff_set_unit_upc(text, text) from public, anon;
grant execute on function public.staff_set_unit_upc(text, text) to authenticated, service_role;

-- Same UPC setter for admins (portal_store_id), so the item page uses one code path.
create or replace function public.portal_set_unit_upc(p_sku text, p_upc text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_store uuid := public.portal_store_id();
  v_unit public.units;
  v_upc text := nullif(btrim(coalesce(p_upc, '')), '');
  v_specs jsonb;
  v_old text;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if nullif(btrim(coalesce(p_sku, '')), '') is null then
    raise exception 'sku_required' using errcode = '22023';
  end if;

  select * into v_unit from public.units where store_id = v_store and sku = p_sku for update;
  if not found then raise exception 'unit_not_found' using errcode = 'P0001'; end if;
  v_old := v_unit.upc;
  v_specs := coalesce(v_unit.listing_specs, '{}'::jsonb);

  if v_upc is not null and v_upc ~* '^(does not apply|n/?a)$' then
    v_specs := jsonb_set(
      v_specs,
      '{ebay_aspects}',
      coalesce(v_specs->'ebay_aspects', '{}'::jsonb)
        || jsonb_build_object('UPC', to_jsonb('Does not apply'::text)),
      true
    );
    v_specs := v_specs || jsonb_build_object('upc', 'Does not apply');
    update public.units
      set upc = null, listing_specs = v_specs, updated_at = now()
      where store_id = v_store and sku = p_sku
      returning * into v_unit;
    insert into public.events (store_id, sku, kind, field, old_value, new_value, actor, actor_id)
    values (v_store, p_sku, 'edit', 'upc', left(coalesce(v_old, ''), 200), 'Does not apply',
      coalesce((select email from auth.users where id = auth.uid()), 'admin'), auth.uid());
    return jsonb_build_object('sku', v_unit.sku, 'upc', null, 'upc_does_not_apply', true);
  end if;

  if v_upc is null then
    raise exception 'upc_required' using errcode = '22023';
  end if;
  if not public.valid_gtin(v_upc) then
    raise exception 'invalid_gtin' using errcode = '22023';
  end if;

  v_specs := v_specs - 'upc';
  if v_specs ? 'ebay_aspects' then
    v_specs := jsonb_set(v_specs, '{ebay_aspects}', (v_specs->'ebay_aspects') - 'UPC', true);
  end if;

  update public.units
    set upc = v_upc, listing_specs = v_specs, updated_at = now()
    where store_id = v_store and sku = p_sku
    returning * into v_unit;
  insert into public.events (store_id, sku, kind, field, old_value, new_value, actor, actor_id)
  values (v_store, p_sku, 'edit', 'upc', left(coalesce(v_old, ''), 200), left(v_upc, 200),
    coalesce((select email from auth.users where id = auth.uid()), 'admin'), auth.uid());
  return jsonb_build_object('sku', v_unit.sku, 'upc', v_unit.upc, 'upc_does_not_apply', false);
end;
$$;

revoke all on function public.portal_set_unit_upc(text, text) from public, anon;
grant execute on function public.portal_set_unit_upc(text, text) to authenticated, service_role;

-- Clerk item detail: no listings, shipping rules, or cost. Include fields the item page needs.
create or replace function public.staff_inventory_detail(p_sku text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.current_store_id(); v_result jsonb;
begin
  if v_store is null or not exists (
    select 1 from public.staff s where s.user_id=auth.uid() and s.store_id=v_store and s.deactivated_at is null
  ) then raise exception 'staff_access_denied' using errcode = '42501'; end if;
  select jsonb_build_object(
    'unit',jsonb_build_object(
      'sku',u.sku,'brand',u.brand,'model',u.model,'title',u.title,'category',u.category,
      'condition',u.condition,'test_status',u.test_status,'location',u.location,'ask_cents',
      case when u.state in ('available','reserved','repair') then u.ask_cents end,
      'state',u.state,'show_on_website',u.show_on_website,'received_at',u.received_at,'updated_at',u.updated_at,
      'package_weight_lb',u.package_weight_lb,'package_length_in',u.package_length_in,
      'package_width_in',u.package_width_in,'package_height_in',u.package_height_in,'upc',u.upc,
      'listing_body',u.listing_body,'defect_notes',u.defect_notes,
      'qty_on_hand',u.qty_on_hand,'is_stocked',u.is_stocked,
      'upc_does_not_apply',public.unit_upc_does_not_apply(u.listing_specs),
      'aspects',coalesce(u.listing_specs->'ebay_aspects','{}'::jsonb)),
    'photos',coalesce((select jsonb_agg(jsonb_build_object(
        'id',p.id,'path',p.path,'is_primary',p.is_primary,'source',p.source)
      order by p.is_primary desc,p.id) from public.photos p where p.store_id=u.store_id and p.sku=u.sku),'[]'::jsonb),
    'listings','[]'::jsonb
  ) into v_result from public.units u where u.store_id=v_store and u.sku=p_sku;
  if v_result is null then raise exception 'unit_not_found' using errcode = 'P0001'; end if;
  return v_result;
end $$;

commit;
