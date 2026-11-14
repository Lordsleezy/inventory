-- Coverage can count a verified expanded name, category, photo, size, and specifics
-- stored on the lot enrichment book. Manifest identity is unchanged.

create or replace function public.portal_manifest_coverage(p_lot text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
begin
  if auth.uid() is null or v_store is null or coalesce(btrim(p_lot), '') = '' then
    raise exception 'staff_access_denied' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.line_number)
    from (
      select
        l.line_number,
        l.upc_normalized as upc,
        coalesce(nullif(btrim(l.item_number), ''), l.tcin) as item_number,
        l.description,
        l.brand as manifest_brand,
        l.alternate_upcs,
        coalesce(nullif(p.title, ''), c.payload #>> '{merged,title}') as catalog_title,
        nullif(book.entry ->> 'expanded_title', '') as expanded_title,
        coalesce(nullif(p.brand, ''), c.payload #>> '{merged,brand}') as catalog_brand,
        nullif(book.entry ->> 'expanded_brand', '') as expanded_brand,
        coalesce(
          nullif(p.category, ''),
          c.payload #>> '{merged,category}',
          nullif(book.entry ->> 'ebay_category_name', '')
        ) as category,
        (
          p.package_weight_lb is not null or p.package_length_in is not null
          or nullif(c.payload #>> '{merged,package,weight_lb}', '') is not null
          or nullif(c.payload #>> '{merged,package,length_in}', '') is not null
          or nullif(book.entry #>> '{package,weight_lb}', '') is not null
          or nullif(book.entry #>> '{package,length_in}', '') is not null
        ) as has_dims,
        (
          (jsonb_typeof(p.images) = 'array' and jsonb_array_length(p.images) > 0)
          or coalesce(p.photo_path, '') <> ''
          or (jsonb_typeof(c.payload #> '{merged,images}') = 'array' and jsonb_array_length(c.payload #> '{merged,images}') > 0)
          or (jsonb_typeof(book.entry -> 'images') = 'array' and jsonb_array_length(book.entry -> 'images') > 0)
        ) as has_photo,
        (
          (p.aspects is not null and p.aspects <> '{}'::jsonb)
          or (jsonb_typeof(c.payload #> '{merged,aspects}') = 'object' and c.payload #> '{merged,aspects}' <> '{}'::jsonb)
          or (jsonb_typeof(book.entry -> 'specifics') = 'object' and book.entry -> 'specifics' <> '{}'::jsonb)
        ) as has_specifics,
        (
          coalesce(p.aspects->>'identifier_match', '') = 'true'
          or coalesce(c.payload #>> '{amazon,identifier_match}', '') = 'true'
        ) as gtin_match,
        coalesce((book.entry ->> 'identity_accepted') = 'true', false) as identity_accepted
      from public.manifest_lines l
      join public.store_manifests m on m.id = l.manifest_id
      left join public.floor_products p
        on p.gtin14 = lpad(l.upc_normalized, 14, '0')
        and l.upc_normalized !~ '^4999'
      left join public.upc_lookup_cache c
        on c.gtin14 = lpad(l.upc_normalized, 14, '0')
        and l.upc_normalized !~ '^4999'
      left join lateral (
        select s.value -> l.tcin as entry
        from public.store_settings s
        where s.store_id = v_store
          and s.key = 'manifest_line_enrichment_' || l.lot_id
      ) book on true
      where m.store_id = v_store and l.lot_id = btrim(p_lot)
    ) x
  ), '[]'::jsonb);
end $$;

revoke all on function public.portal_manifest_coverage(text) from public, anon;
grant execute on function public.portal_manifest_coverage(text) to authenticated;
