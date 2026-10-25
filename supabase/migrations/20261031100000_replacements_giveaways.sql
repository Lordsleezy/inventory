-- Replacements and giveaways: units that leave the store without a sale.
--  * Replacement: a bad unit is swapped for another. The replacement unit's COST (+ any extra cost) comes off the
--    ORIGINAL sale's profit; its frozen commission is recomputed on the lower base. If that commission was already
--    paid out, a negative payout adjustment is added (payout history is never rewritten).
--  * Giveaway: the unit's COST posts as a store expense in the "Giveaways" category. No commission impact.
--  * Neither is a sale: no revenue, no sales tax. The unit leaves stock (state replaced / given_away) and is delisted.
--  * Undo (admins only) reverses both; a paid-out adjustment is countered with an opposite adjustment row.
-- Costs are always read live from the unit (no defaults). Missing cost => replacement payout waits / giveaway shows
-- "cost missing" until a cost is entered.
-- Newest previous definitions: sale_ledger (live baseline), payout_calc_ticket (20261030150000).
begin;

-- ── New stock states + expense source ──────────────────────────────────────

alter table public.units drop constraint if exists units_state_check;
alter table public.units add constraint units_state_check
  check (state in ('available', 'reserved', 'repair', 'sold', 'voided', 'scrapped', 'lost', 'replaced', 'given_away'));

alter table public.portal_expenses drop constraint if exists portal_expenses_source_check;
alter table public.portal_expenses add constraint portal_expenses_source_check
  check (source in ('manual', 'label', 'manual_label', 'ebay', 'return', 'amazon', 'channel', 'giveaway'));

alter table public.portal_payout_adjustments add column if not exists replacement_id uuid;
-- Delist tasks for units that left without a sale have no sale (already nullable on live; fresh replays skip that file).
alter table public.delist_tasks alter column sale_id drop not null;

-- ── Tables ─────────────────────────────────────────────────────────────────

create table if not exists public.unit_dispositions (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  kind text not null check (kind in ('replacement', 'giveaway')),
  sku text not null,                        -- the unit that left stock
  prior_state text not null,
  original_sale_id bigint references public.sales(id),
  original_sku text,
  extra_cost_cents int not null default 0 check (extra_cost_cents >= 0),
  bad_unit_status text check (bad_unit_status in ('returned', 'pending')),
  bad_unit_sku text,
  given_to text,
  note text,
  expense_id uuid,
  recorded_by uuid,
  recorded_by_name text,
  created_at timestamptz not null default now(),
  undone_at timestamptz,
  undone_by uuid,
  undone_by_name text,
  check ((kind = 'replacement') = (original_sale_id is not null)),
  check (kind <> 'giveaway' or nullif(btrim(coalesce(given_to, '')), '') is not null)
);
create unique index if not exists ux_unit_dispositions_active_sku
  on public.unit_dispositions (store_id, sku) where undone_at is null;
create index if not exists ix_unit_dispositions_sale
  on public.unit_dispositions (original_sale_id) where undone_at is null;

-- Commission each person had on a sale before its first active replacement (never exposed to clients).
create table if not exists public.sale_replacement_baseline (
  sale_id bigint not null references public.sales(id) on delete cascade,
  store_id uuid not null,
  employee_id uuid not null,
  amount_cents int,
  primary key (sale_id, employee_id)
);

alter table public.sale_payout_lines add column if not exists replacement_saved boolean not null default false;
alter table public.sale_payout_lines add column if not exists pre_cost_cents int;
alter table public.sale_payout_lines add column if not exists pre_base_cents int;

alter table public.unit_dispositions enable row level security;
alter table public.sale_replacement_baseline enable row level security;
drop policy if exists unit_dispositions_admin_read on public.unit_dispositions;
create policy unit_dispositions_admin_read on public.unit_dispositions for select to authenticated
  using (store_id = public.portal_store_id() and public.portal_is_admin());
revoke all on public.unit_dispositions from public, anon, authenticated;
revoke all on public.sale_replacement_baseline from public, anon, authenticated;
grant select on public.unit_dispositions to authenticated;
grant all on public.unit_dispositions, public.sale_replacement_baseline to service_role;

-- ── Cost helpers (always live, never a default) ────────────────────────────

create or replace function public.disposition_unit_cost(p_store uuid, p_sku text)
returns int language sql stable security definer set search_path = public as $$
  select (public.unit_cost_json(u.store_id, u.category, u.is_collectible, u.acquisition_cost_cents) ->> 'cost_cents')::int
  from public.units u where u.store_id = p_store and u.sku = p_sku;
$$;

-- Total replacement cost charged to one sale: 0 = none, null = a replacement unit has no cost yet.
create or replace function public.sale_replacement_cost(p_sale bigint)
returns int language plpgsql stable security definer set search_path = public as $$
declare r record; c int; v_total int := 0;
begin
  for r in select d.store_id, d.sku, d.extra_cost_cents from public.unit_dispositions d
    where d.original_sale_id = p_sale and d.kind = 'replacement' and d.undone_at is null loop
    c := public.disposition_unit_cost(r.store_id, r.sku);
    if c is null then return null; end if;
    v_total := v_total + c + r.extra_cost_cents;
  end loop;
  return v_total;
end $$;

-- Used by sale_ledger: the sale's cost plus any replacement cost (null stays null; pending replacement => null).
create or replace function public.sale_cost_with_replacements(p_sale bigint, p_cost int)
returns int language plpgsql stable security definer set search_path = public as $$
declare r int;
begin
  if p_cost is null then return null; end if;
  if not exists (select 1 from public.unit_dispositions d
    where d.original_sale_id = p_sale and d.kind = 'replacement' and d.undone_at is null) then
    return p_cost;
  end if;
  r := public.sale_replacement_cost(p_sale);
  if r is null then return null; end if;
  return p_cost + r;
end $$;
revoke all on function public.disposition_unit_cost(uuid, text) from public, anon;
revoke all on function public.sale_replacement_cost(bigint) from public, anon;
revoke all on function public.sale_cost_with_replacements(bigint, int) from public, anon;
grant execute on function public.disposition_unit_cost(uuid, text) to authenticated, service_role;
grant execute on function public.sale_replacement_cost(bigint) to authenticated, service_role;
grant execute on function public.sale_cost_with_replacements(bigint, int) to authenticated, service_role;

-- ── sale_ledger: cost_cents and profit_cents include replacement cost ─────
-- The live view is long; rewrite only its two item-cost terms from its own deparsed definition.
do $$
declare
  v_def text;
  v_new text;
  v_pat constant text := '(\(\(\(cost\.val ->> ''cost_cents''::text\)\)::integer \* GREATEST\(s\.qty, 1\)\))';
  v_hits int;
begin
  v_def := regexp_replace(pg_get_viewdef('public.sale_ledger'::regclass, false), ';\s*$', '');
  select count(*) into v_hits from regexp_matches(v_def, v_pat, 'g');
  if v_hits <> 2 then
    raise exception 'sale_ledger cost terms not found as expected (% matches)', v_hits;
  end if;
  v_new := regexp_replace(v_def, v_pat, 'public.sale_cost_with_replacements(s.id, \1)', 'g');
  execute 'create or replace view public.sale_ledger as ' || v_new;
end $$;

-- ── Commission recomputation for a replaced sale ──────────────────────────

create or replace function public.payout_sync_replacements(p_sale_id bigint, p_trigger uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  l public.sale_payout_lines;
  v_repl int;
  v_active boolean;
  b record;
  v_new int; v_d int; v_target int; v_cur int; v_delta int;
  v_paid bigint; v_reimb bigint; v_prior bigint; v_covered bigint;
  v_out jsonb := '[]'::jsonb;
  v_sku text;
begin
  select * into l from public.sale_payout_lines where sale_id = p_sale_id;
  if not found then return v_out; end if;
  select s.sku into v_sku from public.sales s where s.id = p_sale_id;
  v_active := exists (select 1 from public.unit_dispositions d
    where d.original_sale_id = p_sale_id and d.kind = 'replacement' and d.undone_at is null);
  v_repl := public.sale_replacement_cost(p_sale_id);

  if v_active and not l.replacement_saved then
    if l.cost_cents is null then return v_out; end if; -- original cost missing: the normal fill-on-cost path covers it
    insert into public.sale_replacement_baseline (sale_id, store_id, employee_id, amount_cents)
      select c.sale_id, c.store_id, c.employee_id, c.amount_cents from public.sale_commissions c where c.sale_id = p_sale_id
      on conflict (sale_id, employee_id) do nothing;
    update public.sale_payout_lines set replacement_saved = true,
      pre_cost_cents = cost_cents, pre_base_cents = commission_base_cents where sale_id = p_sale_id;
    select * into l from public.sale_payout_lines where sale_id = p_sale_id;
  end if;

  if l.replacement_saved then
    if v_active then
      update public.sale_payout_lines set
        cost_cents = case when v_repl is null then null else l.pre_cost_cents + v_repl end,
        commission_base_cents = case when v_repl is null or l.pre_base_cents is null then null else l.pre_base_cents - v_repl end
      where sale_id = p_sale_id;
    else
      update public.sale_payout_lines set cost_cents = l.pre_cost_cents, commission_base_cents = l.pre_base_cents,
        replacement_saved = false, pre_cost_cents = null, pre_base_cents = null
      where sale_id = p_sale_id;
    end if;
    perform public.payout_calc_ticket(l.store_id, l.ticket_key);
  end if;

  for b in select * from public.sale_replacement_baseline where sale_id = p_sale_id loop
    select c.amount_cents into v_new from public.sale_commissions c where c.sale_id = p_sale_id and c.employee_id = b.employee_id;
    v_target := 0;
    if v_active and b.amount_cents is not null and v_new is not null and b.amount_cents > v_new then
      v_d := b.amount_cents - v_new;
      select coalesce(sum(amount_cents), 0) into v_paid from public.portal_payout_payments
        where store_id = b.store_id and employee_id = b.employee_id;
      if v_paid > 0 then
        select coalesce(sum(amount_cents), 0) into v_reimb from public.portal_expenses
          where store_id = b.store_id and employee_id = b.employee_id and needs_reimbursement and voided_at is null;
        select coalesce(sum(c.amount_cents), 0) into v_prior from public.sale_commissions c
          join public.sales s on s.id = c.sale_id and s.voided_at is null
          where c.store_id = b.store_id and c.employee_id = b.employee_id and c.ticket_key <> l.ticket_key;
        v_prior := v_prior + coalesce((select sum(amount_cents) from public.portal_payout_adjustments
          where store_id = b.store_id and employee_id = b.employee_id and replacement_id is null), 0);
        v_covered := greatest(0, v_paid - v_reimb - greatest(0, v_prior));
        v_target := -least(v_d, v_covered::int);
      end if;
    end if;
    select coalesce(sum(amount_cents), 0) into v_cur from public.portal_payout_adjustments
      where sale_id = p_sale_id and employee_id = b.employee_id and replacement_id is not null;
    v_delta := v_target - v_cur;
    if v_delta <> 0 then
      insert into public.portal_payout_adjustments (store_id, employee_id, amount_cents, reason, sale_id, ticket_key, replacement_id, created_by)
      values (b.store_id, b.employee_id, v_delta,
        case when v_delta < 0 then format('Replacement clawback · sale SKU %s (already paid)', v_sku)
             else format('Replacement reversed · sale SKU %s', v_sku) end,
        p_sale_id, l.ticket_key, p_trigger, auth.uid());
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object('employee_id', b.employee_id,
      'before_cents', b.amount_cents, 'after_cents', v_new, 'adjustment_cents', v_target));
  end loop;

  if not v_active then delete from public.sale_replacement_baseline where sale_id = p_sale_id; end if;
  return v_out;
end $$;
revoke all on function public.payout_sync_replacements(bigint, uuid) from public, anon, authenticated;
grant execute on function public.payout_sync_replacements(bigint, uuid) to service_role;

-- ── Giveaway expense ──────────────────────────────────────────────────────

create or replace function public.giveaway_sync_expense(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare d public.unit_dispositions; u public.units; v_cost int; v_exp uuid; v_desc text;
begin
  select * into d from public.unit_dispositions where id = p_id;
  if not found or d.kind <> 'giveaway' then return; end if;
  select * into u from public.units where store_id = d.store_id and sku = d.sku;
  v_cost := public.disposition_unit_cost(d.store_id, d.sku);
  v_desc := format('Giveaway · %s (SKU %s) → %s%s · by %s',
    coalesce(nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), nullif(u.title, ''), 'Item'), d.sku, d.given_to,
    case when nullif(btrim(coalesce(d.note, '')), '') is null then '' else ' — ' || d.note end,
    coalesce(d.recorded_by_name, 'admin'));
  v_exp := d.expense_id;
  if d.undone_at is not null or v_cost is null or v_cost <= 0 then
    if v_exp is not null then
      update public.portal_expenses set voided_at = coalesce(voided_at, now()),
        void_reason = case when d.undone_at is not null then 'Giveaway undone' else 'Giveaway cost removed' end
      where id = v_exp and voided_at is null;
    end if;
    return;
  end if;
  if v_exp is null then
    insert into public.portal_expenses (store_id, spent_on, description, category, amount_cents, needs_reimbursement,
      source, created_by, external_id)
    values (d.store_id, (d.created_at at time zone 'America/Los_Angeles')::date, v_desc, 'Giveaways', v_cost, false,
      'giveaway', d.recorded_by, d.id::text)
    returning id into v_exp;
    update public.unit_dispositions set expense_id = v_exp where id = d.id;
  else
    update public.portal_expenses set amount_cents = v_cost, description = v_desc, voided_at = null, void_reason = null
    where id = v_exp;
  end if;
end $$;
revoke all on function public.giveaway_sync_expense(uuid) from public, anon, authenticated;
grant execute on function public.giveaway_sync_expense(uuid) to service_role;

-- A cost entered/changed later flows into replacements and giveaways.
create or replace function public.disposition_unit_cost_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
declare d record;
begin
  for d in select * from public.unit_dispositions
    where store_id = new.store_id and sku = new.sku and undone_at is null loop
    if d.kind = 'replacement' then perform public.payout_sync_replacements(d.original_sale_id, d.id);
    else perform public.giveaway_sync_expense(d.id); end if;
  end loop;
  return null;
exception when others then
  insert into public.payout_snapshot_errors (store_id, error) values (new.store_id, 'disposition cost ' || new.sku || ': ' || sqlerrm);
  return null;
end $$;
drop trigger if exists disposition_unit_cost on public.units;
create trigger disposition_unit_cost
  after update of acquisition_cost_cents, is_collectible on public.units
  for each row when (old.acquisition_cost_cents is distinct from new.acquisition_cost_cents
    or old.is_collectible is distinct from new.is_collectible)
  execute function public.disposition_unit_cost_trigger();

-- ── Internal steps shared by the RPCs ─────────────────────────────────────

create or replace function public.disposition_actor_name(p_uid uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce((select s.display_name from public.staff s where s.user_id = p_uid order by s.deactivated_at nulls first limit 1), 'Admin');
$$;
revoke all on function public.disposition_actor_name(uuid) from public, anon;
grant execute on function public.disposition_actor_name(uuid) to authenticated, service_role;

-- Leave stock: unit state, checklist, and a delist task for every channel it is live on.
create or replace function public.disposition_leave_stock(p_store uuid, p_sku text, p_state text)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.delist_tasks (store_id, sku, channel, sale_id, nag_after)
  select p_store, l.sku, l.channel, null,
    now() + make_interval(mins => coalesce((public.store_setting(p_store, 'delistNagMinutes', '15'::jsonb) #>> '{}')::int, 15))
  from public.listings l
  where l.store_id is not distinct from p_store and l.sku = p_sku and l.status = 'listed'
    and not exists (select 1 from public.delist_tasks t
      where t.store_id is not distinct from p_store and t.sku = l.sku and t.channel = l.channel and t.completed_at is null);
  update public.listings set status = 'pending_delist'
   where store_id is not distinct from p_store and sku = p_sku and status = 'listed';
  update public.units set state = p_state, listed_on = '{}', show_on_website = false, updated_at = now()
   where store_id = p_store and sku = p_sku;
end $$;
revoke all on function public.disposition_leave_stock(uuid, text, text) from public, anon, authenticated;
grant execute on function public.disposition_leave_stock(uuid, text, text) to service_role;

-- The bad unit coming back: a new Defective unit linked to the replacement record.
create or replace function public.disposition_make_bad_unit(p_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  d public.unit_dispositions; o public.units; v_sku text; v_max bigint; v_digits int; v_receipt text; v_actor text;
begin
  select * into d from public.unit_dispositions where id = p_id for update;
  if not found or d.kind <> 'replacement' then raise exception 'not_a_replacement'; end if;
  if d.bad_unit_sku is not null then return d.bad_unit_sku; end if;
  select * into o from public.units where store_id = d.store_id and sku = d.original_sku;
  select s.receipt_no into v_receipt from public.sales s where s.id = d.original_sale_id;
  v_actor := public.disposition_actor_name(auth.uid());
  v_digits := coalesce((public.store_setting(d.store_id, 'skuDigits', '5'::jsonb) #>> '{}')::int, 5);
  select coalesce(max(case when sku ~ '^[0-9]{5}$' and sku < '90000' then sku::bigint end), 9999) into v_max
    from public.sku_ledger where store_id = d.store_id;
  v_sku := lpad((greatest(v_max + 1, 10000))::text, v_digits, '0');
  insert into public.sku_ledger (store_id, sku, issued_at, label, fate)
    values (d.store_id, v_sku, now(), coalesce(o.title, ''), 'issued');
  -- Cost 0 on purpose: this unit's real cost already sits on the original sale; counting it again would double it.
  insert into public.units (store_id, sku, brand, model, title, category, condition, upc, acquisition_cost_cents,
    defect_notes, state, show_on_website, received_at, updated_at, listing_specs)
  values (d.store_id, v_sku, coalesce(o.brand, ''), coalesce(o.model, ''), coalesce(o.title, ''), o.category,
    'Defective', o.upc, 0,
    format('Bad unit back from replacement. Original SKU %s, sale %s, replaced by SKU %s.', d.original_sku, v_receipt, d.sku),
    'available', false, now(), now(),
    jsonb_build_object('do_not_list', true, 'bad_unit_of', d.original_sku, 'replacement_id', d.id));
  insert into public.events (store_id, sku, kind, actor, actor_id, note)
    values (d.store_id, v_sku, 'bad_unit_received', v_actor, auth.uid(),
      format('Bad unit of SKU %s came back (replacement SKU %s)', d.original_sku, d.sku));
  insert into public.events (store_id, sku, kind, actor, actor_id, note)
    values (d.store_id, d.original_sku, 'bad_unit_received', v_actor, auth.uid(), format('Bad unit logged into Defective as SKU %s', v_sku));
  update public.unit_dispositions set bad_unit_status = 'returned', bad_unit_sku = v_sku where id = d.id;
  return v_sku;
end $$;
revoke all on function public.disposition_make_bad_unit(uuid) from public, anon, authenticated;
grant execute on function public.disposition_make_bad_unit(uuid) to service_role;

-- ── Admin RPCs ────────────────────────────────────────────────────────────

create or replace function public.portal_replacement_sale_search(p_query text default '')
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id(); v_q text := btrim(coalesce(p_query, ''));
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(x order by (x->>'sold_at') desc) from (
    select jsonb_build_object(
      'sale_id', s.id, 'receipt_no', s.receipt_no, 'sku', s.sku,
      'item', coalesce(nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), nullif(u.title, ''), 'Item'),
      'channel', s.channel, 'sold_at', s.sold_at, 'price_cents', s.price_cents,
      'order_ref', coalesce(co.order_id, wo.order_no, nullif(split_part(coalesce(s.payment_id, ''), ':', 3), '')),
      'buyer', coalesce(nullif(wo.buyer_name, ''), nullif(s.customer_name, ''), nullif(co.buyer_username, '')),
      'replacements', (select count(*) from public.unit_dispositions d
        where d.original_sale_id = s.id and d.kind = 'replacement' and d.undone_at is null)
    ) x
    from public.sales s
    left join public.units u on u.store_id = s.store_id and u.sku = s.sku
    left join lateral (select c.order_id, c.buyer_username from public.channel_orders c where c.sale_id = s.id order by c.created_at desc limit 1) co on true
    left join lateral (select w.order_no, w.buyer_name from public.web_orders w where w.sale_id = s.id order by w.created_at limit 1) wo on true
    where s.store_id = v_store and s.voided_at is null
      and (v_q = '' or s.sku ilike '%' || v_q || '%' or s.receipt_no ilike '%' || v_q || '%'
        or coalesce(s.payment_id, '') ilike '%' || v_q || '%' or coalesce(co.order_id, '') ilike '%' || v_q || '%'
        or coalesce(wo.order_no, '') ilike '%' || v_q || '%' or coalesce(u.title, '') ilike '%' || v_q || '%'
        or coalesce(u.model, '') ilike '%' || v_q || '%')
    order by s.sold_at desc limit 25
  ) t), '[]'::jsonb);
end $$;

create or replace function public.portal_record_replacement(
  p_sku text, p_sale_id bigint, p_bad_unit_returned boolean, p_extra_cost_cents int default 0, p_note text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  u public.units; s public.sales; v_id uuid := gen_random_uuid(); v_actor text; v_extra int := coalesce(p_extra_cost_cents, 0);
  v_bad text; v_sync jsonb; v_cost int;
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if v_extra < 0 then raise exception 'extra_cost_invalid'; end if;
  select * into u from public.units where store_id = v_store and sku = p_sku for update;
  if not found then raise exception 'unit_not_found'; end if;
  if u.state <> 'available' then raise exception 'unit_not_available'; end if;
  select * into s from public.sales where id = p_sale_id and store_id = v_store;
  if not found or s.voided_at is not null then raise exception 'sale_not_found'; end if;
  if s.sku = p_sku then raise exception 'replacement_is_original_unit'; end if;
  v_actor := public.disposition_actor_name(auth.uid());
  insert into public.unit_dispositions (id, store_id, kind, sku, prior_state, original_sale_id, original_sku, extra_cost_cents,
    bad_unit_status, note, recorded_by, recorded_by_name)
  values (v_id, v_store, 'replacement', p_sku, u.state, s.id, s.sku, v_extra,
    case when p_bad_unit_returned then 'returned' else 'pending' end, nullif(btrim(coalesce(p_note, '')), ''), auth.uid(), v_actor);
  perform public.disposition_leave_stock(v_store, p_sku, 'replaced');
  if p_bad_unit_returned then v_bad := public.disposition_make_bad_unit(v_id); end if;
  v_cost := public.disposition_unit_cost(v_store, p_sku);
  insert into public.events (store_id, sku, kind, actor, actor_id, note) values
    (v_store, p_sku, 'replacement_sent', v_actor, auth.uid(),
      format('Sent as a replacement for sale %s (SKU %s). Cost %s', s.receipt_no, s.sku,
        coalesce('$' || to_char((v_cost + v_extra) / 100.0, 'FM999990.00'), 'missing'))),
    (v_store, s.sku, 'replacement_sent', v_actor, auth.uid(), format('Replacement SKU %s sent for this sale', p_sku));
  v_sync := public.payout_sync_replacements(s.id, v_id);
  return jsonb_build_object('id', v_id, 'bad_unit_sku', v_bad, 'cost_cents', v_cost, 'extra_cost_cents', v_extra,
    'cost_missing', v_cost is null, 'commissions', v_sync);
end $$;

create or replace function public.portal_replacement_bad_unit_returned(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id(); d public.unit_dispositions; v_sku text;
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  select * into d from public.unit_dispositions where id = p_id and store_id = v_store for update;
  if not found or d.kind <> 'replacement' or d.undone_at is not null then raise exception 'replacement_not_found'; end if;
  v_sku := public.disposition_make_bad_unit(p_id);
  return jsonb_build_object('bad_unit_sku', v_sku);
end $$;

create or replace function public.portal_record_giveaway(p_sku text, p_given_to text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  u public.units; v_id uuid := gen_random_uuid(); v_actor text; v_cost int;
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if nullif(btrim(coalesce(p_given_to, '')), '') is null then raise exception 'given_to_required'; end if;
  select * into u from public.units where store_id = v_store and sku = p_sku for update;
  if not found then raise exception 'unit_not_found'; end if;
  if u.state <> 'available' then raise exception 'unit_not_available'; end if;
  v_actor := public.disposition_actor_name(auth.uid());
  insert into public.unit_dispositions (id, store_id, kind, sku, prior_state, given_to, note, recorded_by, recorded_by_name)
  values (v_id, v_store, 'giveaway', p_sku, u.state, btrim(p_given_to), nullif(btrim(coalesce(p_note, '')), ''), auth.uid(), v_actor);
  perform public.disposition_leave_stock(v_store, p_sku, 'given_away');
  v_cost := public.disposition_unit_cost(v_store, p_sku);
  insert into public.events (store_id, sku, kind, actor, actor_id, note)
  values (v_store, p_sku, 'given_away', v_actor, auth.uid(),
    format('Given to %s%s. Cost %s', btrim(p_given_to), case when nullif(btrim(coalesce(p_note, '')), '') is null then '' else ' (' || p_note || ')' end,
      coalesce('$' || to_char(v_cost / 100.0, 'FM999990.00'), 'missing')));
  perform public.giveaway_sync_expense(v_id);
  return jsonb_build_object('id', v_id, 'cost_cents', v_cost, 'cost_missing', v_cost is null);
end $$;

create or replace function public.portal_undo_disposition(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  d public.unit_dispositions; v_actor text; v_sync jsonb := '[]'::jsonb; v_bad_left boolean := false;
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  select * into d from public.unit_dispositions where id = p_id and store_id = v_store for update;
  if not found then raise exception 'record_not_found'; end if;
  if d.undone_at is not null then raise exception 'already_undone'; end if;
  v_actor := public.disposition_actor_name(auth.uid());
  update public.unit_dispositions set undone_at = now(), undone_by = auth.uid(), undone_by_name = v_actor where id = d.id;
  update public.units set state = d.prior_state, updated_at = now() where store_id = v_store and sku = d.sku and state in ('replaced', 'given_away');
  if d.kind = 'replacement' then
    v_sync := public.payout_sync_replacements(d.original_sale_id, d.id);
    if d.bad_unit_sku is not null then
      update public.units set state = 'voided', updated_at = now()
        where store_id = v_store and sku = d.bad_unit_sku and state = 'available';
      if found then
        update public.sku_ledger set fate = 'voided' where store_id = v_store and sku = d.bad_unit_sku;
      else
        v_bad_left := true;
      end if;
    end if;
    insert into public.events (store_id, sku, kind, actor, actor_id, note) values
      (v_store, d.sku, 'replacement_undone', v_actor, auth.uid(), 'Replacement undone; back in stock'),
      (v_store, d.original_sku, 'replacement_undone', v_actor, auth.uid(), format('Replacement SKU %s undone', d.sku));
  else
    perform public.giveaway_sync_expense(d.id);
    insert into public.events (store_id, sku, kind, actor, actor_id, note)
    values (v_store, d.sku, 'giveaway_undone', v_actor, auth.uid(), 'Giveaway undone; back in stock');
  end if;
  return jsonb_build_object('id', d.id, 'commissions', v_sync, 'bad_unit_left_in_defective', v_bad_left);
end $$;

create or replace function public.portal_dispositions_list(p_kind text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(r order by (r->>'created_at') desc) from (
    select jsonb_build_object(
      'id', d.id, 'kind', d.kind, 'sku', d.sku,
      'item', coalesce(nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), nullif(u.title, ''), 'Item'),
      'cost_cents', public.disposition_unit_cost(d.store_id, d.sku), 'extra_cost_cents', d.extra_cost_cents,
      'cost_missing', public.disposition_unit_cost(d.store_id, d.sku) is null,
      'original_sale_id', d.original_sale_id, 'original_sku', d.original_sku,
      'original_receipt_no', s.receipt_no, 'original_channel', s.channel, 'original_sold_at', s.sold_at,
      'bad_unit_status', d.bad_unit_status, 'bad_unit_sku', d.bad_unit_sku,
      'given_to', d.given_to, 'note', d.note, 'expense_id', d.expense_id,
      'recorded_by_name', d.recorded_by_name, 'created_at', d.created_at,
      'undone_at', d.undone_at, 'undone_by_name', d.undone_by_name
    ) r
    from public.unit_dispositions d
    left join public.units u on u.store_id = d.store_id and u.sku = d.sku
    left join public.sales s on s.id = d.original_sale_id
    where d.store_id = v_store and (p_kind is null or d.kind = p_kind)
    order by d.created_at desc limit 500
  ) t), '[]'::jsonb);
end $$;

create or replace function public.portal_unit_history(p_sku text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('at', e.at, 'kind', e.kind, 'actor', e.actor, 'note', e.note) order by e.at desc)
    from public.events e
    where e.store_id = v_store and e.sku = p_sku
      and e.kind in ('replacement_sent', 'replacement_undone', 'given_away', 'giveaway_undone', 'bad_unit_received')), '[]'::jsonb);
end $$;

do $$ declare f text; begin
  foreach f in array array[
    'portal_replacement_sale_search(text)', 'portal_record_replacement(text, bigint, boolean, int, text)',
    'portal_replacement_bad_unit_returned(uuid)', 'portal_record_giveaway(text, text, text)',
    'portal_undo_disposition(uuid)', 'portal_dispositions_list(text)', 'portal_unit_history(text)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;

commit;
