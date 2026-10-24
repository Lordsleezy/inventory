create or replace function public.portal_set_unit_ask(p_sku text, p_ask_cents int)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_old int;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if p_ask_cents is null or p_ask_cents < 0 then
    raise exception 'ask_must_be_non_negative' using errcode = '22023';
  end if;
  select ask_cents into v_old from public.units where store_id = v_store and sku = p_sku for update;
  if not found then raise exception 'unit_not_found' using errcode = 'P0001'; end if;
  update public.units
    set ask_cents = p_ask_cents, updated_at = now()
  where store_id = v_store and sku = p_sku;
  insert into public.events (store_id, sku, kind, field, old_value, new_value, actor, actor_id)
  values (
    v_store, p_sku, 'edit', 'ask_cents', v_old::text, p_ask_cents::text,
    coalesce((select email from auth.users where id = auth.uid()), 'admin'), auth.uid()
  );
end $$;

revoke all on function public.portal_set_unit_ask(text, int) from public, anon;
grant execute on function public.portal_set_unit_ask(text, int) to authenticated;