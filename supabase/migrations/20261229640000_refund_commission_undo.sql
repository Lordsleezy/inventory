-- A refund does not void a delivered sale. The sale still happened, and the
-- commission that was earned stays on that sale. A new payout adjustment
-- undoes that commission. Profit still drops through buyer_keep_refund_cents.
-- A cancel before the order shipped still voids the sale.

begin;

create or replace function public.payout_keep_refund_cents(p_sale_id bigint)
returns int
language sql
stable
as $$
  -- Commission is not rewritten when money is refunded. The earned cut stays
  -- on the sale. return_post_commission_undo posts the reversing line.
  select 0;
$$;

-- Put the earned commission back, then add the reversing payout line.
create or replace function public.return_post_commission_undo(p_return_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.returns;
  s public.sales;
  v_price int;
  v_refund int;
  v_frac numeric;
  v_emp uuid;
  v_full int;
  v_rev int;
  v_ticket text;
  v_rows jsonb := '[]'::jsonb;
begin
  select * into r from public.returns where id = p_return_id for update;
  if not found or r.sale_id is null then
    return jsonb_build_object('ok', true, 'note', 'no_sale');
  end if;
  select * into s from public.sales where id = r.sale_id and store_id = r.store_id for update;
  if not found then return jsonb_build_object('ok', true, 'note', 'sale_missing'); end if;
  if s.voided_at is not null then
    return jsonb_build_object('ok', true, 'note', 'sale_voided');
  end if;

  v_price := greatest(coalesce(s.price_cents, 0), 0);
  -- The caller already stored how much of this sale was refunded.
  v_refund := coalesce(nullif(s.buyer_keep_refund_cents, 0), coalesce(r.refund_cents, 0));
  if v_price > 0 then v_refund := least(v_refund, v_price); end if;
  if v_refund <= 0 then
    delete from public.portal_payout_adjustments
     where return_id = r.id
       and reason like 'Refund SKU % · undoes the commission%';
    return jsonb_build_object('ok', true, 'note', 'no_refund');
  end if;

  update public.sales set buyer_keep_refund_cents = v_refund where id = s.id;
  perform public.payout_refreeze_sale(s.id);
  v_frac := case when v_price <= 0 then 1 else v_refund::numeric / v_price::numeric end;
  v_ticket := coalesce(s.ticket_id::text, 'sale:' || s.id::text);

  for v_emp in
    select distinct x from (
      select c.employee_id as x
        from public.sale_commissions c
       where c.sale_id = s.id and coalesce(c.amount_cents, 0) > 0
      union
      select public.payout_slot_employee(r.store_id, 'paul')
      union
      select public.payout_slot_employee(r.store_id, 'jacob')
    ) people
    where x is not null
  loop
    v_full := coalesce(
      (select c.amount_cents from public.sale_commissions c
        where c.sale_id = s.id and c.employee_id = v_emp),
      public.sale_commission_cents(r.store_id, s.id, v_emp)
    );
    if v_full is null or v_full <= 0 then continue; end if;
    v_rev := round(v_full * v_frac)::int;
    if v_rev = 0 then continue; end if;
    insert into public.portal_payout_adjustments (
      store_id, employee_id, amount_cents, reason, return_id, sale_id, ticket_key,
      sale_commission_cents, created_by
    ) values (
      r.store_id, v_emp, -v_rev,
      format('Refund SKU %s · undoes the commission · %s cents refunded · return %s', r.sku, v_refund, r.id::text),
      r.id, s.id, v_ticket, 0, auth.uid()
    )
    on conflict (store_id, return_id, employee_id) do update set
      amount_cents = excluded.amount_cents,
      reason = excluded.reason,
      sale_id = excluded.sale_id,
      ticket_key = excluded.ticket_key,
      sale_commission_cents = 0,
      created_at = now();
    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'employee_id', v_emp, 'earned_cents', v_full, 'undo_cents', -v_rev
    ));
  end loop;
  return jsonb_build_object('ok', true, 'refund_cents', v_refund, 'adjustments', v_rows);
end $$;

revoke all on function public.return_post_commission_undo(uuid) from public, anon, authenticated;
grant execute on function public.return_post_commission_undo(uuid) to service_role;

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
    perform public.payout_refreeze_sale(s.id);
    delete from public.portal_payout_adjustments
     where return_id = r.id
       and reason like 'Refund SKU % · undoes the commission%';
    return jsonb_build_object('ok', true, 'keep_cents', 0);
  end if;
  v_price := greatest(coalesce(s.price_cents, 0), 0);
  v_keep := least(v_keep, case when v_price > 0 then v_price else v_keep end);
  update public.sales set buyer_keep_refund_cents = v_keep where id = s.id;
  perform public.return_post_commission_undo(r.id);
  return jsonb_build_object('ok', true, 'keep_cents', v_keep);
end $$;

create or replace function public.return_apply_owner_profit_refund(p_return_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r public.returns;
  s public.sales;
  v_keep int;
  v_price int;
  v_kind text;
  v_status text;
  v_shipped boolean;
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

  -- A delivered refund used to void the sale. The sale still happened.
  if s.voided_at is not null and coalesce(s.void_reason, '') like 'eBay %' then
    v_status := coalesce(
      nullif(r.raw->>'orderFulfillmentStatus', ''),
      nullif(r.raw#>>'{ebay_order_refund,orderFulfillmentStatus}', ''),
      nullif(r.raw#>>'{ebay_line_refund,orderFulfillmentStatus}', ''),
      ''
    );
    select v_status is distinct from 'NOT_STARTED'
      and (
        v_status in ('FULFILLED', 'IN_PROGRESS')
        or exists (
          select 1 from public.web_orders w
          where w.sale_id = s.id and w.shipped_at is not null
        )
      )
    into v_shipped;
    if v_shipped then
      update public.sales set voided_at = null, void_reason = null where id = s.id;
      s.voided_at := null;
    end if;
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
    values (r.store_id, r.id, v_keep, r.channel, v_kind, true, 'Refund comes out of the commission split');
  else
    update public.return_refunds set
      amount_cents = v_keep,
      kind = v_kind,
      item_kept = true
    where return_id = r.id;
  end if;

  update public.sales set buyer_keep_refund_cents = v_keep where id = s.id;
  perform public.return_post_commission_undo(r.id);
  perform public.return_sync_label_expense(r.id);
  return jsonb_build_object('ok', true, 'keep_cents', v_keep);
end $$;

-- Every refund already on the books, not only ones that arrive after this ships.
do $$
declare
  v_id uuid;
begin
  for v_id in
    select r.id
    from public.returns r
    join public.sales s on s.id = r.sale_id
    where coalesce(r.refund_cents, 0) > 0
      and r.status not in ('canceled', 'denied')
  loop
    perform public.return_apply_owner_profit_refund(v_id);
  end loop;

  update public.web_orders w
     set status = 'refunded',
         updated_at = now()
   where w.status = 'canceled'
     and w.shipped_at is not null
     and exists (
       select 1 from public.sales s
       where s.id = w.sale_id and s.voided_at is null
     )
     and exists (
       select 1 from public.returns r
       where r.sale_id = w.sale_id and coalesce(r.refund_cents, 0) > 0
     );
end $$;

commit;
