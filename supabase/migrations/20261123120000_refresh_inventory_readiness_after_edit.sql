begin;

-- Return only readiness gap keys so the editor can refresh its Missing panel
-- immediately after saving without reloading the full (financial) unit detail.
create or replace function public.portal_unit_readiness_gaps(p_sku text)
returns text[] language plpgsql stable security definer set search_path=public as $$
declare st uuid:=coalesce(public.portal_store_id(),public.current_store_id()); result text[];
begin
  if st is null or auth.uid() is null or (not public.portal_is_admin() and not exists(
    select 1 from public.staff s where s.user_id=auth.uid() and s.store_id=st and s.deactivated_at is null)) then
    raise exception 'portal_access_denied' using errcode='42501';
  end if;
  select public.unit_listing_gaps(u) into result from public.units u
    where u.store_id=st and u.sku=btrim(p_sku);
  if not found then raise exception 'unit_not_found' using errcode='P0002'; end if;
  return coalesce(result,'{}'::text[]);
end $$;
revoke all on function public.portal_unit_readiness_gaps(text) from public,anon;
grant execute on function public.portal_unit_readiness_gaps(text) to authenticated;

-- Read-only before/after assessment for all unsold units. Readiness is derived
-- live from unit_listing_gaps, so this reports what the new rules reclassify;
-- it does not rewrite any inventory/category rows.
create or replace function public.floor_inventory_readiness_recompute()
returns jsonb language sql stable security definer set search_path=public as $$
  with base as (
    select u.*,public.unit_listing_gaps(u) as new_gaps,
      public.floor_unit_ebay_gaps(u.store_id,u.sku) as ebay_gaps,
      exists(select 1 from public.unit_channel_selections s where s.store_id=u.store_id and s.sku=u.sku
        and s.channel='ebay' and s.selected) as ebay_selected,
      exists(select 1 from public.unit_channel_selections s where s.store_id=u.store_id and s.sku=u.sku and s.selected) as any_selected,
      exists(select 1 from public.unit_channel_categories c where c.store_id=u.store_id and c.sku=u.sku
        and c.channel='ebay' and c.category_id is not null and c.enabled) as has_category
    from public.units u where u.state in ('available','reserved','repair')
  ), old_a as (
    select b.*,
      case when not public.unit_dns(listing_specs) and not public.unit_not_for_sale(listing_specs)
        and not ebay_selected and 'specifics'=any(ebay_gaps) then array_append(new_gaps,'specifics') else new_gaps end as g1
    from base b
  ), old_b as (
    select b.*,
      case when not public.unit_dns(listing_specs) and not public.unit_not_for_sale(listing_specs)
        and not ebay_selected and 'category'=any(ebay_gaps) and has_category then array_append(g1,'category_review') else g1 end as g2
    from old_a b
  ), scored as (
    select b.*,
      case when not public.unit_dns(listing_specs) and not public.unit_not_for_sale(listing_specs)
        and not ebay_selected and not has_category
        and nullif(btrim(coalesce(category,'')),'') is null
        and nullif(btrim(coalesce(ebay_category,'')),'') is null
        and nullif(btrim(coalesce(listing_specs->>'ebay_category_id','')),'') is null
        then array_append(g2,'category') else g2 end as old_gaps_pre_dims
    from old_b b
  ), scored_dims as (
    select b.*,
      case when not any_selected and not public.unit_dns(listing_specs) and not public.unit_not_for_sale(listing_specs)
        and (coalesce(package_weight_lb,0)<=0 or coalesce(package_length_in,0)<=0
          or coalesce(package_width_in,0)<=0 or coalesce(package_height_in,0)<=0)
        then array_append(old_gaps_pre_dims,'spec') else old_gaps_pre_dims end as old_gaps
    from scored b
  ), counts as (
    select count(*)::int units_scanned,
      count(*) filter(where 'specifics'=any(old_gaps) and not 'specifics'=any(new_gaps))::int false_specifics,
      count(*) filter(where 'category_review'=any(old_gaps) and not 'category_review'=any(new_gaps))::int false_category_review,
      count(*) filter(where 'category'=any(old_gaps) and not 'category'=any(new_gaps))::int false_category,
      count(*) filter(where 'spec'=any(old_gaps) and not 'spec'=any(new_gaps))::int false_package_size,
      count(*) filter(where public.unit_is_unfinished(old_gaps))::int old_not_ready,
      count(*) filter(where public.unit_is_unfinished(new_gaps))::int new_not_ready,
      count(*) filter(where not public.unit_is_defective(listing_specs,condition)
        and not public.unit_not_for_sale(listing_specs) and not any_selected
        and not public.unit_is_unfinished(old_gaps))::int old_needs_check,
      count(*) filter(where not public.unit_is_defective(listing_specs,condition)
        and not public.unit_not_for_sale(listing_specs) and not any_selected
        and not public.unit_is_unfinished(new_gaps))::int new_needs_check
    from scored_dims
  )
  select jsonb_build_object('units_scanned',units_scanned,
    'wrongly_flagged_by_reason',jsonb_build_object('item_specifics',false_specifics,
      'category_review',false_category_review,'category',false_category,'package_size',false_package_size),
    'not_ready_before',old_not_ready,'not_ready_after',new_not_ready,
    'moved_out_of_not_ready',greatest(0,old_not_ready-new_not_ready),
    'needs_check_before',old_needs_check,'needs_check_after',new_needs_check,
    'moved_into_needs_check',greatest(0,new_needs_check-old_needs_check),
    'moved_out_of_needs_check',greatest(0,old_needs_check-new_needs_check)) from counts;
$$;
revoke all on function public.floor_inventory_readiness_recompute() from public,anon,authenticated;
grant execute on function public.floor_inventory_readiness_recompute() to service_role;

commit;
