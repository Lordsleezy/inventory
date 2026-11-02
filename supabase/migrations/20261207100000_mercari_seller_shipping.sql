-- Mercari seller-paid shipping is a reimbursement to the online payout person.
-- It is not a sale cost: the ledger, profit, and frozen commission ignore it.
-- A Mercari sale entered on the Mercari tab stores sale price, Mercari fee, and payout only.
begin;

create or replace function public.ledger_ship_cents(p_channel text, p_cents int)
returns int language sql immutable as $$
  select case when lower(btrim(coalesce(p_channel, ''))) = 'mercari' then 0 else coalesce(p_cents, 0) end;
$$;
revoke all on function public.ledger_ship_cents(text, int) from public, anon;
grant execute on function public.ledger_ship_cents(text, int) to authenticated, service_role;

-- Rewrite the live ledger in place (same view) so Mercari labels drop out of ship cost and profit.
do $$
declare
  v_def text;
  v_new text;
  v_n int;
  v_pat constant text := 'case\s+when\s+\(\s*greatest\(\s*coalesce\(\s*wo\.label_cost_cents\s*,\s*0(?:\s*::integer)?\s*\)\s*,\s*coalesce\(\s*lbl\.cents\s*,\s*0(?:\s*::integer)?\s*\)\s*,\s*coalesce\(\s*man\.cents\s*,\s*0(?:\s*::integer)?\s*\)\s*,\s*coalesce\(\s*co\.ship_label_cents\s*,\s*0(?:\s*::integer)?\s*\)\s*\)\s*>\s*0\s*\)\s+then\s+greatest\(\s*coalesce\(\s*wo\.label_cost_cents\s*,\s*0(?:\s*::integer)?\s*\)\s*,\s*coalesce\(\s*lbl\.cents\s*,\s*0(?:\s*::integer)?\s*\)\s*,\s*coalesce\(\s*man\.cents\s*,\s*0(?:\s*::integer)?\s*\)\s*,\s*coalesce\(\s*co\.ship_label_cents\s*,\s*0(?:\s*::integer)?\s*\)\s*\)\s+else\s+coalesce\(\s*co\.baked_ship_cents\s*,\s*0(?:\s*::integer)?\s*\)\s+end';
begin
  v_def := pg_get_viewdef('public.sale_ledger'::regclass, true);
  select count(*) into v_n from regexp_matches(v_def, v_pat, 'gi');
  if v_n <> 2 then
    raise exception 'sale_ledger ship terms not found as expected (% matches)', v_n;
  end if;
  v_new := regexp_replace(regexp_replace(v_def, ';\s*$', ''), '(' || v_pat || ')', 'public.ledger_ship_cents(s.channel, \1)', 'gi');
  execute 'create or replace view public.sale_ledger as ' || v_new;
end $$;

create or replace function public.mercari_label_reimbursement(
  p_store uuid, p_sale bigint, p_sku text, p_cents int
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_emp uuid;
  v_emp_text text;
  v_order uuid;
  v_ext text;
  v_id uuid;
  v_day date;
begin
  if p_store is null or p_sale is null or p_cents is null or p_cents <= 0 then return null; end if;
  v_ext := 'mercari-label:' || p_sale::text;
  select id into v_order from public.web_orders
   where store_id = p_store and sale_id = p_sale order by created_at limit 1;
  v_emp_text := nullif(public.store_setting(p_store, 'online_payout_employee_id', 'null'::jsonb) #>> '{}', '');
  if v_emp_text ~* '^[0-9a-f-]{36}$' then v_emp := v_emp_text::uuid; end if;
  select (sold_at at time zone 'America/Los_Angeles')::date into v_day from public.sales where id = p_sale;
  select id into v_id from public.portal_expenses
   where store_id = p_store and voided_at is null
     and (external_id = v_ext or (v_order is not null and order_id = v_order and source = 'manual_label'))
   order by (external_id = v_ext) desc, created_at
   limit 1;
  if v_id is not null then
    update public.portal_expenses set
      amount_cents = p_cents,
      needs_reimbursement = v_emp is not null,
      employee_id = v_emp,
      external_id = coalesce(external_id, v_ext),
      order_id = coalesce(order_id, v_order),
      description = 'Mercari shipping label · SKU ' || coalesce(nullif(btrim(p_sku), ''), p_sale::text),
      category = 'Shipping'
    where id = v_id;
    return v_id;
  end if;
  insert into public.portal_expenses(
    store_id, spent_on, description, category, amount_cents, needs_reimbursement, employee_id, source, order_id, external_id)
  values (
    p_store, coalesce(v_day, (now() at time zone 'America/Los_Angeles')::date),
    'Mercari shipping label · SKU ' || coalesce(nullif(btrim(p_sku), ''), p_sale::text),
    'Shipping', p_cents, v_emp is not null, v_emp, 'manual_label', v_order, v_ext)
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.mercari_label_reimbursement(uuid, bigint, text, int) from public, anon, authenticated;
grant execute on function public.mercari_label_reimbursement(uuid, bigint, text, int) to service_role;

create or replace function public.mercari_channel_label_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_mercari boolean;
begin
  if coalesce(new.ship_label_cents, 0) <= 0 then return new; end if;
  v_mercari := lower(coalesce(new.provider, '')) = 'mercari'
    or exists (select 1 from public.sales s where s.id = new.sale_id and lower(s.channel) = 'mercari');
  if not v_mercari then return new; end if;
  perform public.mercari_label_reimbursement(new.store_id, new.sale_id, new.sku, new.ship_label_cents);
  new.ship_label_cents := null;
  new.ship_label_source := null;
  return new;
end $$;

drop trigger if exists mercari_channel_label_guard on public.channel_orders;
create trigger mercari_channel_label_guard
  before insert or update of ship_label_cents on public.channel_orders
  for each row execute function public.mercari_channel_label_guard();

create or replace function public.mercari_order_label_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if lower(coalesce(new.channel, '')) <> 'mercari' or coalesce(new.label_cost_cents, 0) <= 0 then
    return new;
  end if;
  perform public.mercari_label_reimbursement(new.store_id, new.sale_id, new.sku, new.label_cost_cents);
  new.label_cost_cents := null;
  return new;
end $$;

drop trigger if exists mercari_order_label_guard on public.web_orders;
create trigger mercari_order_label_guard
  before insert or update of label_cost_cents on public.web_orders
  for each row execute function public.mercari_order_label_guard();

create or replace function public.mercari_bought_label_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_channel text; v_store uuid; v_sale bigint; v_sku text;
begin
  if tg_op = 'UPDATE' and new.voided_at is not null then return new; end if;
  if coalesce(new.cost_cents, 0) <= 0 or new.voided_at is not null then return new; end if;
  select o.channel, o.store_id, o.sale_id, o.sku into v_channel, v_store, v_sale, v_sku
    from public.web_orders o where o.id = new.order_id;
  if lower(coalesce(v_channel, '')) = 'mercari' then
    perform public.mercari_label_reimbursement(v_store, v_sale, v_sku, new.cost_cents);
  end if;
  return new;
end $$;

drop trigger if exists mercari_bought_label_guard on public.web_order_labels;
create trigger mercari_bought_label_guard
  after insert or update of cost_cents, voided_at on public.web_order_labels
  for each row execute function public.mercari_bought_label_guard();

-- Existing Mercari labels become one reimbursement, then leave the sale.
do $$
declare r record;
begin
  for r in
    select s.id, s.store_id, s.sku,
      greatest(coalesce(wo.label_cost_cents, 0), coalesce(lbl.cents, 0), coalesce(co.ship_label_cents, 0)) as label
    from public.sales s
    left join lateral (
      select w.id, w.label_cost_cents from public.web_orders w
       where w.sale_id = s.id order by w.created_at limit 1
    ) wo on true
    left join lateral (
      select sum(l.cost_cents)::int as cents from public.web_order_labels l
       where l.order_id = wo.id and l.voided_at is null
    ) lbl on true
    left join lateral (
      select c.ship_label_cents from public.channel_orders c
       where c.sale_id = s.id order by c.created_at desc limit 1
    ) co on true
    where lower(s.channel) = 'mercari' and s.voided_at is null
      and greatest(coalesce(wo.label_cost_cents, 0), coalesce(lbl.cents, 0), coalesce(co.ship_label_cents, 0)) > 0
  loop
    perform public.mercari_label_reimbursement(r.store_id, r.id, r.sku, r.label);
  end loop;
end $$;

update public.channel_orders
   set ship_label_cents = null, ship_label_source = null, baked_ship_cents = 0
 where lower(provider) = 'mercari'
   and (coalesce(ship_label_cents, 0) > 0 or coalesce(baked_ship_cents, 0) > 0);

update public.web_orders
   set label_cost_cents = null
 where lower(channel) = 'mercari' and coalesce(label_cost_cents, 0) > 0;

-- Orders → label cost on a Mercari order is only the reimbursement.
create or replace function public.portal_set_order_label_cost(p_order uuid, p_label_cents int)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_order public.web_orders%rowtype;
  v_prev uuid;
  v_owner text;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if p_label_cents is null or p_label_cents < 0 or p_label_cents > 50000 then
    raise exception 'invalid_label_cost';
  end if;
  select * into v_order from public.web_orders where id = p_order and store_id = v_store;
  if not found then raise exception 'order_not_found'; end if;
  if lower(coalesce(v_order.channel, '')) = 'mercari' then
    if p_label_cents > 0 then
      perform public.mercari_label_reimbursement(v_store, v_order.sale_id, v_order.sku, p_label_cents);
    end if;
    return;
  end if;
  if v_order.status <> 'paid' or v_order.fulfillment <> 'ship' then
    raise exception 'order_not_shippable';
  end if;
  if v_order.label_purchased_at is null and coalesce(v_order.pack_condition, '') <> 'ok' then
    raise exception 'Confirm the item matches the listing before recording a label cost.';
  end if;
  update public.web_orders set
    label_cost_cents = p_label_cents,
    label_purchased_at = coalesce(label_purchased_at, now()),
    shipping_rate = case
      when shipping_rate is null or shipping_rate = '{}'::jsonb
        then jsonb_build_object('source', 'manual', 'service', 'Purchased externally')
      else shipping_rate || jsonb_build_object('source', coalesce(shipping_rate->>'source', 'manual'))
    end,
    updated_at = now()
  where id = p_order and store_id = v_store;
  if v_order.payment_id like '%:%' then
    update public.channel_orders set
      ship_label_cents = p_label_cents,
      ship_label_source = case
        when ship_label_source in ('ebay', 'marketplace', 'shippo') then ship_label_source
        else 'manual' end
    where store_id = v_store
      and (order_id = v_order.order_no or order_id = split_part(v_order.payment_id, ':', 2));
  end if;
  select nullif(value #>> '{}', '') into v_owner from public.store_settings
   where store_id = v_store and key = 'online_payout_employee_id';
  if v_owner is not null and v_owner !~* '^[0-9a-f-]{36}$' then v_owner := null; end if;
  select id into v_prev from public.portal_expenses
   where store_id = v_store and order_id = p_order and source = 'manual_label' and voided_at is null
   limit 1;
  if v_prev is not null then
    update public.portal_expenses set
      amount_cents = p_label_cents,
      description = 'Shipping label ' || coalesce(v_order.order_no, p_order::text),
      employee_id = v_owner::uuid,
      needs_reimbursement = (v_owner is not null)
    where id = v_prev;
  elsif p_label_cents > 0 then
    insert into public.portal_expenses(
      store_id, description, category, amount_cents, needs_reimbursement, employee_id, source, order_id)
    values (v_store, 'Shipping label ' || coalesce(v_order.order_no, p_order::text), 'Shipping', p_label_cents, v_owner is not null, v_owner::uuid, 'manual_label', p_order);
  end if;
end $$;
revoke all on function public.portal_set_order_label_cost(uuid, int) from public, anon;
grant execute on function public.portal_set_order_label_cost(uuid, int) to authenticated;

-- Re-freeze Mercari commissions from the corrected ledger. Payments are not touched.
do $$
declare r record;
begin
  for r in
    select id from public.sales where lower(channel) = 'mercari' and voided_at is null order by id
  loop
    delete from public.sale_commissions where sale_id = r.id;
    delete from public.sale_payout_lines where sale_id = r.id;
    perform public.payout_snapshot_sale(r.id);
  end loop;
end $$;

-- Mercari tab entry (sale price, fee, payout only) is applied after the channel-parity
-- functions, in 20261207160000_mercari_sale_fields.sql.

commit;
