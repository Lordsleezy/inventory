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
  if v_kind not in ('photo', 'price', 'spec') then
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
          )
        order by u.received_at desc nulls last, u.sku desc
        limit greatest(p_limit, 1) offset greatest(p_offset, 0)
      ) x
    ), '[]'::jsonb)
  );
end $$;

revoke all on function public.portal_units_missing_field(text, int, int) from public, anon;
grant execute on function public.portal_units_missing_field(text, int, int) to authenticated;