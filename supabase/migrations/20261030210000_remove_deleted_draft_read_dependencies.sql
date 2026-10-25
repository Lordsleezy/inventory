-- Listing readiness and live-category confirmation must use canonical Floor
-- records. Local ebay_drafts rows are disposable and must not be required.

create or replace function public.unit_listing_gaps(u public.units)
returns text[] language sql stable set search_path = public as $$
  with f as (
    select public.unit_not_for_sale(u.listing_specs) as nfs,
      public.floor_unit_ebay_gaps(u.store_id, u.sku) as eg,
      exists (select 1 from public.unit_channel_categories c
        where c.store_id = u.store_id and c.sku = u.sku and c.channel = 'ebay'
          and c.category_id is not null and c.enabled) as has_category
  )
  select array_remove(array[
    case when nullif(btrim(coalesce(u.brand, '')), '') is null
           or u.brand ~* '^(generic|unknown|n/?a|does not apply)$' then 'brand' end,
    case when not f.nfs and ((nullif(btrim(coalesce(u.category, '')), '') is null
           and nullif(btrim(coalesce(u.ebay_category, '')), '') is null
           and nullif(btrim(coalesce(u.listing_specs->>'ebay_category_id', '')), '') is null
           and not f.has_category) or 'category' = any(f.eg)) then 'category' end,
    case when not f.nfs and 'specifics' = any(f.eg) then 'specifics' end,
    case when not f.nfs and (coalesce(u.package_weight_lb, 0) <= 0 or coalesce(u.package_length_in, 0) <= 0
           or coalesce(u.package_width_in, 0) <= 0 or coalesce(u.package_height_in, 0) <= 0) then 'spec' end,
    case when not f.nfs and not public.unit_upc_does_not_apply(u.listing_specs)
           and (nullif(btrim(coalesce(u.upc, '')), '') is null or btrim(u.upc) !~ '^[0-9]{8,14}$') then 'upc' end,
    case when not f.nfs and not exists (
           select 1 from public.photos p where p.store_id = u.store_id and p.sku = u.sku) then 'photo' end,
    case when not f.nfs and u.ask_cents is null then 'price' end,
    case when not f.nfs and nullif(btrim(coalesce(u.title, '')), '') is null then 'title' end,
    case when not f.nfs and nullif(btrim(coalesce(u.condition, '')), '') is null then 'condition' end,
    case when not f.nfs and nullif(btrim(coalesce(u.model, '')), '') is null then 'model' end,
    case when not f.nfs and nullif(btrim(coalesce(u.listing_body, '')), '') is null then 'description' end,
    case when not f.nfs and u.listing_specs->>'ebay_review_reason' in (
      'review_hygiene', 'review_supplement', 'review_quantity', 'review_contents',
      'review_bundle', 'review_stove', 'review_product', 'review_condition', 'review_cosmetic'
    ) then u.listing_specs->>'ebay_review_reason' end
  ], null)
  from f;
$$;
revoke all on function public.unit_listing_gaps(public.units) from public, anon, authenticated;

create or replace function public.floor_category_autoconfirm(p_store uuid, p_dry_run boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  with cand as (
    select c.sku, coalesce(t.fingerprint, '') || ':' || coalesce(t.fields_version, '') fp,
      case when c.adopted_live
             and exists (select 1 from public.listings l where l.store_id = c.store_id and l.sku = c.sku
                          and l.channel = 'ebay' and l.status = 'listed') then 'live_on_ebay'
           when c.source in ('ebay_catalog','confirmed_upc','floor_upc_memory')
             and c.review_reason is distinct from 'conflicting category sources' then c.source end reason
    from public.unit_channel_categories c
    join public.units u on u.store_id = c.store_id and u.sku = c.sku and u.state in ('available','reserved','repair')
    join public.channel_taxonomy t on t.channel = 'ebay' and t.category_id = c.category_id
      and t.active and t.leaf and t.fields_fetched_at is not null
    where c.store_id = p_store and c.channel = 'ebay' and c.enabled and c.category_id is not null
      and (c.review_reason is not null
        or c.validated_version is distinct from coalesce(t.fingerprint, '') || ':' || coalesce(t.fields_version, ''))
  ), picked as (select * from cand where reason is not null),
  upd as (
    update public.unit_channel_categories c set review_reason = null, validated_version = p.fp,
      adopted_live = c.adopted_live or p.reason = 'live_on_ebay', updated_at = now()
    from picked p where not p_dry_run and c.store_id = p_store and c.sku = p.sku and c.channel = 'ebay'
    returning c.sku
  )
  select jsonb_build_object('dry_run', p_dry_run, 'confirmed', (select count(*) from picked),
    'updated', (select count(*) from upd),
    'by_reason', coalesce((select jsonb_object_agg(reason, n) from (select reason, count(*) n from picked group by 1) x), '{}'::jsonb))
  into v;
  return v;
end $$;
revoke all on function public.floor_category_autoconfirm(uuid, boolean) from public, anon, authenticated;
grant execute on function public.floor_category_autoconfirm(uuid, boolean) to service_role;
