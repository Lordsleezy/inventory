-- A unit can have all basic listing fields and still need a physical or policy
-- review before it can be published to eBay. Keep these units in Unfinished,
-- with their specific reason, without moving Do not list for sale stock there.

create or replace function public.unit_listing_gaps(u public.units)
returns text[] language sql stable set search_path = public as $$
  with gap as (
    select public.missing_ebay_aspect_names(d.aspect_defs, d.aspects, u.listing_specs) as names,
           nullif(btrim(coalesce(d.category_id, '')), '') is not null as has_category
    from public.ebay_drafts d
    where d.store_id = u.store_id and d.sku = u.sku
    limit 1
  ), f as (
    select public.unit_not_for_sale(u.listing_specs) as nfs,
      (select names from gap) as names,
      coalesce((select has_category from gap), false) as has_category
  )
  select array_remove(array[
    case when nullif(btrim(coalesce(u.brand, '')), '') is null
           or u.brand ~* '^(generic|unknown|n/?a|does not apply)$' then 'brand' end,
    case when not f.nfs and nullif(btrim(coalesce(u.category, '')), '') is null
           and nullif(btrim(coalesce(u.ebay_category, '')), '') is null
           and nullif(btrim(coalesce(u.listing_specs->>'ebay_category_id', '')), '') is null
           and not f.has_category then 'category' end,
    case when not f.nfs and nullif(btrim(coalesce(f.names, '')), '') is not null then 'specifics' end,
    case when not f.nfs and (coalesce(u.package_weight_lb, 0) <= 0 or coalesce(u.package_length_in, 0) <= 0
           or coalesce(u.package_width_in, 0) <= 0 or coalesce(u.package_height_in, 0) <= 0) then 'spec' end,
    case when not f.nfs and not public.unit_upc_does_not_apply(u.listing_specs)
           and (nullif(btrim(coalesce(u.upc, '')), '') is null or btrim(u.upc) !~ '^[0-9]{8,14}$') then 'upc' end,
    case when not f.nfs and not exists (
           select 1 from public.photos p where p.store_id = u.store_id and p.sku = u.sku) then 'photo' end,
    case when not f.nfs and u.ask_cents is null then 'price' end,
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

create or replace function public.unit_is_unfinished(p_gaps text[])
returns boolean language sql immutable set search_path = public as $$
  select coalesce(p_gaps, '{}') && array[
    'photo','price','brand','condition','category','upc','spec','model',
    'review_hygiene','review_supplement','review_quantity','review_contents',
    'review_bundle','review_stove','review_product','review_condition','review_cosmetic'
  ];
$$;

-- Clearing a review is an explicit admin action after checking the item.
create or replace function public.portal_clear_ebay_review(p_sku text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_unit public.units;
begin
  if v_store is null or not public.portal_is_admin() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  update public.units
     set listing_specs = coalesce(listing_specs, '{}'::jsonb) - 'ebay_review_reason'
   where store_id = v_store and sku = p_sku
   returning * into v_unit;
  if not found then raise exception 'unit_not_found' using errcode = 'P0001'; end if;
  return jsonb_build_object('sku', v_unit.sku, 'listing_specs', v_unit.listing_specs);
end $$;
revoke all on function public.portal_clear_ebay_review(text) from public, anon;
grant execute on function public.portal_clear_ebay_review(text) to authenticated, service_role;
