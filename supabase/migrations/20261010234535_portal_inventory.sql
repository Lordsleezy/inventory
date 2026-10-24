create or replace function public.portal_inventory_counts()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  sid uuid := public.portal_store_id();
  v_all int;
  v_unfinished int;
  v_available int;
begin
  if sid is null then raise exception 'not a portal admin'; end if;
  select count(*)::int into v_all
  from public.units u
  where u.store_id = sid and u.state in ('available','reserved','repair');
  select count(*)::int into v_unfinished
  from public.units u
  where u.store_id = sid
    and u.state in ('available','reserved','repair')
    and (u.ask_cents is null or not exists (select 1 from public.photos p where p.sku = u.sku and p.store_id = u.store_id));
  select count(*)::int into v_available
  from public.units u where u.store_id = sid and u.state = 'available';
  return jsonb_build_object(
    'live', v_all,
    'unfinished', v_unfinished,
    'available', v_available
  );
end;
$$;

create or replace function public.portal_inventory_list(
  p_q text default null,
  p_unfinished boolean default false,
  p_limit integer default 200,
  p_offset integer default 0
)
returns table (
  sku text,
  title text,
  brand text,
  model text,
  category text,
  condition text,
  ask_cents integer,
  acquisition_cost_cents integer,
  floor_cents integer,
  state text,
  has_photo boolean,
  unfinished boolean,
  received_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  sid uuid := public.portal_store_id();
  q text := nullif(btrim(coalesce(p_q, '')), '');
  lim int := greatest(1, least(coalesce(p_limit, 200), 500));
  off int := greatest(0, coalesce(p_offset, 0));
begin
  if sid is null then raise exception 'not a portal admin'; end if;
  return query
  select
    u.sku,
    coalesce(nullif(btrim(u.title), ''), nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), u.sku)::text,
    u.brand,
    u.model,
    u.category,
    u.condition,
    u.ask_cents,
    u.acquisition_cost_cents,
    u.floor_cents,
    u.state,
    exists (select 1 from public.photos p where p.store_id = u.store_id and p.sku = u.sku) as has_photo,
    (
      u.ask_cents is null
      or not exists (select 1 from public.photos p where p.store_id = u.store_id and p.sku = u.sku)
    ) as unfinished,
    u.received_at,
    u.updated_at
  from public.units u
  where u.store_id = sid
    and u.state in ('available','reserved','repair')
    and (
      not coalesce(p_unfinished, false)
      or u.ask_cents is null
      or not exists (select 1 from public.photos p where p.store_id = u.store_id and p.sku = u.sku)
    )
    and (
      q is null
      or u.sku ilike '%' || q || '%'
      or coalesce(u.title, '') ilike '%' || q || '%'
      or coalesce(u.brand, '') ilike '%' || q || '%'
      or coalesce(u.model, '') ilike '%' || q || '%'
    )
  order by u.sku desc
  limit lim offset off;
end;
$$;

create or replace function public.portal_inventory_get(p_sku text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  sid uuid := public.portal_store_id();
  u public.units;
  photos jsonb;
begin
  if sid is null then raise exception 'not a portal admin'; end if;
  select * into u from public.units where store_id = sid and sku = btrim(p_sku);
  if not found then raise exception 'unit_not_found'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id, 'path', p.path, 'is_primary', p.is_primary
  ) order by p.is_primary desc nulls last, p.created_at), '[]'::jsonb)
  into photos
  from public.photos p
  where p.store_id = sid and p.sku = u.sku;
  return jsonb_build_object(
    'sku', u.sku,
    'title', u.title,
    'brand', u.brand,
    'model', u.model,
    'category', u.category,
    'condition', u.condition,
    'test_status', u.test_status,
    'location', u.location,
    'ask_cents', u.ask_cents,
    'acquisition_cost_cents', u.acquisition_cost_cents,
    'floor_cents', u.floor_cents,
    'msrp_cents', u.msrp_cents,
    'upc', u.upc,
    'lot', u.lot,
    'mfr_serial', u.mfr_serial,
    'defect_notes', u.defect_notes,
    'state', u.state,
    'show_on_website', u.show_on_website,
    'received_at', u.received_at,
    'updated_at', u.updated_at,
    'photos', photos,
    'has_photo', jsonb_array_length(photos) > 0,
    'unfinished', u.ask_cents is null or jsonb_array_length(photos) = 0
  );
end;
$$;

create or replace function public.portal_inventory_update_field(
  p_sku text,
  p_field text,
  p_value text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  sid uuid := public.portal_store_id();
  v_old text;
  v_actor text;
begin
  if sid is null then raise exception 'not a portal admin'; end if;
  if p_field not in (
    'brand','model','title','category','condition','test_status','location',
    'mfr_serial','defect_notes','upc','lot','acquisition_cost_cents','msrp_cents',
    'ask_cents','floor_cents'
  ) then
    raise exception 'invalid_field' using errcode = '22023';
  end if;

  if not exists (select 1 from public.units where sku = btrim(p_sku) and store_id = sid) then
    raise exception 'unit_not_found';
  end if;

  execute format('select %I::text from public.units where sku = $1 and store_id = $2', p_field)
    into v_old using btrim(p_sku), sid;

  if p_field like '%_cents' then
    execute format(
      'update public.units set %I = $1::int, updated_at = now() where sku = $2 and store_id = $3',
      p_field
    ) using nullif(p_value, ''), btrim(p_sku), sid;
  else
    execute format(
      'update public.units set %I = $1, updated_at = now() where sku = $2 and store_id = $3',
      p_field
    ) using p_value, btrim(p_sku), sid;
  end if;

  v_actor := coalesce(
    (select display_name from public.staff where user_id = auth.uid() and store_id = sid),
    (select email from auth.users where id = auth.uid()),
    'portal'
  );

  insert into public.events (store_id, sku, kind, field, old_value, new_value, actor, actor_id)
  values (sid, btrim(p_sku), 'edit', p_field, v_old, p_value, v_actor, auth.uid());
end;
$$;

create or replace function public.portal_inventory_next_sku()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  sid uuid := public.portal_store_id();
  v text;
begin
  if sid is null then raise exception 'not a portal admin'; end if;
  begin
    if public.current_store_id() is not null then
      select public.next_sku() into v;
      return v;
    end if;
  exception when others then
    null;
  end;
  select lpad((coalesce(max(sku::bigint), 11000) + 1)::text, 5, '0') into v
  from public.units
  where store_id = sid and sku ~ '^[0-9]+$';
  return v;
end;
$$;

create or replace function public.portal_inventory_receive(
  p_sku text,
  p_brand text default '',
  p_model text default '',
  p_title text default '',
  p_category text default null,
  p_condition text default null,
  p_ask_cents int default null,
  p_cost_cents int default null,
  p_floor_cents int default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  sid uuid := public.portal_store_id();
  v_sku text := btrim(p_sku);
  v_row public.units;
  v_actor text;
  v_title text;
begin
  if sid is null then raise exception 'not a portal admin'; end if;
  if v_sku is null or v_sku = '' then raise exception 'invalid_sku'; end if;

  v_title := coalesce(
    nullif(btrim(p_title), ''),
    nullif(btrim(concat_ws(' ', p_brand, p_model)), ''),
    v_sku
  );

  if exists (
    select 1 from public.staff s
    where s.user_id = auth.uid() and s.store_id = sid and s.deactivated_at is null
  ) and public.current_store_id() is not distinct from sid then
    v_row := public.receive_unit(
      v_sku, coalesce(p_brand,''), coalesce(p_model,''), v_title,
      p_category, p_condition, null, null,
      p_ask_cents, null, p_cost_cents, p_floor_cents, p_notes, null, null, null
    );
    return to_jsonb(v_row);
  end if;

  if exists (select 1 from public.units where store_id = sid and sku = v_sku) then
    raise exception 'SKU % is already in inventory.', v_sku;
  end if;

  v_actor := coalesce(
    (select display_name from public.staff where user_id = auth.uid() and store_id = sid),
    (select email from auth.users where id = auth.uid()),
    'portal'
  );

  insert into public.sku_ledger (store_id, sku, issued_at, label, fate)
  values (sid, v_sku, now(), v_title, 'issued');

  insert into public.units (
    store_id, sku, brand, model, title, category, condition,
    defect_notes, acquisition_cost_cents, ask_cents, floor_cents,
    state, show_on_website, received_at, updated_at
  ) values (
    sid, v_sku, coalesce(p_brand,''), coalesce(p_model,''), v_title,
    p_category, p_condition, p_notes, p_cost_cents, p_ask_cents, p_floor_cents,
    'available', true, now(), now()
  )
  returning * into v_row;

  insert into public.events (store_id, sku, kind, actor, actor_id, note)
  values (sid, v_sku, 'received', v_actor, auth.uid(), 'portal');

  return to_jsonb(v_row);
end;
$$;

create or replace function public.portal_inventory_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  sid uuid := public.portal_store_id();
  cats jsonb;
  conds jsonb;
begin
  if sid is null then raise exception 'not a portal admin'; end if;
  select value into cats from public.store_settings where store_id = sid and key = 'categories';
  select value into conds from public.store_settings where store_id = sid and key = 'conditions';
  return jsonb_build_object('categories', coalesce(cats, '[]'::jsonb), 'conditions', coalesce(conds, '[]'::jsonb));
end;
$$;

grant execute on function public.portal_inventory_counts() to authenticated;
grant execute on function public.portal_inventory_list(text, boolean, integer, integer) to authenticated;
grant execute on function public.portal_inventory_get(text) to authenticated;
grant execute on function public.portal_inventory_update_field(text, text, text) to authenticated;
grant execute on function public.portal_inventory_next_sku() to authenticated;
grant execute on function public.portal_inventory_receive(text, text, text, text, text, text, int, int, int, text) to authenticated;
grant execute on function public.portal_inventory_settings() to authenticated;