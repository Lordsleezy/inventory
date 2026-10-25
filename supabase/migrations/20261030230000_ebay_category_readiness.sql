-- Every unresolved eBay taxonomy issue blocks listing, including stale fields
-- and categories that need rechecking after a taxonomy refresh.
create or replace function public.floor_unit_ebay_gaps(p_store uuid,p_sku text)
returns text[] language sql stable set search_path=public as $$
 select coalesce(array_agg(distinct case when i.issue in ('missing required field','channel document required')
   then 'specifics' else 'category' end),'{}')
 from public.floor_category_issue_rows(p_store,p_sku,'ebay') i;
$$;
revoke all on function public.floor_unit_ebay_gaps(uuid,text) from public,anon,authenticated;
grant execute on function public.floor_unit_ebay_gaps(uuid,text) to service_role;
