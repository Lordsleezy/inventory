drop function if exists public.portal_amazon_list();

create or replace function public.portal_amazon_list()
returns table (
  id uuid, sku text, note text, created_at timestamptz, title text, condition text,
  ask_cents int, photo_path text, upc text, flags text[], status text, asin text,
  matched_title text, amazon_price_cents int, fee_estimate_cents int, condition_code text,
  condition_note text, last_error text, listed_at timestamptz, retail_cents int, cost_cents int,
  needs_review_reason text, acquisition_cost_cents int, brand text, model text, state text
)
language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return query
  select a.id, a.sku, a.note, a.created_at,
    coalesce(nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), nullif(u.title, ''), 'Item')::text,
    u.condition::text, u.ask_cents,
    (select p.path from public.photos p where p.store_id = a.store_id and p.sku = a.sku
      order by p.is_primary desc nulls last, p.sort_order nulls last, p.created_at limit 1) as photo_path,
    u.upc,
    array_remove(array[
      case when not exists (select 1 from public.photos p where p.store_id = a.store_id and p.sku = a.sku) then 'no_photo' end,
      case when nullif(btrim(coalesce(u.upc, '')), '') is null
        and nullif(btrim(coalesce(u.listing_specs->>'asin', '')), '') is null
        and nullif(btrim(coalesce(a.asin, '')), '') is null then 'no_upc_asin' end,
      case when coalesce((u.listing_specs->>'amazon_skip')::boolean, false) then 'skip_list' end,
      case when u.state is distinct from 'available' then 'not_available' end,
      case when a.sku = '11284' then 'never_list' end,
      case when coalesce(u.ask_cents, 0) <= 0 then 'no_price' end
    ], null)::text[] as flags,
    a.status, a.asin, a.matched_title, a.amazon_price_cents, a.fee_estimate_cents,
    a.condition_code, a.condition_note, a.last_error, a.listed_at, a.retail_cents, a.cost_cents,
    a.needs_review_reason, u.acquisition_cost_cents, u.brand::text, u.model::text, u.state::text
  from public.amazon_list_items a
  left join public.units u on u.store_id = a.store_id and u.sku = a.sku
  where a.store_id = v_store and a.status is distinct from 'removed'
  order by a.created_at desc;
end $$;
revoke all on function public.portal_amazon_list() from public, anon;
grant execute on function public.portal_amazon_list() to authenticated;

create or replace function public.portal_amazon_list_set_fields(p_sku text, p_patch jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null or not public.portal_is_admin() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  update public.amazon_list_items a set
    status = coalesce(p_patch->>'status', a.status),
    asin = coalesce(nullif(p_patch->>'asin', ''), a.asin),
    matched_title = coalesce(p_patch->>'matched_title', a.matched_title),
    amazon_price_cents = coalesce((p_patch->>'amazon_price_cents')::int, a.amazon_price_cents),
    fee_estimate_cents = coalesce((p_patch->>'fee_estimate_cents')::int, a.fee_estimate_cents),
    condition_code = coalesce(p_patch->>'condition_code', a.condition_code),
    condition_note = coalesce(p_patch->>'condition_note', a.condition_note),
    last_error = case when p_patch ? 'last_error' then p_patch->>'last_error' else a.last_error end,
    needs_review_reason = case when p_patch ? 'needs_review_reason' then p_patch->>'needs_review_reason' else a.needs_review_reason end,
    note = coalesce(p_patch->>'note', a.note),
    updated_at = now()
  where a.store_id = v_store and a.sku = btrim(p_sku);
end $$;
revoke all on function public.portal_amazon_list_set_fields(text, jsonb) from public, anon;
grant execute on function public.portal_amazon_list_set_fields(text, jsonb) to authenticated;

create or replace function public.portal_amazon_list_add(p_skus text[], p_note text default '')
returns table (sku text, ok boolean, reason text)
language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_sku text; v_note text := coalesce(p_note, ''); v_norm text;
  v_unit public.units%rowtype; v_blob text; v_photos int;
begin
  if v_store is null or not public.portal_is_admin() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  if p_skus is null or cardinality(p_skus) = 0 then return; end if;
  if cardinality(p_skus) > 500 then raise exception 'too_many_skus' using errcode = '22023'; end if;
  foreach v_sku in array p_skus loop
    v_norm := nullif(btrim(v_sku), '');
    if v_norm is null then continue; end if;
    v_norm := regexp_replace(v_norm, '[^0-9A-Za-z\-]+', '', 'g');
    if v_norm = '' then continue; end if;
    select * into v_unit from public.units u where u.store_id = v_store and u.sku = v_norm;
    if not found then sku := v_norm; ok := false; reason := 'unknown_sku'; return next; continue; end if;
    if v_unit.state is distinct from 'available' then sku := v_norm; ok := false; reason := 'already_sold_or_unavailable'; return next; continue; end if;
    if coalesce(v_unit.ask_cents, 0) <= 0 then sku := v_norm; ok := false; reason := 'no_price'; return next; continue; end if;
    select count(*)::int into v_photos from public.photos p where p.store_id = v_store and p.sku = v_norm;
    if coalesce(v_photos, 0) = 0 then sku := v_norm; ok := false; reason := 'no_photos'; return next; continue; end if;
    if v_norm = '11284' then sku := v_norm; ok := false; reason := 'never_list_scooter'; return next; continue; end if;
    v_blob := lower(concat_ws(' ', v_unit.category, v_unit.title, v_unit.brand, v_unit.model, v_unit.listing_body));
    if v_blob ~ 'scooter|m365|segway|hoverboard|fridge|refrigerator|dishwasher|freezer|mattress|box.?spring|\brug\b|carpet|area\s*rug' then
      sku := v_norm; ok := false; reason := 'never_list_category'; return next; continue;
    end if;
    insert into public.amazon_list_items (store_id, sku, note, status, created_by, updated_at)
    values (v_store, v_norm, v_note, 'queued', auth.uid(), now())
    on conflict (store_id, sku) do update
      set note = case when excluded.note <> '' then excluded.note else public.amazon_list_items.note end,
          status = case when public.amazon_list_items.status = 'removed' then 'queued' else public.amazon_list_items.status end,
          updated_at = now();
    sku := v_norm; ok := true; reason := 'added'; return next;
  end loop;
end $$;
revoke all on function public.portal_amazon_list_add(text[], text) from public, anon;
grant execute on function public.portal_amazon_list_add(text[], text) to authenticated;

create or replace function public.portal_amazon_list_remove(p_sku text)
returns void language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null or not public.portal_is_admin() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  update public.amazon_list_items set status = 'removed', updated_at = now()
  where store_id = v_store and sku = btrim(p_sku);
end $$;
revoke all on function public.portal_amazon_list_remove(text) from public, anon;
grant execute on function public.portal_amazon_list_remove(text) to authenticated;