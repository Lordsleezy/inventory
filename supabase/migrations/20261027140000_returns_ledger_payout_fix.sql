-- Fix returns money bugs:
-- 1) Ledger: when a sale is voided, post ONLY extra return costs (label/fees/regrade), never the refund.
-- 2) Payouts: if commission was already paid, insert a negative adjustment (never rewrite payment history).

begin;

-- ---------------------------------------------------------------------------
-- Payout adjustments (clawbacks / credits). Positive = we owe them more;
-- negative = reduce running balance (return clawback).
-- ---------------------------------------------------------------------------
create table if not exists public.portal_payout_adjustments (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  employee_id uuid not null references auth.users(id),
  amount_cents int not null check (amount_cents <> 0),
  reason text not null,
  return_id uuid references public.returns(id) on delete set null,
  sale_id bigint references public.sales(id) on delete set null,
  ticket_key text,
  -- Full commission on the sale before refund fraction (for Payouts UI add-back).
  sale_commission_cents int,
  created_at timestamptz not null default now(),
  created_by uuid,
  unique (store_id, return_id, employee_id)
);

create index if not exists portal_payout_adjustments_employee_idx
  on public.portal_payout_adjustments (store_id, employee_id, created_at desc);

alter table public.portal_payout_adjustments enable row level security;
drop policy if exists portal_payout_adjustments_select on public.portal_payout_adjustments;
create policy portal_payout_adjustments_select on public.portal_payout_adjustments
  for select to authenticated
  using (store_id = public.portal_store_id());
revoke all on public.portal_payout_adjustments from public, anon;
grant select on public.portal_payout_adjustments to authenticated;
grant all on public.portal_payout_adjustments to service_role;

create or replace function public.portal_payout_adjustments()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(to_jsonb(a) order by a.created_at desc)
    from public.portal_payout_adjustments a
    where a.store_id = v_store
  ), '[]'::jsonb);
end $$;
revoke all on function public.portal_payout_adjustments() from public, anon;
grant execute on function public.portal_payout_adjustments() to authenticated;

-- ---------------------------------------------------------------------------
-- Commission owed on one sale for one employee (mirrors apps/admin payouts.ts).
-- ---------------------------------------------------------------------------
create or replace function public.sale_commission_cents(
  p_store uuid,
  p_sale_id bigint,
  p_employee uuid
) returns int language plpgsql stable security definer set search_path = public as $$
declare
  s public.sales;
  v_cost int;
  v_ship int;
  v_base int;
  v_ticket text;
  v_channel text;
  v_online_channels jsonb;
  v_online_pct numeric;
  v_online_emp uuid;
  v_is_online boolean := false;
  v_ov record;
  v_rule record;
  v_rate numeric;
  v_paul uuid := 'f17e6163-b10a-4fe1-a373-75c0094e5363'::uuid;
  v_jacob uuid := 'c851c8ee-2cc2-490f-935f-1e2d7e093d88'::uuid;
begin
  select * into s from public.sales where id = p_sale_id and store_id = p_store;
  if not found then return 0; end if;

  select coalesce(acquisition_cost_cents, case when is_collectible then 0 else null end)
    into v_cost from public.units where store_id = p_store and sku = s.sku;
  if v_cost is null then return null; end if; -- cannot compute

  v_ship := coalesce(s.shipping_cents, 0);
  v_base := greatest(0, s.price_cents + v_ship - v_cost);
  v_ticket := coalesce(s.ticket_id::text, 'sale:' || s.id::text);
  v_channel := lower(coalesce(s.channel, ''));

  select value into v_online_channels from public.store_settings
   where store_id = p_store and key = 'online_payout_channels';
  if v_online_channels is null then
    select value into v_online_channels from public.store_settings
     where store_id = p_store and key = 'online_channels';
  end if;
  v_online_pct := coalesce((public.store_setting(p_store, 'online_payout_pct', '0'::jsonb) #>> '{}')::numeric, 0);
  begin
    v_online_emp := nullif(public.store_setting(p_store, 'online_payout_employee_id', 'null'::jsonb) #>> '{}', '')::uuid;
  exception when others then v_online_emp := null;
  end;

  if v_online_channels is not null and jsonb_typeof(v_online_channels) = 'array' then
    select exists (
      select 1 from jsonb_array_elements_text(v_online_channels) x
      where lower(btrim(x)) = v_channel
    ) into v_is_online;
  end if;

  select * into v_ov from public.portal_commission_overrides
   where store_id = p_store and ticket_key = v_ticket;
  if found then
    if p_employee = v_paul then
      return round(v_base * coalesce(v_ov.paul_pct, 0) / 100.0)::int;
    elsif p_employee = v_jacob then
      return round(v_base * coalesce(v_ov.jacob_pct, 0) / 100.0)::int;
    else
      return 0;
    end if;
  end if;

  if v_is_online then
    if p_employee is distinct from v_online_emp then return 0; end if;
    return round(v_base * v_online_pct / 100.0)::int;
  end if;

  select * into v_rule from public.portal_payout_rules
   where store_id = p_store and employee_id = p_employee;
  if not found then return 0; end if;

  if v_rule.method = 'flat_ticket' then
    return round(v_rule.rate * 100)::int;
  end if;
  if v_rule.method = 'percent_profit' then
    v_rate := v_rule.rate;
    return round(v_base * v_rate / 100.0)::int;
  end if;
  -- percent_sale
  return round(s.price_cents * v_rule.rate / 100.0)::int;
end $$;

revoke all on function public.sale_commission_cents(uuid, bigint, uuid) from public, anon;
grant execute on function public.sale_commission_cents(uuid, bigint, uuid) to service_role;

-- Commission clawbacks / partial retains for returns.
-- Void drops the full sale from live commission. This posts one adjustment per employee so
-- that (UI add-back of sale_commission_cents) + amount_cents nets to −frac × commission.
-- When already paid, amount is negative (clawback). Payment rows are never rewritten.
create or replace function public.return_apply_commission_clawbacks(p_return_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r public.returns;
  s public.sales;
  v_ticket text;
  v_emp uuid;
  v_full_comm int;
  v_reversal int;
  v_frac numeric;
  v_claw int;
  v_amt int;
  v_reason text;
  v_paid bigint;
  v_reimburse bigint;
  v_earned_prior bigint;
  v_covered bigint;
  v_rows jsonb := '[]'::jsonb;
  v_paul uuid := 'f17e6163-b10a-4fe1-a373-75c0094e5363'::uuid;
  v_jacob uuid := 'c851c8ee-2cc2-490f-935f-1e2d7e093d88'::uuid;
  v_online_emp uuid;
begin
  select * into r from public.returns where id = p_return_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'return_not_found'); end if;
  if r.sale_id is null then return jsonb_build_object('ok', true, 'adjustments', '[]'::jsonb, 'note', 'no_sale'); end if;

  select * into s from public.sales where id = r.sale_id and store_id = r.store_id;
  if not found then return jsonb_build_object('ok', true, 'adjustments', '[]'::jsonb, 'note', 'sale_missing'); end if;

  v_ticket := coalesce(s.ticket_id::text, 'sale:' || s.id::text);
  if coalesce(s.price_cents, 0) <= 0 then
    v_frac := 1;
  else
    v_frac := least(1, greatest(0, coalesce(r.refund_cents, s.price_cents)::numeric / s.price_cents::numeric));
  end if;

  begin
    v_online_emp := nullif(public.store_setting(r.store_id, 'online_payout_employee_id', 'null'::jsonb) #>> '{}', '')::uuid;
  exception when others then v_online_emp := null;
  end;

  for v_emp in
    select distinct x from unnest(array[
      v_paul, v_jacob, v_online_emp
    ] || array(select employee_id from public.portal_payout_rules where store_id = r.store_id)) as t(x)
    where x is not null
  loop
    v_full_comm := public.sale_commission_cents(r.store_id, r.sale_id, v_emp);
    if v_full_comm is null or v_full_comm <= 0 then continue; end if;
    v_reversal := round(v_full_comm * v_frac)::int;

    select coalesce(sum(amount_cents), 0) into v_paid
      from public.portal_payout_payments
     where store_id = r.store_id and employee_id = v_emp;

    v_claw := 0;
    if v_paid > 0 and v_reversal > 0 then
      select coalesce(sum(amount_cents), 0) into v_reimburse
        from public.portal_expenses
       where store_id = r.store_id and employee_id = v_emp
         and needs_reimbursement and voided_at is null;

      select coalesce(sum(cents), 0) into v_earned_prior from (
        select public.sale_commission_cents(r.store_id, ss.id, v_emp) as cents
          from public.sales ss
         where ss.store_id = r.store_id and ss.voided_at is null and ss.id <> r.sale_id
      ) x where cents is not null;

      v_earned_prior := v_earned_prior + coalesce((
        select sum(amount_cents) from public.portal_payout_adjustments
         where store_id = r.store_id and employee_id = v_emp
           and (return_id is null or return_id <> r.id)
      ), 0);

      v_covered := greatest(0, v_paid - v_reimburse - greatest(0, v_earned_prior));
      v_claw := least(v_reversal, v_covered::int);
    end if;

    -- Unpaid full refund: commission just drops with the void — no adjustment row.
    if v_claw <= 0 and v_frac >= 1 then continue; end if;

    if v_claw > 0 then
      -- Already paid (at least in part): negative clawback for the reversed share.
      -- Payouts UI add-backs sale_commission_cents so void+addback+claw net to −reversal.
      v_amt := -v_reversal;
      v_reason := format(
        'Return clawback SKU %s · %s · refund %s%% · return %s',
        r.sku, upper(r.channel), round(v_frac * 100)::text, r.id::text
      );
    else
      -- Unpaid partial refund: void drops full sale; retain the unrefunded commission share.
      v_amt := round(v_full_comm * (1.0 - v_frac))::int;
      if v_amt = 0 then continue; end if;
      v_reason := format(
        'Return partial retain SKU %s · %s · kept %s%% commission · return %s',
        r.sku, upper(r.channel), round((1 - v_frac) * 100)::text, r.id::text
      );
    end if;

    insert into public.portal_payout_adjustments (
      store_id, employee_id, amount_cents, reason, return_id, sale_id, ticket_key,
      sale_commission_cents, created_by
    ) values (
      r.store_id, v_emp, v_amt, v_reason,
      r.id, r.sale_id, v_ticket, v_full_comm, auth.uid()
    )
    on conflict (store_id, return_id, employee_id) do update set
      amount_cents = excluded.amount_cents,
      reason = excluded.reason,
      sale_commission_cents = excluded.sale_commission_cents,
      created_at = now();

    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'employee_id', v_emp, 'adjustment_cents', v_amt,
      'clawback_cents', v_claw, 'sale_commission_cents', v_full_comm
    ));
  end loop;

  return jsonb_build_object('ok', true, 'adjustments', v_rows, 'refund_fraction', v_frac);
end $$;

revoke all on function public.return_apply_commission_clawbacks(uuid) from public, anon;
grant execute on function public.return_apply_commission_clawbacks(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Ledger: extras only (never the refund when the sale is / will be voided).
-- ---------------------------------------------------------------------------
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

-- Clean any existing double-counted return expenses (refund bundled in).
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

-- ---------------------------------------------------------------------------
-- Wire clawbacks into return close paths (before/with void).
-- ---------------------------------------------------------------------------
create or replace function public.portal_set_return_status(
  p_return uuid, p_status text, p_patch jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  r public.returns;
  v_status text := lower(btrim(coalesce(p_status, '')));
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  select * into r from public.returns where id = p_return and store_id = v_store for update;
  if not found then raise exception 'return_not_found' using errcode = 'P0001'; end if;
  if v_status not in (
    'requested','approved','in_transit','received','inspected','dispositioned',
    'closed','refunded_no_return','denied','canceled'
  ) then raise exception 'invalid_status' using errcode = '22023'; end if;

  update public.returns set
    status = v_status,
    needs_decision = case when v_status = 'requested' then needs_decision else false end,
    approved_at = case when v_status = 'approved' then coalesce(approved_at, now()) else approved_at end,
    in_transit_at = case when v_status = 'in_transit' then coalesce(in_transit_at, now()) else in_transit_at end,
    received_at = case when v_status = 'received' then coalesce(received_at, now()) else received_at end,
    inspected_at = case when v_status = 'inspected' then coalesce(inspected_at, now()) else inspected_at end,
    closed_at = case when v_status in ('closed','canceled','denied','refunded_no_return') then coalesce(closed_at, now()) else closed_at end,
    refund_cents = coalesce((p_patch->>'refund_cents')::int, refund_cents),
    return_label_cents = coalesce((p_patch->>'return_label_cents')::int, return_label_cents),
    label_paid_by = coalesce(nullif(p_patch->>'label_paid_by',''), label_paid_by),
    unrecovered_fees_cents = coalesce((p_patch->>'unrecovered_fees_cents')::int, unrecovered_fees_cents),
    tracking_number = coalesce(nullif(p_patch->>'tracking_number',''), tracking_number),
    carrier = coalesce(nullif(p_patch->>'carrier',''), carrier),
    inspection_notes = coalesce(nullif(p_patch->>'inspection_notes',''), inspection_notes),
    fault = coalesce(nullif(p_patch->>'fault',''), fault),
    reason = coalesce(nullif(p_patch->>'reason',''), reason),
    updated_at = now()
  where id = r.id
  returning * into r;

  if v_status = 'refunded_no_return' then
    perform public.return_apply_commission_clawbacks(r.id);
    perform public.return_reverse_sale(v_store, r.sale_id, 'Refund without return', false);
    update public.returns set disposition = 'keep_buyer', refunded_at = coalesce(refunded_at, now())
     where id = r.id returning * into r;
    perform public.return_post_ledger(r.id);
  end if;

  return to_jsonb(r);
end $$;

revoke all on function public.portal_set_return_status(uuid, text, jsonb) from public, anon;
grant execute on function public.portal_set_return_status(uuid, text, jsonb) to authenticated;

create or replace function public.portal_disposition_return(
  p_return uuid,
  p_disposition text,
  p_patch jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  r public.returns;
  v_disp text := lower(btrim(coalesce(p_disposition, '')));
  v_settings jsonb;
  v_ch text;
  v_photos int;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if v_disp not in ('relist', 'downgrade_channel', 'bundle_lot', 'write_off') then
    raise exception 'invalid_disposition' using errcode = '22023';
  end if;

  select * into r from public.returns where id = p_return and store_id = v_store for update;
  if not found then raise exception 'return_not_found' using errcode = 'P0001'; end if;
  if r.status not in ('inspected', 'received', 'dispositioned') then
    raise exception 'inspect_before_disposition' using errcode = 'P0001';
  end if;

  select count(*)::int into v_photos from public.return_photos where return_id = r.id;
  if v_photos < 1 then
    raise exception 'inspection_photos_required' using errcode = 'P0001';
  end if;

  v_settings := public.return_settings(v_store);

  update public.returns set
    refund_cents = coalesce((p_patch->>'refund_cents')::int, refund_cents),
    return_label_cents = coalesce((p_patch->>'return_label_cents')::int, return_label_cents),
    unrecovered_fees_cents = coalesce((p_patch->>'unrecovered_fees_cents')::int, unrecovered_fees_cents),
    regrade_loss_cents = coalesce((p_patch->>'regrade_loss_cents')::int, regrade_loss_cents),
    label_paid_by = coalesce(nullif(p_patch->>'label_paid_by',''), label_paid_by),
    updated_at = now()
  where id = r.id
  returning * into r;

  -- Clawbacks while sale is still live, then void.
  perform public.return_apply_commission_clawbacks(r.id);

  if r.sale_id is not null then
    perform public.return_reverse_sale(
      v_store, r.sale_id,
      'Return disposition: ' || v_disp,
      v_disp <> 'write_off' or coalesce((p_patch->>'restock')::boolean, false)
    );
  else
    if v_disp in ('relist', 'downgrade_channel', 'bundle_lot') then
      update public.units set state = 'available', updated_at = now()
       where store_id = v_store and sku = r.sku and state in ('sold', 'reserved');
      update public.sku_ledger set fate = 'issued'
       where store_id = v_store and sku = r.sku;
    elsif v_disp = 'write_off' then
      update public.units set state = 'scrapped', updated_at = now()
       where store_id = v_store and sku = r.sku;
      update public.sku_ledger set fate = 'retired'
       where store_id = v_store and sku = r.sku;
    end if;
  end if;

  if v_disp = 'downgrade_channel' then
    for v_ch in
      select lower(btrim(x)) from jsonb_array_elements_text(
        coalesce(v_settings->'downgrade_block_channels', '["amazon","tiktok"]'::jsonb)
      ) x
    loop
      insert into public.unit_marketplace_overrides(store_id, sku, channel, decision, note, actor_id, actor_name)
      values (
        v_store, r.sku, v_ch, 'block',
        'Return downgrade — pulled from forced-return channels',
        auth.uid(),
        coalesce((select display_name from public.staff where user_id = auth.uid()), 'portal')
      )
      on conflict (store_id, sku, channel) do update set
        decision = 'block', note = excluded.note, updated_at = now(),
        actor_id = excluded.actor_id, actor_name = excluded.actor_name;
    end loop;
  end if;

  if v_disp = 'bundle_lot' then
    update public.units set
      listing_body = trim(both from coalesce(listing_body, '') || E'\n[RETURN → bundle lot]'),
      updated_at = now()
     where store_id = v_store and sku = r.sku;
    insert into public.unit_marketplace_overrides(store_id, sku, channel, decision, note, actor_id, actor_name)
    select v_store, r.sku, c, 'block', 'Return → bundle lot only', auth.uid(), 'portal'
      from unnest(array['amazon','tiktok']) c
    on conflict (store_id, sku, channel) do update set
      decision = 'block', note = excluded.note, updated_at = now();
  end if;

  if v_disp = 'write_off' then
    insert into public.unit_marketplace_overrides(store_id, sku, channel, decision, note, actor_id, actor_name)
    select v_store, r.sku, c, 'block', 'Return write-off', auth.uid(), 'portal'
      from unnest(array['amazon','tiktok','ebay','mercari','website','depop','whatnot','facebook']) c
    on conflict (store_id, sku, channel) do update set
      decision = 'block', note = excluded.note, updated_at = now();
  end if;

  if v_disp = 'relist' and coalesce((p_patch->>'clear_channel_blocks')::boolean, false) then
    delete from public.unit_marketplace_overrides
     where store_id = v_store and sku = r.sku
       and channel in ('amazon', 'tiktok')
       and note like 'Return%';
  end if;

  update public.returns set
    status = 'dispositioned',
    disposition = v_disp,
    dispositioned_at = coalesce(dispositioned_at, now()),
    refunded_at = coalesce(refunded_at, case when coalesce((p_patch->>'mark_refunded')::boolean, true) then now() else null end),
    updated_at = now()
  where id = r.id
  returning * into r;

  perform public.return_post_ledger(r.id);

  if coalesce((p_patch->>'close')::boolean, true) then
    update public.returns set status = 'closed', closed_at = coalesce(closed_at, now()), closed_by = auth.uid(), updated_at = now()
     where id = r.id returning * into r;
  end if;

  if exists (select 1 from public.sku_ledger where store_id = v_store and sku = r.sku) then
    insert into public.events (store_id, sku, kind, actor, note)
    values (v_store, r.sku, 'return_dispositioned',
            coalesce((select display_name from public.staff where user_id = auth.uid()), 'portal'),
            v_disp);
  end if;

  return to_jsonb(r);
end $$;

revoke all on function public.portal_disposition_return(uuid, text, jsonb) from public, anon;
grant execute on function public.portal_disposition_return(uuid, text, jsonb) to authenticated;

-- Also clawback on ingest auto refund-no-return path
create or replace function public.ingest_channel_return(
  p_store uuid,
  p_channel text,
  p_payload jsonb
) returns public.returns
language plpgsql security definer set search_path = public as $$
declare
  v_channel text := lower(btrim(coalesce(p_channel, '')));
  v_ext text := nullif(btrim(coalesce(p_payload->>'external_return_id', p_payload->>'amazon_rma_id', p_payload->>'return_id', '')), '');
  v_order text := nullif(btrim(coalesce(p_payload->>'external_order_id', p_payload->>'order_id', '')), '');
  v_sku text := nullif(btrim(coalesce(p_payload->>'sku', p_payload->>'merchant_sku', '')), '');
  v_wo public.web_orders;
  v_sale public.sales;
  v_settings jsonb;
  v_hours int;
  v_row public.returns;
  v_item int;
  v_label int := greatest(0, coalesce((p_payload->>'return_label_cents')::int, 0));
  v_refund int := greatest(0, coalesce((p_payload->>'refund_cents')::int, 0));
  v_status text := lower(btrim(coalesce(p_payload->>'status', 'requested')));
  v_needs boolean := coalesce((p_payload->>'needs_decision')::boolean, true);
  v_supplier public.suppliers;
  v_route text := 'garage';
begin
  perform public.assert_service();
  if p_store is null or v_channel = '' then
    raise exception 'store_and_channel_required' using errcode = '22023';
  end if;

  if v_ext is not null then
    select * into v_row from public.returns
     where store_id = p_store and channel = v_channel and external_return_id = v_ext;
    if found then
      update public.returns set
        raw = coalesce(raw, '{}'::jsonb) || coalesce(p_payload, '{}'::jsonb),
        refund_cents = case when v_refund > 0 then v_refund else refund_cents end,
        return_label_cents = case when v_label > 0 then v_label else return_label_cents end,
        tracking_number = coalesce(nullif(p_payload->>'tracking_number',''), tracking_number),
        carrier = coalesce(nullif(p_payload->>'carrier',''), carrier),
        updated_at = now()
      where id = v_row.id
      returning * into v_row;
      return v_row;
    end if;
  end if;

  if v_order is not null then
    select * into v_wo from public.web_orders
     where store_id = p_store and channel = v_channel and order_no = v_order
     order by created_at desc limit 1;
  end if;

  if v_sku is null and v_wo.id is not null then v_sku := v_wo.sku; end if;

  if v_wo.sale_id is not null then
    select * into v_sale from public.sales where id = v_wo.sale_id;
  elsif v_sku is not null then
    select * into v_sale from public.sales
     where store_id = p_store and sku = v_sku and voided_at is null
     order by sold_at desc limit 1;
  end if;

  if v_sku is null then v_sku := 'UNMATCHED'; end if;

  v_item := coalesce(v_wo.item_cents, v_sale.price_cents, (p_payload->>'order_amount_cents')::int, 0);
  if v_refund <= 0 then v_refund := v_item; end if;

  if v_sku <> 'UNMATCHED' then
    select s.* into v_supplier
      from public.units u
      join public.suppliers s on s.id = u.supplier_id
     where u.store_id = p_store and u.sku = v_sku;
    if found then
      if v_supplier.accepts_returns and v_supplier.has_us_return_address then
        v_route := 'supplier';
      elsif public.returns_should_refund_no_return(p_store, v_item, v_label) then
        v_route := 'buyer_keeps';
        v_status := 'refunded_no_return';
        v_needs := false;
      end if;
    end if;
  end if;

  if v_route = 'garage' and public.returns_should_refund_no_return(p_store, v_item, v_label)
     and coalesce((p_payload->>'force_physical_return')::boolean, false) is not true then
    v_route := 'buyer_keeps';
    v_status := 'refunded_no_return';
    v_needs := false;
  end if;

  if v_status not in (
    'requested','approved','in_transit','received','inspected','dispositioned',
    'closed','refunded_no_return','denied','canceled'
  ) then
    v_status := 'requested';
  end if;

  v_settings := public.return_settings(p_store);
  v_hours := coalesce(
    (v_settings #>> array['decision_hours', v_channel])::int,
    (v_settings #>> array['decision_hours', 'default'])::int,
    72
  );

  insert into public.returns (
    store_id, sku, sale_id, web_order_id, channel, external_order_id, external_return_id,
    reason, fault, status, refund_cents, return_label_cents, label_paid_by,
    unrecovered_fees_cents, decision_deadline_at, needs_decision, route_to, supplier_id,
    tracking_number, carrier, condition_before, raw
  ) values (
    p_store, v_sku, v_sale.id, v_wo.id, v_channel, v_order, v_ext,
    public.map_return_reason(coalesce(p_payload->>'reason', p_payload->>'return_reason', '')),
    case
      when lower(coalesce(p_payload->>'fault','')) in ('seller','buyer','carrier') then lower(p_payload->>'fault')
      when public.map_return_reason(coalesce(p_payload->>'reason','')) in ('defective','not_as_described','wrong_item') then 'seller'
      when public.map_return_reason(coalesce(p_payload->>'reason','')) = 'buyer_remorse' then 'buyer'
      else 'unknown'
    end,
    v_status, v_refund, v_label,
    case lower(coalesce(p_payload->>'label_paid_by', p_payload->>'label_to_be_paid_by', ''))
      when 'seller' then 'seller' when 'buyer' then 'buyer' when 'customer' then 'buyer'
      when 'amazon' then 'channel' when 'channel' then 'channel' else 'unknown'
    end,
    greatest(0, coalesce((p_payload->>'unrecovered_fees_cents')::int, 0)),
    case when v_needs then now() + make_interval(hours => greatest(v_hours, 1)) else null end,
    v_needs, v_route, v_supplier.id,
    nullif(p_payload->>'tracking_number',''), nullif(p_payload->>'carrier',''),
    (select condition from public.units where store_id = p_store and sku = v_sku),
    coalesce(p_payload, '{}'::jsonb)
  ) returning * into v_row;

  if v_row.needs_decision then
    perform public.enqueue_return_decision_alert(v_row);
  end if;

  if v_row.status = 'refunded_no_return' then
    perform public.return_apply_commission_clawbacks(v_row.id);
    perform public.return_reverse_sale(p_store, v_row.sale_id, 'Refund without return', false);
    if v_row.web_order_id is not null then
      update public.web_orders
         set status = case when status = 'paid' then 'refunded' else status end,
             canceled_at = coalesce(canceled_at, now()),
             cancel_source = coalesce(cancel_source, 'return'),
             cancel_reason = coalesce(cancel_reason, 'refunded_no_return'),
             updated_at = now()
       where id = v_row.web_order_id and store_id = p_store;
    end if;
    update public.returns set
      refunded_at = now(), closed_at = now(), disposition = 'keep_buyer', updated_at = now()
     where id = v_row.id
     returning * into v_row;
    perform public.return_post_ledger(v_row.id);
  end if;

  if exists (select 1 from public.sku_ledger where store_id = p_store and sku = v_row.sku) then
    insert into public.events (store_id, sku, kind, actor, note)
    values (p_store, v_row.sku, 'return_opened', 'channel:' || v_channel,
            coalesce(v_row.external_return_id, v_row.id::text) || ' ' || v_row.status);
  end if;

  return v_row;
end $$;

revoke all on function public.ingest_channel_return(uuid, text, jsonb) from public, anon;
grant execute on function public.ingest_channel_return(uuid, text, jsonb) to service_role;

-- Report: total_cost = extras only; refund shown separately (revenue reversal via void).
create or replace function public.portal_return_report(p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return jsonb_build_object(
    'by_channel', coalesce((
      select jsonb_agg(jsonb_build_object(
        'channel', channel,
        'returns', n,
        'sales', sales_n,
        'return_rate', case when sales_n > 0 then round((n::numeric / sales_n) * 100, 2) else 0 end,
        'refund_cents', refund_cents,
        'label_cents', label_cents,
        'fee_cents', fee_cents,
        'regrade_loss_cents', regrade_loss_cents,
        'total_cost_cents', label_cents + fee_cents + regrade_loss_cents,
        'note', 'total_cost excludes refund (counted via voided sale)'
      ) order by (label_cents + fee_cents + regrade_loss_cents) desc)
      from (
        select r.channel,
          count(*)::int as n,
          coalesce(sum(r.refund_cents),0)::int as refund_cents,
          coalesce(sum(case when r.label_paid_by = 'seller' then r.return_label_cents else 0 end),0)::int as label_cents,
          coalesce(sum(r.unrecovered_fees_cents),0)::int as fee_cents,
          coalesce(sum(r.regrade_loss_cents),0)::int as regrade_loss_cents,
          (
            select count(*)::int from public.sales s
             where s.store_id = v_store and lower(s.channel) = r.channel
               and s.sold_at >= p_from and s.sold_at < p_to
          ) as sales_n
        from public.returns r
        where r.store_id = v_store
          and r.created_at >= p_from and r.created_at < p_to
          and r.status not in ('canceled', 'denied')
        group by r.channel
      ) c
    ), '[]'::jsonb),
    'by_category', coalesce((
      select jsonb_agg(jsonb_build_object(
        'category', category, 'returns', n, 'total_cost_cents', total_cost_cents
      ) order by total_cost_cents desc)
      from (
        select coalesce(nullif(btrim(u.category), ''), '(uncategorized)') as category,
          count(*)::int as n,
          (
            coalesce(sum(case when r.label_paid_by = 'seller' then r.return_label_cents else 0 end),0)
            + coalesce(sum(r.unrecovered_fees_cents),0)
            + coalesce(sum(r.regrade_loss_cents),0)
          )::int as total_cost_cents
        from public.returns r
        left join public.units u on u.store_id = r.store_id and u.sku = r.sku
        where r.store_id = v_store
          and r.created_at >= p_from and r.created_at < p_to
          and r.status not in ('canceled', 'denied')
        group by 1
      ) x
    ), '[]'::jsonb),
    'by_month', coalesce((
      select jsonb_agg(jsonb_build_object(
        'month', month, 'returns', n, 'total_cost_cents', total_cost_cents
      ) order by month desc)
      from (
        select to_char(timezone('America/Los_Angeles', r.created_at), 'YYYY-MM') as month,
          count(*)::int as n,
          (
            coalesce(sum(case when r.label_paid_by = 'seller' then r.return_label_cents else 0 end),0)
            + coalesce(sum(r.unrecovered_fees_cents),0)
            + coalesce(sum(r.regrade_loss_cents),0)
          )::int as total_cost_cents
        from public.returns r
        where r.store_id = v_store
          and r.created_at >= p_from and r.created_at < p_to
          and r.status not in ('canceled', 'denied')
        group by 1
      ) m
    ), '[]'::jsonb)
  );
end $$;

revoke all on function public.portal_return_report(timestamptz, timestamptz) from public, anon;
grant execute on function public.portal_return_report(timestamptz, timestamptz) to authenticated;

commit;
