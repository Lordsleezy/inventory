begin;

insert into public.store_settings (store_id, key, value)
select id, 'marketplace_packing_markup_cents', '200'::jsonb
from public.stores
on conflict (store_id, key) do nothing;

create or replace function public.portal_set_marketplace_packing_markup(p_markup_cents integer)
returns integer language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if p_markup_cents is null or p_markup_cents < 0 then
    raise exception 'packing_markup_must_be_nonnegative' using errcode = '22023';
  end if;
  insert into public.store_settings (store_id, key, value)
  values (v_store, 'marketplace_packing_markup_cents', to_jsonb(p_markup_cents))
  on conflict (store_id, key) do update set value = excluded.value;
  return p_markup_cents;
end $$;

create or replace function public.portal_set_unit_marketplace_markup(p_sku text, p_markup_cents integer)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_old integer;
  v_specs jsonb;
  v_who text := (select email from auth.users where id = auth.uid());
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if p_markup_cents is not null and p_markup_cents < 0 then
    raise exception 'packing_markup_must_be_nonnegative' using errcode = '22023';
  end if;
  select listing_specs into v_specs from public.units where store_id = v_store and sku = p_sku for update;
  if not found then raise exception 'unit_not_found' using errcode = 'P0002'; end if;
  begin v_old := nullif(v_specs->>'marketplace_packing_markup_cents','')::integer;
  exception when others then v_old := null; end;
  if p_markup_cents is null then
    v_specs := coalesce(v_specs, '{}'::jsonb) - 'marketplace_packing_markup_cents';
    if v_specs = '{}'::jsonb then v_specs := null; end if;
  else
    v_specs := jsonb_set(coalesce(v_specs, '{}'::jsonb), '{marketplace_packing_markup_cents}', to_jsonb(p_markup_cents), true);
  end if;
  update public.units set listing_specs = v_specs, updated_at = now() where store_id = v_store and sku = p_sku;
  insert into public.events (store_id, sku, kind, field, old_value, new_value, actor, actor_id)
  values (v_store, p_sku, 'edit', 'marketplace_packing_markup_cents', v_old::text,
    p_markup_cents::text, coalesce(v_who,'admin'), auth.uid());
  return p_markup_cents;
end $$;

revoke all on function public.portal_set_marketplace_packing_markup(integer) from public, anon;
revoke all on function public.portal_set_unit_marketplace_markup(text, integer) from public, anon;
grant execute on function public.portal_set_marketplace_packing_markup(integer) to authenticated;
grant execute on function public.portal_set_unit_marketplace_markup(text, integer) to authenticated;

commit;
