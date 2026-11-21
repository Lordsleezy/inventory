-- Refunds and partial refunds stay on the sale. Profit drops by the refund.
-- Paul and Jacob's frozen commissions are recalculated on that lower base,
-- so an online sale drops Paul 25% of the refund and Jacob 5%. Steve's share
-- is profit after those commissions, so he absorbs the other 70%.
-- A pre-ship cancel still voids the sale and drops it out of the numbers.

begin;

create or replace function public.payout_keep_refund_cents(p_sale_id bigint)
returns int
language sql
stable
as $$
  select coalesce((
    select least(coalesce(s.buyer_keep_refund_cents, 0), greatest(coalesce(s.price_cents, 0), 0))
    from public.sales s
    where s.id = p_sale_id
  ), 0);
$$;

create or replace function public.payout_line_net_base(p_sale_id bigint, p_base int, p_fees int)
returns int
language sql
stable
as $$
  select case
    when p_base is null then null
    else greatest(0, p_base + coalesce(p_fees, 0) - public.payout_keep_refund_cents(p_sale_id))
  end;
$$;

create or replace function public.payout_refreeze_sale(p_sale_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.sales;
begin
  select * into s from public.sales where id = p_sale_id;
  if not found or s.voided_at is not null then return; end if;
  perform public.payout_refreeze_ticket(s.store_id, coalesce(s.ticket_id::text, 'sale:' || s.id::text));
end $$;

create or replace function public.payout_calc_ticket(p_store uuid, p_ticket text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  t public.sale_payout_tickets;
  v_ov public.portal_commission_overrides;
  v_has_ov boolean;
  v_sub bigint; v_cost_null boolean; v_base bigint;
  v_emp uuid; v_method text; v_rate numeric; v_amt int; v_touched boolean;
  v_emps uuid[];
  v_absorb boolean := coalesce((public.store_setting(p_store, 'commission_store_absorbs_fees', 'true'::jsonb) #>> '{}')::boolean, true);
begin
  select * into t from public.sale_payout_tickets where store_id = p_store and ticket_key = p_ticket;
  if not found then return; end if;
  delete from public.sale_commissions where store_id = p_store and ticket_key = p_ticket;
  select sum(l.price_cents),
    sum(public.payout_line_net_base(
      l.sale_id,
      l.commission_base_cents,
      case when v_absorb then coalesce((to_jsonb(l)->>'fees_cents')::int, 0) else 0 end)),
    bool_or(l.cost_cents is null)
    into v_sub, v_base, v_cost_null
  from public.sale_payout_lines l where l.store_id = p_store and l.ticket_key = p_ticket;
  if v_sub is null then return; end if;
  if v_cost_null then v_base := null; end if;
  select * into v_ov from public.portal_commission_overrides where store_id = p_store and ticket_key = p_ticket;
  v_has_ov := found;

  select array_agg(distinct e) into v_emps from (
    select (r->>'employee_id')::uuid e from jsonb_array_elements(t.rules) r
    union select t.online_employee_id
    union select nullif(t.slots->>'jacob', '')::uuid
  ) x where e is not null;

  foreach v_emp in array coalesce(v_emps, '{}') loop
    select r->>'method', (r->>'rate')::numeric into v_method, v_rate
      from jsonb_array_elements(t.rules) r where (r->>'employee_id')::uuid = v_emp limit 1;
    if v_method is null then v_method := 'percent_sale'; v_rate := 0; end if;
    v_touched := false;
    if v_cost_null then
      v_amt := null;
    elsif v_has_ov then
      v_rate := case when v_emp = (t.slots->>'paul')::uuid then v_ov.paul_pct
                     when v_emp = (t.slots->>'jacob')::uuid then v_ov.jacob_pct else 0 end;
      v_amt := case when v_base is null then null
                    else public.payout_js_round(greatest(0, v_base)::float8 * v_rate::float8 / 100) end;
    elsif t.online then
      v_amt := case
        when v_base is null then null
        when v_emp is not distinct from t.online_employee_id
          then public.payout_js_round(greatest(0, v_base)::float8 * t.online_pct::float8 / 100)
        when v_emp is not distinct from nullif(t.slots->>'jacob', '')::uuid
          then public.payout_js_round(greatest(0, v_base)::float8 * coalesce(t.online_jacob_pct, 0)::float8 / 100)
        else 0 end;
    elsif v_method = 'flat_ticket' then
      v_amt := public.payout_js_round(v_rate::float8 * 100);
    elsif v_method = 'percent_profit' then
      select exists(select 1 from public.sale_payout_lines l where l.store_id = p_store and l.ticket_key = p_ticket
        and t.sku_rates->l.sku ? v_emp::text) into v_touched;
      if v_touched then
        if v_base is null then v_amt := null;
        else
          insert into public.sale_commissions (sale_id, store_id, ticket_key, employee_id, amount_cents)
          select l.sale_id, p_store, p_ticket, v_emp,
            public.payout_js_round(public.payout_line_net_base(
              l.sale_id,
              l.commission_base_cents,
              case when v_absorb then coalesce((to_jsonb(l)->>'fees_cents')::int, 0) else 0 end)::float8
              * coalesce((t.sku_rates->l.sku->>v_emp::text)::numeric, v_rate)::float8 / 100)
          from public.sale_payout_lines l where l.store_id = p_store and l.ticket_key = p_ticket;
          continue;
        end if;
      else
        v_amt := case when v_base is null then null
                      else public.payout_js_round(greatest(0, v_base)::float8 * v_rate::float8 / 100) end;
      end if;
    else
      v_amt := public.payout_js_round(v_sub::float8 * v_rate::float8 / 100);
    end if;

    insert into public.sale_commissions (sale_id, store_id, ticket_key, employee_id, amount_cents)
    select w.sale_id, p_store, p_ticket, v_emp,
      case when v_amt is null then null
           when w.total = 0 then case when w.rn = 1 then v_amt else 0 end
           else (round(v_amt::numeric * w.cum / w.total) - round(v_amt::numeric * (w.cum - w.weight) / w.total))::int end
    from (
      select l.sale_id, x.weight,
        sum(x.weight) over (order by l.sale_id) cum,
        sum(x.weight) over () total,
        row_number() over (order by l.sale_id) rn
      from public.sale_payout_lines l
      cross join lateral (select case
        when v_has_ov or t.online or v_method = 'percent_profit' then coalesce(public.payout_line_net_base(
          l.sale_id,
          l.commission_base_cents,
          case when v_absorb then coalesce((to_jsonb(l)->>'fees_cents')::int, 0) else 0 end), 0)
        when v_method = 'flat_ticket' then 1
        else greatest(0, l.price_cents) end::numeric weight) x
      where l.store_id = p_store and l.ticket_key = p_ticket
    ) w;
  end loop;
  update public.sale_payout_tickets set computed_at = now() where store_id = p_store and ticket_key = p_ticket;
end $$;

create or replace function public.sale_commission_cents(p_store uuid, p_sale_id bigint, p_employee uuid)
returns integer
language plpgsql
stable security definer
set search_path = public
as $$
declare
  s public.sales;
  v_cost int;
  v_base int;
  v_ticket text;
  v_channel text;
  v_online_channels jsonb;
  v_online_pct numeric;
  v_online_emp uuid;
  v_online_jacob numeric := 0;
  v_is_online boolean := false;
  v_ov record;
  v_rule record;
  v_rate numeric;
  v_paul uuid := public.payout_slot_employee(p_store, 'paul');
  v_jacob uuid := public.payout_slot_employee(p_store, 'jacob');
  v_absorb boolean := coalesce((public.store_setting(p_store, 'commission_store_absorbs_fees', 'true'::jsonb) #>> '{}')::boolean, true);
begin
  if exists(select 1 from public.sale_payout_lines where sale_id = p_sale_id and store_id = p_store) then
    return coalesce((select amount_cents from public.sale_commissions
      where sale_id = p_sale_id and employee_id = p_employee), 0);
  end if;

  select * into s from public.sales where id = p_sale_id and store_id = p_store;
  if not found then return 0; end if;

  select cost_cents,
    greatest(0, price_cents + coalesce(tax_collected_cents, 0) + coalesce(shipping_cents, 0) - coalesce(channel_fee_cents, 0)
      - coalesce(ship_cost_cents, 0) - coalesce(processing_fee_cents, 0)
      - coalesce(tax_collected_cents, 0) - cost_cents
      + case when v_absorb then coalesce(channel_fee_cents, 0) + coalesce(processing_fee_cents, 0) else 0 end)
    into v_cost, v_base
  from public.sale_ledger where id = s.id;
  if v_cost is null then return null; end if;
  v_base := greatest(0, coalesce(v_base, 0) - public.payout_keep_refund_cents(s.id));
  v_ticket := coalesce(s.ticket_id::text, 'sale:' || s.id::text);
  v_channel := lower(coalesce(s.channel, ''));

  select value into v_online_channels from public.store_settings
   where store_id = p_store and key = 'online_payout_channels';
  if v_online_channels is null then
    select value into v_online_channels from public.store_settings
     where store_id = p_store and key = 'online_channels';
  end if;
  v_online_pct := coalesce((public.store_setting(p_store, 'online_payout_pct', '0'::jsonb) #>> '{}')::numeric, 0);
  v_online_jacob := coalesce((public.store_setting(p_store, 'online_jacob_pct', '0'::jsonb) #>> '{}')::numeric, 0);
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
    select t.online_pct, coalesce(t.online_jacob_pct, 0), t.online_employee_id
      into v_online_pct, v_online_jacob, v_online_emp
    from public.sale_payout_tickets t
    where t.store_id = p_store and t.ticket_key = v_ticket and t.online;
    if not found then
      v_online_pct := coalesce((public.store_setting(p_store, 'online_payout_pct', '0'::jsonb) #>> '{}')::numeric, 0);
      v_online_jacob := coalesce((public.store_setting(p_store, 'online_jacob_pct', '0'::jsonb) #>> '{}')::numeric, 0);
      begin
        v_online_emp := nullif(public.store_setting(p_store, 'online_payout_employee_id', 'null'::jsonb) #>> '{}', '')::uuid;
      exception when others then v_online_emp := null;
      end;
    end if;
    if p_employee is not distinct from v_online_emp then
      return round(v_base * v_online_pct / 100.0)::int;
    elsif p_employee is not distinct from v_jacob then
      return round(v_base * coalesce(v_online_jacob, 0) / 100.0)::int;
    else
      return 0;
    end if;
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
  return round(s.price_cents * v_rule.rate / 100.0)::int;
end $$;

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
    return jsonb_build_object('ok', true, 'keep_cents', 0);
  end if;
  v_price := greatest(coalesce(s.price_cents, 0), 0);
  v_keep := least(v_keep, case when v_price > 0 then v_price else v_keep end);
  update public.sales set buyer_keep_refund_cents = v_keep where id = s.id;
  perform public.payout_refreeze_sale(s.id);
  return jsonb_build_object('ok', true, 'keep_cents', v_keep, 'adjustments', '[]'::jsonb);
end $$;

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
    values (r.store_id, r.id, v_keep, r.channel, v_kind, true, 'Refund comes out of the commission split');
  else
    update public.return_refunds set
      amount_cents = v_keep,
      kind = v_kind,
      item_kept = true
    where return_id = r.id;
  end if;

  update public.sales set buyer_keep_refund_cents = v_keep where id = s.id;
  perform public.payout_refreeze_sale(s.id);
  perform public.return_sync_label_expense(r.id);
  return jsonb_build_object('ok', true, 'keep_cents', v_keep);
end $$;

revoke all on function public.payout_keep_refund_cents(bigint) from public, anon;
revoke all on function public.payout_line_net_base(bigint, int, int) from public, anon;
revoke all on function public.payout_refreeze_sale(bigint) from public, anon, authenticated;
grant execute on function public.payout_keep_refund_cents(bigint) to service_role;
grant execute on function public.payout_line_net_base(bigint, int, int) to service_role;
grant execute on function public.payout_refreeze_sale(bigint) to service_role;

do $$
declare r record;
begin
  for r in
    select distinct s.store_id, coalesce(s.ticket_id::text, 'sale:' || s.id::text) as ticket_key
    from public.sales s
    where s.voided_at is null and coalesce(s.buyer_keep_refund_cents, 0) > 0
  loop
    perform public.payout_refreeze_ticket(r.store_id, r.ticket_key);
  end loop;
end $$;

commit;
