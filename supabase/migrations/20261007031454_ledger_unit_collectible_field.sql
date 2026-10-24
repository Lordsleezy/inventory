create or replace function public.update_unit_field(p_sku text, p_field text, p_value text)
returns void language plpgsql security definer set search_path to 'public' as $function$
declare
  v_store uuid := public.current_store_id();
  v_old text;
  v_cost_fields text[] := array['acquisition_cost_cents', 'floor_cents'];
  v_num_fields text[] := array['package_length_in','package_width_in','package_height_in','package_weight_lb',
    'product_height_in','product_width_in','product_depth_in','product_weight_lb'];
  v_bool_fields text[] := array['show_on_website','shippable','requires_power','is_electrical','is_camera',
    'has_stock_photos','has_ai_images','has_manufacturer_photos','is_collectible'];
  v_bool boolean;
begin
  perform public.assert_staff_or_service();
  if p_field = any (v_cost_fields) and not public.is_manager() then raise exception 'not_manager' using errcode = '42501'; end if;
  if p_field not in ('brand','model','title','category','condition','test_status','location','mfr_serial','defect_notes','upc','lot',
      'acquisition_cost_cents','msrp_cents','ask_cents','floor_cents','listing_body','listing_specs','show_on_website','shippable',
      'shipping_cents','fulfillment_override','dims_source','requires_power','is_electrical','is_camera',
      'has_stock_photos','has_ai_images','has_manufacturer_photos','is_collectible') and not (p_field = any (v_num_fields)) then
    raise exception 'invalid_field' using errcode = '22023';
  end if;
  if p_field = 'show_on_website' and lower(coalesce(p_value, '')) in ('true', '1', 't', 'yes', 'on') then
    perform public.assert_channel_eligible(v_store, p_sku, 'website');
  end if;
  execute format('select %I::text from public.units where sku = $1 and store_id = $2', p_field) into v_old using p_sku, v_store;
  if p_field like '%_cents' then
    execute format('update public.units set %I = $1::int, updated_at = now() where sku = $2 and store_id = $3', p_field)
      using nullif(p_value, ''), p_sku, v_store;
  elsif p_field = any (v_num_fields) then
    if nullif(p_value, '') is not null and p_value::numeric <= 0 then raise exception 'must_be_positive' using errcode = '22023'; end if;
    execute format('update public.units set %I = $1::numeric, dims_source = case when $1 is null then dims_source else ''verified'' end, updated_at = now() where sku = $2 and store_id = $3', p_field)
      using nullif(p_value, ''), p_sku, v_store;
  elsif p_field = 'listing_specs' then
    update public.units set listing_specs = nullif(p_value, '')::jsonb, updated_at = now() where sku = p_sku and store_id = v_store;
  elsif p_field = any (v_bool_fields) then
    if nullif(btrim(coalesce(p_value, '')), '') is null and p_field in ('requires_power', 'is_electrical', 'is_camera') then
      v_bool := null;
    else
      v_bool := lower(coalesce(p_value, '')) in ('true', '1', 't', 'yes', 'on');
    end if;
    execute format('update public.units set %I = $1, updated_at = now() where sku = $2 and store_id = $3', p_field)
      using v_bool, p_sku, v_store;
    if p_field = 'is_collectible' and v_bool is true then
      update public.units set acquisition_cost_cents = 0, updated_at = now() where sku = p_sku and store_id = v_store;
    end if;
  elsif p_field in ('fulfillment_override', 'dims_source') then
    execute format('update public.units set %I = $1, updated_at = now() where sku = $2 and store_id = $3', p_field)
      using nullif(btrim(p_value), ''), p_sku, v_store;
  else
    execute format('update public.units set %I = $1, updated_at = now() where sku = $2 and store_id = $3', p_field)
      using p_value, p_sku, v_store;
  end if;
  insert into public.events (store_id, sku, kind, field, old_value, new_value, actor, actor_id)
  values (v_store, p_sku, 'edit', p_field, v_old, p_value,
    coalesce((select display_name from public.staff where user_id = auth.uid()), 'staff'), auth.uid());
end; $function$;