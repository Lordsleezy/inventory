-- A single SKU typed far ahead of the sticker run (a probe, a typo) must not
-- become the next suggested number. The run is the highest SKU whose gap from
-- the previous SKU is at most 100. Deleting inside the run still does not
-- lower the next number, because those rows stay on the ledger.

create or replace function public.next_sku()
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
  v_start int;
  v_digits int;
  v_max bigint;
begin
  perform public.assert_staff_or_service();
  v_digits := public.sku_digits();
  v_start := coalesce((public.store_setting(v_store, 'skuStart', '10000'::jsonb) #>> '{}')::int, 10000);
  select coalesce(max(n), v_start - 1) into v_max
    from (
      select sku::bigint as n,
             lag(sku::bigint) over (order by sku::bigint) as prev
        from public.sku_ledger
       where store_id = v_store
         and sku ~ '^[0-9]+$'
    ) issued
   where prev is null or n - prev <= 100;
  if greatest(v_max + 1, v_start) > (10 ^ v_digits) - 1 then
    raise exception 'sku_exhausted' using errcode = 'P0001';
  end if;
  return lpad(greatest(v_max + 1, v_start)::text, v_digits, '0');
end;
$$;

-- 99696 was a receive probe with no unit and no sale. It pulled the suggestion
-- up near 99697 while the store's stickers were still in the 11100s.
do $$
begin
  if not exists (select 1 from public.units where sku = '99696')
     and not exists (select 1 from public.sales where sku = '99696') then
    delete from public.events where sku = '99696';
    delete from public.photos where sku = '99696';
    delete from public.listings where sku = '99696';
    delete from public.delist_tasks where sku = '99696';
    delete from public.reservations where sku = '99696';
    delete from public.sku_ledger where sku = '99696' and fate = 'issued';
  end if;
end $$;
;
