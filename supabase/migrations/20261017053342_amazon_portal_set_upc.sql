-- Let Amazon queue cards save a missing UPC onto the Floor unit (portal auth).

create or replace function public.portal_amazon_set_upc(p_sku text, p_upc text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_store uuid := public.portal_store_id();
  v_sku text := nullif(btrim(coalesce(p_sku, '')), '');
  v_upc text := nullif(regexp_replace(coalesce(p_upc, ''), '[^0-9]', '', 'g'), '');
  v_old text;
begin
  if v_store is null or not public.portal_is_admin() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  if v_sku is null then
    raise exception 'sku_required' using errcode = '22023';
  end if;
  if v_upc is null then
    raise exception 'upc_required' using errcode = '22023';
  end if;
  if not public.valid_gtin(v_upc) then
    raise exception 'invalid_upc' using errcode = '22023';
  end if;

  select upc into v_old
  from public.units
  where store_id = v_store and sku = v_sku
  for update;
  if not found then
    raise exception 'unit_not_found' using errcode = 'P0001';
  end if;

  update public.units
     set upc = v_upc,
         upc_rejected = null,
         updated_at = now()
   where store_id = v_store and sku = v_sku;

  update public.amazon_list_items
     set last_error = null,
         updated_at = now()
   where store_id = v_store and sku = v_sku and status is distinct from 'removed';

  insert into public.events (store_id, sku, kind, field, old_value, new_value, actor, actor_id)
  values (
    v_store, v_sku, 'edit', 'upc', left(v_old, 200), left(v_upc, 200),
    coalesce((select email from auth.users where id = auth.uid()), 'admin'), auth.uid()
  );
end
$function$;

revoke all on function public.portal_amazon_set_upc(text, text) from public, anon;
grant execute on function public.portal_amazon_set_upc(text, text) to authenticated;
