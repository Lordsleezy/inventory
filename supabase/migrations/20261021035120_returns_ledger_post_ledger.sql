create or replace function public.return_post_ledger(p_return_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  r public.returns;
  v_extras int;
  v_desc text;
  v_sale_voided boolean := false;
begin
  select * into r from public.returns where id = p_return_id for update;
  if not found then return; end if;
  if r.ledger_posted_at is not null then return; end if;

  if r.sale_id is not null then
    select voided_at is not null into v_sale_voided
      from public.sales where id = r.sale_id;
  end if;
  -- Paths that reverse the sale always void; treat refund-no-return / dispositioned the same.
  if r.status in ('refunded_no_return', 'dispositioned', 'closed')
     or r.disposition is not null then
    v_sale_voided := true;
  end if;

  -- Extra costs only. Refund is represented by voiding the sale (revenue reversal).
  v_extras :=
    case when r.label_paid_by = 'seller' then coalesce(r.return_label_cents, 0) else 0 end
    + coalesce(r.unrecovered_fees_cents, 0)
    + coalesce(r.regrade_loss_cents, 0);

  -- Only if somehow a return posts without voiding the sale, include refund once.
  if not coalesce(v_sale_voided, false) then
    v_extras := v_extras + coalesce(r.refund_cents, 0);
  end if;

  if v_extras <= 0 then
    update public.returns set ledger_posted_at = now(), updated_at = now() where id = r.id;
    return;
  end if;

  v_desc := 'Return extras ' || upper(r.channel) || ' SKU ' || r.sku
    || coalesce(' order ' || r.external_order_id, '')
    || ' (label/fees/regrade; refund via voided sale)';

  -- Replace any prior double-counted return expense for this return.
  update public.portal_expenses set
    voided_at = coalesce(voided_at, now()),
    void_reason = coalesce(void_reason, 'returns_ledger_fix')
  where store_id = r.store_id and source = 'return' and external_id = r.id::text
    and voided_at is null;

  insert into public.portal_expenses(
    store_id, spent_on, description, category, amount_cents,
    needs_reimbursement, source, order_id, external_id
  ) values (
    r.store_id,
    (timezone('America/Los_Angeles', now()))::date,
    v_desc,
    'Returns',
    v_extras,
    false,
    'return',
    r.web_order_id,
    r.id::text
  );

  update public.returns set ledger_posted_at = now(), updated_at = now() where id = r.id;
end $$;

update public.portal_expenses e set
  voided_at = coalesce(voided_at, now()),
  void_reason = coalesce(void_reason, 'returns_ledger_fix_double_count')
where e.source = 'return'
  and e.voided_at is null
  and e.category = 'Returns'
  and e.description not like 'Return extras%'
  and exists (
    select 1 from public.returns r
    where r.id::text = e.external_id and r.sale_id is not null
  );
