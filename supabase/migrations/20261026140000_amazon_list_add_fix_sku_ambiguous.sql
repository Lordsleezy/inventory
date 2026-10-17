-- portal_amazon_list_add RETURNS TABLE(sku ...) shadows the table column
-- name "sku", so ON CONFLICT (store_id, sku) raises:
--   column reference "sku" is ambiguous
-- Use the unique constraint name instead.

create or replace function public.portal_amazon_list_add(p_skus text[], p_note text default ''::text)
returns table(sku text, ok boolean, reason text, matched_by text, input text)
language plpgsql
security definer
set search_path to 'public'
as $function$
#variable_conflict use_column
declare
  v_store uuid := public.portal_store_id();
  v_code text;
  v_note text := coalesce(p_note, '');
  v_norm text;
  v_digits text;
  v_unit public.units%rowtype;
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

    -- 2) UPC / GTIN → prefer oldest available; else any match (may be sold)
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
        select * into v_unit
        from public.units u
        where u.store_id = v_store
          and (
            regexp_replace(coalesce(u.upc, ''), '[^0-9]', '', 'g') = v_digits
            or right(regexp_replace(coalesce(u.upc, ''), '[^0-9]', '', 'g'), 12)
                 = right(v_digits, 12)
            or nullif(ltrim(regexp_replace(coalesce(u.upc, ''), '[^0-9]', '', 'g'), '0'), '')
                 = nullif(ltrim(v_digits, '0'), '')
          )
        order by u.received_at desc nulls last, u.sku asc
        limit 1;
        if found then
          v_found := true;
          v_matched := 'upc';
        end if;
      end if;
    end if;

    if not v_found then
      sku := v_norm; ok := false;
      reason := case when length(v_digits) between 8 and 14 then 'unknown_upc' else 'unknown_sku' end;
      matched_by := null; input := v_norm; return next; continue;
    end if;

    -- Only skip sold / not available
    if v_unit.state is distinct from 'available' then
      sku := v_unit.sku; ok := false; reason := 'already_sold';
      matched_by := v_matched; input := v_norm; return next; continue;
    end if;

    insert into public.amazon_list_items (store_id, sku, note, status, created_by, updated_at)
    values (v_store, v_unit.sku, v_note, 'queued', auth.uid(), now())
    on conflict on constraint amazon_list_items_store_id_sku_key do update
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
