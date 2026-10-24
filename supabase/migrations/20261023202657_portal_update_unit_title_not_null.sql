create or replace function public.portal_update_unit(
  p_sku text,
  p_upc text default null,
  p_brand text default null,
  p_model text default null,
  p_title text default null,
  p_description text default null,
  p_ask_cents integer default null,
  p_cost_cents integer default null,
  p_condition text default null,
  p_test_status text default null,
  p_shippable text default null,
  p_notes text default null,
  p_length numeric default null,
  p_width numeric default null,
  p_height numeric default null,
  p_weight numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_store uuid := public.portal_store_id();
  v_mode text := lower(btrim(coalesce(p_shippable, 'auto')));
  v_override text;
  v_ship boolean;
  v_unit public.units;
  v_dim numeric;
  v_brand text := coalesce(nullif(btrim(coalesce(p_brand, '')), ''), '');
  v_model text := coalesce(nullif(btrim(coalesce(p_model, '')), ''), '');
  v_title text := nullif(btrim(coalesce(p_title, '')), '');
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if nullif(btrim(coalesce(p_sku, '')), '') is null then
    raise exception 'sku_required' using errcode = '22023';
  end if;
  if p_ask_cents is not null and p_ask_cents < 0 then
    raise exception 'ask_must_be_non_negative' using errcode = '22023';
  end if;
  if p_cost_cents is not null and p_cost_cents < 0 then
    raise exception 'cost_must_be_non_negative' using errcode = '22023';
  end if;
  foreach v_dim in array array[p_length, p_width, p_height, p_weight] loop
    if v_dim is not null and v_dim <= 0 then
      raise exception 'dims_must_be_positive' using errcode = '22023';
    end if;
  end loop;

  if v_mode in ('', 'auto', 'automatic') then
    v_override := null;
    v_ship := null;
  elsif v_mode in ('yes', 'true', '1', 'ship', 'shippable') then
    v_override := 'ship';
    v_ship := true;
  elsif v_mode in ('no', 'false', '0', 'pickup', 'pickup_only') then
    v_override := 'pickup';
    v_ship := false;
  else
    raise exception 'invalid_shippable' using errcode = '22023';
  end if;

  if v_title is null then
    v_title := nullif(btrim(concat_ws(' ', nullif(v_brand, ''), nullif(v_model, ''))), '');
  end if;

  select * into v_unit from public.units where store_id = v_store and sku = p_sku for update;
  if not found then raise exception 'unit_not_found' using errcode = 'P0001'; end if;

  if v_title is null then
    v_title := coalesce(nullif(btrim(coalesce(v_unit.title, '')), ''), p_sku);
  end if;

  update public.units set
    upc = nullif(btrim(coalesce(p_upc, '')), ''),
    brand = nullif(v_brand, ''),
    model = nullif(v_model, ''),
    title = v_title,
    listing_body = nullif(btrim(coalesce(p_description, '')), ''),
    ask_cents = p_ask_cents,
    acquisition_cost_cents = p_cost_cents,
    condition = nullif(btrim(coalesce(p_condition, '')), ''),
    test_status = nullif(btrim(coalesce(p_test_status, '')), ''),
    defect_notes = nullif(btrim(coalesce(p_notes, '')), ''),
    package_length_in = p_length,
    package_width_in = p_width,
    package_height_in = p_height,
    package_weight_lb = p_weight,
    dims_source = case
      when p_length is not null or p_width is not null or p_height is not null or p_weight is not null
        then 'verified'
      else dims_source
    end,
    fulfillment_override = case
      when v_mode in ('', 'auto', 'automatic') then null
      else v_override
    end,
    shippable = coalesce(v_ship, shippable),
    updated_at = now()
  where store_id = v_store and sku = p_sku
  returning * into v_unit;

  insert into public.events (store_id, sku, kind, field, old_value, new_value, actor, actor_id)
  values (
    v_store, p_sku, 'edit', 'portal_update_unit', null, 'saved',
    coalesce((select email from auth.users where id = auth.uid()), 'admin'), auth.uid()
  );

  return jsonb_build_object(
    'sku', v_unit.sku,
    'upc', v_unit.upc,
    'brand', v_unit.brand,
    'model', v_unit.model,
    'title', v_unit.title,
    'description', v_unit.listing_body,
    'ask_cents', v_unit.ask_cents,
    'cost_cents', v_unit.acquisition_cost_cents,
    'condition', v_unit.condition,
    'test_status', v_unit.test_status,
    'notes', v_unit.defect_notes,
    'package_length_in', v_unit.package_length_in,
    'package_width_in', v_unit.package_width_in,
    'package_height_in', v_unit.package_height_in,
    'package_weight_lb', v_unit.package_weight_lb,
    'fulfillment_override', v_unit.fulfillment_override,
    'shippable', v_unit.shippable
  );
end;
$$;

revoke all on function public.portal_update_unit(
  text, text, text, text, text, text, integer, integer, text, text, text, text, numeric, numeric, numeric, numeric
) from public, anon;
grant execute on function public.portal_update_unit(
  text, text, text, text, text, text, integer, integer, text, text, text, text, numeric, numeric, numeric, numeric
) to authenticated, service_role;