-- Staff can set ship-to (and buyer name) on open orders before Bundle.
-- Needed for hand-entered Depop sales, which create web_orders with no address.

begin;

create or replace function public.portal_set_order_ship_to(
  p_ids uuid[],
  p_buyer_name text default null,
  p_line1 text default null,
  p_line2 text default null,
  p_city text default null,
  p_region text default null,
  p_postal text default null,
  p_country text default 'US'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  v_ids uuid[] := coalesce(p_ids, '{}');
  peer public.web_orders;
  i int;
  v_buyer text := nullif(btrim(coalesce(p_buyer_name, '')), '');
  v_line1 text := nullif(btrim(coalesce(p_line1, '')), '');
  v_line2 text := nullif(btrim(coalesce(p_line2, '')), '');
  v_city text := nullif(btrim(coalesce(p_city, '')), '');
  v_region text := nullif(btrim(coalesce(p_region, '')), '');
  v_postal text := nullif(btrim(coalesce(p_postal, '')), '');
  v_country text := coalesce(nullif(btrim(coalesce(p_country, '')), ''), 'US');
  v_n int := 0;
begin
  if v_store is null or not public.portal_is_admin() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  if cardinality(v_ids) < 1 then
    raise exception 'need_one' using errcode = 'P0001';
  end if;
  if v_line1 is null or v_city is null or v_region is null or v_postal is null then
    raise exception 'missing_address' using errcode = 'P0001';
  end if;

  for i in 1 .. cardinality(v_ids) loop
    select * into peer from public.web_orders where store_id = v_store and id = v_ids[i];
    if peer.id is null then raise exception 'order_not_found' using errcode = 'P0001'; end if;
    if peer.status is distinct from 'paid'
       or coalesce(peer.fulfillment, 'ship') is distinct from 'ship'
       or peer.canceled_at is not null
       or peer.shipped_at is not null then
      raise exception 'not_open' using errcode = 'P0001';
    end if;

    update public.web_orders
    set
      buyer_name = coalesce(v_buyer, buyer_name),
      ship_line1 = v_line1,
      ship_line2 = v_line2,
      ship_city = v_city,
      ship_region = v_region,
      ship_postal = v_postal,
      ship_country = v_country,
      updated_at = now()
    where store_id = v_store and id = peer.id;
    v_n := v_n + 1;

    insert into public.events(store_id, sku, kind, field, new_value, actor, actor_id, note)
    values (
      v_store, peer.sku, 'edit', 'order_ship_to',
      format('%s · %s, %s %s', v_line1, v_city, v_region, v_postal),
      public.disposition_actor_name(auth.uid()), auth.uid(),
      'Ship-to set for bundling / label'
    );
  end loop;

  return jsonb_build_object('ok', true, 'count', v_n, 'ids', to_jsonb(v_ids));
end $$;

revoke all on function public.portal_set_order_ship_to(uuid[], text, text, text, text, text, text, text) from public, anon;
grant execute on function public.portal_set_order_ship_to(uuid[], text, text, text, text, text, text, text) to authenticated, service_role;

commit;
