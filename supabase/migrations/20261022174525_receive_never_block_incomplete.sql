-- Receive must never fail on incomplete listing fields. Incomplete units save
-- with no (or kept) ask and show under Needs attention. Drop the legacy
-- portal_receive_unit overload so PostgREST stops returning PGRST203
-- ("Could not choose the best candidate function") which the admin UI was
-- rendering as "[object Object]". Invalid UPC digits are parked in upc_rejected
-- instead of failing the units_upc_valid_gtin check.

-- Single overload only.
drop function if exists public.portal_receive_unit(
  integer, text, text, text, text, text, text, text,
  integer, integer, integer, integer, text, text, text, text,
  numeric, numeric, numeric, numeric
);

create or replace function public.portal_receive_unit(
  p_quantity integer default 1,
  p_brand text default '',
  p_model text default '',
  p_title text default '',
  p_description text default null,
  p_condition text default null,
  p_test_status text default null,
  p_ask_cents integer default null,
  p_cost_cents integer default null,
  p_notes text default null,
  p_upc text default null,
  p_shippable text default null,
  p_length numeric default null,
  p_width numeric default null,
  p_height numeric default null,
  p_weight numeric default null,
  p_category text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.portal_store_id();
  v_start int;
  v_max bigint;
  v_sku text;
  v_skus text[] := array[]::text[];
  v_actor text;
  v_mode text := lower(btrim(coalesce(p_shippable, 'auto')));
  v_override text;
  v_ship boolean;
  v_dim numeric;
  v_upc text := nullif(btrim(coalesce(p_upc, '')), '');
  v_upc_rejected text := null;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if (public.store_setting(v_store, 'skuDigits', '5'::jsonb) #>> '{}')::int <> 5 then
    raise exception 'expected_five_digit_skus' using errcode = '22023';
  end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > 100 then
    raise exception 'quantity_must_be_1_to_100' using errcode = '22023';
  end if;
  if coalesce(p_ask_cents, 0) < 0 or coalesce(p_cost_cents, 0) < 0 then
    raise exception 'negative_amount' using errcode = '22023';
  end if;
  foreach v_dim in array array[p_length, p_width, p_height, p_weight] loop
    if v_dim is not null and v_dim <= 0 then
      raise exception 'dims_must_be_positive' using errcode = '22023';
    end if;
  end loop;

  -- Incomplete listing fields never block receive (Needs attention picks them up).
  -- Invalid barcode digits: keep the raw value for review, do not fail the insert.
  if v_upc is not null and not public.valid_gtin(v_upc) then
    v_upc_rejected := v_upc;
    v_upc := null;
  end if;

  if v_mode in ('', 'auto', 'automatic') then
    v_override := null;
    v_ship := true;
  elsif v_mode in ('yes', 'true', '1', 'ship', 'shippable') then
    v_override := 'ship';
    v_ship := true;
  elsif v_mode in ('no', 'false', '0', 'pickup', 'pickup_only') then
    v_override := 'pickup';
    v_ship := false;
  else
    raise exception 'invalid_shippable' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(687593, hashtext(v_store::text));
  v_start := (public.store_setting(v_store, 'skuStart', '10000'::jsonb) #>> '{}')::int;
  select coalesce(max(sku::bigint), v_start - 1) into v_max
    from public.sku_ledger where store_id = v_store;
  if v_max + p_quantity > 99999 then raise exception 'sku_exhausted' using errcode = '22023'; end if;
  select coalesce(st.display_name, split_part(au.email, '@', 1), 'admin') into v_actor
    from auth.users au
    left join public.staff st on st.user_id = au.id and st.store_id = v_store
    where au.id = auth.uid();

  for i in 1..p_quantity loop
    v_sku := lpad((v_max + i)::text, 5, '0');
    insert into public.sku_ledger(store_id, sku, issued_at, label, fate)
      values (v_store, v_sku, now(), coalesce(p_title, ''), 'issued');
    insert into public.units(
      store_id, sku, brand, model, title, category, listing_body, condition, test_status,
      defect_notes, upc, upc_rejected, acquisition_cost_cents, ask_cents, state, show_on_website,
      shippable, fulfillment_override,
      package_length_in, package_width_in, package_height_in, package_weight_lb,
      dims_source, received_at, updated_at
    ) values (
      v_store, v_sku,
      coalesce(p_brand, ''), coalesce(p_model, ''), coalesce(p_title, ''),
      nullif(btrim(coalesce(p_category, '')), ''),
      nullif(btrim(coalesce(p_description, '')), ''),
      p_condition, p_test_status,
      nullif(btrim(coalesce(p_notes, '')), ''),
      v_upc, v_upc_rejected,
      p_cost_cents, p_ask_cents, 'available', true,
      v_ship, v_override,
      p_length, p_width, p_height, p_weight,
      case when p_length is not null or p_width is not null or p_height is not null or p_weight is not null
        then 'verified' else null end,
      now(), now()
    );
    insert into public.events(store_id, sku, kind, actor, actor_id)
      values (v_store, v_sku, 'received', v_actor, auth.uid());
    v_skus := array_append(v_skus, v_sku);
  end loop;
  return jsonb_build_object('skus', to_jsonb(v_skus));
end $$;

revoke all on function public.portal_receive_unit(
  integer, text, text, text, text, text, text, integer, integer, text, text, text,
  numeric, numeric, numeric, numeric, text
) from public, anon;
grant execute on function public.portal_receive_unit(
  integer, text, text, text, text, text, text, integer, integer, text, text, text,
  numeric, numeric, numeric, numeric, text
) to authenticated;

-- Staff receive_unit: same policy — never block on listing completeness; park bad UPCs.
create or replace function public.receive_unit(
  p_sku text,
  p_brand text default '',
  p_model text default '',
  p_title text default '',
  p_category text default null,
  p_condition text default null,
  p_test_status text default null,
  p_location text default null,
  p_ask_cents integer default null,
  p_msrp_cents integer default null,
  p_cost_cents integer default null,
  p_floor_cents integer default null,
  p_notes text default null,
  p_upc text default null,
  p_lot text default null,
  p_mfr_serial text default null,
  p_length numeric default null,
  p_width numeric default null,
  p_height numeric default null,
  p_weight numeric default null
) returns public.units
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
  v_upc text := nullif(btrim(coalesce(p_upc, '')), '');
  v_upc_rejected text := null;
begin
  perform public.assert_staff_or_service();
  if v_store is null then
    raise exception 'no_store' using errcode = 'P0001';
  end if;
  if not public.is_sku(v_sku) then
    raise exception 'invalid_sku' using errcode = '22023';
  end if;

  if v_upc is not null and not public.valid_gtin(v_upc) then
    v_upc_rejected := v_upc;
    v_upc := null;
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
    mfr_serial, defect_notes, upc, upc_rejected, lot, acquisition_cost_cents, msrp_cents, ask_cents,
    floor_cents, state, show_on_website, received_at, updated_at,
    package_length_in, package_width_in, package_height_in, package_weight_lb, dims_source
  ) values (
    v_store, v_sku, coalesce(p_brand,''), coalesce(p_model,''), coalesce(p_title,''),
    p_category, p_condition, p_test_status, p_location, p_mfr_serial, p_notes, v_upc, v_upc_rejected, p_lot,
    v_cost, p_msrp_cents, p_ask_cents, v_floor, 'available', false, now(), now(),
    p_length, p_width, p_height, p_weight,
    case when p_length is not null or p_width is not null or p_height is not null or p_weight is not null
      then 'verified' else null end
  )
  returning * into v_row;

  if v_reuse then
    insert into public.events (store_id, sku, kind, actor, actor_id, note)
    values (v_store, v_sku, 'sku_reused', v_actor, auth.uid(), 'reused after delete with no sale');
  end if;

  insert into public.events (store_id, sku, kind, actor, actor_id, note)
  values (v_store, v_sku, 'received', v_actor, auth.uid(), null);
  return v_row;
end $$;

grant execute on function public.receive_unit(
  text, text, text, text, text, text, text, text, integer, integer, integer, integer,
  text, text, text, text, numeric, numeric, numeric, numeric
) to authenticated;

-- Point video scan at the single portal_receive_unit signature.
create or replace function public.video_scan_receive(p_id uuid, p_draft jsonb, p_ask_cents int)
returns jsonb language plpgsql security definer set search_path = public as $$
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
  v_length numeric;
  v_width numeric;
  v_height numeric;
  v_weight numeric;
  v_num text;
begin
  if v_store is null then raise exception 'scan_access_denied' using errcode = '42501'; end if;
  if p_ask_cents is null or p_ask_cents <= 0 then raise exception 'selling_price_required' using errcode = '22023'; end if;
  select * into v_job from public.video_scan_jobs where id = p_id and store_id = v_store and created_by = auth.uid() for update;
  if not found then raise exception 'scan_not_found' using errcode = 'P0001'; end if;
  if v_job.status = 'saved' then return jsonb_build_object('sku', v_job.sku); end if;
  if v_job.status <> 'ready' then raise exception 'scan_not_ready' using errcode = 'P0001'; end if;
  if jsonb_typeof(p_draft) <> 'object' then raise exception 'invalid_draft' using errcode = '22023'; end if;
  v_title := left(coalesce(p_draft->>'title', ''), 240);
  v_msrp := nullif(p_draft->>'msrp_cents', '')::int;
  v_cost := nullif(p_draft->>'acquisition_cost_cents', '')::int;
  v_floor := nullif(p_draft->>'floor_cents', '')::int;
  if v_msrp < 0 or v_cost < 0 or v_floor < 0 then raise exception 'negative_amount' using errcode = '22023'; end if;
  v_num := coalesce(p_draft->>'package_length_in', p_draft->>'length_in', '');
  v_length := case when v_num ~ '^[0-9]+(\.[0-9]+)?$' then v_num::numeric else null end;
  v_num := coalesce(p_draft->>'package_width_in', p_draft->>'width_in', '');
  v_width := case when v_num ~ '^[0-9]+(\.[0-9]+)?$' then v_num::numeric else null end;
  v_num := coalesce(p_draft->>'package_height_in', p_draft->>'height_in', '');
  v_height := case when v_num ~ '^[0-9]+(\.[0-9]+)?$' then v_num::numeric else null end;
  v_num := coalesce(p_draft->>'package_weight_lb', p_draft->>'weight_lb', '');
  v_weight := case when v_num ~ '^[0-9]+(\.[0-9]+)?$' then v_num::numeric else null end;
  if public.portal_store_id() = v_store then
    v_json := public.portal_receive_unit(
      1,
      coalesce(p_draft->>'brand', ''),
      coalesce(p_draft->>'model', ''),
      v_title,
      p_draft->>'description',
      p_draft->>'condition',
      p_draft->>'test_status',
      p_ask_cents,
      v_cost,
      p_draft->>'condition_notes',
      p_draft->>'upc',
      'auto',
      v_length, v_width, v_height, v_weight,
      p_draft->>'category'
    );
    v_sku := v_json->'skus'->>0;
  else
    perform pg_advisory_xact_lock(687593, hashtext(v_store::text));
    v_sku := public.next_sku();
    v_unit := public.receive_unit(
      v_sku, coalesce(p_draft->>'brand', ''), coalesce(p_draft->>'model', ''), v_title,
      p_draft->>'category', p_draft->>'condition', p_draft->>'test_status', p_draft->>'location',
      p_ask_cents, v_msrp, v_cost, v_floor, p_draft->>'condition_notes', p_draft->>'upc', p_draft->>'lot', p_draft->>'mfr_serial',
      v_length, v_width, v_height, v_weight
    );
  end if;
  update public.units set ai_description = p_draft->>'description',
    ebay_title = left(coalesce(p_draft->>'ebay_title', ''), 80), ebay_category = p_draft->>'ebay_category',
    ebay_item_specifics = case when jsonb_typeof(p_draft->'ebay_item_specifics') = 'object' then p_draft->'ebay_item_specifics' else '{}'::jsonb end,
    retail_price_sources = case when jsonb_typeof(p_draft->'retail_prices') = 'array' then p_draft->'retail_prices' else '[]'::jsonb end,
    retail_source_name = p_draft->>'retail_source_name', retail_source_url = p_draft->>'retail_source_url',
    msrp_cents = coalesce(msrp_cents, v_msrp),
    floor_cents = coalesce(floor_cents, v_floor)
    where store_id = v_store and sku = v_sku;
  update public.video_scan_jobs set status = 'saved', sku = v_sku, updated_at = now() where id = p_id;
  return jsonb_build_object('sku', v_sku);
end $$;