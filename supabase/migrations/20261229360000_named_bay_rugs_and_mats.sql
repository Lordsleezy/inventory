-- Named bays. Rugs and Mats is one floor spot the menus can pick by name.
begin;

alter table public.store_bays add column if not exists name text;

alter table public.store_bays drop constraint if exists store_bays_name_len;
alter table public.store_bays add constraint store_bays_name_len
  check (name is null or char_length(btrim(name)) between 1 and 40);

create unique index if not exists store_bays_name_unique
  on public.store_bays (store_id, lower(btrim(name)))
  where name is not null;

create or replace function public.portal_bay_list()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return jsonb_build_object(
    'bays', coalesce((select jsonb_agg(to_jsonb(b) order by b.bay_no)
      from public.store_bays b where b.store_id = v_store), '[]'::jsonb),
    'locations', coalesce((select jsonb_agg(
      to_jsonb(l) || jsonb_build_object('stock', coalesce(x.stock, 0), 'bay_name', b.name)
      order by l.bay_no, l.row_no, l.bin_no nulls first)
      from public.store_locations l
      join public.store_bays b on b.store_id = l.store_id and b.bay_no = l.bay_no
      left join lateral (
        select coalesce(sum(s.quantity), 0)::int stock
        from public.unit_location_stock s
        join public.units u on u.store_id = s.store_id and u.sku = s.sku
        where s.store_id = l.store_id and s.location_code = l.code
          and u.state in ('available', 'reserved', 'repair')
          and u.qty_on_hand > 0
      ) x on true where l.store_id = v_store), '[]'::jsonb)
  );
end $$;

insert into public.store_bays (store_id, bay_no, row_bins, name)
select s.id,
  coalesce((select max(b.bay_no) from public.store_bays b where b.store_id = s.id), 0) + 1,
  array[0],
  'Rugs and Mats'
from public.stores s
where not exists (
  select 1 from public.store_bays b
  where b.store_id = s.id and lower(btrim(b.name)) = 'rugs and mats'
);

insert into public.store_locations (store_id, code, bay_no, row_no, bin_no)
select b.store_id, b.bay_no::text || '-1', b.bay_no, 1, null
from public.store_bays b
where lower(btrim(b.name)) = 'rugs and mats'
on conflict do nothing;

commit;
