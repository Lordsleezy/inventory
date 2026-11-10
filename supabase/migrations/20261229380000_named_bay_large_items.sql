-- Large Items is one named bay: 1 row, 2 bins, selectable in every location menu.
begin;

insert into public.store_bays (store_id, bay_no, row_bins, name)
select s.id,
  coalesce((select max(b.bay_no) from public.store_bays b where b.store_id = s.id), 0) + 1,
  array[2],
  'Large Items'
from public.stores s
where not exists (
  select 1 from public.store_bays b
  where b.store_id = s.id and lower(btrim(b.name)) = 'large items'
);

insert into public.store_locations (store_id, code, bay_no, row_no, bin_no)
select b.store_id, b.bay_no::text || '-1-' || n.bin_no::text, b.bay_no, 1, n.bin_no
from public.store_bays b
cross join (values (1), (2)) as n(bin_no)
where lower(btrim(b.name)) = 'large items'
on conflict do nothing;

commit;
