begin;

-- Month list for Books: months with activity only (no weekly cards).
create or replace function public.portal_books_list(p_from date default date '2026-01-01', p_to date default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_store uuid := public.books_require_admin();
  v_end date := coalesce(p_to, (now() at time zone 'America/Los_Angeles')::date);
  v_result jsonb;
begin
  insert into public.books_periods(store_id, period_type, period_start, period_end)
  values (v_store, 'month', date_trunc('month', v_end)::date, (date_trunc('month', v_end) + interval '1 month - 1 day')::date)
  on conflict (store_id, period_type, period_start) do nothing;

  select coalesce(jsonb_agg(to_jsonb(p) || jsonb_build_object('locked_by_name', st.display_name) order by p.period_start desc), '[]'::jsonb)
  into v_result
  from public.books_periods p
  left join public.staff st on st.user_id = p.locked_by and st.store_id = p.store_id
  where p.store_id = v_store
    and p.period_type = 'month'
    and p.period_start <= v_end
    and p.period_end >= p_from
    and (
      p.status = 'locked'
      or exists (
        select 1 from public.sale_ledger l
        where l.store_id = v_store and l.voided_at is null
          and (l.sold_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end
      )
      or exists (select 1 from public.portal_expenses e where e.store_id = v_store and e.voided_at is null and e.spent_on between p.period_start and p.period_end)
      or exists (select 1 from public.units u where u.store_id = v_store and (u.received_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end)
    );
  return v_result;
end $$;

-- Lock without surfacing the legacy close checklist in Books UI (Steve still gets frozen exports).
create or replace function public.portal_books_finalize(p_period uuid, p_report jsonb, p_excel_base64 text, p_pdf_base64 text)
returns void language plpgsql security definer set search_path=public as $$
declare v_store uuid:=public.books_require_admin(); p public.books_periods; v_hash text;
begin
 select * into p from public.books_periods where id=p_period and store_id=v_store for update;
 if not found or p.status='locked' then raise exception 'period_not_editable' using errcode='P0001'; end if;
 if p.period_type<>'month' then raise exception 'weekly_period_cannot_lock' using errcode='P0001'; end if;
 if p_excel_base64 is null or p_pdf_base64 is null or length(p_excel_base64)>30000000 or length(p_pdf_base64)>30000000 then raise exception 'frozen_exports_required' using errcode='22023'; end if;
 v_hash:=encode(digest(convert_to(p_report::text,'UTF8'),'sha256'),'hex');
 insert into public.books_period_versions(store_id,period_id,version_no,locked_at,locked_by,snapshot_hash,frozen_report,frozen_excel,frozen_pdf)
 values(v_store,p.id,coalesce((select max(ver.version_no)+1 from public.books_period_versions ver where ver.period_id=p.id),1),now(),auth.uid(),v_hash,p_report,decode(p_excel_base64,'base64'),decode(p_pdf_base64,'base64'));
 update public.books_periods set status='locked',locked_at=now(),locked_by=auth.uid(),frozen_report=p_report,
   frozen_excel=decode(p_excel_base64,'base64'),frozen_pdf=decode(p_pdf_base64,'base64') where id=p.id;
 insert into public.books_period_audit(store_id,period_id,action,reason,actor_id,snapshot_hash) values(v_store,p.id,'locked','',auth.uid(),v_hash);
end $$;

-- return_to_stock_units on inventory summary (portal_books_inventory_summary body patch via full replace of return object only - use dynamic update on existing function)
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
    v_start := greatest(0, coalesce(v_end, 0) - v_recv - v_ret_qty + v_sold + v_give + v_repl + v_def);
    v_start_src := 'approximate';
  end if;

  return jsonb_build_object(
    'start_unit_count', v_start,
    'end_unit_count', v_end,
    'start_source', coalesce(v_start_src, 'approximate'),
    'end_source', coalesce(v_end_src, 'approximate'),
    'sold_units', v_sold,
    'received_units', v_recv,
    'return_to_stock_units', v_ret_qty,
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
        'buyer_keeps_item', (r.route_to = 'buyer_keeps' or r.status = 'refunded_no_return'),
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

commit;
