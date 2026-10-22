-- Needs-attention: add `model` (empty model) and `description` (empty listing_body) kinds,
-- plus a single-field setter so those two lists can be filled in without touching other fields.

create or replace function public.portal_units_missing_field(
  p_kind text,
  p_limit int default 100,
  p_offset int default 0
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_kind text := lower(btrim(coalesce(p_kind, '')));
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if v_kind not in ('photo', 'price', 'spec', 'model', 'description') then
    raise exception 'invalid_missing_kind' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'kind', v_kind,
    'total', (
      select count(*) from public.units u
      where u.store_id = v_store
        and u.state in ('available', 'reserved', 'repair')
        and (
          (v_kind = 'photo' and not exists (
            select 1 from public.photos p where p.store_id = u.store_id and p.sku = u.sku
          ))
          or (v_kind = 'price' and u.ask_cents is null)
          or (v_kind = 'spec' and (
            coalesce(u.package_weight_lb, 0) <= 0
            or coalesce(u.package_length_in, 0) <= 0
            or coalesce(u.package_width_in, 0) <= 0
            or coalesce(u.package_height_in, 0) <= 0
          ))
          or (v_kind = 'model' and nullif(btrim(coalesce(u.model, '')), '') is null)
          or (v_kind = 'description' and nullif(btrim(coalesce(u.listing_body, '')), '') is null)
        )
    ),
    'rows', coalesce((
      select jsonb_agg(x) from (
        select u.sku,
          coalesce(nullif(btrim(u.title), ''), nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), 'Item') as title,
          u.brand, u.model, u.state, u.ask_cents, u.received_at,
          u.package_weight_lb, u.package_length_in, u.package_width_in, u.package_height_in,
          (select count(*)::int from public.photos p where p.store_id = u.store_id and p.sku = u.sku) as photo_count
        from public.units u
        where u.store_id = v_store
          and u.state in ('available', 'reserved', 'repair')
          and (
            (v_kind = 'photo' and not exists (
              select 1 from public.photos p where p.store_id = u.store_id and p.sku = u.sku
            ))
            or (v_kind = 'price' and u.ask_cents is null)
            or (v_kind = 'spec' and (
              coalesce(u.package_weight_lb, 0) <= 0
              or coalesce(u.package_length_in, 0) <= 0
              or coalesce(u.package_width_in, 0) <= 0
              or coalesce(u.package_height_in, 0) <= 0
            ))
            or (v_kind = 'model' and nullif(btrim(coalesce(u.model, '')), '') is null)
            or (v_kind = 'description' and nullif(btrim(coalesce(u.listing_body, '')), '') is null)
          )
        order by u.received_at desc nulls last, u.sku desc
        limit greatest(p_limit, 1) offset greatest(p_offset, 0)
      ) x
    ), '[]'::jsonb)
  );
end $$;

revoke all on function public.portal_units_missing_field(text, int, int) from public, anon;
grant execute on function public.portal_units_missing_field(text, int, int) to authenticated;

-- Set exactly one of: model | description (listing_body). Blank values are rejected.
create or replace function public.portal_set_unit_text(p_sku text, p_field text, p_value text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_field text := lower(btrim(coalesce(p_field, '')));
  v_value text := nullif(btrim(coalesce(p_value, '')), '');
  v_old text;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if v_field not in ('model', 'description') then
    raise exception 'invalid_text_field' using errcode = '22023';
  end if;
  if v_value is null then
    raise exception 'value_required' using errcode = '22023';
  end if;
  if v_field = 'model' then
    select model into v_old from public.units where store_id = v_store and sku = p_sku for update;
  else
    select listing_body into v_old from public.units where store_id = v_store and sku = p_sku for update;
  end if;
  if not found then raise exception 'unit_not_found' using errcode = 'P0001'; end if;
  if v_field = 'model' then
    update public.units set model = v_value, updated_at = now()
      where store_id = v_store and sku = p_sku;
  else
    update public.units set listing_body = v_value, updated_at = now()
      where store_id = v_store and sku = p_sku;
  end if;
  insert into public.events (store_id, sku, kind, field, old_value, new_value, actor, actor_id)
  values (
    v_store, p_sku, 'edit', case when v_field = 'model' then 'model' else 'listing_body' end,
    left(v_old, 200), left(v_value, 200),
    coalesce((select email from auth.users where id = auth.uid()), 'admin'), auth.uid()
  );
end $$;

revoke all on function public.portal_set_unit_text(text, text, text) from public, anon;
grant execute on function public.portal_set_unit_text(text, text, text) to authenticated;
