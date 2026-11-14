-- A receive can be saved with no bin. Those units stay findable under Inventory → No location.
-- Condition and a real photo are unchanged. Do not list still skips the rest of the gate.

create or replace function public.receive_require_new_item(p_fields jsonb, p_photos text[], p_extras jsonb)
returns void
language plpgsql
immutable
as $$
declare
  waived boolean;
  stock text[];
  person integer;
  len numeric; wid numeric; hei numeric; wt numeric;
  cond text;
begin
  waived := coalesce(p_extras->>'do_not_list', '') in ('true', 't', '1')
    or coalesce(p_extras->>'defective', '') in ('true', 't', '1')
    or coalesce(p_fields->>'p_condition', '') ~* '^\s*(defective|scratch)';
  if coalesce(p_extras->>'do_not_list', '') in ('true', 't', '1') then
    return;
  end if;

  cond := nullif(btrim(coalesce(p_fields->>'p_condition', '')), '');
  if cond is null then
    raise exception 'Missing condition.' using errcode = '22023';
  end if;

  if waived then
    return;
  end if;

  stock := coalesce(array(select jsonb_array_elements_text(coalesce(p_extras->'stock_photo_paths', '[]'::jsonb))), '{}'::text[]);
  select count(*)::int into person
  from unnest(coalesce(p_photos, '{}'::text[])) as photo
  where btrim(photo) <> '' and photo <> all (stock);
  if person < 1 then
    raise exception 'Missing a photo taken or chosen for this item. A stock photo does not count.' using errcode = '22023';
  end if;
  len := nullif(p_fields->>'p_length', '')::numeric;
  wid := nullif(p_fields->>'p_width', '')::numeric;
  hei := nullif(p_fields->>'p_height', '')::numeric;
  wt := nullif(p_fields->>'p_weight', '')::numeric;
  if coalesce(len, 0) <= 0 or coalesce(wid, 0) <= 0 or coalesce(hei, 0) <= 0 or coalesce(wt, 0) <= 0 then
    raise exception 'Missing dimensions: length, width, height, and weight.' using errcode = '22023';
  end if;
end $$;

revoke all on function public.receive_require_new_item(jsonb, text[], jsonb) from public, anon;
grant execute on function public.receive_require_new_item(jsonb, text[], jsonb) to authenticated, service_role;
