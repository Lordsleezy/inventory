begin;

alter table public.units
  add column if not exists product_height_in numeric(10,2),
  add column if not exists product_width_in numeric(10,2),
  add column if not exists product_depth_in numeric(10,2),
  add column if not exists product_weight_lb numeric(10,2),
  add column if not exists package_length_in numeric(10,2),
  add column if not exists package_width_in numeric(10,2),
  add column if not exists package_height_in numeric(10,2),
  add column if not exists package_weight_lb numeric(10,2),
  add column if not exists dims_source text;

do $$
begin
  if not exists(select 1 from pg_constraint where conname='units_dims_source_allowed'
    and conrelid='public.units'::regclass) then
    alter table public.units add constraint units_dims_source_allowed
      check (dims_source is null or dims_source in ('verified','estimated'));
  end if;
end $$;

select count(*)=9 as scan_dimensions_ready from information_schema.columns
where table_schema='public' and table_name='units'
  and column_name in ('product_height_in','product_width_in','product_depth_in','product_weight_lb',
    'package_length_in','package_width_in','package_height_in','package_weight_lb','dims_source');
commit;
