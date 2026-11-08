-- New receives need a person-taken photo and package dimensions.
-- Defective (the condition Inventory → Defective already reads) or Do not list waives both.
-- A retried commit that already saved is unchanged. Editing an old unit does not come through here.

create or replace function public.receive_require_new_item(p_fields jsonb, p_photos text[], p_extras jsonb)
returns void language plpgsql immutable as $$
declare
  waived boolean;
  stock text[];
  person integer;
  len numeric; wid numeric; hei numeric; wt numeric;
begin
  waived := coalesce(p_extras->>'do_not_list', '') in ('true', 't', '1')
    or coalesce(p_extras->>'defective', '') in ('true', 't', '1')
    or coalesce(p_fields->>'p_condition', '') ~* '^\s*(defective|scratch)';
  if waived then return; end if;
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

do $$
declare src text;
begin
  select pg_get_functiondef('public.portal_receive_stocked_commit(uuid,jsonb,text[],jsonb)'::regprocedure) into src;
  if position('receive_require_new_item' in src) > 0 then
    return;
  end if;
  if position('one_fields:=jsonb_set' in src) > 0 then
    src := replace(src, 'one_fields:=jsonb_set', 'perform public.receive_require_new_item(p_fields, p_photos, p_extras); one_fields:=jsonb_set');
  elsif position('one_fields := jsonb_set' in src) > 0 then
    src := replace(src, 'one_fields := jsonb_set', 'perform public.receive_require_new_item(p_fields, p_photos, p_extras); one_fields := jsonb_set');
  else
    raise exception 'receive commit was not patched; photo and dimension rules were not enforced';
  end if;
  execute src;
end $$;
