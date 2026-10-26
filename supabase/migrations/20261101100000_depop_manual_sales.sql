-- Depop: no more automatic import. Depop sales are typed in by hand on the Depop tab.
--  * Guards: nothing but portal_depop_record_sale can create a Depop sale, order or channel order (floor.depop_manual).
--  * One-time cleanup: every existing Depop sale (and its orders, delist tasks, commissions) is removed from the books.
--    The units stay Sold. Payment history (portal_payout_payments) is never touched.
--  * Manual entry: portal_depop_record_sale / update / delete / list. Profit = payout - cost (fee = sale - payout), the
--    order goes straight to Done, and the unit is marked sold and delisted everywhere else, like any other sale.
-- Newest previous definitions: finalize_sale (20261002140000), portal_payout_refreeze (20261030150000).
begin;

-- ── Hard guard: only the manual RPC may create Depop rows ──────────────────

create or replace function public.guard_depop_import()
returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('floor.depop_manual', true), '') <> 'on' then
    raise exception 'depop_import_disabled: Depop sales are entered by hand on the Depop tab' using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists depop_guard_sales on public.sales;
create trigger depop_guard_sales before insert on public.sales
  for each row when (lower(new.channel) = 'depop') execute function public.guard_depop_import();
drop trigger if exists depop_guard_web_orders on public.web_orders;
create trigger depop_guard_web_orders before insert on public.web_orders
  for each row when (lower(new.channel) = 'depop') execute function public.guard_depop_import();
drop trigger if exists depop_guard_channel_orders on public.channel_orders;
create trigger depop_guard_channel_orders before insert on public.channel_orders
  for each row when (lower(new.provider) = 'depop') execute function public.guard_depop_import();

-- ── Entries ────────────────────────────────────────────────────────────────

create table if not exists public.depop_sale_entries (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  sale_id bigint references public.sales(id) on delete set null,
  sku text not null,
  sale_cents int not null check (sale_cents > 0),
  fee_cents int not null check (fee_cents >= 0),
  payout_cents int not null check (payout_cents >= 0),
  sold_on date not null,
  note text,
  created_by uuid,
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (payout_cents <= sale_cents)
);
create index if not exists ix_depop_sale_entries_store on public.depop_sale_entries (store_id, sold_on desc);
alter table public.depop_sale_entries enable row level security;
drop policy if exists depop_sale_entries_admin_read on public.depop_sale_entries;
create policy depop_sale_entries_admin_read on public.depop_sale_entries for select to authenticated
  using (store_id = public.portal_store_id() and public.portal_is_admin());
revoke all on public.depop_sale_entries from public, anon, authenticated;
grant select on public.depop_sale_entries to authenticated;
grant all on public.depop_sale_entries to service_role;

-- ── Removing a Depop sale from everything ──────────────────────────────────

create or replace function public.depop_purge_sale(p_sale bigint, p_restore boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s public.sales; v_orders uuid[]; v_ticket text; v_comm jsonb;
begin
  select * into s from public.sales where id = p_sale for update;
  if not found then return null; end if;
  if lower(s.channel) <> 'depop' then raise exception 'not_a_depop_sale'; end if;
  if exists (select 1 from public.unit_dispositions d where d.original_sale_id = p_sale) then raise exception 'sale_has_replacement'; end if;
  v_ticket := coalesce(s.ticket_id::text, 'sale:' || s.id::text);
  select coalesce(jsonb_object_agg(c.employee_id, c.amount_cents), '{}'::jsonb) into v_comm
    from public.sale_commissions c where c.sale_id = p_sale;
  select array_agg(id) into v_orders from public.web_orders where sale_id = p_sale;
  if v_orders is not null then
    delete from public.web_order_emails where order_id = any (v_orders);
    delete from public.web_order_labels where order_id = any (v_orders);
    delete from public.web_orders where id = any (v_orders);
  end if;
  delete from public.channel_orders where sale_id = p_sale;
  delete from public.delist_tasks where sale_id = p_sale;
  update public.reservations set sale_id = null where sale_id = p_sale;
  update public.marketplace_email_sales set sale_id = null, state = 'ignored' where sale_id = p_sale;
  delete from public.portal_sale_corrections where sale_id = p_sale;
  delete from public.portal_commission_overrides where store_id = s.store_id and ticket_key = v_ticket;
  delete from public.sales where id = p_sale;
  delete from public.sale_payout_tickets t where t.store_id = s.store_id and t.ticket_key = v_ticket
    and not exists (select 1 from public.sale_payout_lines l where l.store_id = t.store_id and l.ticket_key = t.ticket_key);
  if p_restore then
    update public.units set state = 'available', updated_at = now() where store_id = s.store_id and sku = s.sku and state = 'sold';
    update public.sku_ledger set fate = 'issued' where sku = s.sku and store_id is not distinct from s.store_id;
  end if;
  insert into public.events (store_id, sku, kind, actor, actor_id, note)
  values (s.store_id, s.sku, case when p_restore then 'depop_sale_deleted' else 'depop_sale_removed' end,
    coalesce((select display_name from public.staff where user_id = auth.uid()), 'system'), auth.uid(),
    format('Depop sale %s (%s) removed%s', s.receipt_no, to_char(s.price_cents / 100.0, 'FM999990.00'),
      case when p_restore then '; unit back in stock' else '; unit stays sold' end));
  return jsonb_build_object('sale_id', s.id, 'sku', s.sku, 'receipt_no', s.receipt_no, 'sold_at', s.sold_at,
    'price_cents', s.price_cents, 'voided', s.voided_at is not null, 'commissions', v_comm);
end $$;
revoke all on function public.depop_purge_sale(bigint, boolean) from public, anon, authenticated;
grant execute on function public.depop_purge_sale(bigint, boolean) to service_role;

-- One-time cleanup of the imported Depop sales. Units stay Sold; payments and adjustments are untouched.
do $$
declare r record;
begin
  for r in select id from public.sales where lower(channel) = 'depop' order by id loop
    perform public.depop_purge_sale(r.id, false);
  end loop;
  -- Depop orders that never had a sale (e.g. UNMATCHED email stubs) and their fee rows.
  delete from public.web_order_emails where order_id in (select id from public.web_orders where lower(channel) = 'depop');
  delete from public.web_order_labels where order_id in (select id from public.web_orders where lower(channel) = 'depop');
  delete from public.web_orders where lower(channel) = 'depop';
  delete from public.channel_orders where lower(provider) = 'depop';
  update public.marketplace_email_sales set state = 'ignored', sale_id = null where lower(marketplace) = 'depop' and state <> 'ignored';
end $$;

-- ── Manual entry ───────────────────────────────────────────────────────────

create or replace function public.depop_sold_at(p_day date)
returns timestamptz language sql immutable as $$
  select ((p_day::timestamp + interval '12 hours') at time zone 'America/Los_Angeles');
$$;

create or replace function public.portal_depop_record_sale(
  p_sku text, p_sale_cents int, p_fee_cents int, p_payout_cents int default null, p_sold_on date default null, p_note text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_admin text; v_id uuid := gen_random_uuid(); v_day date; v_payout int; v_sale public.sales; v_deduct int; v_cost int;
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if p_sale_cents is null or p_sale_cents <= 0 then raise exception 'invalid_sale_price' using errcode = '22023'; end if;
  if p_fee_cents is null or p_fee_cents < 0 then raise exception 'invalid_fee' using errcode = '22023'; end if;
  v_payout := coalesce(p_payout_cents, p_sale_cents - p_fee_cents);
  if v_payout < 0 or v_payout > p_sale_cents then raise exception 'invalid_payout' using errcode = '22023'; end if;
  v_day := coalesce(p_sold_on, (now() at time zone 'America/Los_Angeles')::date);
  if v_day > (now() at time zone 'America/Los_Angeles')::date then raise exception 'sale_date_in_future' using errcode = '22023'; end if;
  if not exists (select 1 from public.units where store_id = v_store and sku = p_sku and state in ('available', 'reserved')) then
    raise exception 'unit_not_sellable' using errcode = 'P0001';
  end if;
  v_admin := public.disposition_actor_name(auth.uid());
  perform set_config('floor.depop_manual', 'on', true);
  v_sale := public.finalize_sale(p_sku, 'depop', p_sale_cents, 'depop', 'depop-manual:' || v_id::text,
    null, null, null, coalesce(nullif(btrim(p_note), ''), 'Depop sale (entered by hand)'), null, 0, null);
  v_deduct := p_sale_cents - v_payout;  -- everything Depop kept: fee, label, anything else
  update public.sales set sold_at = public.depop_sold_at(v_day) where id = v_sale.id;
  insert into public.channel_orders (store_id, provider, order_id, sku, sale_id, item_cents, fee_cents, fee_source, baked_ship_cents)
    values (v_store, 'depop', 'manual:' || v_id::text, p_sku, v_sale.id, p_sale_cents, v_deduct, 'actual', 0);
  insert into public.web_orders (store_id, sku, sale_id, status, channel, fulfillment, order_no, paid_at, buyer_name,
      item_cents, shipping_cents, tax_cents, total_cents, payment_id, payment_env, match_status, marketplace_fee_cents,
      marketplace_title, shipped_at, delivered_at)
    select v_store, p_sku, v_sale.id, 'paid', 'depop', 'ship', 'DEPOP-' || v_sale.receipt_no, public.depop_sold_at(v_day), 'Depop buyer',
      p_sale_cents, 0, 0, p_sale_cents, 'depop-manual:' || v_id::text, 'production', 'matched', v_deduct,
      left(coalesce(nullif(u.title, ''), concat_ws(' ', u.brand, u.model), 'Depop sale'), 250), public.depop_sold_at(v_day), public.depop_sold_at(v_day)
    from public.units u where u.store_id = v_store and u.sku = p_sku;
  update public.web_order_emails set sent_at = now(), last_error = 'manual Depop entry'
    where order_id in (select id from public.web_orders where sale_id = v_sale.id) and sent_at is null;
  update public.listings set status = 'delisted', delisted_at = now()
    where store_id is not distinct from v_store and sku = p_sku and channel = 'depop' and status <> 'delisted';
  insert into public.depop_sale_entries (id, store_id, sale_id, sku, sale_cents, fee_cents, payout_cents, sold_on, note, created_by, created_by_name)
    values (v_id, v_store, v_sale.id, p_sku, p_sale_cents, p_fee_cents, v_payout, v_day, nullif(btrim(p_note), ''), auth.uid(), v_admin);
  -- finalize_sale already froze the commission before the Depop fee row existed (when the snapshot trigger runs immediately): freeze again with the fee.
  perform public.portal_payout_refreeze(coalesce(v_sale.ticket_id::text, 'sale:' || v_sale.id::text));
  v_cost := public.disposition_unit_cost(v_store, p_sku);
  return jsonb_build_object('id', v_id, 'sale_id', v_sale.id, 'receipt_no', v_sale.receipt_no, 'payout_cents', v_payout,
    'cost_cents', v_cost, 'cost_missing', v_cost is null);
end $$;

create or replace function public.portal_depop_update_sale(
  p_id uuid, p_sale_cents int, p_fee_cents int, p_payout_cents int, p_sold_on date, p_note text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  e public.depop_sale_entries; v_deduct int; v_ticket text;
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  select * into e from public.depop_sale_entries where id = p_id and store_id = v_store and deleted_at is null for update;
  if not found or e.sale_id is null then raise exception 'entry_not_found'; end if;
  if p_sale_cents is null or p_sale_cents <= 0 then raise exception 'invalid_sale_price' using errcode = '22023'; end if;
  if p_fee_cents is null or p_fee_cents < 0 then raise exception 'invalid_fee' using errcode = '22023'; end if;
  if p_payout_cents is null or p_payout_cents < 0 or p_payout_cents > p_sale_cents then raise exception 'invalid_payout' using errcode = '22023'; end if;
  if p_sold_on is null or p_sold_on > (now() at time zone 'America/Los_Angeles')::date then raise exception 'invalid_sale_date' using errcode = '22023'; end if;
  v_deduct := p_sale_cents - p_payout_cents;
  update public.sales set price_cents = p_sale_cents, sold_at = public.depop_sold_at(p_sold_on), note = coalesce(nullif(btrim(p_note), ''), note)
    where id = e.sale_id;
  update public.channel_orders set item_cents = p_sale_cents, fee_cents = v_deduct where sale_id = e.sale_id and provider = 'depop';
  update public.web_orders set item_cents = p_sale_cents, total_cents = p_sale_cents, marketplace_fee_cents = v_deduct,
      paid_at = public.depop_sold_at(p_sold_on), shipped_at = public.depop_sold_at(p_sold_on), delivered_at = public.depop_sold_at(p_sold_on)
    where sale_id = e.sale_id;
  update public.depop_sale_entries set sale_cents = p_sale_cents, fee_cents = p_fee_cents, payout_cents = p_payout_cents,
      sold_on = p_sold_on, note = nullif(btrim(p_note), ''), updated_at = now() where id = e.id;
  -- Commission was frozen from the old numbers: re-freeze this one sale from the corrected ledger (payments are untouched).
  v_ticket := coalesce((select ticket_id::text from public.sales where id = e.sale_id), 'sale:' || e.sale_id::text);
  perform public.portal_payout_refreeze(v_ticket);
  return jsonb_build_object('id', e.id, 'sale_id', e.sale_id);
end $$;

create or replace function public.portal_depop_delete_sale(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  e public.depop_sale_entries; v_out jsonb;
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  select * into e from public.depop_sale_entries where id = p_id and store_id = v_store and deleted_at is null for update;
  if not found then raise exception 'entry_not_found'; end if;
  if e.sale_id is not null then v_out := public.depop_purge_sale(e.sale_id, true); end if;
  update public.depop_sale_entries set deleted_at = now(), updated_at = now() where id = e.id;
  return coalesce(v_out, '{}'::jsonb);
end $$;

create or replace function public.portal_depop_entries(p_limit int default 50)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(x order by (x->>'sold_on') desc, (x->>'created_at') desc) from (
    select jsonb_build_object(
      'id', e.id, 'sku', e.sku, 'item', coalesce(nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), nullif(u.title, ''), 'Item'),
      'sale_cents', e.sale_cents, 'fee_cents', e.fee_cents, 'payout_cents', e.payout_cents, 'sold_on', e.sold_on, 'note', e.note,
      'receipt_no', s.receipt_no, 'created_by_name', e.created_by_name, 'created_at', e.created_at,
      'cost_cents', public.disposition_unit_cost(e.store_id, e.sku),
      'cost_missing', public.disposition_unit_cost(e.store_id, e.sku) is null,
      'profit_cents', e.payout_cents - public.disposition_unit_cost(e.store_id, e.sku)
    ) x
    from public.depop_sale_entries e
    left join public.units u on u.store_id = e.store_id and u.sku = e.sku
    left join public.sales s on s.id = e.sale_id
    where e.store_id = v_store and e.deleted_at is null
    order by e.sold_on desc, e.created_at desc limit greatest(1, least(coalesce(p_limit, 50), 200))
  ) t), '[]'::jsonb);
end $$;

do $$ declare f text; begin
  foreach f in array array[
    'portal_depop_record_sale(text, int, int, int, date, text)', 'portal_depop_update_sale(uuid, int, int, int, date, text)',
    'portal_depop_delete_sale(uuid)', 'portal_depop_entries(int)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;

commit;
