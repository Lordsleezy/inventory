create or replace function public.portal_set_unit_text(p_sku text, p_field text, p_value text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_field text := lower(btrim(coalesce(p_field, '')));
  v_value text := nullif(btrim(coalesce(p_value, '')), '');
  v_old text;
  v_column text;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if v_field not in ('model', 'description', 'brand', 'category', 'condition', 'upc') then
    raise exception 'invalid_text_field' using errcode = '22023';
  end if;
  if v_value is null then raise exception 'value_required' using errcode = '22023'; end if;
  if v_field = 'brand' and v_value ~* '^(generic|unknown|n/?a|does not apply)$' then
    raise exception 'brand_invalid' using errcode = '22023';
  end if;
  if v_field = 'upc' and v_value !~ '^[0-9]{8,14}$' then
    raise exception 'upc_must_be_8_to_14_digits' using errcode = '22023';
  end if;
  v_column := case v_field when 'description' then 'listing_body' else v_field end;
  execute format('select %I from public.units where store_id = $1 and sku = $2 for update', v_column)
    into v_old using v_store, p_sku;
  if not found then raise exception 'unit_not_found' using errcode = 'P0001'; end if;
  execute format('update public.units set %I = $1, updated_at = now() where store_id = $2 and sku = $3', v_column)
    using v_value, v_store, p_sku;
  insert into public.events (store_id, sku, kind, field, old_value, new_value, actor, actor_id)
  values (v_store, p_sku, 'edit', v_column, left(v_old, 200), left(v_value, 200),
    coalesce((select email from auth.users where id = auth.uid()), 'admin'), auth.uid());
end $$;
revoke all on function public.portal_set_unit_text(text, text, text) from public, anon;
grant execute on function public.portal_set_unit_text(text, text, text) to authenticated;

create or replace function public.portal_bulk_set_unit_text(p_skus text[], p_field text, p_value text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_sku text; v_updated int := 0;
begin
  if public.portal_store_id() is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if p_skus is null or cardinality(p_skus) > 200 then raise exception 'bulk_limit' using errcode = '22023'; end if;
  foreach v_sku in array p_skus loop
    if nullif(btrim(coalesce(v_sku, '')), '') is null then continue; end if;
    perform public.portal_set_unit_text(v_sku, p_field, p_value);
    v_updated := v_updated + 1;
  end loop;
  return jsonb_build_object('updated', v_updated);
end $$;
revoke all on function public.portal_bulk_set_unit_text(text[], text, text) from public, anon;
grant execute on function public.portal_bulk_set_unit_text(text[], text, text) to authenticated;

create or replace function public.portal_set_unit_aspect(p_sku text, p_name text, p_value text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_name text := btrim(coalesce(p_name, ''));
  v_value text := nullif(btrim(coalesce(p_value, '')), '');
  v_specs jsonb;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if v_name = '' or v_value is null then raise exception 'value_required' using errcode = '22023'; end if;
  if v_name ~* '^(brand)$' and v_value ~* '^(generic|unknown|n/?a|does not apply)$' then
    raise exception 'brand_invalid' using errcode = '22023';
  end if;
  select listing_specs into v_specs from public.units where store_id = v_store and sku = p_sku for update;
  if not found then raise exception 'unit_not_found' using errcode = 'P0001'; end if;
  v_specs := jsonb_set(coalesce(v_specs, '{}'::jsonb), '{ebay_aspects}',
    coalesce(coalesce(v_specs, '{}'::jsonb)->'ebay_aspects', '{}'::jsonb) || jsonb_build_object(v_name, to_jsonb(v_value)), true);
  update public.units set listing_specs = v_specs,
    brand = case when v_name ~* '^brand$' then v_value else brand end, updated_at = now()
    where store_id = v_store and sku = p_sku;
end $$;
revoke all on function public.portal_set_unit_aspect(text, text, text) from public, anon;
grant execute on function public.portal_set_unit_aspect(text, text, text) to authenticated;