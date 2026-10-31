-- Online "Not ready" is for items we still mean to list.
-- Missing cost is internal and does not block eBay.
-- DNS, defective, and never-list stay out of Ready and Not ready.

begin;

do $$
declare src text;
  fn oid := to_regprocedure('public.portal_online_board()');
  hold text := ' and not exists (select 1 from public.units hold where hold.store_id = v_store and hold.sku = s.display_sku and ('
    || 'public.unit_dns(hold.listing_specs) or public.unit_is_defective(hold.listing_specs, hold.condition) or coalesce(hold.ebay_never_list, false) '
    || 'or public.floor_unit_never_list_reason(hold.store_id, hold.sku, ''ebay'') is not null))';
begin
  -- Historical replay omits the recovered live migration that creates this function.
  if fn is null then
    return;
  end if;
  select pg_get_functiondef(fn) into src;
  if position('Missing cost' in src) = 0 then
    raise exception 'portal_online_board Missing cost marker not found';
  end if;
  src := regexp_replace(src, 'case when s\.acquisition_cost_cents is null then ''Missing cost'' end,\s*', '', 'g');
  src := regexp_replace(src, 'and w\.acquisition_cost_cents is not null\s*', '', 'g');
  if position('Missing cost' in src) > 0 then
    raise exception 'portal_online_board still treats missing cost as a blocker';
  end if;
  if position('hold.ebay_never_list' in src) = 0 then
    src := regexp_replace(src,
      'where s\.not_listable_reason is null\s+and coalesce\(cardinality\(s\.online_on\), 0\) = 0',
      'where s.not_listable_reason is null and coalesce(cardinality(s.online_on), 0) = 0' || hold);
  end if;
  if position('hold.ebay_never_list' in src) = 0 or position('Missing cost' in src) > 0 then
    raise exception 'portal_online_board hold filter was not applied';
  end if;
  execute src;
end $$;

commit;
