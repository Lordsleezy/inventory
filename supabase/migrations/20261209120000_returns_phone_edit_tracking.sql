-- Phone Returns: edit ledger re-flow, tracking timeline, reports-facing money view.
begin;

create table if not exists public.return_edit_log (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  return_id uuid not null references public.returns(id) on delete cascade,
  field text not null,
  old_value text,
  new_value text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
create index if not exists return_edit_log_return_idx on public.return_edit_log (return_id, created_at desc);
alter table public.return_edit_log enable row level security;
drop policy if exists staff_all_return_edit_log on public.return_edit_log;
create policy staff_all_return_edit_log on public.return_edit_log
  for all using (store_id = public.portal_store_id());
grant select, insert on public.return_edit_log to authenticated;
grant all on public.return_edit_log to service_role;

create table if not exists public.return_tracking_events (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  return_id uuid not null references public.returns(id) on delete cascade,
  status text not null,
  status_detail text,
  location text,
  carrier text,
  occurred_at timestamptz not null,
  raw jsonb,
  created_at timestamptz not null default now()
);
create unique index if not exists return_tracking_events_dedupe_idx
  on public.return_tracking_events (return_id, occurred_at, status, coalesce(status_detail, ''));
create index if not exists return_tracking_events_return_idx on public.return_tracking_events (return_id, occurred_at desc);
alter table public.return_tracking_events enable row level security;
drop policy if exists staff_all_return_tracking_events on public.return_tracking_events;
create policy staff_all_return_tracking_events on public.return_tracking_events
  for all using (store_id = public.portal_store_id());
grant select, insert, update, delete on public.return_tracking_events to authenticated;
grant all on public.return_tracking_events to service_role;

alter table public.returns
  add column if not exists tracking_eta date,
  add column if not exists shippo_track_id text;

create or replace function public.return_log_edit(
  p_return_id uuid, p_field text, p_old text, p_new text
) returns void language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then return; end if;
  if coalesce(p_old, '') is not distinct from coalesce(p_new, '') then return; end if;
  insert into public.return_edit_log (store_id, return_id, field, old_value, new_value, created_by)
  values (v_store, p_return_id, p_field, p_old, p_new, auth.uid());
end $$;

create or replace function public.return_reconcile_refund_row(p_return_id uuid, p_amount int, p_item_kept boolean)
returns void language plpgsql security definer set search_path = public as $$
declare
  r public.returns;
  s public.sales;
  v_id uuid;
  v_kind text;
begin
  select * into r from public.returns where id = p_return_id for update;
  if not found or r.sale_id is null then return; end if;
  select * into s from public.sales where id = r.sale_id;
  v_kind := case
    when p_amount <= 0 then 'partial'
    when s.price_cents is not null and p_amount < s.price_cents then 'partial'
    else 'full'
  end;
  select id into v_id from public.return_refunds where return_id = r.id order by created_at desc limit 1;
  if v_id is null and p_amount > 0 then
    insert into public.return_refunds (store_id, return_id, amount_cents, channel, kind, item_kept, created_by)
    values (r.store_id, r.id, p_amount, r.channel, v_kind, p_item_kept, auth.uid());
  elsif v_id is not null then
    update public.return_refunds set
      amount_cents = greatest(p_amount, 0),
      kind = v_kind,
      item_kept = p_item_kept
    where id = v_id;
  end if;
  update public.returns set
    refund_cents = greatest(p_amount, 0),
    refunded_at = case when p_amount > 0 then coalesce(refunded_at, now()) else refunded_at end,
    updated_at = now()
  where id = r.id;
  perform public.return_apply_keep_refund(r.id);
end $$;

create or replace function public.portal_return_edit(p_return uuid, p_patch jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  r public.returns;
  v_old public.returns;
  v_cancel boolean := coalesce((p_patch->>'cancel')::boolean, false);
  v_keeps boolean;
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
  v_refund := coalesce((p_patch->>'refund_cents')::int, r.refund_cents);
  v_label := coalesce((p_patch->>'return_label_cents')::int, r.return_label_cents);
  v_track := coalesce(nullif(p_patch->>'tracking_number', ''), r.tracking_number);
  v_qty := greatest(coalesce((p_patch->>'requested_qty')::int, r.requested_qty), 1);

  perform public.return_log_edit(r.id, 'requested_qty', r.requested_qty::text, v_qty::text);
  perform public.return_log_edit(r.id, 'return_label_cents', r.return_label_cents::text, v_label::text);
  perform public.return_log_edit(r.id, 'refund_cents', r.refund_cents::text, v_refund::text);
  perform public.return_log_edit(r.id, 'tracking_number', r.tracking_number, v_track);
  perform public.return_log_edit(r.id, 'buyer_keeps',
    case when r.route_to = 'buyer_keeps' or r.status = 'refunded_no_return' then 'true' else 'false' end,
    case when v_keeps then 'true' else 'false' end);

  update public.returns set
    requested_qty = v_qty,
    return_label_cents = v_label,
    label_paid_by = case when v_label > 0 then 'seller' else label_paid_by end,
    tracking_number = v_track,
    route_to = case when v_keeps then 'buyer_keeps' else 'garage' end,
    status = case
      when v_keeps then 'refunded_no_return'
      when r.status = 'refunded_no_return' and not v_keeps then
        case when nullif(v_track, '') is not null then 'in_transit' else 'requested' end
      else r.status
    end,
    closed_at = case when v_keeps then coalesce(closed_at, now()) when r.status = 'refunded_no_return' and not v_keeps then null else closed_at end,
    disposition = case when v_keeps then 'keep_buyer' when r.status = 'refunded_no_return' and not v_keeps then null else disposition end,
    in_transit_at = case
      when not v_keeps and nullif(v_track, '') is not null and r.in_transit_at is null then now()
      else in_transit_at
    end,
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

-- Extend start flow with tracking on create.
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
    select coalesce(c.order_id, w.order_no, v_sale.receipt_no) into v_order
      from (select 1) dummy
      left join lateral (select order_id from public.channel_orders where sale_id = v_sale.id order by created_at desc limit 1) c on true
      left join lateral (select order_no from public.web_orders where sale_id = v_sale.id order by created_at limit 1) w on true;
    insert into public.returns (
      store_id, sku, sale_id, channel, external_order_id, reason, fault, status,
      return_label_cents, label_paid_by, route_to, needs_decision, requested_qty,
      return_group_id, buyer_name, condition_before, inspection_notes, created_by,
      refunded_at, closed_at, disposition, label_sent_at, tracking_number, in_transit_at
    ) values (
      v_store, v_sale.sku, v_sale.id, lower(coalesce(v_sale.channel, 'other')), v_order,
      v_reason, 'unknown',
      case
        when coalesce(p_no_shipment, false) then 'refunded_no_return'
        when v_track is not null then 'in_transit'
        else 'requested'
      end,
      case when v_first then v_label else 0 end,
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
      case when v_label > 0 and not coalesce(p_no_shipment, false) then now() else null end,
      case when v_first then v_track else null end,
      case when v_first and v_track is not null and not coalesce(p_no_shipment, false) then now() else null end
    ) returning * into v_row;
    if v_label > 0 and not coalesce(p_no_shipment, false) and v_first then
      update public.returns set status = case when v_track is not null then 'in_transit' else 'label_sent' end,
        label_sent_at = now(), approved_at = coalesce(approved_at, now())
       where id = v_row.id returning * into v_row;
    end if;
    v_ids := v_ids || v_row.id;
    insert into public.return_notes (store_id, return_id, body, kind, created_by)
    values (v_store, v_row.id, coalesce(nullif(btrim(coalesce(p_note, '')), ''), 'Return opened'), 'status', auth.uid());
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

create or replace function public.portal_return_candidates(p_query text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_q text := btrim(coalesce(p_query, ''));
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if v_q = '' then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(x order by x.sold_at desc)
    from (
      select s.id as sale_id, s.sku,
        coalesce(nullif(btrim(u.title), ''), nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), 'Item') as title,
        greatest(coalesce(s.qty, 1), 1) as qty,
        coalesce((select sum(rr.requested_qty) from public.returns rr
          where rr.sale_id = s.id and rr.status not in ('canceled', 'denied')), 0)::int as qty_open,
        s.channel, s.price_cents, s.sold_at,
        coalesce(nullif(s.customer_name, ''), nullif(wo.buyer_name, ''), nullif(co.buyer_username, '')) as buyer,
        coalesce(co.order_id, wo.order_no, s.receipt_no, s.id::text) as order_ref,
        (select rr.refund_cents from public.returns rr
          where rr.sale_id = s.id and rr.status not in ('canceled', 'denied', 'closed', 'refunded_no_return')
          order by rr.created_at desc limit 1) as hint_refund_cents,
        coalesce(
          (select rr.tracking_number from public.returns rr
            where rr.sale_id = s.id and nullif(rr.tracking_number, '') is not null
            order by rr.created_at desc limit 1),
          nullif(rm.raw->>'buyer_tracking', ''),
          nullif(rm.raw->>'tracking_number', '')
        ) as hint_tracking
      from public.sales s
      left join public.units u on u.store_id = s.store_id and u.sku = s.sku
      left join lateral (
        select c.order_id, c.buyer_username from public.channel_orders c
         where c.sale_id = s.id order by c.created_at desc limit 1
      ) co on true
      left join lateral (
        select w.order_no, w.buyer_name from public.web_orders w
         where w.sale_id = s.id order by w.created_at limit 1
      ) wo on true
      left join lateral (
        select raw from public.returns rm
         where rm.sale_id = s.id and rm.channel in ('ebay', 'amazon', 'tiktok')
         order by rm.created_at desc limit 1
      ) rm on true
      where s.store_id = v_store and s.voided_at is null
        and (
          s.sku ilike '%' || v_q || '%'
          or s.receipt_no ilike '%' || v_q || '%'
          or s.id::text = v_q
          or coalesce(co.order_id, '') ilike '%' || v_q || '%'
          or coalesce(wo.order_no, '') ilike '%' || v_q || '%'
          or coalesce(u.title, '') ilike '%' || v_q || '%'
        )
      order by s.sold_at desc
      limit 30
    ) x
  ), '[]'::jsonb);
end $$;

create or replace function public.portal_return_tracking_timeline(p_return uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  r public.returns;
  v_line text;
  v_eta date;
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  select * into r from public.returns where id = p_return and store_id = v_store;
  if not found then raise exception 'return_not_found' using errcode = 'P0001'; end if;

  v_eta := r.tracking_eta;
  v_line := case r.status
    when 'in_transit' then 'In transit' || case when v_eta is not null then ' · arriving ' ||
      to_char(v_eta, 'Dy') else '' end
    when 'received' then 'Delivered'
    when 'label_sent' then 'Label sent'
    when 'requested' then 'Requested'
    else initcap(replace(r.status, '_', ' '))
  end;

  return jsonb_build_object(
    'status_line', v_line,
    'eta', v_eta,
    'carrier', r.carrier,
    'tracking_source', coalesce(nullif(r.carrier, ''), 'carrier'),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'status', ev.status,
        'status_detail', ev.status_detail,
        'location', ev.location,
        'carrier', ev.carrier,
        'occurred_at', ev.occurred_at,
        'current', ev.rn = 1
      ) order by ev.occurred_at asc)
      from (
        select e.*, row_number() over (order by e.occurred_at desc) as rn
        from public.return_tracking_events e where e.return_id = r.id
      ) ev
    ), '[]'::jsonb)
  );
end $$;

create or replace view public.returns_money_lines as
select
  r.id as return_id,
  r.store_id,
  r.sku,
  r.sale_id,
  r.channel,
  r.status,
  r.refund_cents,
  r.return_label_cents,
  r.label_paid_by,
  r.route_to,
  r.created_at,
  r.closed_at,
  coalesce((
    select sum(e.amount_cents) from public.portal_expenses e
     where e.store_id = r.store_id and e.source = 'return' and e.external_id = 'return-label:' || r.id::text and e.voided_at is null
  ), 0) as label_expense_cents,
  coalesce((
    select sum(a.amount_cents) from public.portal_payout_adjustments a where a.return_id = r.id
  ), 0) as commission_adjustment_cents,
  (select s.buyer_keep_refund_cents from public.sales s where s.id = r.sale_id) as sale_keep_refund_cents
from public.returns r;

grant select on public.returns_money_lines to authenticated;
grant select on public.returns_money_lines to service_role;

grant execute on function public.portal_return_edit(uuid, jsonb) to authenticated;
grant execute on function public.portal_return_tracking_timeline(uuid) to authenticated;
grant execute on function public.portal_start_returns(jsonb, int, text, text, text, boolean, int, text) to authenticated;

commit;
