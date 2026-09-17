-- Store category vocabulary stays in store_settings.categories (the existing
-- JSON array). These RPCs add rename/remove-with-reassign so units and the
-- public catalog stay in sync. No new tables.

create or replace function public.store_category_names(p_store uuid)
returns text[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v jsonb;
  v_names text[];
begin
  select value into v
    from public.store_settings
   where store_id = p_store and key = 'categories';
  if v is null or jsonb_typeof(v) <> 'array' then
    return array['Uncategorized']::text[];
  end if;
  select coalesce(array_agg(btrim(x) order by ord), array[]::text[])
    into v_names
  from jsonb_array_elements_text(v) with ordinality as t(x, ord)
  where btrim(x) <> '';
  if v_names is null or cardinality(v_names) = 0 then
    return array['Uncategorized']::text[];
  end if;
  return v_names;
end;
$$;

create or replace function public.save_store_categories(p_store uuid, p_names text[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.store_settings (store_id, key, value)
  values (p_store, 'categories', to_jsonb(p_names))
  on conflict (store_id, key) do update set value = excluded.value;
end;
$$;

-- Fold names already on units into the vocabulary so Setup is not empty of
-- categories that inventory already uses.
do $$
declare
  r record;
  names text[];
  extra text;
begin
  for r in
    select id as store_id from public.stores
  loop
    names := public.store_category_names(r.store_id);
    for extra in
      select distinct btrim(u.category)
        from public.units u
       where u.store_id is not distinct from r.store_id
         and u.category is not null
         and btrim(u.category) <> ''
         and not (btrim(u.category) = any (names))
    loop
      names := names || extra;
    end loop;
    perform public.save_store_categories(r.store_id, names);
  end loop;
end $$;

create or replace function public.add_category(p_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
  v_name text := btrim(coalesce(p_name, ''));
  v_names text[];
begin
  perform public.assert_manager();
  if v_name = '' then
    raise exception 'Enter a category name.' using errcode = '22023';
  end if;
  v_names := public.store_category_names(v_store);
  if v_name = any (v_names) then
    raise exception 'Category % already exists.', v_name using errcode = 'P0001';
  end if;
  v_names := v_names || v_name;
  perform public.save_store_categories(v_store, v_names);
  insert into public.events (store_id, sku, kind, new_value, actor, actor_id)
  values (
    v_store, null, 'category_add', v_name,
    coalesce((select display_name from public.staff where user_id = auth.uid()), 'manager'),
    auth.uid()
  );
end;
$$;

create or replace function public.rename_category(p_from text, p_to text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
  v_from text := btrim(coalesce(p_from, ''));
  v_to text := btrim(coalesce(p_to, ''));
  v_names text[];
  i int;
begin
  perform public.assert_manager();
  if v_from = '' or v_to = '' then
    raise exception 'Enter a category name.' using errcode = '22023';
  end if;
  v_names := public.store_category_names(v_store);
  i := array_position(v_names, v_from);
  if i is null then
    raise exception 'Category % is not on the list.', v_from using errcode = 'P0001';
  end if;
  if v_from = v_to then
    return;
  end if;
  if v_to = any (v_names) then
    raise exception 'Category % already exists.', v_to using errcode = 'P0001';
  end if;
  v_names[i] := v_to;
  perform public.save_store_categories(v_store, v_names);
  update public.units
     set category = v_to, updated_at = now()
   where store_id is not distinct from v_store
     and category = v_from;
  insert into public.events (store_id, sku, kind, old_value, new_value, actor, actor_id)
  values (
    v_store, null, 'category_rename', v_from, v_to,
    coalesce((select display_name from public.staff where user_id = auth.uid()), 'manager'),
    auth.uid()
  );
end;
$$;

create or replace function public.reorder_categories(p_names text[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
  v_old text[];
  v_new text[];
begin
  perform public.assert_manager();
  v_old := public.store_category_names(v_store);
  select coalesce(array_agg(btrim(x)), array[]::text[])
    into v_new
  from unnest(coalesce(p_names, array[]::text[])) as x
  where btrim(x) <> '';
  if (select count(*) from unnest(v_new) t(x)) <> (select count(distinct x) from unnest(v_new) t(x)) then
    raise exception 'Category names must be unique.' using errcode = 'P0001';
  end if;
  if (select array_agg(x order by x) from unnest(v_old) t(x))
     is distinct from (select array_agg(x order by x) from unnest(v_new) t(x)) then
    raise exception 'Reorder has to keep the same categories.' using errcode = 'P0001';
  end if;
  perform public.save_store_categories(v_store, v_new);
  insert into public.events (store_id, sku, kind, actor, actor_id, note)
  values (
    v_store, null, 'category_reorder',
    coalesce((select display_name from public.staff where user_id = auth.uid()), 'manager'),
    auth.uid(),
    'reordered'
  );
end;
$$;

create or replace function public.remove_category(p_name text, p_move_to text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
  v_name text := btrim(coalesce(p_name, ''));
  v_move text := nullif(btrim(coalesce(p_move_to, '')), '');
  v_names text[];
  v_used int;
begin
  perform public.assert_manager();
  if v_name = '' then
    raise exception 'Enter a category name.' using errcode = '22023';
  end if;
  v_names := public.store_category_names(v_store);
  if array_position(v_names, v_name) is null then
    raise exception 'Category % is not on the list.', v_name using errcode = 'P0001';
  end if;
  if cardinality(v_names) = 1 then
    raise exception 'Keep at least one category.' using errcode = 'P0001';
  end if;

  select count(*) into v_used
    from public.units
   where store_id is not distinct from v_store
     and category = v_name;

  if v_used > 0 then
    if v_move is null then
      raise exception '% items use this, move them first', v_used using errcode = 'P0001';
    end if;
    if v_move = v_name then
      raise exception 'Pick a different category to move items to.' using errcode = 'P0001';
    end if;
    if array_position(v_names, v_move) is null then
      raise exception 'Category % is not on the list.', v_move using errcode = 'P0001';
    end if;
    update public.units
       set category = v_move, updated_at = now()
     where store_id is not distinct from v_store
       and category = v_name;
  end if;

  v_names := array_remove(v_names, v_name);
  perform public.save_store_categories(v_store, v_names);
  insert into public.events (store_id, sku, kind, old_value, new_value, actor, actor_id, note)
  values (
    v_store, null, 'category_remove', v_name, v_move,
    coalesce((select display_name from public.staff where user_id = auth.uid()), 'manager'),
    auth.uid(),
    case when v_used > 0 then format('moved %s items to %s', v_used, v_move) else 'unused' end
  );
end;
$$;

create or replace function public.set_store_setting(p_key text, p_value jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_manager();
  if p_key in ('manager_pin_hash', 'pin_failed_count', 'pin_locked_until') then
    raise exception 'use_pin_rpc' using errcode = '42501';
  end if;
  if p_key = 'categories' then
    raise exception 'use_category_rpc' using errcode = '42501';
  end if;
  insert into public.store_settings (store_id, key, value)
  values (public.current_store_id(), p_key, p_value)
  on conflict (store_id, key) do update set value = excluded.value;
end;
$$;

-- Public website: same category names as the store vocabulary (not a second list).
create or replace view public.public_categories
with (security_invoker = false) as
select
  s.store_id,
  btrim(x.cat) as name,
  x.ord::int as sort_index
from public.store_settings s
cross join lateral jsonb_array_elements_text(s.value) with ordinality as x(cat, ord)
where s.key = 'categories'
  and jsonb_typeof(s.value) = 'array'
  and btrim(x.cat) <> '';

comment on view public.public_categories is
  'Public category names for the website, in store order. Same strings as units.category.';

grant select on public.public_categories to anon, authenticated;
revoke all on function public.save_store_categories(uuid, text[]) from public;
grant execute on function public.store_category_names(uuid) to authenticated;
grant execute on function public.add_category(text) to authenticated;
grant execute on function public.rename_category(text, text) to authenticated;
grant execute on function public.reorder_categories(text[]) to authenticated;
grant execute on function public.remove_category(text, text) to authenticated;
