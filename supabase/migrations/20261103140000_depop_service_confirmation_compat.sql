begin;
-- Keep already-running listing agents compatible with the original Add listing RPC.
-- Only a signed service-role JWT may resolve a store from a globally unique SKU.
create or replace function public.portal_depop_add_listing(p_sku text,p_url text,p_price_cents integer,p_listed_at date default null)
returns void language plpgsql security definer set search_path=public as $$
declare v_store uuid; v_stores uuid[]; v_actor text;
begin
 if auth.role()='service_role' then
  select array_agg(u.store_id) into v_stores from public.units u where u.sku=btrim(p_sku);
  if coalesce(cardinality(v_stores),0)<>1 then raise exception 'unit_store_not_unique' using errcode='P0002'; end if;
  v_store:=v_stores[1]; v_actor:='Depop listing agent (service)';
 else
  v_store:=public.portal_assert_admin_store();v_actor:=public.disposition_actor_name(auth.uid());
 end if;
 if nullif(btrim(p_url),'') is null then raise exception 'invalid_depop_url' using errcode='22023'; end if;
 if p_price_cents is null then raise exception 'invalid_depop_price' using errcode='22023'; end if;
 perform public.floor_depop_record_listing(v_store,p_sku,p_url,p_price_cents,
  coalesce(p_listed_at,(now() at time zone 'America/Los_Angeles')::date)::timestamp at time zone 'America/Los_Angeles',v_actor);
end $$;
revoke all on function public.portal_depop_add_listing(text,text,integer,date) from public,anon;
grant execute on function public.portal_depop_add_listing(text,text,integer,date) to authenticated,service_role;
commit;
