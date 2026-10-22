-- Amazon queue add: accept Floor SKU and/or UPC; clearer skip reasons.
-- UPC with multiple available units → oldest received (FIFO). One scan = one unit.

drop function if exists public.portal_amazon_list_add(text[], text);

create or replace function public.portal_amazon_list_add(p_skus text[], p_note text default ''::text)
returns table(sku text, ok boolean, reason text, matched_by text, input text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_store uuid := public.portal_store_id();
  v_code text;
  v_note text := coalesce(p_note, '');
  v_norm text;
  v_digits text;
  v_unit public.units%rowtype;
  v_blob text;
  v_photos int;
  v_matched text;
  v_found boolean;
begin
  if v_store is null or not public.portal_is_admin() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  if p_skus is null or cardinality(p_skus) = 0 then return; end if;
  if cardinality(p_skus) > 500 then raise exception 'too_many_skus' using errcode = '22023'; end if;

  foreach v_code in array p_skus loop
    v_norm := nullif(btrim(v_code), '');
    if v_norm is null then continue; end if;
    v_norm := regexp_replace(v_norm, '[^0-9A-Za-z\-]+', '', 'g');
    if v_norm = '' then continue; end if;
    v_digits := regexp_replace(v_norm, '[^0-9]', '', 'g');
    v_matched := null;
    v_found := false;

    -- 1) Exact Floor SKU
    select * into v_unit
    from public.units u
    where u.store_id = v_store and u.sku = v_norm;
    if found then
      v_found := true;
      v_matched := 'sku';
    end if;

    -- 2) UPC / GTIN (8–14 digits) → oldest available unit
    if not v_found and length(v_digits) between 8 and 14 then
      select * into v_unit
      from public.units u
      where u.store_id = v_store
        and u.state = 'available'
        and (
          regexp_replace(coalesce(u.upc, ''), '[^0-9]', '', 'g') = v_digits
          or right(regexp_replace(coalesce(u.upc, ''), '[^0-9]', '', 'g'), 12)
               = right(v_digits, 12)
          or nullif(ltrim(regexp_replace(coalesce(u.upc, ''), '[^0-9]', '', 'g'), '0'), '')
               = nullif(ltrim(v_digits, '0'), '')
        )
      order by u.received_at asc nulls last, u.sku asc
      limit 1;
      if found then
        v_found := true;
        v_matched := 'upc';
      else
        -- Any unit with this UPC exists but none available?
        if exists (
          select 1 from public.units u
          where u.store_id = v_store
            and (
              regexp_replace(coalesce(u.upc, ''), '[^0-9]', '', 'g') = v_digits
              or right(regexp_replace(coalesce(u.upc, ''), '[^0-9]', '', 'g'), 12)
                   = right(v_digits, 12)
              or nullif(ltrim(regexp_replace(coalesce(u.upc, ''), '[^0-9]', '', 'g'), '0'), '')
                   = nullif(ltrim(v_digits, '0'), '')
            )
        ) then
          sku := v_norm; ok := false; reason := 'already_sold_or_unavailable';
          matched_by := 'upc'; input := v_norm; return next; continue;
        end if;
      end if;
    end if;

    if not v_found then
      sku := v_norm; ok := false;
      reason := case when length(v_digits) between 8 and 14 then 'unknown_upc' else 'unknown_sku' end;
      matched_by := null; input := v_norm; return next; continue;
    end if;

    if v_unit.state is distinct from 'available' then
      sku := v_unit.sku; ok := false; reason := 'already_sold_or_unavailable';
      matched_by := v_matched; input := v_norm; return next; continue;
    end if;
    if coalesce(v_unit.ask_cents, 0) <= 0 then
      sku := v_unit.sku; ok := false; reason := 'no_price';
      matched_by := v_matched; input := v_norm; return next; continue;
    end if;
    select count(*)::int into v_photos
    from public.photos p where p.store_id = v_store and p.sku = v_unit.sku;
    if coalesce(v_photos, 0) = 0 then
      sku := v_unit.sku; ok := false; reason := 'no_photos';
      matched_by := v_matched; input := v_norm; return next; continue;
    end if;
    if v_unit.sku = '11284' then
      sku := v_unit.sku; ok := false; reason := 'never_list_scooter';
      matched_by := v_matched; input := v_norm; return next; continue;
    end if;
    v_blob := lower(concat_ws(' ', v_unit.category, v_unit.title, v_unit.brand, v_unit.model, v_unit.listing_body));
    if v_blob ~ 'scooter|m365|segway|hoverboard|fridge|refrigerator|dishwasher|freezer|mattress|box.?spring|\brug\b|carpet|area\s*rug' then
      sku := v_unit.sku; ok := false; reason := 'never_list_category';
      matched_by := v_matched; input := v_norm; return next; continue;
    end if;

    insert into public.amazon_list_items (store_id, sku, note, status, created_by, updated_at)
    values (v_store, v_unit.sku, v_note, 'queued', auth.uid(), now())
    on conflict (store_id, sku) do update
      set note = case when excluded.note <> '' then excluded.note else public.amazon_list_items.note end,
          status = case when public.amazon_list_items.status = 'removed' then 'queued' else public.amazon_list_items.status end,
          updated_at = now();

    sku := v_unit.sku;
    ok := true;
    reason := case when v_matched = 'upc' then 'added_via_upc' else 'added' end;
    matched_by := v_matched;
    input := v_norm;
    return next;
  end loop;
end
$function$;

grant execute on function public.portal_amazon_list_add(text[], text) to authenticated;
