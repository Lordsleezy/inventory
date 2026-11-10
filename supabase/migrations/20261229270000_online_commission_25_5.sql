-- New online sales: Paul 25% of commission profit, Jacob 5%.
-- Past sale_payout_tickets keep the online_pct they were frozen with.
-- Existing rows get online_jacob_pct 0, so Jacob stays at nothing on those sales.
-- A later fee or label sync rebuilds the ticket; the old rates are put back
-- before commission is recalculated.

begin;

alter table public.sale_payout_tickets
  add column if not exists online_jacob_pct numeric not null default 0;

insert into public.store_settings (store_id, key, value)
select s.id, 'online_payout_pct', '25'::jsonb from public.stores s
on conflict (store_id, key) do update set value = excluded.value;

insert into public.store_settings (store_id, key, value)
select s.id, 'online_jacob_pct', '5'::jsonb from public.stores s
on conflict (store_id, key) do update set value = excluded.value;

create or replace function public.payout_freeze_ticket_config(p_store uuid, p_ticket text, p_channel text, p_source text)
returns void language plpgsql security definer set search_path = public as $$
declare v_emp_text text;
begin
  v_emp_text := nullif(public.store_setting(p_store, 'online_payout_employee_id', 'null'::jsonb) #>> '{}', '');
  insert into public.sale_payout_tickets (store_id, ticket_key, channel, online, online_pct, online_jacob_pct, online_employee_id,
    rules, slots, sku_rates, source)
  values (p_store, p_ticket, lower(coalesce(p_channel, '')),
    exists(select 1 from jsonb_array_elements_text(public.store_setting(p_store, 'online_channels', '["website"]'::jsonb)) c
      where lower(c) = lower(coalesce(p_channel, ''))),
    coalesce((public.store_setting(p_store, 'online_payout_pct', '25'::jsonb) #>> '{}')::numeric, 0),
    coalesce((public.store_setting(p_store, 'online_jacob_pct', '0'::jsonb) #>> '{}')::numeric, 0),
    case when v_emp_text ~* '^[0-9a-f-]{36}$' then v_emp_text::uuid end,
    coalesce((select jsonb_agg(jsonb_build_object('employee_id', r.employee_id, 'method', r.method, 'rate', r.rate)
      order by r.employee_id) from public.portal_payout_rules r where r.store_id = p_store), '[]'::jsonb),
    coalesce((select jsonb_object_agg(p.slot, p.employee_id) from public.store_payout_people p where p.store_id = p_store), '{}'::jsonb),
    '{}'::jsonb, p_source)
  on conflict (store_id, ticket_key) do nothing;
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
    sum(l.commission_base_cents + case when v_absorb then coalesce((to_jsonb(l)->>'fees_cents')::int, 0) else 0 end),
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
            public.payout_js_round(greatest(0, l.commission_base_cents + case when v_absorb then coalesce((to_jsonb(l)->>'fees_cents')::int, 0) else 0 end)::float8
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
        when v_has_ov or t.online or v_method = 'percent_profit' then greatest(0, coalesce(l.commission_base_cents + case when v_absorb then coalesce((to_jsonb(l)->>'fees_cents')::int, 0) else 0 end, 0))
        when v_method = 'flat_ticket' then 1
        else greatest(0, l.price_cents) end::numeric weight) x
      where l.store_id = p_store and l.ticket_key = p_ticket
    ) w;
  end loop;
  update public.sale_payout_tickets set computed_at = now() where store_id = p_store and ticket_key = p_ticket;
end $$;

-- Fee and label sync deletes the snapshot and rebuilds it. Put the rates from
-- the deleted row back so an old sale does not pick up the new 25/5 split.
create or replace function public.payout_refreeze_ticket(p_store uuid, p_ticket text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
  v_online boolean;
  v_pct numeric;
  v_jacob numeric;
  v_emp uuid;
  v_had boolean := false;
begin
  if p_store is null or nullif(btrim(coalesce(p_ticket, '')), '') is null then
    return;
  end if;
  select t.online, t.online_pct, t.online_jacob_pct, t.online_employee_id
    into v_online, v_pct, v_jacob, v_emp
  from public.sale_payout_tickets t
  where t.store_id = p_store and t.ticket_key = p_ticket;
  v_had := found;

  delete from public.sale_payout_tickets where store_id = p_store and ticket_key = p_ticket;
  delete from public.sale_payout_lines where store_id = p_store and ticket_key = p_ticket;
  delete from public.sale_commissions where store_id = p_store and ticket_key = p_ticket;
  for v_id in
    select s.id
      from public.sales s
     where s.store_id = p_store
       and s.voided_at is null
       and coalesce(s.ticket_id::text, 'sale:' || s.id::text) = p_ticket
     order by s.id
  loop
    perform public.payout_snapshot_sale(v_id);
  end loop;
  if v_had then
    update public.sale_payout_tickets t
       set online = v_online,
           online_pct = v_pct,
           online_jacob_pct = coalesce(v_jacob, 0),
           online_employee_id = v_emp
     where t.store_id = p_store and t.ticket_key = p_ticket;
    perform public.payout_calc_ticket(p_store, p_ticket);
  end if;
  update public.sale_payout_tickets
     set source = 'refreeze'
   where store_id = p_store and ticket_key = p_ticket;
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

create or replace function public.portal_payout_config()
returns jsonb
language plpgsql
stable security definer
set search_path = public
as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null or not public.portal_financial_access() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return jsonb_build_object(
    'online_channels', public.store_setting(v_store,'online_channels','["website"]'::jsonb),
    'online_payout_pct', public.store_setting(v_store,'online_payout_pct','25'::jsonb),
    'online_jacob_pct', public.store_setting(v_store,'online_jacob_pct','5'::jsonb),
    'online_payout_employee_id', public.store_setting(v_store,'online_payout_employee_id','null'::jsonb),
    'absorb_fees', coalesce((public.store_setting(v_store,'commission_store_absorbs_fees','true'::jsonb) #>> '{}')::boolean, true));
end $$;

create or replace function public.portal_default_commission_split(p_store uuid, p_ticket_key text)
returns table (paul_pct numeric, jacob_pct numeric, online boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_channel text;
  v_online_pct numeric;
  v_jacob_pct numeric := 0;
  v_paul uuid := 'f17e6163-b10a-4fe1-a373-75c0094e5363'::uuid;
  v_jacob uuid := 'c851c8ee-2cc2-490f-935f-1e2d7e093d88'::uuid;
  v_paul_rate numeric := 0;
  v_jacob_rate numeric := 0;
  v_is_online boolean := false;
begin
  select lower(s.channel) into v_channel
  from public.sales s
  where s.store_id = p_store and s.voided_at is null
    and coalesce(s.ticket_id::text, 'sale:' || s.id::text) = p_ticket_key
  order by s.id
  limit 1;

  if v_channel is null then
    raise exception 'invalid_payout_ticket' using errcode = '22023';
  end if;

  v_online_pct := coalesce((public.store_setting(p_store, 'online_payout_pct', '0'::jsonb) #>> '{}')::numeric, 0);
  v_is_online := v_channel = any (public.setting_text_array(p_store, 'online_channels'));

  if v_is_online then
    select t.online_pct, coalesce(t.online_jacob_pct, 0)
      into v_online_pct, v_jacob_pct
    from public.sale_payout_tickets t
    where t.store_id = p_store and t.ticket_key = p_ticket_key and t.online;
    if not found then
      v_online_pct := coalesce((public.store_setting(p_store, 'online_payout_pct', '0'::jsonb) #>> '{}')::numeric, 0);
      v_jacob_pct := coalesce((public.store_setting(p_store, 'online_jacob_pct', '0'::jsonb) #>> '{}')::numeric, 0);
    end if;
    return query select v_online_pct, coalesce(v_jacob_pct, 0), true;
    return;
  end if;

  select coalesce(r.rate, 0) into v_paul_rate
  from public.portal_payout_rules r
  where r.store_id = p_store and r.employee_id = v_paul;

  select coalesce(r.rate, 0) into v_jacob_rate
  from public.portal_payout_rules r
  where r.store_id = p_store and r.employee_id = v_jacob;

  return query select coalesce(v_paul_rate, 0), coalesce(v_jacob_rate, 0), false;
end $$;

drop function if exists public.portal_payout_commissions();
create function public.portal_payout_commissions()
returns table (ticket_key text, employee_id uuid, amount_cents int, frozen_at timestamptz, online boolean, online_pct numeric, online_jacob_pct numeric)
language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null or not public.portal_financial_access() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  return query
    select c.ticket_key, c.employee_id,
      case when bool_or(c.amount_cents is null) then null else sum(c.amount_cents)::int end,
      max(t.frozen_at),
      bool_or(t.online),
      max(t.online_pct),
      max(coalesce(t.online_jacob_pct, 0))
    from public.sale_commissions c
    join public.sales s on s.id = c.sale_id and s.voided_at is null
    join public.sale_payout_tickets t on t.store_id = c.store_id and t.ticket_key = c.ticket_key
    where c.store_id = v_store
    group by c.ticket_key, c.employee_id;
end $$;

revoke all on function public.portal_payout_commissions() from public, anon;
grant execute on function public.portal_payout_commissions() to authenticated, service_role;

commit;
