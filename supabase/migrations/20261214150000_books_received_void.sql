begin;

create or replace function public.portal_books_items_received(p_period uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare p public.books_periods; v_store uuid := public.books_require_admin();
begin
  if not public.portal_is_admin() or not public.portal_financial_access() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  select * into p from public.books_periods where id = p_period and store_id = v_store;
  if not found then raise exception 'period_not_found' using errcode = 'P0002'; end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'sku', u.sku,
      'title', coalesce(nullif(u.title, ''), nullif(concat_ws(' ', u.brand, u.model), ''), u.sku),
      'brand', u.brand,
      'category', coalesce(u.internal_category, u.category),
      'condition', u.condition,
      'qty_on_hand', u.qty_on_hand,
      'cost_cents', u.acquisition_cost_cents,
      'ask_cents', coalesce(u.floor_cents, u.ask_cents),
      'location', u.location,
      'received_at', u.received_at,
      'receiver_name', coalesce(
        (select st.display_name from public.stock_movements m
          join public.staff st on st.store_id = m.store_id and st.user_id = m.actor_id
         where m.store_id = u.store_id and m.sku = u.sku and m.movement_type in ('received', 'added')
         order by m.created_at limit 1),
        ''
      ),
      'listing_status', coalesce((
        select string_agg(l.channel || ' ' || l.status, ', ' order by l.channel)
          from public.listings l where l.store_id = u.store_id and l.sku = u.sku
      ), u.state),
      'unit_state', u.state
    ) order by u.received_at, u.sku)
    from public.units u
    where u.store_id = v_store
      and u.state not in ('voided', 'lost', 'scrapped', 'deleted', 'mistake')
      and coalesce(u.qty_on_hand, 0) > 0
      and (u.received_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end
      and not exists (
        select 1 from public.stock_movements mv
        where mv.store_id = u.store_id and mv.sku = u.sku
          and mv.movement_type in ('voided', 'deleted', 'mistake')
          and (mv.created_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end
      )
  ), '[]'::jsonb);
end $$;

commit;
