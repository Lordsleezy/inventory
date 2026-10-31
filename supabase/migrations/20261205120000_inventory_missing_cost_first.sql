-- Inventory subtabs (In stock, Sold, Needs to be checked, and the rest)
-- list units with no acquisition cost first. Sold units missing a cost
-- come before other missing-cost units, then the chosen SKU / price / date sort.

begin;

do $$
declare
  src text;
  marker text := 'acquisition_cost_cents is null and state = ''sold''';
begin
  select pg_get_functiondef('public.receive_inventory_list(text,text,boolean,text,integer,integer,text)'::regprocedure) into src;
  if position(marker in src) = 0 then
    src := regexp_replace(
      src,
      $re$case when p_sort\s*=\s*'sku' then sku::numeric end desc nulls last$re$,
      $to$case when acquisition_cost_cents is null and state = 'sold' then 0 when acquisition_cost_cents is null then 1 else 2 end, case when p_sort='sku' then sku::numeric end desc nulls last$to$,
      'g'
    );
  end if;
  if (length(src) - length(replace(src, marker, ''))) / length(marker) < 2 then
    raise exception 'receive_inventory_list missing-cost sort was not applied';
  end if;
  execute src;
end $$;

commit;
