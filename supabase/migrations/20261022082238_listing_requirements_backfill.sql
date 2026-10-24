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

update public.units u
set listing_specs = jsonb_set(coalesce(u.listing_specs, '{}'::jsonb), '{ebay_aspects}', src.clean, true), updated_at = now()
from (
  select d.store_id, d.sku,
    (
      select coalesce(jsonb_object_agg(e.key, case when jsonb_typeof(e.value) = 'array' then e.value->0 else e.value end), '{}'::jsonb)
      from jsonb_each(case when jsonb_typeof(d.aspects) = 'object' then d.aspects else '{}'::jsonb end) e
      where nullif(btrim(case when jsonb_typeof(e.value) = 'array' then e.value->>0 else e.value#>>'{}' end), '') is not null
        and not (e.key ~* '^brand$' and btrim(case when jsonb_typeof(e.value) = 'array' then e.value->>0 else e.value#>>'{}' end) ~* '^(unbranded|generic|unknown|n/?a|does not apply)$')
    ) as clean
  from public.ebay_drafts d
) src
where u.store_id = src.store_id and u.sku = src.sku and src.clean <> '{}'::jsonb
  and (u.listing_specs->'ebay_aspects' is null or u.listing_specs->'ebay_aspects' = '{}'::jsonb);

update public.units u
set brand = btrim(case when jsonb_typeof(u.listing_specs->'ebay_aspects'->'Brand') = 'array' then u.listing_specs->'ebay_aspects'->'Brand'->>0 else u.listing_specs#>>'{ebay_aspects,Brand}' end),
    updated_at = now()
where nullif(btrim(coalesce(u.brand, '')), '') is null
  and nullif(btrim(coalesce(case when jsonb_typeof(u.listing_specs->'ebay_aspects'->'Brand') = 'array' then u.listing_specs->'ebay_aspects'->'Brand'->>0 else u.listing_specs#>>'{ebay_aspects,Brand}' end, '')), '') is not null
  and btrim(coalesce(case when jsonb_typeof(u.listing_specs->'ebay_aspects'->'Brand') = 'array' then u.listing_specs->'ebay_aspects'->'Brand'->>0 else u.listing_specs#>>'{ebay_aspects,Brand}' end, '')) !~* '^(unbranded|generic|unknown|n/?a|does not apply)$';

update public.units u
set category = btrim(d.category_name), updated_at = now()
from public.ebay_drafts d
where u.store_id = d.store_id and u.sku = d.sku
  and nullif(btrim(coalesce(u.category, '')), '') is null
  and nullif(btrim(coalesce(d.category_name, '')), '') is not null;

update public.units u
set listing_specs = jsonb_set(coalesce(u.listing_specs, '{}'::jsonb), '{ebay_category_id}', to_jsonb(btrim(d.category_id)), true), updated_at = now()
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
      case when jsonb_typeof(d.aspects->'GTIN') = 'array' then d.aspects->'GTIN'->>0 else d.aspects->>'GTIN' end, '')) from '^[0-9]{8,14}$') as upc
  from public.ebay_drafts d
) src
where u.store_id = src.store_id and u.sku = src.sku
  and nullif(btrim(coalesce(u.upc, '')), '') is null and src.upc is not null;

update public.units u
set model = left(btrim(case when jsonb_typeof(u.listing_specs->'ebay_aspects'->'Model') = 'array' then u.listing_specs->'ebay_aspects'->'Model'->>0 else u.listing_specs#>>'{ebay_aspects,Model}' end), 80),
    updated_at = now()
where nullif(btrim(coalesce(u.model, '')), '') is null
  and nullif(btrim(coalesce(case when jsonb_typeof(u.listing_specs->'ebay_aspects'->'Model') = 'array' then u.listing_specs->'ebay_aspects'->'Model'->>0 else u.listing_specs#>>'{ebay_aspects,Model}' end, '')), '') is not null
  and btrim(coalesce(case when jsonb_typeof(u.listing_specs->'ebay_aspects'->'Model') = 'array' then u.listing_specs->'ebay_aspects'->'Model'->>0 else u.listing_specs#>>'{ebay_aspects,Model}' end, '')) !~* '^(does not apply|unknown|n/?a|generic)$';

update public.units u set package_length_in = (u.listing_specs->>'package_length_in')::numeric
where u.package_length_in is null and coalesce(u.listing_specs->>'package_length_in', '') ~ '^[0-9]+(\.[0-9]+)?$' and (u.listing_specs->>'package_length_in')::numeric > 0;
update public.units u set package_width_in = (u.listing_specs->>'package_width_in')::numeric
where u.package_width_in is null and coalesce(u.listing_specs->>'package_width_in', '') ~ '^[0-9]+(\.[0-9]+)?$' and (u.listing_specs->>'package_width_in')::numeric > 0;
update public.units u set package_height_in = (u.listing_specs->>'package_height_in')::numeric
where u.package_height_in is null and coalesce(u.listing_specs->>'package_height_in', '') ~ '^[0-9]+(\.[0-9]+)?$' and (u.listing_specs->>'package_height_in')::numeric > 0;
update public.units u set package_weight_lb = (u.listing_specs->>'package_weight_lb')::numeric
where u.package_weight_lb is null and coalesce(u.listing_specs->>'package_weight_lb', '') ~ '^[0-9]+(\.[0-9]+)?$' and (u.listing_specs->>'package_weight_lb')::numeric > 0;