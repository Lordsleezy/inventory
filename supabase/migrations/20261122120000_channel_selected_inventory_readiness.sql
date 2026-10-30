begin;

-- Channel-specific requirements only block an item once that sales channel is
-- selected. Shared receive fields (photo, price, brand, title, etc.) stay shared.
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
    case when nullif(btrim(coalesce(u.brand,'')),'') is null
      or u.brand ~* '^(generic|unknown|n/?a|does not apply)$' then 'brand' end,
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
revoke all on function public.unit_listing_gaps(public.units) from public,anon,authenticated;

-- Group disposition needs one admin-checked, audited call so batch marking is
-- atomic and cannot overwrite cost or other item fields.
create or replace function public.portal_receive_group_mark_defective(p_group uuid,p_skus text[])
returns int language plpgsql security definer set search_path=public as $$
declare st uuid:=public.portal_store_id(); n int:=0; u public.units;
begin
  if st is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode='42501'; end if;
  if p_skus is null or cardinality(p_skus)<1 or cardinality(p_skus)>100 then raise exception 'invalid_group_quantity' using errcode='22023'; end if;
  if cardinality(p_skus)<>(select count(distinct x)::int from unnest(p_skus) x) then raise exception 'duplicate_group_sku' using errcode='22023'; end if;
  perform 1 from public.receive_groups where id=p_group and store_id=st for update;
  if not found then raise exception 'receive_group_not_found'; end if;
  if p_skus is distinct from (select array_agg(q.sku order by q.sku::numeric) from (
      select unit_row.sku from public.receive_group_members m join public.units unit_row on unit_row.store_id=m.store_id and unit_row.sku=m.sku
      where m.group_id=p_group and m.store_id=st and m.detached_at is null
        and unit_row.state in ('available','reserved','repair') and unit_row.qty_on_hand>0
      order by unit_row.sku::numeric limit cardinality(p_skus)) q) then
    raise exception 'group_units_must_be_lowest_skus';
  end if;
  if exists(select 1 from unnest(p_skus) x where not exists(
    select 1 from public.receive_group_members m join public.units unit_row on unit_row.store_id=m.store_id and unit_row.sku=m.sku
    where m.group_id=p_group and m.store_id=st and m.detached_at is null and m.sku=x
      and unit_row.state in ('available','reserved','repair') and unit_row.qty_on_hand>0)) then
    raise exception 'group_unit_not_available';
  end if;
  perform set_config('floor.receive_group_apply','on',true);
  for u in select v.* from public.units v where v.store_id=st and v.sku=any(p_skus)
    and v.state in ('available','reserved','repair') and v.qty_on_hand>0 order by v.sku for update loop
    insert into public.receive_group_audit(store_id,group_id,sku,actor_id,action,before_row)
      values(st,p_group,u.sku,auth.uid(),'mark_defective',to_jsonb(u));
    insert into public.events(store_id,sku,kind,field,old_value,new_value,actor,actor_id)
      values(st,u.sku,'edit','condition',u.condition,'Defective',
        coalesce((select display_name from public.staff where user_id=auth.uid()),'admin'),auth.uid());
    update public.units set condition='Defective',updated_at=now() where store_id=st and sku=u.sku;
    n:=n+1;
  end loop;
  perform set_config('floor.receive_group_apply','',true);
  return n;
end $$;
revoke all on function public.portal_receive_group_mark_defective(uuid,text[]) from public,anon;
grant execute on function public.portal_receive_group_mark_defective(uuid,text[]) to authenticated;

commit;
