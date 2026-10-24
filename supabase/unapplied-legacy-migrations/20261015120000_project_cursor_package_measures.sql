-- Cursor stores sourced/estimated package measurements in listing_specs.
-- The storefront and Merchant sync read the package_* columns, so project
-- complete Cursor measurements into those shipping-facing columns without
-- modifying listing_specs or changing listing eligibility rules.
create or replace function public.project_cursor_package_measures()
returns trigger language plpgsql set search_path = public as $$
declare
  v_specs jsonb := coalesce(new.listing_specs, '{}'::jsonb);
  v_status text := v_specs->>'package_measure_status';
  v_weight numeric;
  v_length numeric;
  v_width numeric;
  v_height numeric;
begin
  if v_status not in ('sourced', 'estimated') then
    return new;
  end if;

  begin
    v_weight := nullif(v_specs->>'package_weight_lb', '')::numeric;
    v_length := nullif(v_specs->>'package_length_in', '')::numeric;
    v_width := nullif(v_specs->>'package_width_in', '')::numeric;
    v_height := nullif(v_specs->>'package_height_in', '')::numeric;
  exception when invalid_text_representation then
    return new;
  end;

  if coalesce(v_weight, 0) <= 0 or coalesce(v_length, 0) <= 0
     or coalesce(v_width, 0) <= 0 or coalesce(v_height, 0) <= 0 then
    return new;
  end if;

  new.package_weight_lb := v_weight;
  new.package_length_in := v_length;
  new.package_width_in := v_width;
  new.package_height_in := v_height;
  return new;
end $$;

drop trigger if exists project_cursor_package_measures on public.units;
create trigger project_cursor_package_measures
before insert or update of listing_specs on public.units
for each row execute function public.project_cursor_package_measures();

-- Cursor updates listing_specs only. Queue Google reconciliation on that field
-- as well as when the projected package columns are edited directly.
drop trigger if exists google_queue_units on public.units;
create trigger google_queue_units
after insert or update of state,show_on_website,ask_cents,title,brand,model,condition,defect_notes,upc,
  package_length_in,package_width_in,package_height_in,package_weight_lb,listing_body,listing_specs on public.units
for each row execute function public.queue_google_unit_trigger();

-- Backfill the current Cursor records. The existing package_* update trigger
-- queues affected live website listings for Google synchronization.
update public.units
set package_weight_lb = nullif(listing_specs->>'package_weight_lb', '')::numeric,
    package_length_in = nullif(listing_specs->>'package_length_in', '')::numeric,
    package_width_in = nullif(listing_specs->>'package_width_in', '')::numeric,
    package_height_in = nullif(listing_specs->>'package_height_in', '')::numeric,
    updated_at = now()
where listing_specs->>'package_measure_status' in ('sourced', 'estimated')
  and coalesce(nullif(listing_specs->>'package_weight_lb', '')::numeric, 0) > 0
  and coalesce(nullif(listing_specs->>'package_length_in', '')::numeric, 0) > 0
  and coalesce(nullif(listing_specs->>'package_width_in', '')::numeric, 0) > 0
  and coalesce(nullif(listing_specs->>'package_height_in', '')::numeric, 0) > 0
  and (coalesce(package_weight_lb, 0) <= 0
    or coalesce(package_length_in, 0) <= 0
    or coalesce(package_width_in, 0) <= 0
    or coalesce(package_height_in, 0) <= 0);
