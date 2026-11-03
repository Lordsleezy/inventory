-- Returns desk: several SKUs on one return, a label expense, refunds that are
-- separate from the shipment, and buyer-keeps refunds that reduce profit
-- without voiding the sale. A full physical return still voids, and an
-- already-paid commission becomes a negative adjustment. History is not rewritten.
begin;

alter table public.sales
  add column if not exists buyer_keep_refund_cents int not null default 0
  check (buyer_keep_refund_cents >= 0);

alter table public.returns
  add column if not exists label_sent_at timestamptz,
  add column if not exists return_group_id uuid,
  add column if not exists buyer_name text,
  add column if not exists requested_qty int not null default 1;

alter table public.returns drop constraint if exists returns_requested_qty_check;
alter table public.returns add constraint returns_requested_qty_check check (requested_qty > 0);

do $$
declare c name;
begin
  select con.conname into c
    from pg_constraint con
   where con.conrelid = 'public.returns'::regclass
     and con.contype = 'c'
     and pg_get_constraintdef(con.oid) ilike '%''requested''%';
  if c is not null then
    execute format('alter table public.returns drop constraint %I', c);
  end if;
end $$;

alter table public.returns add constraint returns_status_check check (status in (
  'requested', 'label_sent', 'approved', 'in_transit', 'received', 'inspected',
  'dispositioned', 'closed', 'refunded_no_return', 'denied', 'canceled'
));

create index if not exists returns_group_idx on public.returns (return_group_id) where return_group_id is not null;

create table if not exists public.return_refunds (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  return_id uuid not null references public.returns(id) on delete cascade,
  amount_cents int not null check (amount_cents > 0),
  refunded_on date not null default (timezone('America/Los_Angeles', now()))::date,
  channel text not null,
  kind text not null check (kind in ('full', 'partial')),
  item_kept boolean not null default false,
  note text,
  created_at timestamptz not null default now(),
  created_by uuid
);
create index if not exists return_refunds_return_idx on public.return_refunds (return_id, created_at);

create table if not exists public.return_notes (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  return_id uuid not null references public.returns(id) on delete cascade,
  body text not null,
  kind text not null default 'note' check (kind in ('note', 'status')),
  created_at timestamptz not null default now(),
  created_by uuid
);
create index if not exists return_notes_return_idx on public.return_notes (return_id, created_at);

alter table public.return_refunds enable row level security;
alter table public.return_notes enable row level security;
drop policy if exists staff_all_return_refunds on public.return_refunds;
create policy staff_all_return_refunds on public.return_refunds
  for all to authenticated
  using (store_id = coalesce(public.current_store_id(), public.portal_store_id()))
  with check (store_id = coalesce(public.current_store_id(), public.portal_store_id()));
drop policy if exists staff_all_return_notes on public.return_notes;
create policy staff_all_return_notes on public.return_notes
  for all to authenticated
  using (store_id = coalesce(public.current_store_id(), public.portal_store_id()))
  with check (store_id = coalesce(public.current_store_id(), public.portal_store_id()));
grant select, insert, update, delete on public.return_refunds to authenticated;
grant select, insert, update, delete on public.return_notes to authenticated;
grant all on public.return_refunds to service_role;
grant all on public.return_notes to service_role;

-- Buyer-keeps and partial refunds come off sale profit. A later void clears the
-- column because the sale itself leaves the ledger.
do $$
declare v_def text; v_new text; v_n int;
begin
  v_def := pg_get_viewdef('public.sale_ledger'::regclass, false);
  if position('buyer_keep_refund_cents' in v_def) > 0 then
    return;
  end if;
  select count(*) into v_n from regexp_matches(v_def, 'as profit_cents', 'gi');
  if v_n <> 1 then
    raise exception 'sale_ledger profit alias not found as expected (% matches)', v_n;
  end if;
  v_new := regexp_replace(v_def,
    'as profit_cents',
    '- least(coalesce(s.buyer_keep_refund_cents, 0), greatest(coalesce(s.price_cents, 0), 0)) as profit_cents',
    'i');
  v_new := regexp_replace(v_new, ';\s*$', '');
  execute 'create or replace view public.sale_ledger as ' || v_new;
end $$;

create or replace function public.return_sync_label_expense(p_return_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  r public.returns;
  v_ext text;
  v_id uuid;
begin
  select * into r from public.returns where id = p_return_id;
  if not found then return; end if;
  v_ext := 'return-label:' || r.id::text;
  if r.label_paid_by is distinct from 'seller' or coalesce(r.return_label_cents, 0) <= 0 then
    update public.portal_expenses set
      voided_at = coalesce(voided_at, now()),
      void_reason = coalesce(void_reason, 'return label is not a seller cost')
    where store_id = r.store_id and source = 'return' and external_id = v_ext and voided_at is null;
    return;
  end if;
  select id into v_id from public.portal_expenses
   where store_id = r.store_id and source = 'return' and external_id = v_ext and voided_at is null
   order by created_at desc limit 1;
  if v_id is null then
    insert into public.portal_expenses (
      store_id, spent_on, description, category, amount_cents,
      needs_reimbursement, source, order_id, external_id
    ) values (
      r.store_id,
      (timezone('America/Los_Angeles', now()))::date,
      'Return label ' || upper(r.channel) || ' SKU ' || r.sku || coalesce(' order ' || r.external_order_id, ''),
      'Returns',
      r.return_label_cents,
      false,
      'return',
      r.web_order_id,
      v_ext
    );
  else
    update public.portal_expenses set
      amount_cents = r.return_label_cents,
      description = 'Return label ' || upper(r.channel) || ' SKU ' || r.sku || coalesce(' order ' || r.external_order_id, ''),
      order_id = r.web_order_id
    where id = v_id;
  end if;
end $$;

-- Partial refunds and "buyer keeps it" stay on the sale. Profit drops by the
-- refund. Commission drops by the same fraction through an adjustment, including
-- when that commission was already paid. sale_commission_cents stays 0 so the
-- payout screen does not add the voided-sale commission back on top.
create or replace function public.return_apply_keep_refund(p_return_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r public.returns;
  s public.sales;
  v_keep int;
  v_price int;
  v_frac numeric;
  v_emp uuid;
  v_full int;
  v_rev int;
  v_ticket text;
  v_paul uuid;
  v_jacob uuid;
  v_online uuid;
  v_rows jsonb := '[]'::jsonb;
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
  -- A refund marked full, item coming back, for the whole price waits for the void.
  if v_keep <= 0 then
    update public.sales set buyer_keep_refund_cents = 0 where id = s.id and buyer_keep_refund_cents <> 0;
    return jsonb_build_object('ok', true, 'keep_cents', 0);
  end if;
  v_price := greatest(coalesce(s.price_cents, 0), 0);
  v_keep := least(v_keep, case when v_price > 0 then v_price else v_keep end);
  update public.sales set buyer_keep_refund_cents = v_keep where id = s.id;
  v_frac := case when v_price <= 0 then 1 else v_keep::numeric / v_price::numeric end;
  v_ticket := coalesce(s.ticket_id::text, 'sale:' || s.id::text);
  v_paul := public.payout_slot_employee(r.store_id, 'paul');
  v_jacob := public.payout_slot_employee(r.store_id, 'jacob');
  begin
    v_online := nullif(public.store_setting(r.store_id, 'online_payout_employee_id', 'null'::jsonb) #>> '{}', '')::uuid;
  exception when others then v_online := null;
  end;

  for v_emp in
    select distinct x from unnest(array[v_paul, v_jacob, v_online]
      || array(select employee_id from public.portal_payout_rules where store_id = r.store_id)) as t(x)
    where x is not null
  loop
    v_full := public.sale_commission_cents(r.store_id, r.sale_id, v_emp);
    if v_full is null or v_full <= 0 then continue; end if;
    v_rev := round(v_full * v_frac)::int;
    if v_rev = 0 then continue; end if;
    insert into public.portal_payout_adjustments (
      store_id, employee_id, amount_cents, reason, return_id, sale_id, ticket_key,
      sale_commission_cents, created_by
    ) values (
      r.store_id, v_emp, -v_rev,
      format('Refund SKU %s · %s · %s cents kept on the sale · return %s', r.sku, upper(r.channel), v_keep, r.id::text),
      r.id, r.sale_id, v_ticket, 0, auth.uid()
    )
    on conflict (store_id, return_id, employee_id) do update set
      amount_cents = excluded.amount_cents,
      reason = excluded.reason,
      sale_commission_cents = 0,
      created_at = now();
    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'employee_id', v_emp, 'adjustment_cents', -v_rev, 'sale_commission_cents', v_full
    ));
  end loop;
  return jsonb_build_object('ok', true, 'keep_cents', v_keep, 'adjustments', v_rows);
end $$;

create or replace function public.return_record_keep_from_row(p_return_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r public.returns; s public.sales; v_kind text;
begin
  select * into r from public.returns where id = p_return_id;
  if not found or coalesce(r.refund_cents, 0) <= 0 then
    perform public.return_sync_label_expense(p_return_id);
    return;
  end if;
  select * into s from public.sales where id = r.sale_id;
  v_kind := case
    when s.price_cents is not null and r.refund_cents < s.price_cents then 'partial'
    else 'full'
  end;
  if not exists (select 1 from public.return_refunds f where f.return_id = r.id and f.item_kept) then
    insert into public.return_refunds (store_id, return_id, amount_cents, channel, kind, item_kept, note)
    values (r.store_id, r.id, r.refund_cents, r.channel, v_kind, true, 'Buyer kept the item');
  end if;
  perform public.return_apply_keep_refund(r.id);
  perform public.return_sync_label_expense(r.id);
end $$;

create or replace function public.return_post_ledger(p_return_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  r public.returns;
  v_extras int;
begin
  select * into r from public.returns where id = p_return_id for update;
  if not found then return; end if;
  perform public.return_sync_label_expense(r.id);
  if r.ledger_posted_at is not null then return; end if;
  -- The refund is either a void or a profit reduction. It is not also an expense.
  v_extras := coalesce(r.unrecovered_fees_cents, 0) + coalesce(r.regrade_loss_cents, 0);
  if v_extras <= 0 then
    update public.returns set ledger_posted_at = now(), updated_at = now() where id = r.id;
    return;
  end if;
  update public.portal_expenses set
    voided_at = coalesce(voided_at, now()),
    void_reason = coalesce(void_reason, 'returns_ledger_reposted')
  where store_id = r.store_id and source = 'return' and external_id = 'return-extras:' || r.id::text
    and voided_at is null;
  insert into public.portal_expenses (
    store_id, spent_on, description, category, amount_cents,
    needs_reimbursement, source, order_id, external_id
  ) values (
    r.store_id,
    (timezone('America/Los_Angeles', now()))::date,
    'Return extras ' || upper(r.channel) || ' SKU ' || r.sku
      || coalesce(' order ' || r.external_order_id, '')
      || ' (fees/regrade; refund is not counted again)',
    'Returns',
    v_extras,
    false,
    'return',
    r.web_order_id,
    'return-extras:' || r.id::text
  );
  update public.returns set ledger_posted_at = now(), updated_at = now() where id = r.id;
end $$;

create or replace function public.return_reverse_sale(
  p_store uuid, p_sale_id bigint, p_reason text, p_restock boolean default true
) returns void language plpgsql security definer set search_path = public as $$
declare r public.sales;
begin
  perform set_config('floor.store_id', p_store::text, true);
  if p_sale_id is null then return; end if;
  select * into r from public.sales where id = p_sale_id and store_id = p_store and voided_at is null for update;
  if not found then return; end if;
  perform set_config('floor.stock_return_restock', p_restock::text, true);
  update public.sales set
    voided_at = now(),
    void_reason = btrim(coalesce(p_reason, 'return')),
    buyer_keep_refund_cents = 0
  where id = r.id;
  perform set_config('floor.stock_return_restock', '', true);
  update public.sku_ledger set fate = case when p_restock then 'issued' else 'retired' end
   where store_id = p_store and sku = r.sku;
  if p_restock then
    update public.units set state = 'available', updated_at = now() where store_id = p_store and sku = r.sku;
    perform public.enqueue_sale_relist_alerts(r);
  else
    update public.units set state = 'lost', updated_at = now() where store_id = p_store and sku = r.sku;
  end if;
  insert into public.events (store_id, sku, kind, actor, note)
  values (p_store, r.sku, 'sale_void', coalesce((select display_name from public.staff where user_id = auth.uid()), 'returns'),
    btrim(coalesce(p_reason, 'return')) || case when p_restock then ' (restock)' else ' (no restock)' end);
end $$;

create or replace function public.portal_set_return_status(
  p_return uuid, p_status text, p_patch jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  r public.returns;
  v_status text := lower(btrim(coalesce(p_status, '')));
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  select * into r from public.returns where id = p_return and store_id = v_store for update;
  if not found then raise exception 'return_not_found' using errcode = 'P0001'; end if;
  if v_status not in (
    'requested', 'label_sent', 'approved', 'in_transit', 'received', 'inspected', 'dispositioned',
    'closed', 'refunded_no_return', 'denied', 'canceled'
  ) then raise exception 'invalid_status' using errcode = '22023'; end if;

  update public.returns set
    status = v_status,
    needs_decision = case when v_status = 'requested' then needs_decision else false end,
    label_sent_at = case when v_status in ('label_sent', 'approved') then coalesce(label_sent_at, now()) else label_sent_at end,
    approved_at = case when v_status in ('label_sent', 'approved') then coalesce(approved_at, now()) else approved_at end,
    in_transit_at = case when v_status = 'in_transit' then coalesce(in_transit_at, now()) else in_transit_at end,
    received_at = case when v_status = 'received' then coalesce(received_at, now()) else received_at end,
    inspected_at = case when v_status = 'inspected' then coalesce(inspected_at, now()) else inspected_at end,
    closed_at = case when v_status in ('closed', 'canceled', 'denied', 'refunded_no_return') then coalesce(closed_at, now()) else closed_at end,
    refund_cents = coalesce((p_patch->>'refund_cents')::int, refund_cents),
    return_label_cents = coalesce((p_patch->>'return_label_cents')::int, return_label_cents),
    label_paid_by = coalesce(nullif(p_patch->>'label_paid_by', ''), label_paid_by),
    unrecovered_fees_cents = coalesce((p_patch->>'unrecovered_fees_cents')::int, unrecovered_fees_cents),
    tracking_number = coalesce(nullif(p_patch->>'tracking_number', ''), tracking_number),
    carrier = coalesce(nullif(p_patch->>'carrier', ''), carrier),
    inspection_notes = coalesce(nullif(p_patch->>'inspection_notes', ''), inspection_notes),
    fault = coalesce(nullif(p_patch->>'fault', ''), fault),
    reason = coalesce(nullif(p_patch->>'reason', ''), reason),
    updated_at = now()
  where id = r.id
  returning * into r;

  insert into public.return_notes (store_id, return_id, body, kind, created_by)
  values (v_store, r.id, 'Status → ' || v_status, 'status', auth.uid());

  perform public.return_sync_label_expense(r.id);

  if v_status = 'refunded_no_return' then
    update public.returns set disposition = 'keep_buyer', route_to = 'buyer_keeps',
      refunded_at = coalesce(refunded_at, now())
     where id = r.id returning * into r;
    perform public.return_record_keep_from_row(r.id);
    perform public.return_post_ledger(r.id);
  end if;

  return to_jsonb(r);
end $$;

-- Channel auto "refund, buyer keeps" must not void the sale. Profit drops instead.
do $$
declare src text; nxt text;
begin
  src := pg_get_functiondef('public.ingest_channel_return(uuid,text,jsonb)'::regprocedure);
  nxt := regexp_replace(src,
    $re$perform public\.return_apply_commission_clawbacks\(v_row\.id\);\s*perform public\.return_reverse_sale\(p_store,\s*v_row\.sale_id,\s*'Refund without return',\s*false\);$re$,
    'perform public.return_record_keep_from_row(v_row.id);',
    'n');
  if nxt = src then
    raise exception 'ingest_channel_return keep-refund path not found near %',
      substr(src, greatest(position('Refund without return' in src) - 80, 1), 240);
  end if;
  execute nxt;
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
        coalesce(co.order_id, wo.order_no, s.receipt_no, s.id::text) as order_ref
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
      where s.store_id = v_store and s.voided_at is null
        and (
          s.sku ilike '%' || v_q || '%'
          or coalesce(s.receipt_no, '') ilike '%' || v_q || '%'
          or coalesce(s.customer_name, '') ilike '%' || v_q || '%'
          or coalesce(co.order_id, '') ilike '%' || v_q || '%'
          or coalesce(co.buyer_username, '') ilike '%' || v_q || '%'
          or coalesce(wo.order_no, '') ilike '%' || v_q || '%'
          or coalesce(wo.buyer_name, '') ilike '%' || v_q || '%'
          or coalesce(u.title, '') ilike '%' || v_q || '%'
        )
      order by s.sold_at desc
      limit 30
    ) x
  ), '[]'::jsonb);
end $$;

create or replace function public.portal_start_returns(
  p_lines jsonb,
  p_label_cents int default 0,
  p_label_paid_by text default 'seller',
  p_note text default null,
  p_reason text default 'other',
  p_no_shipment boolean default false,
  p_refund_cents int default 0
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
      refunded_at, closed_at, disposition, label_sent_at
    ) values (
      v_store, v_sale.sku, v_sale.id, lower(coalesce(v_sale.channel, 'other')), v_order,
      v_reason, 'unknown',
      case when coalesce(p_no_shipment, false) then 'refunded_no_return' else 'requested' end,
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
      case when v_label > 0 and not coalesce(p_no_shipment, false) then now() else null end
    ) returning * into v_row;
    if v_label > 0 and not coalesce(p_no_shipment, false) and v_first then
      update public.returns set status = 'label_sent', label_sent_at = now(), approved_at = coalesce(approved_at, now())
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

create or replace function public.portal_log_return_refund(
  p_return uuid,
  p_amount_cents int,
  p_refunded_on date default null,
  p_channel text default null,
  p_kind text default null,
  p_item_kept boolean default false,
  p_note text default null,
  p_close_without_shipment boolean default false
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  r public.returns;
  s public.sales;
  v_kind text;
  v_sum int;
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if coalesce(p_amount_cents, 0) <= 0 then raise exception 'refund_required' using errcode = '22023'; end if;
  select * into r from public.returns where id = p_return and store_id = v_store for update;
  if not found then raise exception 'return_not_found' using errcode = 'P0001'; end if;
  select * into s from public.sales where id = r.sale_id;
  v_kind := lower(btrim(coalesce(p_kind, '')));
  if v_kind not in ('full', 'partial') then
    v_kind := case
      when s.price_cents is not null and p_amount_cents < s.price_cents then 'partial'
      else 'full'
    end;
  end if;
  insert into public.return_refunds (
    store_id, return_id, amount_cents, refunded_on, channel, kind, item_kept, note, created_by
  ) values (
    v_store, r.id, p_amount_cents,
    coalesce(p_refunded_on, (timezone('America/Los_Angeles', now()))::date),
    lower(btrim(coalesce(p_channel, r.channel))),
    v_kind, coalesce(p_item_kept, false), nullif(btrim(coalesce(p_note, '')), ''), auth.uid()
  );
  select coalesce(sum(amount_cents), 0)::int into v_sum from public.return_refunds where return_id = r.id;
  update public.returns set refund_cents = v_sum, refunded_at = coalesce(refunded_at, now()), updated_at = now()
   where id = r.id returning * into r;
  insert into public.return_notes (store_id, return_id, body, kind, created_by)
  values (v_store, r.id, format('Refund %s cents · %s%s', p_amount_cents, v_kind,
    case when coalesce(p_item_kept, false) then ' · buyer kept it' else '' end), 'status', auth.uid());
  if coalesce(p_item_kept, false) or v_kind = 'partial' or p_amount_cents < coalesce(s.price_cents, p_amount_cents + 1) then
    perform public.return_apply_keep_refund(r.id);
  end if;
  if coalesce(p_close_without_shipment, false) or (coalesce(p_item_kept, false) and r.status in ('requested', 'label_sent', 'approved')) then
    update public.returns set
      status = 'refunded_no_return', route_to = 'buyer_keeps', disposition = 'keep_buyer',
      closed_at = coalesce(closed_at, now()), needs_decision = false, updated_at = now()
     where id = r.id returning * into r;
    perform public.return_post_ledger(r.id);
  end if;
  return to_jsonb(r);
end $$;

create or replace function public.portal_add_return_note(p_return uuid, p_body text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  n public.return_notes;
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if nullif(btrim(coalesce(p_body, '')), '') is null then raise exception 'note_required' using errcode = '22023'; end if;
  if not exists (select 1 from public.returns where id = p_return and store_id = v_store) then
    raise exception 'return_not_found' using errcode = 'P0001';
  end if;
  insert into public.return_notes (store_id, return_id, body, kind, created_by)
  values (v_store, p_return, btrim(p_body), 'note', auth.uid())
  returning * into n;
  return to_jsonb(n);
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
          'id', r.id, 'kind', 'return', 'sku', r.sku,
          'title', coalesce(nullif(btrim(u.title), ''), nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), 'Item'),
          'channel', r.channel, 'status', r.status, 'reason', r.reason, 'fault', r.fault,
          'external_order_id', r.external_order_id, 'buyer_name', r.buyer_name,
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

-- A replacement shows up here, tied to the original sale. The bad unit uses the same return steps when it is coming back.
create or replace function public.returns_link_replacement()
returns trigger language plpgsql security definer set search_path = public as $$
declare s public.sales; v_id uuid;
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
  if exists (select 1 from public.returns where store_id = new.store_id and raw->>'replacement_id' = new.id::text) then
    return new;
  end if;
  select * into s from public.sales where id = new.original_sale_id;
  insert into public.returns (
    store_id, sku, sale_id, channel, external_order_id, external_return_id,
    reason, status, route_to, needs_decision, requested_qty, buyer_name, raw, created_by,
    received_at
  ) values (
    new.store_id, coalesce(new.original_sku, new.sku), new.original_sale_id,
    lower(coalesce(s.channel, 'other')), s.receipt_no, 'replacement:' || new.id::text,
    'defective',
    case when new.bad_unit_status = 'returned' then 'received' else 'requested' end,
    'garage', false, 1, s.customer_name,
    jsonb_build_object('replacement_id', new.id, 'replacement_sku', new.sku),
    new.recorded_by,
    case when new.bad_unit_status = 'returned' then now() else null end
  ) returning id into v_id;
  insert into public.return_notes (store_id, return_id, body, kind, created_by)
  values (new.store_id, v_id, 'Replacement SKU ' || new.sku || ' sent for this sale', 'status', new.recorded_by);
  return new;
end $$;

drop trigger if exists returns_link_replacement_ins on public.unit_dispositions;
create trigger returns_link_replacement_ins
  after insert or update of undone_at, bad_unit_status on public.unit_dispositions
  for each row execute function public.returns_link_replacement();

create or replace function public.returns_writeoff_defective()
returns trigger language plpgsql security definer set search_path = public as $$
declare u public.units;
begin
  if new.disposition is distinct from 'write_off' or new.disposition is not distinct from old.disposition then
    return new;
  end if;
  select * into u from public.units where store_id = new.store_id and sku = new.sku;
  if not found then return new; end if;
  if coalesce(u.is_stocked, false) and coalesce(u.qty_on_hand, 0) > coalesce(new.requested_qty, 1) then
    return new;
  end if;
  update public.units set
    state = 'available',
    condition = 'Defective',
    show_on_website = false,
    qty_on_hand = greatest(coalesce(qty_on_hand, 0), coalesce(new.requested_qty, 1)),
    listing_specs = coalesce(listing_specs, '{}'::jsonb) || jsonb_build_object('do_not_list', true),
    updated_at = now()
  where store_id = new.store_id and sku = new.sku;
  return new;
end $$;

drop trigger if exists returns_writeoff_defective_upd on public.returns;
create trigger returns_writeoff_defective_upd
  after update of disposition on public.returns
  for each row execute function public.returns_writeoff_defective();

insert into public.returns (
  store_id, sku, sale_id, channel, external_order_id, external_return_id,
  reason, status, route_to, needs_decision, requested_qty, raw, created_by, received_at
)
select d.store_id, coalesce(d.original_sku, d.sku), d.original_sale_id,
  lower(coalesce(s.channel, 'other')), s.receipt_no, 'replacement:' || d.id::text,
  'defective',
  case when d.bad_unit_status = 'returned' then 'received' else 'requested' end,
  'garage', false, 1,
  jsonb_build_object('replacement_id', d.id, 'replacement_sku', d.sku),
  d.recorded_by,
  case when d.bad_unit_status = 'returned' then d.created_at else null end
from public.unit_dispositions d
left join public.sales s on s.id = d.original_sale_id
where d.kind = 'replacement' and d.undone_at is null
  and not exists (
    select 1 from public.returns r
     where r.store_id = d.store_id and r.external_return_id = 'replacement:' || d.id::text
  );

-- Garage actions stay admin-only, same as the Returns tab.
do $$
declare src text; nxt text; fn text;
begin
  foreach fn in array array[
    'public.portal_inspect_return(uuid,text,text,int)',
    'public.portal_disposition_return(uuid,text,jsonb)',
    'public.portal_create_return(jsonb)',
    'public.portal_add_return_photo(uuid,text,text)',
    'public.portal_returns(text,int)',
    'public.portal_return_lookup(text)'
  ] loop
    src := pg_get_functiondef(fn::regprocedure);
    nxt := replace(src,
      'if v_store is null then raise exception ''portal_access_denied'' using errcode = ''42501''; end if;',
      'if v_store is null or not public.portal_is_admin() then raise exception ''portal_access_denied'' using errcode = ''42501''; end if;');
    if nxt = src then
      raise exception 'admin gate not applied to %', fn;
    end if;
    execute nxt;
  end loop;
end $$;

do $$ declare f text; begin
  foreach f in array array[
    'return_sync_label_expense(uuid)',
    'return_apply_keep_refund(uuid)',
    'return_record_keep_from_row(uuid)',
    'portal_return_candidates(text)',
    'portal_start_returns(jsonb, int, text, text, text, boolean, int)',
    'portal_log_return_refund(uuid, int, date, text, text, boolean, text, boolean)',
    'portal_add_return_note(uuid, text)',
    'portal_return_desk(text, text, date, date)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;

revoke all on function public.return_sync_label_expense(uuid) from authenticated;
revoke all on function public.return_apply_keep_refund(uuid) from authenticated;
revoke all on function public.return_record_keep_from_row(uuid) from authenticated;
grant execute on function public.return_sync_label_expense(uuid) to service_role;
grant execute on function public.return_apply_keep_refund(uuid) to service_role;
grant execute on function public.return_record_keep_from_row(uuid) to service_role;

commit;
