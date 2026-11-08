-- Returns: refunds reduce owner profit (buyer_keep_refund_cents / sale_ledger)
-- and never claw back worker commissions. A replacement's extra cost stays on
-- the sale. It is not posted again as a Returns expense.

begin;

-- Profit-only keep-refund: update sales.buyer_keep_refund_cents, no payout adjustments.
create or replace function public.return_apply_keep_refund(p_return_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r public.returns;
  s public.sales;
  v_keep int;
  v_price int;
begin
  select * into r from public.returns where id = p_return_id for update;
  if not found or r.sale_id is null then
    return jsonb_build_object('ok', true, 'note', 'no_sale');
  end if;
  select * into s from public.sales where id = r.sale_id and store_id = r.store_id for update;
  if not found then return jsonb_build_object('ok', true, 'note', 'sale_missing'); end if;
  if s.voided_at is not null then
    update public.sales set buyer_keep_refund_cents = 0 where id = s.id;
    return jsonb_build_object('ok', true, 'note', 'sale_voided');
  end if;

  select coalesce(sum(amount_cents), 0)::int into v_keep
    from public.return_refunds f
   where f.return_id = r.id
     and (f.item_kept or f.kind = 'partial' or f.amount_cents < coalesce(s.price_cents, f.amount_cents));
  if v_keep <= 0 and coalesce(r.refund_cents, 0) > 0
     and (r.route_to = 'buyer_keeps' or r.status in ('refunded_no_return', 'closed') or r.refunded_at is not null)
  then
    v_keep := coalesce(r.refund_cents, 0);
  end if;
  if v_keep <= 0 then
    update public.sales set buyer_keep_refund_cents = 0 where id = s.id and buyer_keep_refund_cents <> 0;
    return jsonb_build_object('ok', true, 'keep_cents', 0);
  end if;
  v_price := greatest(coalesce(s.price_cents, 0), 0);
  v_keep := least(v_keep, case when v_price > 0 then v_price else v_keep end);
  update public.sales set buyer_keep_refund_cents = v_keep where id = s.id;
  -- Owner profit only. Worker commissions stay on the original sale.
  return jsonb_build_object('ok', true, 'keep_cents', v_keep, 'adjustments', '[]'::jsonb);
end $$;

-- Apply a confirmed refund amount to owner profit without voiding or clawbacks.
create or replace function public.return_apply_owner_profit_refund(p_return_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r public.returns;
  s public.sales;
  v_keep int;
  v_price int;
  v_kind text;
begin
  select * into r from public.returns where id = p_return_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'return_not_found'); end if;
  if r.sale_id is null or coalesce(r.refund_cents, 0) <= 0 then
    perform public.return_sync_label_expense(r.id);
    return jsonb_build_object('ok', true, 'note', 'no_refund');
  end if;
  select * into s from public.sales where id = r.sale_id and store_id = r.store_id for update;
  if not found then
    perform public.return_sync_label_expense(r.id);
    return jsonb_build_object('ok', true, 'note', 'sale_missing');
  end if;
  if s.voided_at is not null then
    perform public.return_sync_label_expense(r.id);
    return jsonb_build_object('ok', true, 'note', 'sale_voided');
  end if;

  v_price := greatest(coalesce(s.price_cents, 0), 0);
  v_keep := least(coalesce(r.refund_cents, 0), case when v_price > 0 then v_price else coalesce(r.refund_cents, 0) end);
  v_kind := case when v_price > 0 and v_keep < v_price then 'partial' else 'full' end;

  if not exists (select 1 from public.return_refunds f where f.return_id = r.id) then
    insert into public.return_refunds (store_id, return_id, amount_cents, channel, kind, item_kept, note)
    values (r.store_id, r.id, v_keep, r.channel, v_kind, true, 'Owner profit refund — commissions unchanged');
  else
    update public.return_refunds set
      amount_cents = v_keep,
      kind = v_kind,
      item_kept = true
    where return_id = r.id;
  end if;

  update public.sales set buyer_keep_refund_cents = v_keep where id = s.id;
  perform public.return_sync_label_expense(r.id);
  return jsonb_build_object('ok', true, 'keep_cents', v_keep);
end $$;

revoke all on function public.return_apply_owner_profit_refund(uuid) from public, anon, authenticated;
grant execute on function public.return_apply_owner_profit_refund(uuid) to service_role;

-- Replacement link: copy extra shipping/label cost onto the return row.
create or replace function public.returns_link_replacement()
returns trigger language plpgsql security definer set search_path = public as $$
declare s public.sales; v_id uuid; v_label int;
begin
  if new.kind is distinct from 'replacement' then return new; end if;
  if new.undone_at is not null then
    update public.returns set status = 'canceled', closed_at = coalesce(closed_at, now()), updated_at = now()
     where store_id = new.store_id and raw->>'replacement_id' = new.id::text
       and status not in ('closed', 'canceled', 'denied');
    return new;
  end if;
  if tg_op = 'UPDATE' and new.bad_unit_status = 'returned' and old.bad_unit_status is distinct from 'returned' then
    update public.returns set status = 'received', received_at = coalesce(received_at, now()), updated_at = now()
     where store_id = new.store_id and raw->>'replacement_id' = new.id::text
       and status in ('requested', 'label_sent', 'approved', 'in_transit');
  end if;
  v_label := greatest(coalesce(new.extra_cost_cents, 0), 0);
  if exists (select 1 from public.returns where store_id = new.store_id and raw->>'replacement_id' = new.id::text) then
    if v_label > 0 then
      update public.returns set
        return_label_cents = case when coalesce(return_label_cents, 0) > 0 then return_label_cents else v_label end,
        label_paid_by = 'seller',
        raw = coalesce(raw, '{}'::jsonb) || jsonb_build_object('return_kind', 'replacement'),
        updated_at = now()
       where store_id = new.store_id and raw->>'replacement_id' = new.id::text;
    end if;
    return new;
  end if;
  select * into s from public.sales where id = new.original_sale_id;
  insert into public.returns (
    store_id, sku, sale_id, channel, external_order_id, external_return_id,
    reason, status, route_to, needs_decision, requested_qty, buyer_name, raw, created_by,
    received_at, return_label_cents, label_paid_by, refund_cents
  ) values (
    new.store_id, coalesce(new.original_sku, new.sku), new.original_sale_id,
    lower(coalesce(s.channel, 'other')), s.receipt_no, 'replacement:' || new.id::text,
    'defective',
    case when new.bad_unit_status = 'returned' then 'received' else 'requested' end,
    'garage', false, 1, s.customer_name,
    jsonb_build_object(
      'replacement_id', new.id,
      'replacement_sku', new.sku,
      'return_kind', 'replacement'
    ),
    new.recorded_by,
    case when new.bad_unit_status = 'returned' then now() else null end,
    v_label,
    case when v_label > 0 then 'seller' else 'unknown' end,
    0
  ) returning id into v_id;
  insert into public.return_notes (store_id, return_id, body, kind, created_by)
  values (new.store_id, v_id, 'Replacement SKU ' || new.sku || ' sent for this sale', 'status', new.recorded_by);
  return new;
end $$;

-- Backfill: showerhead / other replacements that already exist with $0 label.
update public.returns r
set
  return_label_cents = d.extra_cost_cents,
  label_paid_by = 'seller',
  raw = coalesce(r.raw, '{}'::jsonb) || jsonb_build_object('return_kind', 'replacement'),
  updated_at = now()
from public.unit_dispositions d
where d.kind = 'replacement'
  and d.undone_at is null
  and r.store_id = d.store_id
  and r.raw->>'replacement_id' = d.id::text
  and coalesce(d.extra_cost_cents, 0) > 0
  and coalesce(r.return_label_cents, 0) = 0;

-- Desk: mark replacement rows and expose external_return_id for the phone UI.
create or replace function public.portal_return_desk(
  p_filter text default 'open',
  p_query text default null,
  p_from date default null,
  p_to date default null
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_admin boolean := public.portal_is_admin();
  v_filter text := lower(btrim(coalesce(p_filter, 'open')));
  v_q text := btrim(coalesce(p_query, ''));
  v_from date := coalesce(p_from, (timezone('America/Los_Angeles', now()))::date - 30);
  v_to date := coalesce(p_to, (timezone('America/Los_Angeles', now()))::date);
begin
  if v_store is null or not v_admin then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return jsonb_build_object(
    'rows', coalesce((
      select jsonb_agg(row order by (row->>'created_at') desc)
      from (
        select jsonb_build_object(
          'id', r.id,
          'kind', case
            when r.raw ? 'replacement_id' or coalesce(r.raw->>'return_kind', '') = 'replacement'
              or r.external_return_id like 'replacement:%' then 'replacement'
            else 'return'
          end,
          'sku', r.sku,
          'title', coalesce(nullif(btrim(u.title), ''), nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), 'Item'),
          'channel', r.channel, 'status', r.status, 'reason', r.reason, 'fault', r.fault,
          'external_order_id', r.external_order_id,
          'external_return_id', r.external_return_id,
          'buyer_name', r.buyer_name,
          'refund_cents', r.refund_cents, 'return_label_cents', r.return_label_cents,
          'label_paid_by', r.label_paid_by, 'unrecovered_fees_cents', r.unrecovered_fees_cents,
          'regrade_loss_cents', r.regrade_loss_cents, 'requested_qty', r.requested_qty,
          'return_group_id', r.return_group_id, 'disposition', r.disposition, 'route_to', r.route_to,
          'needs_decision', r.needs_decision, 'decision_deadline_at', r.decision_deadline_at,
          'condition_after', r.condition_after, 'unit_condition', u.condition, 'unit_state', u.state,
          'inspection_notes', r.inspection_notes, 'tracking_number', r.tracking_number,
          'photo_count', (select count(*)::int from public.return_photos p where p.return_id = r.id),
          'created_at', r.created_at, 'label_sent_at', r.label_sent_at, 'in_transit_at', r.in_transit_at,
          'received_at', r.received_at, 'inspected_at', r.inspected_at, 'dispositioned_at', r.dispositioned_at,
          'closed_at', r.closed_at, 'refunded_at', r.refunded_at,
          'replacement_id', r.raw->>'replacement_id', 'replacement_sku', r.raw->>'replacement_sku',
          'sale_id', r.sale_id,
          'refunds', coalesce((select jsonb_agg(jsonb_build_object(
              'id', f.id, 'amount_cents', f.amount_cents, 'refunded_on', f.refunded_on,
              'channel', f.channel, 'kind', f.kind, 'item_kept', f.item_kept, 'note', f.note, 'created_at', f.created_at
            ) order by f.created_at) from public.return_refunds f where f.return_id = r.id), '[]'::jsonb),
          'notes', coalesce((select jsonb_agg(jsonb_build_object(
              'id', n.id, 'body', n.body, 'kind', n.kind, 'created_at', n.created_at
            ) order by n.created_at) from public.return_notes n where n.return_id = r.id), '[]'::jsonb)
        ) as row
        from public.returns r
        left join public.units u on u.store_id = r.store_id and u.sku = r.sku
        where r.store_id = v_store
          and (
            v_q = ''
            or r.sku ilike '%' || v_q || '%'
            or coalesce(r.external_order_id, '') ilike '%' || v_q || '%'
            or coalesce(r.buyer_name, '') ilike '%' || v_q || '%'
            or coalesce(u.title, '') ilike '%' || v_q || '%'
          )
          and (
            (v_filter = 'open' and r.status not in ('closed', 'canceled', 'denied', 'refunded_no_return', 'dispositioned'))
            or (v_filter = 'awaiting' and r.status in ('requested', 'label_sent', 'approved', 'in_transit'))
            or (v_filter = 'refunds' and r.refund_cents > 0
                and (r.refunded_at at time zone 'America/Los_Angeles')::date between v_from and v_to)
            or (v_filter = 'replacements' and r.raw ? 'replacement_id' and r.status not in ('canceled', 'denied'))
            or (v_filter = 'closed' and r.status in ('closed', 'canceled', 'denied', 'refunded_no_return', 'dispositioned')
                and (coalesce(r.closed_at, r.updated_at) at time zone 'America/Los_Angeles')::date between v_from and v_to)
            or (v_filter = 'all')
          )
        order by r.created_at desc
        limit 300
      ) listed
    ), '[]'::jsonb),
    'totals', (
      select jsonb_build_object(
        'refund_cents', coalesce((select sum(f.amount_cents) from public.return_refunds f
           where f.store_id = v_store and f.refunded_on between v_from and v_to), 0),
        'label_cents', coalesce((select sum(e.amount_cents) from public.portal_expenses e
           where e.store_id = v_store and e.source = 'return' and e.voided_at is null
             and e.external_id like 'return-label:%' and e.spent_on between v_from and v_to), 0),
        'writeoff_cents', coalesce((select sum(r.regrade_loss_cents) from public.returns r
           where r.store_id = v_store and r.disposition = 'write_off'
             and (coalesce(r.dispositioned_at, r.updated_at) at time zone 'America/Los_Angeles')::date between v_from and v_to), 0)
      )
    )
  );
end $$;

revoke all on function public.portal_return_desk(text, text, date, date) from public, anon;
grant execute on function public.portal_return_desk(text, text, date, date) to authenticated, service_role;

commit;
