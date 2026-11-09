-- Staff Do not list: a title is enough, and the unit is defective.
-- An admin Do not list still needs a brand. A clerk who does enter a brand keeps that path.

create or replace function public.require_photo_for_new_unit()
returns trigger language plpgsql security definer set search_path=public,storage as $$
declare
  paths text[];
  supplied text;
  stock_paths text[];
  supplied_stock text;
begin
  if new.state not in ('available','reserved','repair') or coalesce(new.qty_on_hand,0)<1 then return new; end if;
  if current_setting('floor.receive_not_for_sale', true) = 'true' then
    if current_setting('floor.receive_dnl_title_only', true) = 'true' then
      if nullif(btrim(coalesce(new.title, '')), '') is null then
        raise exception 'Title required' using errcode = '23514';
      end if;
      new.condition := 'Defective/non-sellable';
      new.listing_specs := coalesce(new.listing_specs, '{}'::jsonb) || jsonb_build_object('do_not_list', true);
      new.show_on_website := false;
      return new;
    end if;
    if not public.receive_not_for_sale_brand_is_valid(new.brand) then
      raise exception 'Brand required' using errcode='23514';
    end if;
    new.listing_specs := coalesce(new.listing_specs, '{}'::jsonb) || jsonb_build_object('do_not_list', true);
    new.show_on_website := false;
    return new;
  end if;
  supplied := nullif(current_setting('floor.receive_photo_paths', true), '');
  supplied_stock := nullif(current_setting('floor.receive_stock_photo_paths', true), '');
  stock_paths := case when supplied_stock is null then '{}'::text[] else array(select jsonb_array_elements_text(supplied_stock::jsonb)) end;
  if supplied is not null then
    select array_agg(value) into paths from jsonb_array_elements_text(supplied::jsonb);
  else
    select array_agg(o.name order by o.created_at, o.name) into paths
      from storage.objects o
     where o.bucket_id = 'unit-photos'
       and split_part(o.name, '/', 1) = new.store_id::text
       and split_part(o.name, '/', 2) = new.sku
       and o.name not like '%/web/%';
  end if;
  if coalesce(cardinality(paths), 0) = 0 or exists (
    select 1 from unnest(paths) p
     where split_part(p, '/', 1) <> new.store_id::text
        or p like '%/web/%'
        or not exists (select 1 from storage.objects o where o.bucket_id='unit-photos' and o.name=p)
  ) then
    raise exception 'unit_photo_required' using errcode='23514';
  end if;
  if exists(select 1 from unnest(stock_paths) p where not p=any(paths)) then
    raise exception 'invalid_stock_photo' using errcode='23514';
  end if;
  insert into public.photos(store_id, sku, path, original_path, is_primary, source)
  select new.store_id, new.sku, p, p, n=1, case when p=any(stock_paths) then 'stock' else 'camera' end from unnest(paths) with ordinality t(p,n);
  if cardinality(stock_paths)>0 then new.has_stock_photos:=true; end if;
  return new;
end;
$$;

do $$
declare src text;
begin
  select pg_get_functiondef('public.receive_commit(uuid,jsonb,text[],jsonb)'::regprocedure) into src;
  if position('floor.receive_dnl_title_only' in src) > 0 then
    return;
  end if;
  if position('if v_do_not_list and not public.receive_not_for_sale_brand_is_valid(p_fields->>''p_brand'') then raise exception ''Brand required'' using errcode=''22023'';end if;' in src) = 0 then
    raise exception 'receive_commit brand check was not found';
  end if;
  src := replace(src,
    'if v_do_not_list and not public.receive_not_for_sale_brand_is_valid(p_fields->>''p_brand'') then raise exception ''Brand required'' using errcode=''22023'';end if;',
    'if v_do_not_list and not adm then
  p_fields := jsonb_set(p_fields, ''{p_condition}'', to_jsonb(''Defective/non-sellable''::text), true);
  if not public.receive_not_for_sale_brand_is_valid(p_fields->>''p_brand'') then
    if nullif(btrim(p_fields->>''p_title''), '''') is null then raise exception ''Title required'' using errcode=''22023''; end if;
    perform set_config(''floor.receive_dnl_title_only'', ''true'', true);
  end if;
 elsif v_do_not_list and not public.receive_not_for_sale_brand_is_valid(p_fields->>''p_brand'') then raise exception ''Brand required'' using errcode=''22023''; end if;'
  );
  src := replace(src,
    'perform set_config(''floor.receive_not_for_sale'','''',true);',
    'perform set_config(''floor.receive_not_for_sale'','''',true);
 perform set_config(''floor.receive_dnl_title_only'','''',true);'
  );
  if position('floor.receive_dnl_title_only' in src) = 0 then
    raise exception 'receive_commit was not patched';
  end if;
  execute src;
end $$;

create or replace function public.unit_listing_gaps(u public.units)
returns text[] language sql stable set search_path=public as $$
  with f as (
    select public.unit_not_for_sale(u.listing_specs) as nfs,
      public.floor_unit_ebay_gaps(u.store_id,u.sku) as eg,
      exists(select 1 from public.unit_channel_categories c where c.store_id=u.store_id
        and c.sku=u.sku and c.channel='ebay' and c.category_id is not null and c.enabled) as has_category,
      exists(select 1 from public.unit_channel_selections s where s.store_id=u.store_id
        and s.sku=u.sku and s.channel='ebay' and s.selected) as ebay_selected,
      exists(select 1 from public.unit_channel_selections s where s.store_id=u.store_id
        and s.sku=u.sku and s.channel in ('ebay','amazon','tiktok') and s.selected) as any_channel_selected
  )
  select case when public.unit_dns(u.listing_specs) then '{}'::text[] else array_remove(array[
    case when not (f.nfs and nullif(btrim(coalesce(u.title,'')),'') is not null)
      and (nullif(btrim(coalesce(u.brand,'')),'') is null
      or u.brand ~* '^(generic|unknown|n/?a|does not apply)$') then 'brand' end,
    case when not f.nfs and f.ebay_selected and not f.has_category
      and nullif(btrim(coalesce(u.category,'')),'') is null
      and nullif(btrim(coalesce(u.ebay_category,'')),'') is null
      and nullif(btrim(coalesce(u.listing_specs->>'ebay_category_id','')),'') is null then 'category' end,
    case when not f.nfs and f.ebay_selected and 'category'=any(f.eg) and f.has_category then 'category_review' end,
    case when not f.nfs and f.ebay_selected and 'specifics'=any(f.eg) then 'specifics' end,
    case when not f.nfs and f.any_channel_selected and (coalesce(u.package_weight_lb,0)<=0
      or coalesce(u.package_length_in,0)<=0 or coalesce(u.package_width_in,0)<=0
      or coalesce(u.package_height_in,0)<=0) then 'spec' end,
    case when not f.nfs and not public.floor_valid_upc(u.upc) and exists(
      select 1 from public.unit_channel_selections s where s.store_id=u.store_id and s.sku=u.sku
        and s.selected and s.channel in ('amazon','tiktok')) then 'upc' end,
    case when not f.nfs and not exists(select 1 from public.photos p where p.store_id=u.store_id and p.sku=u.sku) then 'photo' end,
    case when not f.nfs and u.ask_cents is null then 'price' end,
    case when not f.nfs and nullif(btrim(coalesce(u.title,'')),'') is null then 'title' end,
    case when not f.nfs and nullif(btrim(coalesce(u.condition,'')),'') is null then 'condition' end,
    case when not f.nfs and nullif(btrim(coalesce(u.model,'')),'') is null then 'model' end,
    case when not f.nfs and nullif(btrim(coalesce(u.listing_body,'')),'') is null then 'description' end,
    case when not f.nfs and f.ebay_selected and u.listing_specs->>'ebay_review_reason' in
      ('review_hygiene','review_supplement','review_quantity','review_contents','review_bundle',
       'review_stove','review_product','review_condition','review_cosmetic') then u.listing_specs->>'ebay_review_reason' end
  ],null) end from f;
$$;
