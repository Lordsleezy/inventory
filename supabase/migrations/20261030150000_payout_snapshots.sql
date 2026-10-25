-- Payouts in the database (FLOOR-PROBLEMS #6).
-- Commission per person is computed in SQL with the exact rules of apps/admin/src/payouts.ts and frozen
-- per sale line when the sale is recorded, so later cost/rule edits never change past payouts.
--  * People (override slots) and per-SKU in-store rates move from payouts.ts into per-store tables.
--  * Frozen inputs: sale_payout_tickets (rules/online config/slots/SKU rates at sale time) +
--    sale_payout_lines (price and resolved cost at sale time). Output: sale_commissions (per line, per person).
--  * Only exceptions that re-run the math: a line frozen without a real cost is filled once when the real unit cost
--    is first entered; a per-sale override (portal_commission_overrides) re-runs on the frozen inputs;
--    an owner can explicitly re-freeze one sale with portal_payout_refreeze().
--  * Returns keep the existing adjustment flow (return_apply_commission_clawbacks) but read frozen amounts.
-- Newest previous definitions: sale_commission_cents (20261021035021), return_apply_commission_clawbacks
-- (20261021034909).
begin;

create table if not exists public.store_payout_people (
  store_id uuid not null references public.stores(id) on delete cascade,
  slot text not null check (slot in ('paul', 'jacob')),
  employee_id uuid not null references auth.users(id),
  primary key (store_id, slot),
  unique (store_id, employee_id)
);
comment on table public.store_payout_people is
  'Who fills each per-sale override column of portal_commission_overrides (paul_pct / jacob_pct).';

create table if not exists public.store_payout_sku_rates (
  store_id uuid not null references public.stores(id) on delete cascade,
  sku text not null,
  employee_id uuid not null references auth.users(id),
  rate numeric(10,2) not null check (rate >= 0 and rate <= 100),
  primary key (store_id, sku, employee_id)
);
comment on table public.store_payout_sku_rates is
  'In-store percent-of-(sale − cost) rate for one SKU and person (replaces IN_STORE_SKU_PROFIT_OVERRIDES).';

create table if not exists public.sale_payout_tickets (
  store_id uuid not null references public.stores(id) on delete cascade,
  ticket_key text not null,
  channel text not null,
  online boolean not null,
  online_pct numeric not null,
  online_employee_id uuid,
  rules jsonb not null,
  slots jsonb not null,
  sku_rates jsonb not null,
  source text not null check (source in ('sale', 'backfill', 'refreeze')),
  frozen_at timestamptz not null default now(),
  computed_at timestamptz not null default now(),
  primary key (store_id, ticket_key)
);

create table if not exists public.sale_payout_lines (
  sale_id bigint primary key references public.sales(id) on delete cascade,
  store_id uuid not null,
  ticket_key text not null,
  sku text not null,
  price_cents int not null,
  commission_base_cents int,
  cost_cents int,
  cost_source text,
  frozen_at timestamptz not null default now(),
  foreign key (store_id, ticket_key) references public.sale_payout_tickets(store_id, ticket_key)
    on delete cascade on update cascade
);
create index if not exists ix_sale_payout_lines_ticket on public.sale_payout_lines (store_id, ticket_key);
create index if not exists ix_sale_payout_lines_pending on public.sale_payout_lines (store_id, sku)
  where cost_cents is null or cost_source = 'default';

create table if not exists public.sale_commissions (
  sale_id bigint not null references public.sale_payout_lines(sale_id) on delete cascade,
  store_id uuid not null,
  ticket_key text not null,
  employee_id uuid not null,
  amount_cents int,
  computed_at timestamptz not null default now(),
  primary key (sale_id, employee_id)
);
comment on column public.sale_commissions.amount_cents is 'null = cost missing; filled when the cost is first entered.';
create index if not exists ix_sale_commissions_ticket on public.sale_commissions (store_id, ticket_key);
create index if not exists ix_sale_commissions_employee on public.sale_commissions (store_id, employee_id);

create table if not exists public.payout_snapshot_errors (
  id bigserial primary key,
  store_id uuid,
  sale_id bigint,
  ticket_key text,
  error text not null,
  created_at timestamptz not null default now()
);

-- Preserve an explicit review list before removing the historic category/default cost fallback below.
create table if not exists public.sale_payout_cost_flags (
  sale_id bigint primary key references public.sales(id) on delete cascade,
  store_id uuid not null,
  ticket_key text not null,
  sku text not null,
  qty int not null,
  unit_cost_cents int not null check (unit_cost_cents in (900, 25000, 30000)),
  cost_source text,
  flagged_at timestamptz not null default now(),
  confirmed_at timestamptz,
  confirmed_by uuid references auth.users(id)
);

alter table public.store_payout_people enable row level security;
alter table public.store_payout_sku_rates enable row level security;
alter table public.sale_payout_tickets enable row level security;
alter table public.sale_payout_lines enable row level security;
alter table public.sale_commissions enable row level security;
alter table public.payout_snapshot_errors enable row level security;
alter table public.sale_payout_cost_flags enable row level security;

drop policy if exists store_payout_people_admin on public.store_payout_people;
create policy store_payout_people_admin on public.store_payout_people for all to authenticated
  using (store_id = public.portal_store_id() and public.portal_is_admin())
  with check (store_id = public.portal_store_id() and public.portal_is_admin());
drop policy if exists store_payout_sku_rates_admin on public.store_payout_sku_rates;
create policy store_payout_sku_rates_admin on public.store_payout_sku_rates for all to authenticated
  using (store_id = public.portal_store_id() and public.portal_is_admin())
  with check (store_id = public.portal_store_id() and public.portal_is_admin());
drop policy if exists sale_payout_tickets_admin_read on public.sale_payout_tickets;
create policy sale_payout_tickets_admin_read on public.sale_payout_tickets for select to authenticated
  using (store_id = public.portal_store_id() and public.portal_is_admin());
drop policy if exists sale_payout_lines_admin_read on public.sale_payout_lines;
create policy sale_payout_lines_admin_read on public.sale_payout_lines for select to authenticated
  using (store_id = public.portal_store_id() and public.portal_is_admin());
drop policy if exists sale_commissions_admin_read on public.sale_commissions;
create policy sale_commissions_admin_read on public.sale_commissions for select to authenticated
  using (store_id = public.portal_store_id() and public.portal_is_admin());
drop policy if exists payout_snapshot_errors_admin_read on public.payout_snapshot_errors;
create policy payout_snapshot_errors_admin_read on public.payout_snapshot_errors for select to authenticated
  using (store_id = public.portal_store_id() and public.portal_is_admin());
drop policy if exists sale_payout_cost_flags_admin on public.sale_payout_cost_flags;
create policy sale_payout_cost_flags_admin on public.sale_payout_cost_flags for all to authenticated
  using (store_id = public.portal_store_id() and public.portal_is_admin())
  with check (store_id = public.portal_store_id() and public.portal_is_admin());

revoke all on public.store_payout_people, public.store_payout_sku_rates, public.sale_payout_tickets,
  public.sale_payout_lines, public.sale_commissions, public.payout_snapshot_errors, public.sale_payout_cost_flags from public, anon;
revoke all on public.sale_payout_tickets, public.sale_payout_lines, public.sale_commissions,
  public.payout_snapshot_errors from authenticated;
grant select, insert, update, delete on public.store_payout_people, public.store_payout_sku_rates to authenticated;
grant update on public.sale_payout_cost_flags to authenticated;
grant select on public.sale_payout_tickets, public.sale_payout_lines, public.sale_commissions,
  public.payout_snapshot_errors, public.sale_payout_cost_flags to authenticated;
grant all on public.store_payout_people, public.store_payout_sku_rates, public.sale_payout_tickets,
  public.sale_payout_lines, public.sale_commissions, public.payout_snapshot_errors, public.sale_payout_cost_flags to service_role;
grant usage, select on sequence public.payout_snapshot_errors_id_seq to service_role;

-- Seed people + SKU rates from the values that were hardcoded in apps/admin/src/payouts.ts, for every
-- store where those two users are staff.
insert into public.store_payout_people (store_id, slot, employee_id)
select st.store_id, v.slot, v.employee_id
from (values ('paul', 'f17e6163-b10a-4fe1-a373-75c0094e5363'::uuid),
             ('jacob', 'c851c8ee-2cc2-490f-935f-1e2d7e093d88'::uuid)) v(slot, employee_id)
join public.staff st on st.user_id = v.employee_id and st.store_id is not null
on conflict do nothing;

insert into public.store_payout_sku_rates (store_id, sku, employee_id, rate)
select p.store_id, v.sku, p.employee_id, v.rate
from (values
  ('11314', 'jacob', 25), ('11314', 'paul', 5),
  ('11386', 'jacob', 20), ('11386', 'paul', 10),
  ('11415', 'jacob', 20), ('11415', 'paul', 10),
  ('11522', 'jacob', 25), ('11522', 'paul', 5),
  ('99694', 'jacob', 0),  ('99694', 'paul', 30),
  ('11629', 'jacob', 20), ('11629', 'paul', 10),
  ('99695', 'jacob', 20), ('99695', 'paul', 10)
) v(sku, slot, rate)
join public.store_payout_people p on p.slot = v.slot
on conflict do nothing;

-- Flag every currently resolved sold unit cost that matches one of the retired defaults.
insert into public.sale_payout_cost_flags
  (sale_id, store_id, ticket_key, sku, qty, unit_cost_cents, cost_source)
select l.id, l.store_id, coalesce(l.ticket_id::text, 'sale:' || l.id::text), l.sku,
  greatest(coalesce(l.qty, 1), 1), l.cost_unit_cents, l.cost_source
from public.sale_ledger l
where l.voided_at is null and l.cost_unit_cents in (900, 25000, 30000)
on conflict (sale_id) do nothing;

-- Retire all inferred category/other defaults. Only a recorded unit acquisition cost or an
-- explicitly marked collectible (real zero cost) is a payout cost from this point forward.
create or replace function public.unit_cost_json(p_store uuid, p_category text, p_collectible boolean, p_acq int)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if coalesce(p_collectible, false) then return jsonb_build_object('cost_cents', 0, 'source', 'collectible'); end if;
  if p_acq is not null then return jsonb_build_object('cost_cents', p_acq, 'source', 'unit'); end if;
  return jsonb_build_object('cost_cents', null, 'source', 'missing');
end $$;
revoke all on function public.unit_cost_json(uuid, text, boolean, int) from public, anon;
grant execute on function public.unit_cost_json(uuid, text, boolean, int) to authenticated, service_role;

create or replace function public.payout_slot_employee(p_store uuid, p_slot text)
returns uuid language sql stable security definer set search_path = public as $$
  select employee_id from public.store_payout_people where store_id = p_store and slot = p_slot;
$$;

-- JavaScript Math.round(base * rate / 100) evaluated in double precision, as payouts.ts does.
create or replace function public.payout_js_round(p_value double precision)
returns int language sql immutable as $$ select floor(p_value + 0.5)::int $$;

-- Ticket-level amount exactly as payouts.ts payout(); null = cannot be calculated (cost missing).
-- Then split across the ticket's lines (cumulative rounding, so lines sum to the ticket amount).
create or replace function public.payout_calc_ticket(p_store uuid, p_ticket text)
returns void language plpgsql security definer set search_path = public as $$
declare
  t public.sale_payout_tickets;
  v_ov public.portal_commission_overrides;
  v_has_ov boolean;
  v_sub bigint; v_cost_null boolean; v_base bigint;
  v_emp uuid; v_method text; v_rate numeric; v_amt int; v_touched boolean;
  v_emps uuid[];
begin
  select * into t from public.sale_payout_tickets where store_id = p_store and ticket_key = p_ticket;
  if not found then return; end if;
  delete from public.sale_commissions where store_id = p_store and ticket_key = p_ticket;
  select sum(price_cents), sum(commission_base_cents), bool_or(cost_cents is null)
    into v_sub, v_base, v_cost_null
  from public.sale_payout_lines where store_id = p_store and ticket_key = p_ticket;
  if v_sub is null then return; end if;
  if v_cost_null then v_base := null; end if;
  select * into v_ov from public.portal_commission_overrides where store_id = p_store and ticket_key = p_ticket;
  v_has_ov := found;

  select array_agg(distinct e) into v_emps from (
    select (r->>'employee_id')::uuid e from jsonb_array_elements(t.rules) r
    union select t.online_employee_id) x where e is not null;

  foreach v_emp in array coalesce(v_emps, '{}') loop
    select r->>'method', (r->>'rate')::numeric into v_method, v_rate
      from jsonb_array_elements(t.rules) r where (r->>'employee_id')::uuid = v_emp limit 1;
    if v_method is null then v_method := 'percent_sale'; v_rate := 0; end if; -- online recipient without a rule
    v_touched := false;
    if v_cost_null then
      v_amt := null;
    elsif v_has_ov then
      v_rate := case when v_emp = (t.slots->>'paul')::uuid then v_ov.paul_pct
                     when v_emp = (t.slots->>'jacob')::uuid then v_ov.jacob_pct else 0 end;
      v_amt := case when v_base is null then null
                    else public.payout_js_round(greatest(0, v_base)::float8 * v_rate::float8 / 100) end;
    elsif t.online then
      v_amt := case when v_emp is distinct from t.online_employee_id then 0
                    when v_base is null then null
                    else public.payout_js_round(greatest(0, v_base)::float8 * t.online_pct::float8 / 100) end;
    elsif v_method = 'flat_ticket' then
      v_amt := public.payout_js_round(v_rate::float8 * 100);
    elsif v_method = 'percent_profit' then
      select exists(select 1 from public.sale_payout_lines l where l.store_id = p_store and l.ticket_key = p_ticket
        and t.sku_rates->l.sku ? v_emp::text) into v_touched;
      if v_touched then
        if v_base is null then v_amt := null;
        else
          -- Per-line rates: each line gets its own amount (payouts.ts sums per-line rounded amounts).
          insert into public.sale_commissions (sale_id, store_id, ticket_key, employee_id, amount_cents)
          select l.sale_id, p_store, p_ticket, v_emp,
            public.payout_js_round(greatest(0, l.commission_base_cents)::float8
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
        when v_has_ov or t.online or v_method = 'percent_profit' then greatest(0, coalesce(l.commission_base_cents, 0))
        when v_method = 'flat_ticket' then 1
        else greatest(0, l.price_cents) end::numeric weight) x
      where l.store_id = p_store and l.ticket_key = p_ticket
    ) w;
  end loop;
  update public.sale_payout_tickets set computed_at = now() where store_id = p_store and ticket_key = p_ticket;
end $$;

create or replace function public.payout_freeze_ticket_config(p_store uuid, p_ticket text, p_channel text, p_source text)
returns void language plpgsql security definer set search_path = public as $$
declare v_emp_text text;
begin
  v_emp_text := nullif(public.store_setting(p_store, 'online_payout_employee_id', 'null'::jsonb) #>> '{}', '');
  insert into public.sale_payout_tickets (store_id, ticket_key, channel, online, online_pct, online_employee_id,
    rules, slots, sku_rates, source)
  values (p_store, p_ticket, lower(coalesce(p_channel, '')),
    exists(select 1 from jsonb_array_elements_text(public.store_setting(p_store, 'online_channels', '["website"]'::jsonb)) c
      where lower(c) = lower(coalesce(p_channel, ''))),
    coalesce((public.store_setting(p_store, 'online_payout_pct', '30'::jsonb) #>> '{}')::numeric, 0),
    case when v_emp_text ~* '^[0-9a-f-]{36}$' then v_emp_text::uuid end,
    coalesce((select jsonb_agg(jsonb_build_object('employee_id', r.employee_id, 'method', r.method, 'rate', r.rate)
      order by r.employee_id) from public.portal_payout_rules r where r.store_id = p_store), '[]'::jsonb),
    coalesce((select jsonb_object_agg(p.slot, p.employee_id) from public.store_payout_people p where p.store_id = p_store), '{}'::jsonb),
    '{}'::jsonb, p_source)
  on conflict (store_id, ticket_key) do nothing;
end $$;

-- Freeze one sale line (price + resolved cost now) into its ticket and recompute the ticket.
create or replace function public.payout_snapshot_sale(p_sale_id bigint)
returns void language plpgsql security definer set search_path = public as $$
declare l record; v_ticket text; v_old text;
begin
  select s.id, s.store_id, s.sku, s.channel, s.price_cents, s.ticket_id, s.voided_at,
    led.cost_cents, led.cost_source,
    s.price_cents + coalesce(led.tax_collected_cents, 0) + coalesce(led.shipping_cents, 0) - coalesce(led.channel_fee_cents, 0)
      - coalesce(led.ship_cost_cents, 0) - coalesce(led.processing_fee_cents, 0)
      - coalesce(led.tax_collected_cents, 0) - led.cost_cents as commission_base_cents
    into l
  from public.sales s join public.sale_ledger led on led.id = s.id where s.id = p_sale_id;
  if not found then return; end if;
  v_ticket := coalesce(l.ticket_id::text, 'sale:' || l.id::text);
  select ticket_key into v_old from public.sale_payout_lines where sale_id = l.id;
  if v_old is not null and v_old = v_ticket then return; end if; -- already frozen
  perform public.payout_freeze_ticket_config(l.store_id, v_ticket, l.channel, 'sale');
  if v_old is not null then
    update public.sale_payout_lines set ticket_key = v_ticket where sale_id = l.id;
    update public.sale_commissions set ticket_key = v_ticket where sale_id = l.id;
    perform public.payout_calc_ticket(l.store_id, v_old);
    delete from public.sale_payout_tickets t where t.store_id = l.store_id and t.ticket_key = v_old
      and not exists(select 1 from public.sale_payout_lines x where x.store_id = t.store_id and x.ticket_key = t.ticket_key);
  else
    if l.voided_at is not null then return; end if;
    insert into public.sale_payout_cost_flags
      (sale_id, store_id, ticket_key, sku, qty, unit_cost_cents, cost_source)
    select led.id, led.store_id, coalesce(led.ticket_id::text, 'sale:' || led.id::text), led.sku,
      greatest(coalesce(led.qty, 1), 1), led.cost_unit_cents, led.cost_source
    from public.sale_ledger led where led.id = l.id and led.cost_unit_cents in (900, 25000, 30000)
    on conflict (sale_id) do nothing;
    insert into public.sale_payout_lines
      (sale_id, store_id, ticket_key, sku, price_cents, commission_base_cents, cost_cents, cost_source)
    values (l.id, l.store_id, v_ticket, l.sku, coalesce(l.price_cents, 0), l.commission_base_cents, l.cost_cents, l.cost_source);
  end if;
  update public.sale_payout_tickets t
     set sku_rates = t.sku_rates || coalesce((select jsonb_object_agg(r.sku, r.rates) from (
       select x.sku, jsonb_object_agg(x.employee_id, x.rate) rates from public.store_payout_sku_rates x
       where x.store_id = l.store_id and x.sku = l.sku group by x.sku) r), '{}'::jsonb)
   where t.store_id = l.store_id and t.ticket_key = v_ticket and not (t.sku_rates ? l.sku);
  perform public.payout_calc_ticket(l.store_id, v_ticket);
end $$;

create or replace function public.payout_sales_snapshot_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  begin
    perform public.payout_snapshot_sale(new.id);
  exception when others then
    insert into public.payout_snapshot_errors (store_id, sale_id, ticket_key, error)
    values (new.store_id, new.id, coalesce(new.ticket_id::text, 'sale:' || new.id::text), sqlerrm);
  end;
  return null;
end $$;

-- Real cost entered later: fill only lines frozen without one (no cost, or a category-default estimate).
-- Lines frozen with a real unit/collectible cost never change.
create or replace function public.payout_fill_pending_cost_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in
    update public.sale_payout_lines pl set cost_cents = led.cost_cents, cost_source = led.cost_source,
      commission_base_cents = s.price_cents + coalesce(led.tax_collected_cents, 0) + coalesce(led.shipping_cents, 0) - coalesce(led.channel_fee_cents, 0)
        - coalesce(led.ship_cost_cents, 0) - coalesce(led.processing_fee_cents, 0)
        - coalesce(led.tax_collected_cents, 0) - led.cost_cents,
      frozen_at = now()
    from public.sale_ledger led
    join public.sales s on s.id = led.id
    where pl.store_id = new.store_id and pl.sku = new.sku
      and (pl.cost_cents is null or pl.cost_source = 'default')
      and led.id = pl.sale_id and led.cost_cents is not null
      and (pl.cost_cents is null or led.cost_source in ('unit', 'collectible'))
    returning pl.store_id, pl.ticket_key
  loop
    perform public.payout_calc_ticket(r.store_id, r.ticket_key);
  end loop;
  insert into public.sale_payout_cost_flags
    (sale_id, store_id, ticket_key, sku, qty, unit_cost_cents, cost_source)
  select led.id, led.store_id, coalesce(led.ticket_id::text, 'sale:' || led.id::text), led.sku,
    greatest(coalesce(led.qty, 1), 1), led.cost_unit_cents, led.cost_source
  from public.sale_ledger led
  where led.store_id = new.store_id and led.sku = new.sku and led.voided_at is null
    and led.cost_unit_cents in (900, 25000, 30000)
  on conflict (sale_id) do nothing;
  return null;
exception when others then
  insert into public.payout_snapshot_errors (store_id, error) values (new.store_id, 'fill cost ' || new.sku || ': ' || sqlerrm);
  return null;
end $$;

create or replace function public.payout_override_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_store uuid := coalesce(new.store_id, old.store_id); v_ticket text := coalesce(new.ticket_key, old.ticket_key);
begin
  perform public.payout_calc_ticket(v_store, v_ticket);
  return null;
end $$;

-- Owner re-freezes one sale with today's cost and rules (explicit correction).
create or replace function public.portal_payout_refreeze(p_ticket_key text)
returns void language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id(); v_id bigint;
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  delete from public.sale_payout_tickets where store_id = v_store and ticket_key = p_ticket_key;
  delete from public.sale_payout_lines where store_id = v_store and ticket_key = p_ticket_key;
  for v_id in select id from public.sales where store_id = v_store and voided_at is null
    and coalesce(ticket_id::text, 'sale:' || id::text) = p_ticket_key order by id loop
    perform public.payout_snapshot_sale(v_id);
  end loop;
  update public.sale_payout_tickets set source = 'refreeze' where store_id = v_store and ticket_key = p_ticket_key;
end $$;

-- Frozen commission per ticket and person (non-voided lines). amount_cents null = waiting on cost.
create or replace function public.portal_payout_commissions()
returns table (ticket_key text, employee_id uuid, amount_cents int, frozen_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return query
    select c.ticket_key, c.employee_id,
      case when bool_or(c.amount_cents is null) then null else sum(c.amount_cents)::int end,
      max(t.frozen_at)
    from public.sale_commissions c
    join public.sales s on s.id = c.sale_id and s.voided_at is null
    join public.sale_payout_tickets t on t.store_id = c.store_id and t.ticket_key = c.ticket_key
    where c.store_id = v_store
    group by c.ticket_key, c.employee_id;
end $$;

-- Totals per person, for verification (same numbers the Payouts screen sums).
create or replace function public.payout_commission_totals(p_store uuid)
returns table (employee_id uuid, commission_cents bigint, pending_tickets bigint)
language sql stable security definer set search_path = public as $$
  select x.employee_id, coalesce(sum(x.amount), 0)::bigint, count(*) filter (where x.amount is null)
  from (
    select c.ticket_key, c.employee_id,
      case when bool_or(c.amount_cents is null) then null else sum(c.amount_cents) end amount
    from public.sale_commissions c join public.sales s on s.id = c.sale_id and s.voided_at is null
    where c.store_id = p_store group by c.ticket_key, c.employee_id
  ) x group by x.employee_id;
$$;

-- Returns read the frozen amount; sales without a snapshot (voided before this migration) keep the
-- previous formula.
create or replace function public.sale_commission_cents(
  p_store uuid,
  p_sale_id bigint,
  p_employee uuid
) returns int language plpgsql stable security definer set search_path = public as $$
declare
  s public.sales;
  v_cost int;
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
  v_paul uuid := public.payout_slot_employee(p_store, 'paul');
  v_jacob uuid := public.payout_slot_employee(p_store, 'jacob');
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
      - coalesce(tax_collected_cents, 0) - cost_cents)
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
  return round(s.price_cents * v_rule.rate / 100.0)::int;
end $$;

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
  v_paul uuid;
  v_jacob uuid;
  v_online_emp uuid;
begin
  select * into r from public.returns where id = p_return_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'return_not_found'); end if;
  if r.sale_id is null then return jsonb_build_object('ok', true, 'adjustments', '[]'::jsonb, 'note', 'no_sale'); end if;

  select * into s from public.sales where id = r.sale_id and store_id = r.store_id;
  if not found then return jsonb_build_object('ok', true, 'adjustments', '[]'::jsonb, 'note', 'sale_missing'); end if;

  v_ticket := coalesce(s.ticket_id::text, 'sale:' || s.id::text);
  v_paul := public.payout_slot_employee(r.store_id, 'paul');
  v_jacob := public.payout_slot_employee(r.store_id, 'jacob');
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


-- Backfill: freeze every non-voided sale with today's costs, rules and overrides, i.e. exactly the
-- inputs the Payouts screen uses right now.
do $$
declare r record;
begin
  for r in
    select distinct on (s.store_id, coalesce(s.ticket_id::text, 'sale:' || s.id::text))
      s.store_id, coalesce(s.ticket_id::text, 'sale:' || s.id::text) ticket_key, s.channel
    from public.sales s where s.voided_at is null
    order by s.store_id, coalesce(s.ticket_id::text, 'sale:' || s.id::text), s.id
  loop
    perform public.payout_freeze_ticket_config(r.store_id, r.ticket_key, r.channel, 'backfill');
  end loop;
  insert into public.sale_payout_lines
    (sale_id, store_id, ticket_key, sku, price_cents, commission_base_cents, cost_cents, cost_source)
  select l.id, l.store_id, coalesce(l.ticket_id::text, 'sale:' || l.id::text), l.sku, coalesce(l.price_cents, 0),
    l.price_cents + coalesce(l.tax_collected_cents, 0) + coalesce(l.shipping_cents, 0) - coalesce(l.channel_fee_cents, 0)
      - coalesce(l.ship_cost_cents, 0) - coalesce(l.processing_fee_cents, 0)
      - coalesce(l.tax_collected_cents, 0) - l.cost_cents,
    l.cost_cents, l.cost_source
  from public.sale_ledger l where l.voided_at is null
  on conflict (sale_id) do nothing;
  update public.sale_payout_tickets t set sku_rates = coalesce((
    select jsonb_object_agg(x.sku, x.rates) from (
      select sr.sku, jsonb_object_agg(sr.employee_id, sr.rate) rates from public.store_payout_sku_rates sr
      where sr.store_id = t.store_id and exists(select 1 from public.sale_payout_lines l
        where l.store_id = t.store_id and l.ticket_key = t.ticket_key and l.sku = sr.sku)
      group by sr.sku) x), '{}'::jsonb)
  where t.source = 'backfill';
  for r in select store_id, ticket_key from public.sale_payout_tickets where source = 'backfill' loop
    perform public.payout_calc_ticket(r.store_id, r.ticket_key);
  end loop;
end $$;

drop trigger if exists payout_sales_snapshot on public.sales;
create constraint trigger payout_sales_snapshot
  after insert or update of ticket_id on public.sales
  deferrable initially deferred
  for each row execute function public.payout_sales_snapshot_trigger();

drop trigger if exists payout_fill_pending_cost on public.units;
create trigger payout_fill_pending_cost
  after update of acquisition_cost_cents, is_collectible, category on public.units
  for each row
  when (old.acquisition_cost_cents is distinct from new.acquisition_cost_cents
     or old.is_collectible is distinct from new.is_collectible
     or old.category is distinct from new.category)
  execute function public.payout_fill_pending_cost_trigger();

drop trigger if exists payout_override_recalc on public.portal_commission_overrides;
create trigger payout_override_recalc
  after insert or update or delete on public.portal_commission_overrides
  for each row execute function public.payout_override_trigger();

revoke all on function public.payout_slot_employee(uuid, text) from public, anon, authenticated;
revoke all on function public.payout_js_round(double precision) from public, anon;
revoke all on function public.payout_calc_ticket(uuid, text) from public, anon, authenticated;
revoke all on function public.payout_freeze_ticket_config(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.payout_snapshot_sale(bigint) from public, anon, authenticated;
revoke all on function public.payout_sales_snapshot_trigger() from public, anon, authenticated;
revoke all on function public.payout_fill_pending_cost_trigger() from public, anon, authenticated;
revoke all on function public.payout_override_trigger() from public, anon, authenticated;
revoke all on function public.payout_commission_totals(uuid) from public, anon, authenticated;
revoke all on function public.portal_payout_refreeze(text) from public, anon;
revoke all on function public.portal_payout_commissions() from public, anon;
revoke all on function public.sale_commission_cents(uuid, bigint, uuid) from public, anon, authenticated;
grant execute on function public.payout_slot_employee(uuid, text) to service_role;
grant execute on function public.payout_calc_ticket(uuid, text) to service_role;
grant execute on function public.payout_snapshot_sale(bigint) to service_role;
grant execute on function public.payout_commission_totals(uuid) to service_role;
grant execute on function public.portal_payout_refreeze(text) to authenticated, service_role;
grant execute on function public.portal_payout_commissions() to authenticated, service_role;
grant execute on function public.sale_commission_cents(uuid, bigint, uuid) to service_role;
commit;
