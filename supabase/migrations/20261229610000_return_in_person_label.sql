begin;

-- A return can be labeled In person even when the sale was online.
-- The unit is already in hand: no tracking, no return label.

create or replace function public.portal_return_edit(p_return uuid, p_patch jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  r public.returns;
  v_old public.returns;
  v_cancel boolean := coalesce((p_patch->>'cancel')::boolean, false);
  v_keeps boolean;
  v_person boolean;
  v_refund int;
  v_label int;
  v_track text;
  v_qty int;
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  select * into r from public.returns where id = p_return and store_id = v_store for update;
  if not found then raise exception 'return_not_found' using errcode = 'P0001'; end if;
  v_old := r;

  if v_cancel then
    perform public.return_log_edit(r.id, 'status', r.status, 'canceled');
    update public.returns set status = 'canceled', closed_at = coalesce(closed_at, now()), updated_at = now()
     where id = r.id returning * into r;
    update public.portal_expenses set voided_at = coalesce(voided_at, now()), void_reason = coalesce(void_reason, 'return canceled')
     where store_id = r.store_id and source = 'return' and external_id = 'return-label:' || r.id::text and voided_at is null;
    delete from public.return_refunds where return_id = r.id;
    update public.returns set refund_cents = 0 where id = r.id returning * into r;
    perform public.return_apply_keep_refund(r.id);
    return to_jsonb(r);
  end if;

  v_keeps := coalesce((p_patch->>'buyer_keeps')::boolean,
    r.route_to = 'buyer_keeps' or r.status = 'refunded_no_return');
  v_person := case
    when v_keeps then false
    when p_patch ? 'in_person' then coalesce((p_patch->>'in_person')::boolean, false)
    else coalesce((r.raw->>'in_person')::boolean, lower(coalesce(r.channel, '')) = 'floor')
  end;
  v_refund := coalesce((p_patch->>'refund_cents')::int, r.refund_cents);
  v_label := coalesce((p_patch->>'return_label_cents')::int, r.return_label_cents);
  v_track := coalesce(nullif(p_patch->>'tracking_number', ''), r.tracking_number);
  v_qty := greatest(coalesce((p_patch->>'requested_qty')::int, r.requested_qty), 1);
  if v_person or v_keeps then
    v_label := 0;
    v_track := null;
  end if;

  perform public.return_log_edit(r.id, 'requested_qty', r.requested_qty::text, v_qty::text);
  perform public.return_log_edit(r.id, 'return_label_cents', r.return_label_cents::text, v_label::text);
  perform public.return_log_edit(r.id, 'refund_cents', r.refund_cents::text, v_refund::text);
  perform public.return_log_edit(r.id, 'tracking_number', r.tracking_number, v_track);
  perform public.return_log_edit(r.id, 'buyer_keeps',
    case when r.route_to = 'buyer_keeps' or r.status = 'refunded_no_return' then 'true' else 'false' end,
    case when v_keeps then 'true' else 'false' end);
  perform public.return_log_edit(r.id, 'in_person',
    coalesce(r.raw->>'in_person', ''),
    case when v_person then 'true' else 'false' end);

  update public.returns set
    requested_qty = v_qty,
    return_label_cents = v_label,
    label_paid_by = case when v_label > 0 then 'seller' else label_paid_by end,
    tracking_number = v_track,
    raw = coalesce(raw, '{}'::jsonb) || jsonb_build_object('in_person', v_person),
    route_to = case when v_keeps then 'buyer_keeps' else 'garage' end,
    status = case
      when v_keeps then 'refunded_no_return'
      when r.status in ('dispositioned', 'closed', 'canceled', 'denied') then r.status
      when v_person and r.status in ('requested', 'label_sent', 'approved', 'in_transit', 'refunded_no_return') then 'received'
      when not v_person and p_patch ? 'in_person' and r.status = 'received' and nullif(v_track, '') is null then 'requested'
      when r.status = 'refunded_no_return' and not v_keeps then
        case when nullif(v_track, '') is not null then 'in_transit' else 'requested' end
      else r.status
    end,
    received_at = case
      when v_person and r.status not in ('canceled', 'denied') then coalesce(received_at, now())
      when not v_person and p_patch ? 'in_person' and r.status = 'received' and nullif(v_track, '') is null then null
      else received_at
    end,
    closed_at = case when v_keeps then coalesce(closed_at, now()) when r.status = 'refunded_no_return' and not v_keeps then null else closed_at end,
    disposition = case when v_keeps then 'keep_buyer' when r.status = 'refunded_no_return' and not v_keeps then null else disposition end,
    in_transit_at = case
      when v_person then null
      when not v_keeps and nullif(v_track, '') is not null and r.in_transit_at is null then now()
      else in_transit_at
    end,
    label_sent_at = case when v_person then null else label_sent_at end,
    updated_at = now()
  where id = r.id returning * into r;

  perform public.return_sync_label_expense(r.id);
  perform public.return_reconcile_refund_row(r.id, v_refund, v_keeps or v_refund < coalesce((select price_cents from public.sales where id = r.sale_id), v_refund + 1));

  if v_keeps then
    perform public.return_record_keep_from_row(r.id);
    perform public.return_post_ledger(r.id);
  end if;

  return to_jsonb(r);
end $$;

create or replace function public.portal_start_returns(
  p_lines jsonb,
  p_label_cents int default 0,
  p_label_paid_by text default 'seller',
  p_note text default null,
  p_reason text default 'other',
  p_no_shipment boolean default false,
  p_refund_cents int default 0,
  p_tracking_number text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_group uuid := gen_random_uuid();
  v_line jsonb;
  v_sale public.sales;
  v_qty int;
  v_order text;
  v_orders text[] := '{}';
  v_row public.returns;
  v_ids uuid[] := '{}';
  v_paid text := lower(btrim(coalesce(p_label_paid_by, 'seller')));
  v_reason text := lower(btrim(coalesce(p_reason, 'other')));
  v_label int := greatest(coalesce(p_label_cents, 0), 0);
  v_first boolean := true;
  v_track text := nullif(btrim(coalesce(p_tracking_number, '')), '');
  v_person boolean := false;
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) < 1 then
    raise exception 'lines_required' using errcode = '22023';
  end if;
  if v_paid not in ('seller', 'buyer', 'channel', 'unknown') then
    raise exception 'invalid_label_payer' using errcode = '22023';
  end if;
  if v_reason not in ('buyer_remorse', 'defective', 'not_as_described', 'wrong_item', 'damaged_in_transit', 'other') then
    v_reason := 'other';
  end if;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    select * into v_sale from public.sales
     where id = (v_line->>'sale_id')::bigint and store_id = v_store and voided_at is null;
    if not found then raise exception 'sale_not_found' using errcode = 'P0001'; end if;
    v_qty := greatest(coalesce((v_line->>'qty')::int, 1), 1);
    if v_qty > greatest(coalesce(v_sale.qty, 1), 1) then
      raise exception 'return_qty_exceeds_sale' using errcode = '22023';
    end if;
    select coalesce(c.order_id, w.order_no, v_sale.receipt_no, v_sale.id::text) into v_order
      from (select 1) dummy
      left join lateral (select order_id from public.channel_orders where sale_id = v_sale.id order by created_at desc limit 1) c on true
      left join lateral (select order_no from public.web_orders where sale_id = v_sale.id order by created_at limit 1) w on true;
    v_orders := v_orders || v_order;
  end loop;
  if (select count(distinct x) from unnest(v_orders) x) > 1 then
    raise exception 'different_orders' using errcode = '22023';
  end if;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    select * into v_sale from public.sales where id = (v_line->>'sale_id')::bigint and store_id = v_store;
    v_qty := greatest(coalesce((v_line->>'qty')::int, 1), 1);
    v_person := case
      when coalesce(p_no_shipment, false) then false
      when v_line ? 'in_person' then coalesce((v_line->>'in_person')::boolean, false)
      else lower(coalesce(v_sale.channel, '')) = 'floor'
    end;
    select coalesce(c.order_id, w.order_no, v_sale.receipt_no) into v_order
      from (select 1) dummy
      left join lateral (select order_id from public.channel_orders where sale_id = v_sale.id order by created_at desc limit 1) c on true
      left join lateral (select order_no from public.web_orders where sale_id = v_sale.id order by created_at limit 1) w on true;
    insert into public.returns (
      store_id, sku, sale_id, channel, external_order_id, reason, fault, status,
      return_label_cents, label_paid_by, route_to, needs_decision, requested_qty,
      return_group_id, buyer_name, condition_before, inspection_notes, created_by,
      refunded_at, closed_at, disposition, label_sent_at, tracking_number, in_transit_at, raw
    ) values (
      v_store, v_sale.sku, v_sale.id, lower(coalesce(v_sale.channel, 'other')), v_order,
      v_reason, 'unknown',
      case
        when coalesce(p_no_shipment, false) then 'refunded_no_return'
        when v_person then 'received'
        when v_track is not null then 'in_transit'
        else 'requested'
      end,
      case when v_first and not v_person then v_label else 0 end,
      case when v_first then v_paid else 'unknown' end,
      case when coalesce(p_no_shipment, false) then 'buyer_keeps' else 'garage' end,
      false, v_qty, v_group,
      nullif(btrim(coalesce(v_sale.customer_name, '')), ''),
      (select condition from public.units u where u.store_id = v_store and u.sku = v_sale.sku),
      nullif(btrim(coalesce(p_note, '')), ''),
      auth.uid(),
      case when coalesce(p_no_shipment, false) then now() else null end,
      case when coalesce(p_no_shipment, false) then now() else null end,
      case when coalesce(p_no_shipment, false) then 'keep_buyer' else null end,
      case when v_label > 0 and not coalesce(p_no_shipment, false) and not v_person then now() else null end,
      case when v_first and not v_person then v_track else null end,
      case when v_first and v_track is not null and not coalesce(p_no_shipment, false) and not v_person then now() else null end,
      jsonb_build_object('in_person', v_person)
    ) returning * into v_row;
    if v_person then
      update public.returns set received_at = coalesce(received_at, now()), updated_at = now()
       where id = v_row.id returning * into v_row;
    elsif v_label > 0 and not coalesce(p_no_shipment, false) and v_first then
      update public.returns set status = case when v_track is not null then 'in_transit' else 'label_sent' end,
        label_sent_at = now(), approved_at = coalesce(approved_at, now())
       where id = v_row.id returning * into v_row;
    end if;
    v_ids := v_ids || v_row.id;
    insert into public.return_notes (store_id, return_id, body, kind, created_by)
    values (v_store, v_row.id, coalesce(nullif(btrim(coalesce(p_note, '')), ''),
      case when v_person then 'In person' else 'Return opened' end), 'status', auth.uid());
    perform public.return_sync_label_expense(v_row.id);
    if v_first and coalesce(p_refund_cents, 0) > 0 then
      insert into public.return_refunds (store_id, return_id, amount_cents, channel, kind, item_kept, note, created_by)
      values (
        v_store, v_row.id, p_refund_cents, v_row.channel,
        case when p_refund_cents < coalesce(v_sale.price_cents, p_refund_cents) then 'partial' else 'full' end,
        coalesce(p_no_shipment, false) or p_refund_cents < coalesce(v_sale.price_cents, p_refund_cents),
        nullif(btrim(coalesce(p_note, '')), ''),
        auth.uid()
      );
      update public.returns set refund_cents = p_refund_cents, refunded_at = coalesce(refunded_at, now()) where id = v_row.id;
      perform public.return_apply_keep_refund(v_row.id);
    elsif coalesce(p_no_shipment, false) then
      perform public.return_record_keep_from_row(v_row.id);
    end if;
    v_first := false;
  end loop;

  return coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at) from public.returns r where r.id = any(v_ids)), '[]'::jsonb);
end $$;

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
          'in_person', case when r.raw ? 'in_person' then (r.raw->>'in_person')::boolean else null end,
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

revoke all on function public.portal_return_edit(uuid, jsonb) from public, anon;
grant execute on function public.portal_return_edit(uuid, jsonb) to authenticated;
revoke all on function public.portal_start_returns(jsonb, int, text, text, text, boolean, int, text) from public, anon;
grant execute on function public.portal_start_returns(jsonb, int, text, text, text, boolean, int, text) to authenticated;
revoke all on function public.portal_return_desk(text, text, date, date) from public, anon;
grant execute on function public.portal_return_desk(text, text, date, date) to authenticated, service_role;

commit;
