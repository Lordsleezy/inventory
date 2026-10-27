-- Auto-pick the eBay category and auto-generate the description (no AI, nothing is listed or checked).
-- Service-role only. The snapshot answers "which units still need an auto category / description" and, for the report,
-- "which units are Unfinished / Needs check and why". The mark remembers which title already got an eBay suggestion attempt
-- so a title with no suggestion is not retried every run (a changed title is).
begin;

create or replace function public.floor_auto_fill_snapshot(p_store uuid, p_sku text default null)
returns table (sku text, title text, has_category boolean, has_description boolean, has_name boolean, tried_title text,
               eligible boolean, gaps text[], unfinished boolean, needs_check boolean)
language sql stable security definer set search_path = public as $$
  select u.sku, u.title,
    coalesce(c.category_id, '') <> '' as has_category,
    nullif(btrim(coalesce(u.listing_body, '')), '') is not null as has_description,
    coalesce(nullif(btrim(coalesce(u.title, '')), ''), nullif(btrim(concat_ws(' ', u.brand, u.model)), '')) is not null as has_name,
    u.listing_specs->>'auto_category_tried' as tried_title,
    (not public.unit_is_defective(u.listing_specs, u.condition)
      and not public.unit_not_for_sale(u.listing_specs)
      and not public.unit_dns(u.listing_specs)
      and public.floor_unit_never_list_reason(p_store, u.sku, 'ebay') is null) as eligible,
    g.gaps,
    public.unit_is_unfinished(g.gaps) as unfinished,
    (not public.unit_is_defective(u.listing_specs, u.condition)
      and not public.unit_not_for_sale(u.listing_specs)
      and not public.unit_is_unfinished(g.gaps)
      and not exists (select 1 from public.unit_channel_selections cs where cs.store_id = p_store and cs.sku = u.sku and cs.selected)
      and exists (select 1 from unnest(array['ebay','amazon','tiktok']) ch
        where public.floor_unit_never_list_reason(p_store, u.sku, ch) is null)) as needs_check
  from public.units u
  left join public.unit_channel_categories c on c.store_id = u.store_id and c.sku = u.sku and c.channel = 'ebay'
  cross join lateral (select public.unit_listing_gaps(u) as gaps) g
  where u.store_id = p_store and u.state in ('available', 'reserved', 'repair')
    and (p_sku is null or u.sku = p_sku);
$$;
revoke all on function public.floor_auto_fill_snapshot(uuid, text) from public, anon, authenticated;
grant execute on function public.floor_auto_fill_snapshot(uuid, text) to service_role;

create or replace function public.floor_auto_fill_mark(p_store uuid, p_sku text, p_title text)
returns void language sql security definer set search_path = public as $$
  update public.units set listing_specs = coalesce(listing_specs, '{}'::jsonb) || jsonb_build_object('auto_category_tried', p_title)
   where store_id = p_store and sku = p_sku;
$$;
revoke all on function public.floor_auto_fill_mark(uuid, text, text) from public, anon, authenticated;
grant execute on function public.floor_auto_fill_mark(uuid, text, text) to service_role;

commit;
