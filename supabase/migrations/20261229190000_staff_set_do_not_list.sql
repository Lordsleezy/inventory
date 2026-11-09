-- Phone item edit can mark Do not list the same way Receive can.
-- Writes only the not-for-sale flag. Cost, shippable, and Do not ship stay untouched.

begin;

create or replace function public.staff_inventory_detail(p_sku text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.current_store_id(); v_result jsonb;
begin
  if v_store is null or not exists (
    select 1 from public.staff s where s.user_id = auth.uid() and s.store_id = v_store and s.deactivated_at is null
  ) then raise exception 'staff_access_denied' using errcode = '42501'; end if;
  select jsonb_build_object(
    'unit', jsonb_build_object('sku', u.sku, 'brand', u.brand, 'model', u.model, 'title', u.title, 'category', u.category,
      'condition', u.condition, 'test_status', u.test_status, 'location', u.location, 'ask_cents',
      case when u.state in ('available', 'reserved', 'repair') then u.ask_cents end,
      'state', u.state, 'show_on_website', u.show_on_website, 'received_at', u.received_at, 'updated_at', u.updated_at,
      'package_weight_lb', u.package_weight_lb, 'package_length_in', u.package_length_in,
      'package_width_in', u.package_width_in, 'package_height_in', u.package_height_in, 'upc', u.upc,
      'listing_body', u.listing_body, 'defect_notes', u.defect_notes,
      'qty_on_hand', u.qty_on_hand, 'is_stocked', u.is_stocked,
      'upc_does_not_apply', public.unit_upc_does_not_apply(u.listing_specs),
      'not_for_sale', public.unit_not_for_sale(u.listing_specs),
      'aspects', coalesce(u.listing_specs->'ebay_aspects', '{}'::jsonb)),
    'photos', coalesce((select jsonb_agg(jsonb_build_object(
        'id', p.id, 'path', p.path, 'is_primary', p.is_primary, 'source', p.source)
      order by p.is_primary desc, p.id) from public.photos p where p.store_id = u.store_id and p.sku = u.sku), '[]'::jsonb),
    'listings', '[]'::jsonb
  ) into v_result from public.units u where u.store_id = v_store and u.sku = p_sku;
  if v_result is null then raise exception 'unit_not_found' using errcode = 'P0001'; end if;
  if (v_result #>> '{unit,state}') = 'sold' then
    v_result := jsonb_set(v_result, '{unit}', (v_result->'unit') - 'ask_cents');
  end if;
  return v_result;
end $$;

create or replace function public.staff_set_unit_do_not_list(p_sku text, p_on boolean)
returns jsonb
language plpgsql
security definer
set search_path to public
as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  v_unit public.units;
  v_specs jsonb;
  v_actor text;
begin
  if v_store is null or not (
    public.portal_is_admin()
    or exists (
      select 1 from public.staff s
      where s.user_id = auth.uid() and s.store_id = v_store and s.deactivated_at is null
    )
  ) then
    raise exception 'staff_access_denied' using errcode = '42501';
  end if;
  if p_on is null then
    raise exception 'do_not_list_required' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_sku, '')), '') is null then
    raise exception 'sku_required' using errcode = '22023';
  end if;

  select * into v_unit from public.units where store_id = v_store and sku = p_sku for update;
  if not found then raise exception 'unit_not_found' using errcode = 'P0001'; end if;

  v_specs := coalesce(v_unit.listing_specs, '{}'::jsonb) || jsonb_build_object('do_not_list', p_on);
  if not p_on and coalesce(v_specs->>'hold_reason', '') = 'do_not_list' then
    v_specs := v_specs - 'hold_reason';
  end if;

  update public.units set
    listing_specs = v_specs,
    show_on_website = case
      when p_on then false
      when coalesce(v_specs->>'hold_reason', '') <> '' then show_on_website
      else true
    end,
    updated_at = now()
  where store_id = v_store and sku = p_sku;

  select coalesce(display_name, 'staff') into v_actor
    from public.staff where user_id = auth.uid() and store_id = v_store;

  insert into public.events (store_id, sku, kind, field, old_value, new_value, actor, actor_id)
  values (
    v_store, p_sku, 'edit', 'do_not_list',
    public.unit_not_for_sale(v_unit.listing_specs)::text, p_on::text,
    coalesce(v_actor, 'staff'), auth.uid()
  );

  return jsonb_build_object('sku', p_sku, 'do_not_list', p_on);
end;
$$;

revoke all on function public.staff_set_unit_do_not_list(text, boolean) from public, anon;
grant execute on function public.staff_set_unit_do_not_list(text, boolean) to authenticated;

commit;
