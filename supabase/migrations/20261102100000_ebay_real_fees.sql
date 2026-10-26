-- eBay: every dollar comes from eBay, none from Floor's own math.
--  * ebay_order_fees: one row per eBay Finances charge, by fee type (final value fee, ad fee, label, ...).
--  * channel_orders.fee_cents (ledger fee) = the sum of those stored rows; ad_fee_cents is the ad part alone.
--  * The estimated eBay fee in the ledger is gone (channel_fee_estimate returns no rate for eBay).
--  * An eBay sale's commission stays "waiting on eBay fees" (frozen line with no base, every amount null)
--    until Finances has shown the sale AND the grace period (store setting ebay_fee_grace_hours, default 72)
--    has passed for late ad charges. Then the line is filled once and the ticket recomputed.
--  * payout_refresh_ebay_fees(): used only by scripts/ebay-fee-history.mjs to re-base UNPAID, already frozen
--    sales on real fees. Paid-out sales are never touched.
-- Newest previous definitions: payout_calc_ticket / payout_snapshot_sale / payout_fill_pending_cost_trigger /
-- portal_payout_commissions (20261030150000), channel_fee_estimate (20261016093000).
begin;

-- ── Stored eBay charges ─────────────────────────────────────────────────────

create table if not exists public.ebay_order_fees (
  id bigserial primary key,
  store_id uuid not null references public.stores(id) on delete cascade,
  order_id text,                       -- null = a charge eBay did not tie to an order (e.g. ad campaign charge)
  fee_type text not null,              -- FINAL_VALUE_FEE, AD_FEE, PREMIUM_AD_FEES, SHIPPING_LABEL, ...
  amount_cents int not null,           -- + = charged to us, − = credited back
  txn_id text not null,
  txn_type text not null,              -- SALE, NON_SALE_CHARGE, SHIPPING_LABEL
  txn_date timestamptz,
  line_item_id text not null default '',
  recorded_at timestamptz not null default now(),
  unique (store_id, txn_id, fee_type, line_item_id)
);
create index if not exists ix_ebay_order_fees_order on public.ebay_order_fees (store_id, order_id);
create index if not exists ix_ebay_order_fees_type_date on public.ebay_order_fees (store_id, fee_type, txn_date);
comment on table public.ebay_order_fees is
  'Real eBay Finances charges by fee type, attached to the order they belong to. Source of channel_orders.fee_cents.';

alter table public.ebay_order_fees enable row level security;
revoke all on public.ebay_order_fees from public, anon, authenticated;
grant select on public.ebay_order_fees to authenticated;
grant all on public.ebay_order_fees to service_role;
grant usage, select on sequence public.ebay_order_fees_id_seq to service_role;
drop policy if exists ebay_order_fees_admin_read on public.ebay_order_fees;
create policy ebay_order_fees_admin_read on public.ebay_order_fees for select to authenticated
  using (store_id = public.portal_store_id() and public.portal_is_admin());

alter table public.channel_orders
  add column if not exists ad_fee_cents int not null default 0,
  add column if not exists fees_synced_at timestamptz,
  add column if not exists fee_sale_txn_at timestamptz,   -- date of eBay's SALE transaction (fees are final-ish from here)
  add column if not exists fees_settled_at timestamptz;   -- grace period over: commission may freeze
comment on column public.channel_orders.fees_settled_at is
  'eBay: SALE transaction seen in Finances + ebay_fee_grace_hours elapsed. Commission is held until set.';

alter table public.sale_payout_lines
  add column if not exists fees_pending boolean not null default false;
comment on column public.sale_payout_lines.fees_pending is
  'true = frozen without a commission base because eBay fees are not final yet (amounts stay null).';

-- ── Ledger: no estimated eBay fee ───────────────────────────────────────────

create or replace function public.channel_fee_estimate(p_store uuid, p_channel text, p_price_cents int)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_rates jsonb := coalesce(public.store_setting(p_store, 'channel_fee_rates', '{}'::jsonb), '{}'::jsonb);
  v_r jsonb; v_fee int;
begin
  -- eBay fees come only from eBay (ebay_order_fees). Floor never estimates them.
  if lower(btrim(coalesce(p_channel, ''))) = 'ebay' then return null; end if;
  v_r := v_rates -> lower(btrim(coalesce(p_channel, '')));
  if v_r is null or jsonb_typeof(v_r) <> 'object' then return null; end if;
  v_fee := round(coalesce(p_price_cents, 0) * coalesce((v_r ->> 'pct')::numeric, 0) / 100.0)::int
         + coalesce((v_r ->> 'fixed_cents')::int, 0);
  v_fee := greatest(v_fee, coalesce((v_r ->> 'min_fee_cents')::int, 0), 0);
  return jsonb_build_object('fee_cents', v_fee, 'source', 'estimated');
end $$;
revoke all on function public.channel_fee_estimate(uuid, text, int) from public, anon;
grant execute on function public.channel_fee_estimate(uuid, text, int) to authenticated, service_role;

-- ── Is this eBay sale still waiting on its fees? ────────────────────────────

create or replace function public.ebay_fees_waiting(p_sale bigint)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.sales s
      where s.id = p_sale and lower(coalesce(s.channel, '')) = 'ebay' and coalesce(s.payment_id, '') like 'ebay:%')
    and not exists (select 1 from public.channel_orders co
      where co.sale_id = p_sale and co.provider = 'ebay' and co.fees_settled_at is not null);
$$;
revoke all on function public.ebay_fees_waiting(bigint) from public, anon, authenticated;
grant execute on function public.ebay_fees_waiting(bigint) to service_role;

-- ── Frozen-commission system: waiting on eBay fees ──────────────────────────
-- Same functions as 20261030150000 with three changes marked "fees_pending" / "waiting on eBay fees".

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
  select sum(price_cents), sum(commission_base_cents), bool_or(cost_cents is null or fees_pending)
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

create or replace function public.payout_snapshot_sale(p_sale_id bigint)
returns void language plpgsql security definer set search_path = public as $$
declare l record; v_ticket text; v_old text; v_pending boolean;
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
    -- eBay: fees are not final until Finances shows the sale plus the grace period. Freeze the line with
    -- no commission base so every person's amount stays null ("waiting on eBay fees") until they are.
    v_pending := public.ebay_fees_waiting(l.id);
    insert into public.sale_payout_lines
      (sale_id, store_id, ticket_key, sku, price_cents, commission_base_cents, cost_cents, cost_source, fees_pending)
    values (l.id, l.store_id, v_ticket, l.sku, coalesce(l.price_cents, 0),
      case when v_pending then null else l.commission_base_cents end, l.cost_cents, l.cost_source, v_pending);
  end if;
  update public.sale_payout_tickets t
     set sku_rates = t.sku_rates || coalesce((select jsonb_object_agg(r.sku, r.rates) from (
       select x.sku, jsonb_object_agg(x.employee_id, x.rate) rates from public.store_payout_sku_rates x
       where x.store_id = l.store_id and x.sku = l.sku group by x.sku) r), '{}'::jsonb)
   where t.store_id = l.store_id and t.ticket_key = v_ticket and not (t.sku_rates ? l.sku);
  perform public.payout_calc_ticket(l.store_id, v_ticket);
end $$;

create or replace function public.payout_fill_pending_cost_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in
    update public.sale_payout_lines pl set cost_cents = led.cost_cents, cost_source = led.cost_source,
      commission_base_cents = case when pl.fees_pending then null
        else s.price_cents + coalesce(led.tax_collected_cents, 0) + coalesce(led.shipping_cents, 0) - coalesce(led.channel_fee_cents, 0)
          - coalesce(led.ship_cost_cents, 0) - coalesce(led.processing_fee_cents, 0)
          - coalesce(led.tax_collected_cents, 0) - led.cost_cents end,
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

-- Frozen commission per ticket and person. amount_cents null = waiting on cost or on eBay fees.
drop function if exists public.portal_payout_commissions();
create function public.portal_payout_commissions()
returns table (ticket_key text, employee_id uuid, amount_cents int, frozen_at timestamptz, waiting_fees boolean)
language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return query
    select c.ticket_key, c.employee_id,
      case when bool_or(c.amount_cents is null) then null else sum(c.amount_cents)::int end,
      max(t.frozen_at),
      coalesce(bool_or(l.fees_pending), false)
    from public.sale_commissions c
    join public.sales s on s.id = c.sale_id and s.voided_at is null
    join public.sale_payout_tickets t on t.store_id = c.store_id and t.ticket_key = c.ticket_key
    join public.sale_payout_lines l on l.sale_id = c.sale_id
    where c.store_id = v_store
    group by c.ticket_key, c.employee_id;
end $$;
revoke all on function public.portal_payout_commissions() from public, anon;
grant execute on function public.portal_payout_commissions() to authenticated, service_role;

-- ── Money components of one sale, from the ledger or from explicit overrides ─

-- price + buyer shipping − channel fee − ship cost − processing  (tax is pass-through and cancels out).
-- p_fee / p_label override the ledger values (history dry-run). Cost is NOT included.
create or replace function public.ebay_commission_before_cost(p_sale bigint, p_fee int default null, p_label int default null)
returns int language sql stable security definer set search_path = public as $$
  select s.price_cents + coalesce(led.shipping_cents, 0) - coalesce(p_fee, led.channel_fee_cents, 0)
    - coalesce(p_label, led.ship_cost_cents, 0) - coalesce(led.processing_fee_cents, 0)
  from public.sales s join public.sale_ledger led on led.id = s.id where s.id = p_sale;
$$;
revoke all on function public.ebay_commission_before_cost(bigint, int, int) from public, anon, authenticated;
grant execute on function public.ebay_commission_before_cost(bigint, int, int) to service_role;

-- ── Release: fees are final, fill the held line once and compute the ticket ─

create or replace function public.payout_release_ebay_fees(p_sale bigint)
returns void language plpgsql security definer set search_path = public as $$
declare pl public.sale_payout_lines; v_before int;
begin
  select * into pl from public.sale_payout_lines where sale_id = p_sale for update;
  if not found then
    perform public.payout_snapshot_sale(p_sale); -- not frozen yet: the snapshot now sees settled fees
    return;
  end if;
  if not pl.fees_pending then return; end if;
  v_before := public.ebay_commission_before_cost(p_sale);
  update public.sale_payout_lines set
    fees_pending = false,
    frozen_at = now(),
    commission_base_cents = case when pl.cost_cents is null or v_before is null then null else v_before - pl.cost_cents end,
    pre_base_cents = case when pl.replacement_saved and pl.pre_cost_cents is not null and v_before is not null
      then v_before - pl.pre_cost_cents else pl.pre_base_cents end
  where sale_id = p_sale;
  perform public.payout_calc_ticket(pl.store_id, pl.ticket_key);
end $$;
revoke all on function public.payout_release_ebay_fees(bigint) from public, anon, authenticated;
grant execute on function public.payout_release_ebay_fees(bigint) to service_role;

-- ── Record real fees for one order ──────────────────────────────────────────
-- p_rows: [{fee_type, amount_cents, txn_id, txn_type, txn_date, line_item_id}]
-- Fees only reach the ledger once eBay's SALE transaction is known; before that the rows are stored only.

create or replace function public.ebay_record_order_fees(
  p_store uuid, p_order_id text, p_rows jsonb,
  p_sale_txn_at timestamptz default null, p_net_cents int default null,
  p_tax_cents int default null, p_label_cents int default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_fee int; v_ad int; v_sale_at timestamptz; v_co public.channel_orders;
begin
  perform public.assert_service();
  select * into v_co from public.channel_orders
   where store_id = p_store and provider = 'ebay' and order_id = p_order_id;
  if not found then return jsonb_build_object('found', false); end if;

  insert into public.ebay_order_fees (store_id, order_id, fee_type, amount_cents, txn_id, txn_type, txn_date, line_item_id)
  select p_store, p_order_id, r ->> 'fee_type', (r ->> 'amount_cents')::int, r ->> 'txn_id', r ->> 'txn_type',
    nullif(r ->> 'txn_date', '')::timestamptz, coalesce(r ->> 'line_item_id', '')
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
  on conflict (store_id, txn_id, fee_type, line_item_id) do update set
    order_id = excluded.order_id, amount_cents = excluded.amount_cents, txn_date = excluded.txn_date, recorded_at = now();

  v_sale_at := coalesce(p_sale_txn_at, v_co.fee_sale_txn_at);
  select coalesce(sum(amount_cents) filter (where fee_type <> 'SHIPPING_LABEL'), 0)::int,
         coalesce(sum(amount_cents) filter (where fee_type in ('AD_FEE', 'PREMIUM_AD_FEES')), 0)::int
    into v_fee, v_ad
  from public.ebay_order_fees where store_id = p_store and order_id = p_order_id;

  update public.channel_orders set
    fees_synced_at = now(),
    fee_sale_txn_at = v_sale_at,
    ad_fee_cents = case when v_sale_at is not null then v_ad else ad_fee_cents end,
    fee_cents = case when v_sale_at is not null then v_fee else fee_cents end,
    fee_source = case when v_sale_at is not null then 'actual' else fee_source end,
    ship_label_cents = coalesce(p_label_cents, ship_label_cents),
    ship_label_source = case when p_label_cents is not null then 'ebay' else ship_label_source end,
    tax_cents = coalesce(tax_cents, p_tax_cents),
    tax_remitted = case when p_tax_cents is not null then true else tax_remitted end,
    payout_cents = coalesce(p_net_cents, payout_cents)
  where store_id = p_store and provider = 'ebay' and order_id = p_order_id;

  return jsonb_build_object('found', true, 'sale_seen', v_sale_at is not null, 'fee_cents', v_fee, 'ad_fee_cents', v_ad);
end $$;
revoke all on function public.ebay_record_order_fees(uuid, text, jsonb, timestamptz, int, int, int) from public, anon, authenticated;
grant execute on function public.ebay_record_order_fees(uuid, text, jsonb, timestamptz, int, int, int) to service_role;

-- ── Grace period over → commission may freeze ───────────────────────────────

create or replace function public.ebay_fee_settle_due(p_store uuid, p_now timestamptz default now())
returns int language plpgsql security definer set search_path = public as $$
declare
  r record; n int := 0;
  v_grace int := greatest(0, coalesce((public.store_setting(p_store, 'ebay_fee_grace_hours', '72'::jsonb) #>> '{}')::int, 72));
begin
  perform public.assert_service();
  for r in
    update public.channel_orders co set fees_settled_at = p_now
     where co.store_id = p_store and co.provider = 'ebay' and co.fees_settled_at is null
       and co.fee_sale_txn_at is not null
       and co.fee_sale_txn_at + make_interval(hours => v_grace) <= p_now
    returning co.sale_id
  loop
    n := n + 1;
    if r.sale_id is not null then
      begin
        perform public.payout_release_ebay_fees(r.sale_id);
      exception when others then
        insert into public.payout_snapshot_errors (store_id, sale_id, error)
        values (p_store, r.sale_id, 'ebay fee release: ' || sqlerrm);
      end;
    end if;
  end loop;
  return n;
end $$;
revoke all on function public.ebay_fee_settle_due(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.ebay_fee_settle_due(uuid, timestamptz) to service_role;

-- ── History: who has already been paid how much of each sale ────────────────
-- Payments count against reimbursements first, then commission (same rule as the Payouts screen).
-- The commission pool is applied oldest sale first, per person. paid_cents > 0 = already (partly) paid out.

create or replace function public.ebay_commission_paid_status(p_store uuid)
returns table (sale_id bigint, employee_id uuid, commission_cents int, paid_cents int)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.assert_service();
  return query
  with pool as (
    select e.employee_id,
      greatest(0,
        coalesce((select sum(p.amount_cents) from public.portal_payout_payments p
                   where p.store_id = p_store and p.employee_id = e.employee_id and p.voided_at is null), 0)
        - coalesce((select sum(x.amount_cents) from public.portal_expenses x
                   where x.store_id = p_store and x.employee_id = e.employee_id
                     and x.needs_reimbursement and x.voided_at is null), 0)) as pool_cents
    from (select distinct c.employee_id from public.sale_commissions c where c.store_id = p_store) e
  ),
  ordered as (
    select c.sale_id, c.employee_id, c.amount_cents,
      sum(coalesce(c.amount_cents, 0)) over (partition by c.employee_id order by s.sold_at, s.id) as cum
    from public.sale_commissions c join public.sales s on s.id = c.sale_id and s.voided_at is null
    where c.store_id = p_store
  )
  select o.sale_id, o.employee_id, o.amount_cents,
    case when o.amount_cents is null or o.amount_cents <= 0 then 0
         else greatest(0, least(o.amount_cents, p.pool_cents - (o.cum - o.amount_cents)))::int end
  from ordered o join pool p on p.employee_id = o.employee_id;
end $$;
revoke all on function public.ebay_commission_paid_status(uuid) from public, anon, authenticated;
grant execute on function public.ebay_commission_paid_status(uuid) to service_role;

-- ── History: re-base one UNPAID frozen sale on real fees ────────────────────
-- p_dry = true computes the new amounts and rolls everything back. Returns before/after per person.
-- A sale with any commission already paid out is NEVER written: it always runs as a dry run and reports
-- status 'paid_out' with the amounts that would have changed, so they can be decided by hand.
-- p_fee / p_label override the ledger's fee / label for the preview.

create or replace function public.payout_refresh_ebay_fees(
  p_sale bigint, p_dry boolean default false, p_fee int default null, p_label int default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  pl public.sale_payout_lines; v_before_cost int; v_out jsonb := '{}'::jsonb; v_old jsonb; v_new jsonb;
  v_paid int; v_force_dry boolean;
begin
  perform public.assert_service();
  select * into pl from public.sale_payout_lines where sale_id = p_sale;
  if not found then return jsonb_build_object('status', 'not_frozen'); end if;
  select coalesce(sum(st.paid_cents), 0)::int into v_paid
    from public.ebay_commission_paid_status(pl.store_id) st where st.sale_id = p_sale;
  v_force_dry := p_dry or v_paid > 0;
  select coalesce(jsonb_object_agg(c.employee_id::text, c.amount_cents), '{}'::jsonb) into v_old
    from public.sale_commissions c where c.sale_id = p_sale;
  begin
    v_before_cost := public.ebay_commission_before_cost(p_sale, p_fee, p_label);
    update public.sale_payout_lines set
      frozen_at = now(),
      commission_base_cents = case when fees_pending or cost_cents is null or v_before_cost is null then null
                                   else v_before_cost - cost_cents end,
      pre_base_cents = case when replacement_saved and pre_cost_cents is not null and v_before_cost is not null
                            then v_before_cost - pre_cost_cents else pre_base_cents end
    where sale_id = p_sale;
    perform public.payout_calc_ticket(pl.store_id, pl.ticket_key);
    select coalesce(jsonb_object_agg(c.employee_id::text, c.amount_cents), '{}'::jsonb) into v_new
      from public.sale_commissions c where c.sale_id = p_sale;
    v_out := jsonb_build_object(
      'status', case when v_paid > 0 then 'paid_out' when p_dry then 'dry_run' else 'updated' end,
      'paid_cents', v_paid, 'before', v_old, 'after', v_new);
    if v_force_dry then raise exception 'dry_run_rollback'; end if;
  exception when raise_exception then
    if sqlerrm <> 'dry_run_rollback' then raise; end if;
  end;
  return v_out;
end $$;
revoke all on function public.payout_refresh_ebay_fees(bigint, boolean, int, int) from public, anon, authenticated;
grant execute on function public.payout_refresh_ebay_fees(bigint, boolean, int, int) to service_role;

-- ── Reports → Shipping & fees: eBay ad fees on their own ────────────────────
-- attached = ad charges on sales sold in the window (already inside the eBay fee total);
-- unattached = ad charges eBay did not tie to an order (the sync books debits as eBay overhead expenses, which the
-- Reports fee total already includes).

create or replace function public.portal_ebay_ad_fee_report(p_start date, p_end date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_from timestamptz; v_to timestamptz; v_attached int; v_orders int; v_unattached int; v_by jsonb;
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  v_from := p_start::timestamp at time zone 'America/Los_Angeles';
  v_to := p_end::timestamp at time zone 'America/Los_Angeles';
  select coalesce(sum(co.ad_fee_cents), 0)::int, count(*) filter (where co.ad_fee_cents <> 0)::int
    into v_attached, v_orders
  from public.channel_orders co join public.sales s on s.id = co.sale_id
  where co.store_id = v_store and co.provider = 'ebay' and s.voided_at is null
    and s.sold_at >= v_from and s.sold_at < v_to;
  select coalesce(sum(f.amount_cents), 0)::int into v_unattached
  from public.ebay_order_fees f
  where f.store_id = v_store and f.order_id is null and f.fee_type in ('AD_FEE', 'PREMIUM_AD_FEES')
    and f.txn_date >= v_from and f.txn_date < v_to;
  select coalesce(jsonb_agg(jsonb_build_object('fee_type', t.fee_type, 'cents', t.cents) order by t.cents desc), '[]'::jsonb)
    into v_by
  from (
    select f.fee_type, sum(f.amount_cents)::int cents
    from public.ebay_order_fees f
    join public.channel_orders co on co.store_id = f.store_id and co.provider = 'ebay' and co.order_id = f.order_id
    join public.sales s on s.id = co.sale_id and s.voided_at is null
    where f.store_id = v_store and s.sold_at >= v_from and s.sold_at < v_to and f.fee_type <> 'SHIPPING_LABEL'
    group by f.fee_type
  ) t;
  return jsonb_build_object('attached_cents', v_attached, 'orders_with_ad_fee', v_orders,
    'unattached_cents', v_unattached, 'ad_fee_cents', v_attached + v_unattached, 'by_type', v_by);
end $$;
revoke all on function public.portal_ebay_ad_fee_report(date, date) from public, anon;
grant execute on function public.portal_ebay_ad_fee_report(date, date) to authenticated, service_role;

commit;
