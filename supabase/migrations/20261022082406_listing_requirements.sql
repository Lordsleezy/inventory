-- Listing requirements live on the unit. A priced receive must have brand, title,
-- category, condition, UPC, and package size. Incomplete units can still be
-- received with no ask and show up in Needs attention. No trigger on units,
-- so later edits and tests that insert a priced row are unchanged.
-- Backfill copies only values already stored. It does not invent a brand,
-- a dimension, or an Unbranded label.

begin;

create or replace function public.assert_ready_listing_fields(
  p_ask integer,
  p_brand text,
  p_condition text,
  p_title text,
  p_category text,
  p_upc text,
  p_length numeric,
  p_width numeric,
  p_height numeric,
  p_weight numeric
) returns void
language plpgsql
as $$
declare
  v_brand text := btrim(coalesce(p_brand, ''));
begin
  if p_ask is null then
    return;
  end if;
  if v_brand = '' then
    raise exception 'brand_required' using errcode = '22023';
  end if;
  if v_brand ~* '^(generic|unknown|n/?a|does not apply)$' then
    raise exception 'brand_invalid' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_condition, '')), '') is null then
    raise exception 'condition_required' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_title, '')), '') is null then
    raise exception 'title_required' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_category, '')), '') is null then
    raise exception 'category_required' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_upc, '')), '') is null or btrim(p_upc) !~ '^[0-9]{8,14}$' then
    raise exception 'upc_required' using errcode = '22023';
  end if;
  if coalesce(p_length, 0) <= 0 or coalesce(p_width, 0) <= 0
     or coalesce(p_height, 0) <= 0 or coalesce(p_weight, 0) <= 0 then
    raise exception 'package_required' using errcode = '22023';
  end if;
end $$;

create or replace function public.missing_ebay_aspect_names(p_defs jsonb, p_aspects jsonb, p_specs jsonb)
returns text
language sql
immutable
as $$
  select nullif(string_agg(name, ', ' order by name), '')
  from (
    select distinct btrim(def->>'name') as name
    from jsonb_array_elements(case when jsonb_typeof(p_defs) = 'array' then p_defs else '[]'::jsonb end) def
    where lower(coalesce(def->>'required', '')) in ('true', 't')
      and btrim(coalesce(def->>'name', '')) !~* '^(brand|upc|mpn)$'
      and nullif(btrim(coalesce(
        case when jsonb_typeof(p_aspects->(def->>'name')) = 'array' then p_aspects->(def->>'name')->>0 else p_aspects->>(def->>'name') end,
        case when jsonb_typeof(coalesce(p_specs, '{}'::jsonb)->'ebay_aspects'->(def->>'name')) = 'array'
          then coalesce(p_specs, '{}'::jsonb)->'ebay_aspects'->(def->>'name')->>0
          else coalesce(p_specs, '{}'::jsonb)#>>array['ebay_aspects', def->>'name'] end
      )), '') is null
  ) q
  where name <> '';
$$;

-- Admin receive. p_category is appended so existing named calls keep working.
drop function if exists public.portal_receive_unit(integer, text, text, text, text, text, text, integer, integer, text, text, text, numeric, numeric, numeric, numeric);

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
  perform public.assert_ready_listing_fields(
    p_ask_cents, p_brand, p_condition, p_title, p_category, p_upc, p_length, p_width, p_height, p_weight
  );

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
      defect_notes, upc, acquisition_cost_cents, ask_cents, state, show_on_website,
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
      nullif(btrim(coalesce(p_upc, '')), ''),
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

revoke all on function public.portal_receive_unit(integer, text, text, text, text, text, text, integer, integer, text, text, text, numeric, numeric, numeric, numeric, text) from public, anon;
grant execute on function public.portal_receive_unit(integer, text, text, text, text, text, text, integer, integer, text, text, text, numeric, numeric, numeric, numeric, text) to authenticated;

drop function if exists public.portal_receive_unit(integer, text, text, text, text, text, text, text, integer, integer, integer, integer, text, text, text, text);

create or replace function public.portal_receive_unit(
  p_quantity integer default 1,
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
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.portal_receive_unit(
    p_quantity, p_brand, p_model, p_title, null::text, p_condition, p_test_status,
    p_ask_cents, p_cost_cents, p_notes, p_upc, 'auto'::text,
    p_length, p_width, p_height, p_weight, p_category
  );
end $$;

revoke all on function public.portal_receive_unit(integer, text, text, text, text, text, text, text, integer, integer, integer, integer, text, text, text, text, numeric, numeric, numeric, numeric) from public, anon;
grant execute on function public.portal_receive_unit(integer, text, text, text, text, text, text, text, integer, integer, integer, integer, text, text, text, text, numeric, numeric, numeric, numeric) to authenticated;

drop function if exists public.receive_unit(text, text, text, text, text, text, text, text, integer, integer, integer, integer, text, text, text, text);

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
begin
  perform public.assert_staff_or_service();
  if v_store is null then
    raise exception 'no_store' using errcode = 'P0001';
  end if;
  if not public.is_sku(v_sku) then
    raise exception 'invalid_sku' using errcode = '22023';
  end if;
  perform public.assert_ready_listing_fields(
    p_ask_cents, p_brand, p_condition, p_title, p_category, p_upc, p_length, p_width, p_height, p_weight
  );

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
    floor_cents, state, show_on_website, received_at, updated_at,
    package_length_in, package_width_in, package_height_in, package_weight_lb, dims_source
  ) values (
    v_store, v_sku, coalesce(p_brand,''), coalesce(p_model,''), coalesce(p_title,''),
    p_category, p_condition, p_test_status, p_location, p_mfr_serial, p_notes, p_upc, p_lot,
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

grant execute on function public.receive_unit(text, text, text, text, text, text, text, text, integer, integer, integer, integer, text, text, text, text, numeric, numeric, numeric, numeric) to authenticated;

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
      1, coalesce(p_draft->>'brand', ''), coalesce(p_draft->>'model', ''), v_title,
      p_draft->>'category', p_draft->>'condition', p_draft->>'test_status', p_draft->>'location',
      p_ask_cents, v_msrp, v_cost, v_floor, p_draft->>'condition_notes', p_draft->>'upc', p_draft->>'lot', p_draft->>'mfr_serial',
      v_length, v_width, v_height, v_weight
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
    retail_source_name = p_draft->>'retail_source_name', retail_source_url = p_draft->>'retail_source_url'
    where store_id = v_store and sku = v_sku;
  update public.video_scan_jobs set status = 'saved', sku = v_sku, updated_at = now() where id = p_id;
  return jsonb_build_object('sku', v_sku);
end $$;

-- Copy stored eBay specifics onto the unit when the unit has none. Skip junk brands.
update public.units u
set listing_specs = jsonb_set(
      coalesce(u.listing_specs, '{}'::jsonb),
      '{ebay_aspects}',
      src.clean,
      true
    ),
    updated_at = now()
from (
  select d.store_id, d.sku,
    (
      select coalesce(jsonb_object_agg(e.key, case when jsonb_typeof(e.value) = 'array' then e.value->0 else e.value end), '{}'::jsonb)
      from jsonb_each(case when jsonb_typeof(d.aspects) = 'object' then d.aspects else '{}'::jsonb end) e
      where nullif(btrim(case when jsonb_typeof(e.value) = 'array' then e.value->>0 else e.value#>>'{}' end), '') is not null
        and not (
          e.key ~* '^brand$'
          and btrim(case when jsonb_typeof(e.value) = 'array' then e.value->>0 else e.value#>>'{}' end)
              ~* '^(unbranded|generic|unknown|n/?a|does not apply)$'
        )
    ) as clean
  from public.ebay_drafts d
) src
where u.store_id = src.store_id and u.sku = src.sku
  and src.clean <> '{}'::jsonb
  and (
    u.listing_specs->'ebay_aspects' is null
    or u.listing_specs->'ebay_aspects' = '{}'::jsonb
  );

update public.units u
set brand = btrim(case
      when jsonb_typeof(u.listing_specs->'ebay_aspects'->'Brand') = 'array' then u.listing_specs->'ebay_aspects'->'Brand'->>0
      else u.listing_specs#>>'{ebay_aspects,Brand}'
    end),
    updated_at = now()
where nullif(btrim(coalesce(u.brand, '')), '') is null
  and nullif(btrim(coalesce(
    case when jsonb_typeof(u.listing_specs->'ebay_aspects'->'Brand') = 'array' then u.listing_specs->'ebay_aspects'->'Brand'->>0
         else u.listing_specs#>>'{ebay_aspects,Brand}' end, '')), '') is not null
  and btrim(coalesce(
    case when jsonb_typeof(u.listing_specs->'ebay_aspects'->'Brand') = 'array' then u.listing_specs->'ebay_aspects'->'Brand'->>0
         else u.listing_specs#>>'{ebay_aspects,Brand}' end, ''))
      !~* '^(unbranded|generic|unknown|n/?a|does not apply)$';

update public.units u
set category = btrim(d.category_name), updated_at = now()
from public.ebay_drafts d
where u.store_id = d.store_id and u.sku = d.sku
  and nullif(btrim(coalesce(u.category, '')), '') is null
  and nullif(btrim(coalesce(d.category_name, '')), '') is not null;

update public.units u
set listing_specs = jsonb_set(coalesce(u.listing_specs, '{}'::jsonb), '{ebay_category_id}', to_jsonb(btrim(d.category_id)), true),
    updated_at = now()
from public.ebay_drafts d
where u.store_id = d.store_id and u.sku = d.sku
  and nullif(btrim(coalesce(d.category_id, '')), '') is not null
  and nullif(btrim(coalesce(u.listing_specs->>'ebay_category_id', '')), '') is null;

update public.units u
set upc = src.upc, updated_at = now()
from (
  select d.store_id, d.sku,
    substring(btrim(coalesce(
      case when jsonb_typeof(d.aspects->'UPC') = 'array' then d.aspects->'UPC'->>0 else d.aspects->>'UPC' end,
      case when jsonb_typeof(d.aspects->'GTIN') = 'array' then d.aspects->'GTIN'->>0 else d.aspects->>'GTIN' end,
      ''
    )) from '^[0-9]{8,14}$') as upc
  from public.ebay_drafts d
) src
where u.store_id = src.store_id and u.sku = src.sku
  and nullif(btrim(coalesce(u.upc, '')), '') is null
  and src.upc is not null;

update public.units u
set model = left(btrim(case
      when jsonb_typeof(u.listing_specs->'ebay_aspects'->'Model') = 'array' then u.listing_specs->'ebay_aspects'->'Model'->>0
      else u.listing_specs#>>'{ebay_aspects,Model}' end), 80),
    updated_at = now()
where nullif(btrim(coalesce(u.model, '')), '') is null
  and nullif(btrim(coalesce(
    case when jsonb_typeof(u.listing_specs->'ebay_aspects'->'Model') = 'array' then u.listing_specs->'ebay_aspects'->'Model'->>0
         else u.listing_specs#>>'{ebay_aspects,Model}' end, '')), '') is not null
  and btrim(coalesce(
    case when jsonb_typeof(u.listing_specs->'ebay_aspects'->'Model') = 'array' then u.listing_specs->'ebay_aspects'->'Model'->>0
         else u.listing_specs#>>'{ebay_aspects,Model}' end, ''))
      !~* '^(does not apply|unknown|n/?a|generic)$';

update public.units u
set package_length_in = (u.listing_specs->>'package_length_in')::numeric
where u.package_length_in is null
  and coalesce(u.listing_specs->>'package_length_in', '') ~ '^[0-9]+(\.[0-9]+)?$'
  and (u.listing_specs->>'package_length_in')::numeric > 0;
update public.units u
set package_width_in = (u.listing_specs->>'package_width_in')::numeric
where u.package_width_in is null
  and coalesce(u.listing_specs->>'package_width_in', '') ~ '^[0-9]+(\.[0-9]+)?$'
  and (u.listing_specs->>'package_width_in')::numeric > 0;
update public.units u
set package_height_in = (u.listing_specs->>'package_height_in')::numeric
where u.package_height_in is null
  and coalesce(u.listing_specs->>'package_height_in', '') ~ '^[0-9]+(\.[0-9]+)?$'
  and (u.listing_specs->>'package_height_in')::numeric > 0;
update public.units u
set package_weight_lb = (u.listing_specs->>'package_weight_lb')::numeric
where u.package_weight_lb is null
  and coalesce(u.listing_specs->>'package_weight_lb', '') ~ '^[0-9]+(\.[0-9]+)?$'
  and (u.listing_specs->>'package_weight_lb')::numeric > 0;

create or replace function public.portal_units_missing_field(
  p_kind text,
  p_limit int default 100,
  p_offset int default 0
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_kind text := lower(btrim(coalesce(p_kind, '')));
  v_blocks text;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if v_kind not in ('photo', 'price', 'spec', 'model', 'description', 'brand', 'upc', 'condition', 'category', 'specifics') then
    raise exception 'invalid_missing_kind' using errcode = '22023';
  end if;
  v_blocks := case v_kind
    when 'brand' then 'eBay, Amazon, TikTok'
    when 'category' then 'eBay, TikTok'
    when 'specifics' then 'eBay'
    when 'spec' then 'eBay, Amazon, TikTok'
    when 'upc' then 'eBay, Amazon'
    when 'photo' then 'eBay, Amazon, TikTok'
    when 'price' then 'eBay, Amazon, TikTok, Depop'
    when 'condition' then 'eBay, Amazon, TikTok'
    else null
  end;
  return jsonb_build_object(
    'kind', v_kind,
    'blocks', v_blocks,
    'total', (
      select count(*) from public.units u
      left join lateral (
        select public.missing_ebay_aspect_names(d.aspect_defs, d.aspects, u.listing_specs) as names,
               nullif(btrim(coalesce(d.category_id, '')), '') is not null as has_category
        from public.ebay_drafts d
        where d.store_id = u.store_id and d.sku = u.sku
        limit 1
      ) gap on true
      where u.store_id = v_store
        and u.state in ('available', 'reserved', 'repair')
        and (
          (v_kind = 'photo' and not exists (select 1 from public.photos p where p.store_id = u.store_id and p.sku = u.sku))
          or (v_kind = 'price' and u.ask_cents is null)
          or (v_kind = 'spec' and (
            coalesce(u.package_weight_lb, 0) <= 0 or coalesce(u.package_length_in, 0) <= 0
            or coalesce(u.package_width_in, 0) <= 0 or coalesce(u.package_height_in, 0) <= 0))
          or (v_kind = 'model' and nullif(btrim(coalesce(u.model, '')), '') is null)
          or (v_kind = 'description' and nullif(btrim(coalesce(u.listing_body, '')), '') is null)
          or (v_kind = 'brand' and (
            nullif(btrim(coalesce(u.brand, '')), '') is null
            or u.brand ~* '^(generic|unknown|n/?a|does not apply)$'))
          or (v_kind = 'upc' and (
            nullif(btrim(coalesce(u.upc, '')), '') is null
            or btrim(u.upc) !~ '^[0-9]{8,14}$'))
          or (v_kind = 'condition' and nullif(btrim(coalesce(u.condition, '')), '') is null)
          or (v_kind = 'category' and nullif(btrim(coalesce(u.category, '')), '') is null
            and nullif(btrim(coalesce(u.ebay_category, '')), '') is null
            and nullif(btrim(coalesce(u.listing_specs->>'ebay_category_id', '')), '') is null
            and coalesce(gap.has_category, false) = false)
          or (v_kind = 'specifics' and nullif(btrim(coalesce(gap.names, '')), '') is not null)
        )
    ),
    'rows', coalesce((
      select jsonb_agg(x) from (
        select u.sku,
          coalesce(nullif(btrim(u.title), ''), nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), 'Item') as title,
          u.brand, u.model, u.category, u.condition, u.upc, u.state, u.ask_cents, u.received_at,
          u.package_weight_lb, u.package_length_in, u.package_width_in, u.package_height_in,
          (select count(*)::int from public.photos p where p.store_id = u.store_id and p.sku = u.sku) as photo_count,
          v_blocks as blocks,
          gap.names as missing_aspects
        from public.units u
        left join lateral (
          select public.missing_ebay_aspect_names(d.aspect_defs, d.aspects, u.listing_specs) as names,
                 nullif(btrim(coalesce(d.category_id, '')), '') is not null as has_category
          from public.ebay_drafts d
          where d.store_id = u.store_id and d.sku = u.sku
          limit 1
        ) gap on true
        where u.store_id = v_store
          and u.state in ('available', 'reserved', 'repair')
          and (
            (v_kind = 'photo' and not exists (select 1 from public.photos p where p.store_id = u.store_id and p.sku = u.sku))
            or (v_kind = 'price' and u.ask_cents is null)
            or (v_kind = 'spec' and (
              coalesce(u.package_weight_lb, 0) <= 0 or coalesce(u.package_length_in, 0) <= 0
              or coalesce(u.package_width_in, 0) <= 0 or coalesce(u.package_height_in, 0) <= 0))
            or (v_kind = 'model' and nullif(btrim(coalesce(u.model, '')), '') is null)
            or (v_kind = 'description' and nullif(btrim(coalesce(u.listing_body, '')), '') is null)
            or (v_kind = 'brand' and (
              nullif(btrim(coalesce(u.brand, '')), '') is null
              or u.brand ~* '^(generic|unknown|n/?a|does not apply)$'))
            or (v_kind = 'upc' and (
              nullif(btrim(coalesce(u.upc, '')), '') is null
              or btrim(u.upc) !~ '^[0-9]{8,14}$'))
            or (v_kind = 'condition' and nullif(btrim(coalesce(u.condition, '')), '') is null)
            or (v_kind = 'category' and nullif(btrim(coalesce(u.category, '')), '') is null
              and nullif(btrim(coalesce(u.ebay_category, '')), '') is null
              and nullif(btrim(coalesce(u.listing_specs->>'ebay_category_id', '')), '') is null
              and coalesce(gap.has_category, false) = false)
            or (v_kind = 'specifics' and nullif(btrim(coalesce(gap.names, '')), '') is not null)
          )
        order by u.received_at desc nulls last, u.sku desc
        limit greatest(p_limit, 1) offset greatest(p_offset, 0)
      ) x
    ), '[]'::jsonb)
  );
end $$;

revoke all on function public.portal_units_missing_field(text, int, int) from public, anon;
grant execute on function public.portal_units_missing_field(text, int, int) to authenticated;

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
  if v_value is null then
    raise exception 'value_required' using errcode = '22023';
  end if;
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
  values (
    v_store, p_sku, 'edit', v_column, left(v_old, 200), left(v_value, 200),
    coalesce((select email from auth.users where id = auth.uid()), 'admin'), auth.uid()
  );
end $$;

revoke all on function public.portal_set_unit_text(text, text, text) from public, anon;
grant execute on function public.portal_set_unit_text(text, text, text) to authenticated;

create or replace function public.portal_bulk_set_unit_text(p_skus text[], p_field text, p_value text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_sku text;
  v_updated int := 0;
begin
  if public.portal_store_id() is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if p_skus is null or cardinality(p_skus) > 200 then
    raise exception 'bulk_limit' using errcode = '22023';
  end if;
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
  v_specs := jsonb_set(
    coalesce(v_specs, '{}'::jsonb),
    '{ebay_aspects}',
    coalesce(coalesce(v_specs, '{}'::jsonb)->'ebay_aspects', '{}'::jsonb) || jsonb_build_object(v_name, to_jsonb(v_value)),
    true
  );
  update public.units
    set listing_specs = v_specs,
        brand = case when v_name ~* '^brand$' then v_value else brand end,
        updated_at = now()
    where store_id = v_store and sku = p_sku;
end $$;

revoke all on function public.portal_set_unit_aspect(text, text, text) from public, anon;
grant execute on function public.portal_set_unit_aspect(text, text, text) to authenticated;

commit;
