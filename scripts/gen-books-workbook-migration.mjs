import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const fixup = fs.readFileSync(path.join(root, 'supabase/migrations/20261108120000_money_books_fixup.sql'), 'utf8');
const m = fixup.match(/create or replace function public\.portal_books_report[\s\S]*?^end \$\$;/m);
if (!m) throw new Error('portal_books_report not found');
let fn = m[0];
fn = fn.replace(
  "if not found then raise exception 'period_not_found' using errcode='P0002'; end if;",
  "if not found then raise exception 'period_not_found' using errcode='P0002'; end if;\n if p.status = 'locked' and p.frozen_report is not null then return p.frozen_report; end if;",
);

const inv = `
create or replace function public.portal_books_inventory_summary(p_period uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare
  p public.books_periods;
  v_store uuid := public.books_require_admin();
  v_start int; v_end int; v_start_src text; v_end_src text;
  v_sold int; v_recv int; v_give int; v_repl int; v_ret int; v_def int; v_ret_qty int;
begin
  if not public.portal_is_admin() or not public.portal_financial_access() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  select * into p from public.books_periods where id = p_period and store_id = v_store;
  if not found then raise exception 'period_not_found' using errcode = 'P0002'; end if;

  select s.unit_count into v_start from public.books_inventory_snapshots s
    where s.store_id = v_store and s.captured_on = p.period_start and s.boundary = 'start' limit 1;
  if v_start is null then
    select s.unit_count into v_start from public.books_inventory_snapshots s
      where s.store_id = v_store and s.boundary = 'start' and s.captured_on <= p.period_start
      order by s.captured_on desc limit 1;
  end if;
  if v_start is not null then v_start_src := 'snapshot'; end if;

  select s.unit_count into v_end from public.books_inventory_snapshots s
    where s.store_id = v_store and s.captured_on = p.period_end and s.boundary = 'end' limit 1;
  if v_end is null then
    select s.unit_count into v_end from public.books_inventory_snapshots s
      where s.store_id = v_store and s.boundary = 'end' and s.captured_on <= p.period_end
      order by s.captured_on desc limit 1;
  end if;
  if v_end is not null then v_end_src := 'snapshot'; end if;

  select coalesce(sum(coalesce(l.qty, 1)), 0)::int into v_sold
    from public.sale_ledger l where l.store_id = v_store and l.voided_at is null
      and (l.sold_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end;

  select coalesce(sum(greatest(m.quantity_delta, 0)), 0)::int into v_recv
    from public.stock_movements m where m.store_id = v_store and m.movement_type in ('received', 'added')
      and (m.created_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end;

  select count(*) filter (where d.kind = 'giveaway'), count(*) filter (where d.kind = 'replacement')
    into v_give, v_repl
    from public.unit_dispositions d
   where d.store_id = v_store and d.undone_at is null
     and (d.created_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end;

  select count(*)::int into v_ret from public.returns r
   where r.store_id = v_store
     and (r.created_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end;

  select coalesce(sum(abs(m.quantity_delta)), 0)::int into v_def
    from public.stock_movements m
   where m.store_id = v_store and m.movement_type = 'pulled_defective'
     and (m.created_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end;

  select coalesce(sum(greatest(m.quantity_delta, 0)), 0)::int into v_ret_qty
    from public.stock_movements m
   where m.store_id = v_store and m.movement_type = 'returned'
     and (m.created_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end;

  if v_end is null then
    select coalesce(sum(u.qty_on_hand), 0)::int into v_end
      from public.units u
     where u.store_id = v_store and u.state in ('available', 'reserved', 'repair');
    v_end_src := 'approximate';
  end if;
  if v_start is null then
    v_start := greatest(0, coalesce(v_end, 0) - v_recv + v_sold + v_give + v_repl + v_def - v_ret_qty);
    v_start_src := 'approximate';
  end if;

  return jsonb_build_object(
    'start_unit_count', v_start,
    'end_unit_count', v_end,
    'start_source', coalesce(v_start_src, 'approximate'),
    'end_source', coalesce(v_end_src, 'approximate'),
    'sold_units', v_sold,
    'received_units', v_recv,
    'giveaway_units', v_give,
    'replacement_units', v_repl,
    'return_count', v_ret,
    'defective_units', v_def,
    'giveaways', coalesce((
      select jsonb_agg(jsonb_build_object(
        'sku', d.sku,
        'title', coalesce(nullif(u.title, ''), nullif(concat_ws(' ', u.brand, u.model), ''), d.sku),
        'cost_cents', u.acquisition_cost_cents,
        'given_to', d.given_to,
        'date', d.created_at
      ) order by d.created_at) from public.unit_dispositions d
      left join public.units u on u.store_id = d.store_id and u.sku = d.sku
      where d.store_id = v_store and d.kind = 'giveaway' and d.undone_at is null
        and (d.created_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end
    ), '[]'::jsonb),
    'replacements', coalesce((
      select jsonb_agg(jsonb_build_object(
        'sku', d.sku,
        'title', coalesce(nullif(u.title, ''), nullif(concat_ws(' ', u.brand, u.model), ''), d.sku),
        'original_sale_id', d.original_sale_id,
        'original_sku', d.original_sku,
        'bad_unit_status', d.bad_unit_status,
        'bad_unit_sku', d.bad_unit_sku,
        'extra_cost_cents', d.extra_cost_cents,
        'date', d.created_at
      ) order by d.created_at) from public.unit_dispositions d
      left join public.units u on u.store_id = d.store_id and u.sku = d.sku
      where d.store_id = v_store and d.kind = 'replacement' and d.undone_at is null
        and (d.created_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end
    ), '[]'::jsonb),
    'returns', coalesce((
      select jsonb_agg(jsonb_build_object(
        'sku', r.sku,
        'order_id', coalesce(r.external_order_id, r.external_return_id),
        'channel', r.channel,
        'refund_cents', r.refund_cents,
        'label_cents', r.return_label_cents,
        'status', r.status,
        'disposition', r.disposition,
        'route_to', r.route_to,
        'date', r.created_at
      ) order by r.created_at) from public.returns r
      where r.store_id = v_store
        and (r.created_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end
    ), '[]'::jsonb),
    'defective_moves', coalesce((
      select jsonb_agg(jsonb_build_object(
        'sku', m.sku,
        'title', coalesce(nullif(u.title, ''), nullif(concat_ws(' ', u.brand, u.model), ''), m.sku),
        'quantity', abs(m.quantity_delta),
        'date', m.created_at,
        'reason', m.reason
      ) order by m.created_at) from public.stock_movements m
      left join public.units u on u.store_id = m.store_id and u.sku = m.sku
      where m.store_id = v_store and m.movement_type = 'pulled_defective'
        and (m.created_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end
    ), '[]'::jsonb)
  );
end $$;

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
      and (u.received_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end
  ), '[]'::jsonb);
end $$;

revoke all on function public.portal_books_inventory_summary(uuid) from public, anon;
revoke all on function public.portal_books_items_received(uuid) from public, anon;
grant execute on function public.portal_books_inventory_summary(uuid) to authenticated;
grant execute on function public.portal_books_items_received(uuid) to authenticated;
`;

const out = `begin;\n\n${fn}\n\n${inv}\ncommit;\n`;
const dest = path.join(root, 'supabase/migrations/20261211130000_books_workbook.sql');
fs.writeFileSync(dest, out);
console.log('Wrote', dest, out.length, 'bytes');
