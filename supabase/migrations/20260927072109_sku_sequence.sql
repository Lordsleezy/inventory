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

-- A historical receive probe was cleaned in production. Fresh replays must
-- never delete rows by SKU alone; see explicit is_test markers in the later migration.
