-- Clerks may set selling price (ask). Acquisition cost / floor stay manager-only.

begin;

create or replace function public.receive_unit(
  p_sku text,
  p_brand text default '',
  p_model text default '',
  p_title text default '',
  p_category text default null,
  p_condition text default null,
  p_test_status text default null,
  p_location text default null,
  p_ask_cents int default null,
  p_msrp_cents int default null,
  p_cost_cents int default null,
  p_floor_cents int default null,
  p_notes text default null,
  p_upc text default null,
  p_lot text default null,
  p_mfr_serial text default null
)
returns public.units
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
  v_sku text := btrim(p_sku);
  v_row public.units;
  v_cost int;
  v_floor int;
  v_status text;
  v_actor text;
  v_reuse boolean := false;
begin
  perform public.assert_staff_or_service();
  if v_store is null then
    raise exception 'no_store' using errcode = 'P0001';
  end if;
  if not public.is_sku(v_sku) then
    raise exception 'invalid_sku' using errcode = '22023';
  end if;

  v_status := public.sku_status(v_sku) ->> 'status';
  if v_status = 'taken' then
    raise exception 'SKU % is already in inventory.', v_sku using errcode = 'P0001';
  end if;
  if v_status = 'locked' then
    raise exception 'SKU % was used before and can''t be reused.', v_sku using errcode = 'P0001';
  end if;
  if v_status = 'invalid' then
    raise exception 'invalid_sku' using errcode = '22023';
  end if;

  v_cost := case when public.is_manager() then p_cost_cents else null end;
  v_floor := case when public.is_manager() then p_floor_cents else null end;
  v_actor := coalesce((select display_name from public.staff where user_id = auth.uid()), 'staff');

  if v_status = 'reusable' then
    v_reuse := true;
    update public.sku_ledger
       set fate = 'issued',
           label = coalesce(nullif(btrim(p_title), ''), label)
     where sku = v_sku and store_id is not distinct from v_store;
  else
    insert into public.sku_ledger (store_id, sku, issued_at, label, fate)
    values (v_store, v_sku, now(), coalesce(p_title, ''), 'issued');
  end if;

  insert into public.units (
    store_id, sku, brand, model, title, category, condition, test_status, location,
    mfr_serial, defect_notes, upc, lot, acquisition_cost_cents, msrp_cents, ask_cents,
    floor_cents, state, show_on_website, received_at, updated_at
  ) values (
    v_store, v_sku, coalesce(p_brand,''), coalesce(p_model,''), coalesce(p_title,''),
    p_category, p_condition, p_test_status, p_location, p_mfr_serial, p_notes, p_upc, p_lot,
    v_cost, p_msrp_cents, p_ask_cents, v_floor, 'available', false, now(), now()
  )
  returning * into v_row;

  if v_reuse then
    insert into public.events (store_id, sku, kind, actor, actor_id, note)
    values (v_store, v_sku, 'sku_reused', v_actor, auth.uid(), 'reused after delete with no sale');
  end if;

  insert into public.events (store_id, sku, kind, actor, actor_id, note)
  values (v_store, v_sku, 'received', v_actor, auth.uid(), null);
  return v_row;
end;
$$;

grant execute on function public.receive_unit(text, text, text, text, text, text, text, text, int, int, int, int, text, text, text, text) to authenticated;

create or replace function public.update_unit_field(p_sku text, p_field text, p_value text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
  v_old text;
  v_manager_fields text[] := array[
    'brand','model','title','category','mfr_serial','upc','lot',
    'acquisition_cost_cents','msrp_cents','floor_cents',
    'listing_body','listing_specs','show_on_website','shippable',
    'shipping_cents','fulfillment_override','dims_source',
    'requires_power','is_electrical','is_camera',
    'has_stock_photos','has_ai_images','has_manufacturer_photos','is_collectible',
    'package_length_in','package_width_in','package_height_in','package_weight_lb',
    'product_height_in','product_width_in','product_depth_in','product_weight_lb'
  ];
  v_staff_fields text[] := array[
    'condition','test_status','location','defect_notes','qty_on_hand','ask_cents'
  ];
  v_num_fields text[] := array[
    'package_length_in','package_width_in','package_height_in','package_weight_lb',
    'product_height_in','product_width_in','product_depth_in','product_weight_lb'
  ];
  v_bool_fields text[] := array[
    'show_on_website','shippable','requires_power','is_electrical','is_camera',
    'has_stock_photos','has_ai_images','has_manufacturer_photos','is_collectible'
  ];
  v_bool boolean;
  v_qty int;
begin
  perform public.assert_staff_or_service();
  if v_store is null then
    raise exception 'no_store' using errcode = 'P0001';
  end if;

  if p_field = any (v_manager_fields) and not public.is_manager() then
    raise exception 'not_manager' using errcode = '42501';
  end if;

  if p_field <> all (v_manager_fields || v_staff_fields) then
    raise exception 'invalid_field' using errcode = '22023';
  end if;

  if p_field = 'show_on_website' and lower(coalesce(p_value, '')) in ('true', '1', 't', 'yes', 'on') then
    perform public.assert_channel_eligible(v_store, p_sku, 'website');
  end if;

  execute format('select %I::text from public.units where sku = $1 and store_id = $2', p_field)
    into v_old using p_sku, v_store;

  if p_field = 'qty_on_hand' then
    if nullif(btrim(coalesce(p_value, '')), '') is null then
      raise exception 'qty_required' using errcode = '22023';
    end if;
    v_qty := p_value::int;
    if v_qty < 0 or v_qty > 9999 then
      raise exception 'qty_out_of_range' using errcode = '22023';
    end if;
    update public.units
       set qty_on_hand = v_qty,
           state = case when v_qty <= 0 then 'sold' else case when state = 'sold' then 'available' else state end end,
           updated_at = now()
     where sku = p_sku and store_id = v_store;
  elsif p_field like '%_cents' then
    execute format('update public.units set %I = $1::int, updated_at = now() where sku = $2 and store_id = $3', p_field)
      using nullif(p_value, ''), p_sku, v_store;
  elsif p_field = any (v_num_fields) then
    if nullif(p_value, '') is not null and p_value::numeric <= 0 then
      raise exception 'must_be_positive' using errcode = '22023';
    end if;
    execute format(
      'update public.units set %I = $1::numeric, dims_source = case when $1 is null then dims_source else ''verified'' end, updated_at = now() where sku = $2 and store_id = $3',
      p_field
    ) using nullif(p_value, ''), p_sku, v_store;
  elsif p_field = 'listing_specs' then
    update public.units set listing_specs = nullif(p_value, '')::jsonb, updated_at = now()
     where sku = p_sku and store_id = v_store;
  elsif p_field = any (v_bool_fields) then
    if nullif(btrim(coalesce(p_value, '')), '') is null and p_field in ('requires_power', 'is_electrical', 'is_camera') then
      v_bool := null;
    else
      v_bool := lower(coalesce(p_value, '')) in ('true', '1', 't', 'yes', 'on');
    end if;
    execute format('update public.units set %I = $1, updated_at = now() where sku = $2 and store_id = $3', p_field)
      using v_bool, p_sku, v_store;
    if p_field = 'is_collectible' and v_bool is true then
      update public.units set acquisition_cost_cents = 0, updated_at = now()
       where sku = p_sku and store_id = v_store;
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
end;
$$;

grant execute on function public.update_unit_field(text, text, text) to authenticated;

create or replace function public.video_scan_receive(p_id uuid, p_draft jsonb, p_ask_cents integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.video_scan_store_id();
  v_job public.video_scan_jobs;
  v_sku text;
  v_json jsonb;
  v_unit public.units;
  v_msrp int;
  v_title text;
  v_cost int;
  v_floor int;
  v_ask int;
begin
  if v_store is null then raise exception 'scan_access_denied' using errcode = '42501'; end if;

  -- Selling price optional for everyone (blank → Unfinished). When provided, store it.
  if p_ask_cents is not null and p_ask_cents <= 0 then
    raise exception 'selling_price_invalid' using errcode = '22023';
  end if;
  v_ask := p_ask_cents;

  select * into v_job
    from public.video_scan_jobs
   where id = p_id and store_id = v_store and created_by = auth.uid()
   for update;
  if not found then raise exception 'scan_not_found' using errcode = 'P0001'; end if;
  if v_job.status = 'saved' then return jsonb_build_object('sku', v_job.sku); end if;
  if v_job.status <> 'ready' then raise exception 'scan_not_ready' using errcode = 'P0001'; end if;
  if jsonb_typeof(p_draft) <> 'object' then raise exception 'invalid_draft' using errcode = '22023'; end if;

  v_title := left(coalesce(p_draft->>'title', ''), 240);
  v_msrp := nullif(p_draft->>'msrp_cents', '')::int;
  if public.is_manager() then
    v_cost := nullif(p_draft->>'acquisition_cost_cents', '')::int;
    v_floor := nullif(p_draft->>'floor_cents', '')::int;
  else
    v_cost := null;
    v_floor := null;
  end if;
  if v_msrp < 0 or v_cost < 0 or v_floor < 0 then
    raise exception 'negative_amount' using errcode = '22023';
  end if;

  if public.portal_store_id() = v_store then
    perform public.assert_manager();
    v_json := public.portal_receive_unit(
      1, coalesce(p_draft->>'brand', ''), coalesce(p_draft->>'model', ''), v_title,
      p_draft->>'category', p_draft->>'condition', p_draft->>'test_status', p_draft->>'location',
      v_ask, v_msrp, v_cost, v_floor, p_draft->>'condition_notes', p_draft->>'upc', p_draft->>'lot', p_draft->>'mfr_serial'
    );
    v_sku := v_json->'skus'->>0;
  else
    perform pg_advisory_xact_lock(687593, hashtext(v_store::text));
    v_sku := public.next_sku();
    v_unit := public.receive_unit(
      v_sku, coalesce(p_draft->>'brand', ''), coalesce(p_draft->>'model', ''), v_title,
      p_draft->>'category', p_draft->>'condition', p_draft->>'test_status', p_draft->>'location',
      v_ask, v_msrp, v_cost, v_floor, p_draft->>'condition_notes', p_draft->>'upc', p_draft->>'lot', p_draft->>'mfr_serial'
    );
  end if;

  update public.units set
    ai_description = p_draft->>'description',
    ebay_title = left(coalesce(p_draft->>'ebay_title', ''), 80),
    ebay_category = p_draft->>'ebay_category',
    ebay_item_specifics = case when jsonb_typeof(p_draft->'ebay_item_specifics') = 'object' then p_draft->'ebay_item_specifics' else '{}'::jsonb end,
    retail_price_sources = case when jsonb_typeof(p_draft->'retail_prices') = 'array' then p_draft->'retail_prices' else '[]'::jsonb end,
    retail_source_name = p_draft->>'retail_source_name',
    retail_source_url = p_draft->>'retail_source_url'
  where store_id = v_store and sku = v_sku;

  update public.video_scan_jobs set status = 'saved', sku = v_sku, updated_at = now() where id = p_id;
  return jsonb_build_object('sku', v_sku);
end;
$$;

grant execute on function public.video_scan_receive(uuid, jsonb, integer) to authenticated;

commit;
