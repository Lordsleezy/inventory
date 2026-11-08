begin;

-- Mercari is no longer a marketplace. Past sales stay on the sales ledger.
-- Inventory reports list current defective stock under Not listed.

create or replace function public.portal_books_inventory_owner(p_period uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare
  p public.books_periods;
  v_store uuid := public.books_require_admin();
  v_end date;
  v_on_units int; v_on_cost bigint; v_on_floor bigint;
  v_sold_units int; v_sold_cost bigint;
  v_recv_units int; v_recv_cost bigint;
  v_ret_units int; v_ret_cost bigint;
  v_give_units int; v_give_cost bigint;
  v_repl_units int; v_repl_cost bigint;
  v_def_units int; v_def_cost bigint;
  v_start_units int; v_start_src text;
begin
  if not public.portal_is_admin() or not public.portal_financial_access() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  select * into p from public.books_periods where id = p_period and store_id = v_store;
  if not found then raise exception 'period_not_found' using errcode = 'P0002'; end if;
  v_end := p.period_end;

  select s.unit_count, 'snapshot' into v_start_units, v_start_src
    from public.books_inventory_snapshots s
   where s.store_id = v_store and s.captured_on = p.period_start and s.boundary = 'start' limit 1;

  with live as (
    select u.sku,
      greatest(coalesce(u.qty_on_hand, 0), 0)::int qty,
      coalesce(u.acquisition_cost_cents, 0)::bigint cost_each,
      coalesce(u.floor_cents, u.ask_cents, 0)::bigint floor_each,
      coalesce(nullif(btrim(u.internal_category), ''), nullif(btrim(u.category), ''), 'Uncategorized') category,
      coalesce(u.listed_on, '{}'::text[]) listed_on,
      coalesce((u.listing_specs->>'do_not_list')::boolean, false) do_not_list,
      u.received_at,
      coalesce(nullif(u.title, ''), nullif(concat_ws(' ', u.brand, u.model), ''), u.sku) title,
      exists (select 1 from public.photos ph where ph.sku = u.sku) has_photo
    from public.units u
    where u.store_id = v_store
      and u.state in ('available', 'reserved', 'repair')
      and coalesce(u.qty_on_hand, 0) > 0
  ),
  sold as (
    select coalesce(sum(coalesce(l.qty, 1)), 0)::int units,
           coalesce(sum(coalesce(l.cost_cents, l.unit_cost_cents, 0)), 0)::bigint cost
      from public.sale_ledger l
     where l.store_id = v_store and l.voided_at is null
       and (l.sold_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end
  ),
  recv as (
    select coalesce(sum(greatest(m.quantity_delta, 0)), 0)::int units,
           coalesce(sum(greatest(m.quantity_delta, 0) * coalesce(u.acquisition_cost_cents, 0)), 0)::bigint cost
      from public.stock_movements m
      join public.units u on u.store_id = m.store_id and u.sku = m.sku
     where m.store_id = v_store and m.movement_type in ('received', 'added')
       and u.state not in ('voided', 'lost', 'scrapped', 'deleted', 'mistake')
       and (m.created_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end
  ),
  retn as (
    select coalesce(sum(greatest(m.quantity_delta, 0)), 0)::int units,
           coalesce(sum(greatest(m.quantity_delta, 0) * coalesce(u.acquisition_cost_cents, 0)), 0)::bigint cost
      from public.stock_movements m
      join public.units u on u.store_id = m.store_id and u.sku = m.sku
     where m.store_id = v_store and m.movement_type = 'returned'
       and u.state not in ('voided', 'lost', 'scrapped', 'deleted', 'mistake')
       and (m.created_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end
  ),
  give as (
    select count(*)::int units, coalesce(sum(coalesce(u.acquisition_cost_cents, 0)), 0)::bigint cost
      from public.unit_dispositions d
      left join public.units u on u.store_id = d.store_id and u.sku = d.sku
     where d.store_id = v_store and d.kind = 'giveaway' and d.undone_at is null
       and (d.created_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end
  ),
  repl as (
    select count(*)::int units, coalesce(sum(coalesce(d.extra_cost_cents, u.acquisition_cost_cents, 0)), 0)::bigint cost
      from public.unit_dispositions d
      left join public.units u on u.store_id = d.store_id and u.sku = d.sku
     where d.store_id = v_store and d.kind = 'replacement' and d.undone_at is null
       and (d.created_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end
  ),
  def as (
    select coalesce(sum(abs(m.quantity_delta)), 0)::int units,
           coalesce(sum(abs(m.quantity_delta) * coalesce(u.acquisition_cost_cents, 0)), 0)::bigint cost
      from public.stock_movements m
      left join public.units u on u.store_id = m.store_id and u.sku = m.sku
     where m.store_id = v_store and m.movement_type = 'pulled_defective'
       and (m.created_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end
  )
  select
    (select coalesce(sum(qty), 0) from live),
    (select coalesce(sum(qty * cost_each), 0) from live),
    (select coalesce(sum(qty * floor_each), 0) from live),
    (select units from sold), (select cost from sold),
    (select units from recv), (select cost from recv),
    (select units from retn), (select cost from retn),
    (select units from give), (select cost from give),
    (select units from repl), (select cost from repl),
    (select units from def), (select cost from def)
  into v_on_units, v_on_cost, v_on_floor,
       v_sold_units, v_sold_cost, v_recv_units, v_recv_cost, v_ret_units, v_ret_cost,
       v_give_units, v_give_cost, v_repl_units, v_repl_cost, v_def_units, v_def_cost;

  if v_start_units is null then
    v_start_units := greatest(0, v_on_units - v_recv_units - v_ret_units + v_sold_units + v_give_units + v_repl_units + v_def_units);
    v_start_src := 'approximate';
  end if;

  return jsonb_build_object(
    'value', jsonb_build_object(
      'end_units', v_on_units,
      'end_cost_cents', v_on_cost,
      'end_floor_cents', v_on_floor,
      'end_source', 'live',
      'start_units', v_start_units,
      'start_cost_cents', v_on_cost - v_recv_cost - v_ret_cost + v_sold_cost + v_give_cost + v_repl_cost + v_def_cost,
      'start_floor_cents', null,
      'start_source', v_start_src,
      'start_note', case when v_start_src = 'snapshot'
        then 'Unit count is the month-start snapshot. Dollar start is current shelf cost rolled back by this month''s movement, because snapshots do not store cost.'
        else 'Estimated: no month-start snapshot. Units and cost are the current shelf rolled back by this month''s movement.' end
    ),
    'categories', coalesce((
      with live as (
        select greatest(coalesce(u.qty_on_hand, 0), 0)::int qty,
          coalesce(u.acquisition_cost_cents, 0)::bigint cost_each,
          coalesce(u.floor_cents, u.ask_cents, 0)::bigint floor_each,
          coalesce(nullif(btrim(u.internal_category), ''), nullif(btrim(u.category), ''), 'Uncategorized') category
        from public.units u
        where u.store_id = v_store and u.state in ('available', 'reserved', 'repair') and coalesce(u.qty_on_hand, 0) > 0
      ),
      sold as (
        select coalesce(nullif(btrim(u.internal_category), ''), nullif(btrim(u.category), ''), 'Uncategorized') category,
               coalesce(sum(coalesce(l.qty, 1)), 0)::int sold_units
          from public.sale_ledger l
          left join public.units u on u.store_id = l.store_id and u.sku = l.sku
         where l.store_id = v_store and l.voided_at is null
           and (l.sold_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end
         group by 1
      )
      select jsonb_agg(jsonb_build_object(
        'category', h.category,
        'units', h.units,
        'cost_cents', h.cost_cents,
        'floor_cents', h.floor_cents,
        'sold_units', coalesce(s.sold_units, 0),
        'sell_through', case when coalesce(s.sold_units, 0) + h.units = 0 then 0
          else round(100.0 * coalesce(s.sold_units, 0) / (coalesce(s.sold_units, 0) + h.units), 1) end
      ) order by h.cost_cents desc)
      from (
        select category, sum(qty)::int units, sum(qty * cost_each)::bigint cost_cents, sum(qty * floor_each)::bigint floor_cents
          from live group by category
      ) h
      left join sold s on s.category = h.category
    ), '[]'::jsonb),
    'listed', coalesce((
      select jsonb_agg(jsonb_build_object('channel', channel, 'units', units, 'cost_cents', cost_cents) order by channel)
      from (
        select c channel, sum(x.qty)::int units, sum(x.qty * x.cost_each)::bigint cost_cents
          from (
            select greatest(coalesce(u.qty_on_hand, 0), 0)::int qty,
                   coalesce(u.acquisition_cost_cents, 0)::bigint cost_each,
                   coalesce(u.listed_on, '{}'::text[]) listed_on
              from public.units u
             where u.store_id = v_store and u.state in ('available', 'reserved', 'repair') and coalesce(u.qty_on_hand, 0) > 0
          ) x
          cross join lateral unnest(x.listed_on) c
         where c in ('ebay', 'depop', 'tiktok', 'amazon', 'website')
         group by c
      ) z
    ), '[]'::jsonb),
    'listed_once', (
      select jsonb_build_object(
        'units', coalesce(sum(greatest(coalesce(u.qty_on_hand, 0), 0)) filter (where cardinality(coalesce(u.listed_on, '{}')) > 0), 0),
        'cost_cents', coalesce(sum(greatest(coalesce(u.qty_on_hand, 0), 0) * coalesce(u.acquisition_cost_cents, 0)) filter (where cardinality(coalesce(u.listed_on, '{}')) > 0), 0)
      )
      from public.units u
      where u.store_id = v_store and u.state in ('available', 'reserved', 'repair') and coalesce(u.qty_on_hand, 0) > 0
    ),
    'unlisted', coalesce((
      select jsonb_agg(jsonb_build_object('reason', reason, 'units', units, 'cost_cents', cost_cents) order by reason)
      from (
        select reason, sum(qty)::int units, sum(qty * cost_each)::bigint cost_cents
          from (
            select greatest(coalesce(u.qty_on_hand, 0), 0)::int qty,
              coalesce(u.acquisition_cost_cents, 0)::bigint cost_each,
              case
                when coalesce((u.listing_specs->>'do_not_list')::boolean, false) then 'do-not-list'
                when not exists (select 1 from public.photos ph where ph.sku = u.sku) then 'missing photo'
                when coalesce(u.floor_cents, u.ask_cents, 0) <= 0 then 'missing price'
                when coalesce(u.acquisition_cost_cents, 0) <= 0 then 'missing cost'
                else 'other'
              end reason
            from public.units u
            where u.store_id = v_store and u.state in ('available', 'reserved', 'repair')
              and coalesce(u.qty_on_hand, 0) > 0
              and cardinality(coalesce(u.listed_on, '{}'::text[])) = 0
          ) q
         group by reason
      ) z
    ), '[]'::jsonb),
    'aging', coalesce((
      select jsonb_agg(jsonb_build_object('bucket', bucket, 'units', units, 'cost_cents', cost_cents) order by ord)
      from (
        select bucket, min(ord) ord, sum(qty)::int units, sum(qty * cost_each)::bigint cost_cents
          from (
            select greatest(coalesce(u.qty_on_hand, 0), 0)::int qty,
              coalesce(u.acquisition_cost_cents, 0)::bigint cost_each,
              case
                when u.received_at is null then '90+ days'
                when (v_end - (u.received_at at time zone 'America/Los_Angeles')::date) <= 30 then '0–30 days'
                when (v_end - (u.received_at at time zone 'America/Los_Angeles')::date) <= 60 then '31–60 days'
                when (v_end - (u.received_at at time zone 'America/Los_Angeles')::date) <= 90 then '61–90 days'
                else '90+ days'
              end bucket,
              case
                when u.received_at is null then 4
                when (v_end - (u.received_at at time zone 'America/Los_Angeles')::date) <= 30 then 1
                when (v_end - (u.received_at at time zone 'America/Los_Angeles')::date) <= 60 then 2
                when (v_end - (u.received_at at time zone 'America/Los_Angeles')::date) <= 90 then 3
                else 4
              end ord
            from public.units u
            where u.store_id = v_store and u.state in ('available', 'reserved', 'repair') and coalesce(u.qty_on_hand, 0) > 0
          ) q
         group by bucket
      ) z
    ), '[]'::jsonb),
    'defective_shelf', (
      select jsonb_build_object(
        'units', coalesce(sum(greatest(coalesce(u.qty_on_hand, 0), 0)), 0),
        'cost_cents', coalesce(sum(greatest(coalesce(u.qty_on_hand, 0), 0) * coalesce(u.acquisition_cost_cents, 0)), 0)
      )
      from public.units u
      where u.store_id = v_store
        and u.state in ('available', 'reserved', 'repair')
        and coalesce(u.qty_on_hand, 0) > 0
        and coalesce(u.defective, false)
    ),
    'movement', jsonb_build_object(
      'received_units', v_recv_units, 'received_cost_cents', v_recv_cost,
      'sold_units', v_sold_units, 'sold_cost_cents', v_sold_cost,
      'return_to_stock_units', v_ret_units, 'return_to_stock_cost_cents', v_ret_cost,
      'giveaway_units', v_give_units, 'giveaway_cost_cents', v_give_cost,
      'replacement_units', v_repl_units, 'replacement_cost_cents', v_repl_cost,
      'defective_units', v_def_units, 'defective_cost_cents', v_def_cost
    ),
    'returns', coalesce((
      select jsonb_agg(jsonb_build_object(
        'sku', r.sku,
        'title', coalesce(nullif(u.title, ''), nullif(concat_ws(' ', u.brand, u.model), ''), r.sku),
        'channel', r.channel,
        'status', r.status,
        'refund_cents', r.refund_cents
      ) order by r.created_at)
      from public.returns r
      left join public.units u on u.store_id = r.store_id and u.sku = r.sku
      where r.store_id = v_store
        and (r.created_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end
    ), '[]'::jsonb),
    'slowest', coalesce((
      select jsonb_agg(x order by x.days desc)
      from (
        select u.sku,
          coalesce(nullif(u.title, ''), nullif(concat_ws(' ', u.brand, u.model), ''), u.sku) title,
          case when u.received_at is null then null
            else (v_end - (u.received_at at time zone 'America/Los_Angeles')::date) end days,
          coalesce(u.acquisition_cost_cents, 0) cost_cents,
          coalesce(u.floor_cents, u.ask_cents, 0) floor_cents,
          array_to_string(coalesce(u.listed_on, '{}'::text[]), ', ') listed
        from public.units u
        where u.store_id = v_store and u.state in ('available', 'reserved', 'repair') and coalesce(u.qty_on_hand, 0) > 0
        order by (u.received_at is null) desc, u.received_at asc
        limit 15
      ) x
    ), '[]'::jsonb)
  );
end $$;


revoke all on function public.portal_books_inventory_owner(uuid) from public, anon;
grant execute on function public.portal_books_inventory_owner(uuid) to authenticated;

commit;
