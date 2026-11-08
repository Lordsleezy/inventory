-- Let the inventory Never list tab filter through receive_inventory_list.
-- The live function was extended in place by later migrations, so this patches
-- that definition instead of pasting an older copy back over it.
do $$
declare
  src text;
  needle text := 'p_status in (''inventory_listed'',''inventory_not_listed'',''inventory_not_ready'')';
  patched text := 'p_status in (''inventory_listed'',''inventory_not_listed'',''inventory_not_ready'',''inventory_never_list'')';
begin
  select pg_get_functiondef('public.receive_inventory_list(text,text,boolean,text,integer,integer,text)'::regprocedure) into src;
  if position('inventory_never_list' in src) > 0 then
    return;
  end if;
  if position(needle in src) = 0 then
    raise exception 'receive_inventory_list status list was not found; Never list tab was not added';
  end if;
  execute replace(src, needle, patched);
end $$;
