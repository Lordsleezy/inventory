-- Pickup-only launch switch, packing-time labels, acquisition cost tools, online payout settings,
-- standalone expenses (incl. automatic label expenses) and the monthly sales tax report.
begin;

alter table public.units drop constraint if exists units_dims_source_allowed;
alter table public.units add constraint units_dims_source_allowed
  check (dims_source is null or dims_source in ('verified','estimated','measured'));

-- Settings (owner = the staff member with role owner).
insert into public.store_settings (store_id, key, value)
select s.id, d.key, d.value from public.stores s
cross join lateral (values
  ('shipping_enabled', 'false'::jsonb),
  ('online_channels', '["website"]'::jsonb),
  ('online_payout_pct', '30'::jsonb),
  ('online_payout_employee_id', coalesce((select to_jsonb(st.user_id::text) from public.staff st
      where st.store_id = s.id and st.role = 'owner' and st.deactivated_at is null order by st.user_id limit 1), 'null'::jsonb))
) d(key, value)
on conflict (store_id, key) do nothing;

-- Ship check: the original rules, then the master shipping switch. Missing dims still read as
-- "missing", so the admin can see what is waiting for shipping to be turned on.
create or replace function public.unit_ship_rules(u public.units)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_dims numeric[];
  v_text text;
  k text;
  v_max_lb numeric := coalesce(nullif(public.store_setting(u.store_id,'ship_max_weight_lb','70'::jsonb) #>> '{}','')::numeric, 70);
  v_max_len numeric := coalesce(nullif(public.store_setting(u.store_id,'ship_max_length_in','108'::jsonb) #>> '{}','')::numeric, 108);
  v_max_lg numeric := coalesce(nullif(public.store_setting(u.store_id,'ship_max_length_girth_in','165'::jsonb) #>> '{}','')::numeric, 165);
begin
  if u.fulfillment_override = 'pickup' then
    return jsonb_build_object('ship', false, 'reason', 'Pickup only (set by staff)');
  end if;
  if coalesce(u.package_weight_lb,0) <= 0 or coalesce(u.package_length_in,0) <= 0
     or coalesce(u.package_width_in,0) <= 0 or coalesce(u.package_height_in,0) <= 0 then
    return jsonb_build_object('ship', false, 'missing_dims', true, 'reason', 'Missing package dimensions or weight');
  end if;
  if u.fulfillment_override = 'ship' then
    return jsonb_build_object('ship', true, 'reason', 'Shipping forced on by staff');
  end if;
  if lower(btrim(coalesce(u.category,''))) = any (public.setting_text_array(u.store_id,'ship_excluded_categories')) then
    return jsonb_build_object('ship', false, 'reason', format('%s is a pickup-only category', u.category));
  end if;
  v_text := lower(concat_ws(' ', u.title, u.brand, u.model, u.category));
  foreach k in array public.setting_text_array(u.store_id,'ship_excluded_keywords') loop
    if v_text ~ ('\m' || regexp_replace(k, '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g') || '\M') then
      return jsonb_build_object('ship', false, 'reason', format('Large item ("%s")', k));
    end if;
  end loop;
  v_dims := array(select x from unnest(array[u.package_length_in,u.package_width_in,u.package_height_in]) x order by x desc);
  if u.package_weight_lb > v_max_lb then
    return jsonb_build_object('ship', false, 'reason', format('Package %s lb is over the %s lb limit', u.package_weight_lb, v_max_lb));
  end if;
  if v_dims[1] > v_max_len then
    return jsonb_build_object('ship', false, 'reason', format('Longest side %s in is over the %s in limit', v_dims[1], v_max_len));
  end if;
  if v_dims[1] + 2 * (v_dims[2] + v_dims[3]) > v_max_lg then
    return jsonb_build_object('ship', false, 'reason', format('Length + girth %s in is over the %s in limit',
      v_dims[1] + 2 * (v_dims[2] + v_dims[3]), v_max_lg));
  end if;
  return jsonb_build_object('ship', true, 'reason', 'Ships');
end $$;
revoke all on function public.unit_ship_rules(public.units) from public, anon;
grant execute on function public.unit_ship_rules(public.units) to authenticated, service_role;

create or replace function public.unit_ship_check(u public.units)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r jsonb := public.unit_ship_rules(u);
begin
  if coalesce((r->>'ship')::boolean, false)
     and not coalesce((public.store_setting(u.store_id,'shipping_enabled','false'::jsonb) #>> '{}')::boolean, false) then
    return jsonb_build_object('ship', false, 'shipping_off', true,
      'reason', 'Shipping is turned off (store pickup only). Would ship once shipping is on.');
  end if;
  return r;
end $$;

-- Label history: every label bought, so a void/re-buy keeps a record.
alter table public.web_orders add column if not exists label_buying_at timestamptz;
create table if not exists public.web_order_labels (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  order_id uuid not null references public.web_orders(id) on delete cascade,
  transaction_id text not null,
  rate_id text,
  carrier text, service text, estimated_days int,
  cost_cents int not null check (cost_cents > 0),
  tracking_number text, tracking_url text, label_url text,
  box jsonb,
  purchased_at timestamptz not null default now(),
  purchased_by text,
  voided_at timestamptz,
  void_status text
);
alter table public.web_order_labels enable row level security;
revoke all on public.web_order_labels from anon, authenticated;
grant all on public.web_order_labels to service_role;

-- Expenses (manual + automatic label costs). Replaces typing expenses into a daily report.
create table if not exists public.portal_expenses (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  spent_on date not null default ((now() at time zone 'America/Los_Angeles')::date),
  description text not null check (btrim(description) <> ''),
  category text not null default 'Other',
  amount_cents int not null check (amount_cents > 0),
  needs_reimbursement boolean not null default true,
  employee_id uuid,
  source text not null default 'manual' check (source in ('manual','label')),
  order_id uuid references public.web_orders(id) on delete set null,
  label_id uuid references public.web_order_labels(id) on delete set null,
  created_by uuid,
  created_at timestamptz not null default now(),
  voided_at timestamptz,
  void_reason text
);
create index if not exists portal_expenses_store_date on public.portal_expenses(store_id, spent_on desc);
alter table public.portal_expenses enable row level security;
drop policy if exists portal_expenses_select on public.portal_expenses;
create policy portal_expenses_select on public.portal_expenses for select to authenticated
  using (store_id = public.portal_store_id());
revoke all on public.portal_expenses from anon;
revoke insert, update, delete on public.portal_expenses from authenticated;
grant select on public.portal_expenses to authenticated;
grant all on public.portal_expenses to service_role;

create or replace function public.portal_owner_employee()
returns uuid language sql stable security definer set search_path = public as $$
  select nullif(public.store_setting(public.portal_store_id(),'online_payout_employee_id','null'::jsonb) #>> '{}','')::uuid
$$;

create or replace function public.portal_add_expense(p_spent_on date, p_description text, p_category text,
  p_amount_cents int, p_needs_reimbursement boolean default true, p_employee uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id(); v_emp uuid; v_id uuid;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if p_amount_cents is null or p_amount_cents <= 0 then raise exception 'amount_required' using errcode = '22023'; end if;
  v_emp := coalesce(p_employee, public.portal_owner_employee());
  if coalesce(p_needs_reimbursement, true) and (v_emp is null
     or not exists(select 1 from public.staff s where s.user_id = v_emp and s.store_id = v_store and s.deactivated_at is null)) then
    raise exception 'reimbursement_recipient_required' using errcode = '22023';
  end if;
  insert into public.portal_expenses(store_id, spent_on, description, category, amount_cents, needs_reimbursement, employee_id, created_by)
  values (v_store, coalesce(p_spent_on, (now() at time zone 'America/Los_Angeles')::date), btrim(p_description),
          coalesce(nullif(btrim(p_category),''),'Other'), p_amount_cents, coalesce(p_needs_reimbursement,true),
          case when coalesce(p_needs_reimbursement,true) then v_emp end, auth.uid())
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.portal_update_expense(p_id uuid, p_spent_on date, p_description text, p_category text,
  p_amount_cents int, p_needs_reimbursement boolean, p_employee uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id(); v_emp uuid;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if p_amount_cents is null or p_amount_cents <= 0 then raise exception 'amount_required' using errcode = '22023'; end if;
  v_emp := coalesce(p_employee, public.portal_owner_employee());
  update public.portal_expenses set spent_on = coalesce(p_spent_on, spent_on), description = btrim(p_description),
    category = coalesce(nullif(btrim(p_category),''),'Other'), amount_cents = p_amount_cents,
    needs_reimbursement = coalesce(p_needs_reimbursement,true),
    employee_id = case when coalesce(p_needs_reimbursement,true) then v_emp end
   where id = p_id and store_id = v_store and source = 'manual' and voided_at is null;
  if not found then raise exception 'expense_not_editable' using errcode = 'P0001'; end if;
end $$;

create or replace function public.portal_delete_expense(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  update public.portal_expenses set voided_at = now(), void_reason = 'deleted'
   where id = p_id and store_id = v_store and source = 'manual' and voided_at is null;
  if not found then raise exception 'expense_not_editable' using errcode = 'P0001'; end if;
end $$;

-- Online payout configuration (shared by website now; eBay etc. later by adding the channel).
create or replace function public.portal_payout_config()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return jsonb_build_object(
    'online_channels', public.store_setting(v_store,'online_channels','["website"]'::jsonb),
    'online_payout_pct', public.store_setting(v_store,'online_payout_pct','30'::jsonb),
    'online_payout_employee_id', public.store_setting(v_store,'online_payout_employee_id','null'::jsonb));
end $$;

create or replace function public.portal_set_payout_config(p_channels jsonb, p_pct numeric, p_employee uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if jsonb_typeof(p_channels) <> 'array' or exists(select 1 from jsonb_array_elements(p_channels) x where jsonb_typeof(x) <> 'string') then
    raise exception 'channel_list_required' using errcode = '22023';
  end if;
  if p_pct is null or p_pct < 0 or p_pct > 100 then raise exception 'percent_0_to_100_required' using errcode = '22023'; end if;
  if p_employee is null or not exists(select 1 from public.staff s where s.user_id = p_employee and s.store_id = v_store and s.deactivated_at is null) then
    raise exception 'recipient_must_be_active_staff' using errcode = '22023';
  end if;
  insert into public.store_settings(store_id, key, value) values
    (v_store, 'online_channels', (select coalesce(jsonb_agg(lower(btrim(x))), '[]'::jsonb) from jsonb_array_elements_text(p_channels) x where btrim(x) <> '')),
    (v_store, 'online_payout_pct', to_jsonb(p_pct)),
    (v_store, 'online_payout_employee_id', to_jsonb(p_employee::text))
  on conflict (store_id, key) do update set value = excluded.value;
end $$;

-- Acquisition cost helpers.
create or replace function public.portal_units_missing_cost(p_limit int default 100, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return jsonb_build_object(
    'total', (select count(*) from public.units u where u.store_id = v_store and u.acquisition_cost_cents is null and u.state in ('available','reserved','sold')),
    'sold', (select count(*) from public.units u where u.store_id = v_store and u.acquisition_cost_cents is null and u.state = 'sold'),
    'rows', coalesce((select jsonb_agg(x) from (
      select u.sku, coalesce(nullif(btrim(u.title),''), nullif(btrim(concat_ws(' ', u.brand, u.model)),''), 'Item') as title,
             u.brand, u.model, u.state, u.ask_cents, u.received_at,
             (select max(s.sold_at) from public.sales s where s.store_id = u.store_id and s.sku = u.sku and s.voided_at is null) as sold_at,
             (select max(s.channel) from public.sales s where s.store_id = u.store_id and s.sku = u.sku and s.voided_at is null) as sold_channel,
             (select max(s.price_cents) from public.sales s where s.store_id = u.store_id and s.sku = u.sku and s.voided_at is null) as sold_price_cents
        from public.units u
       where u.store_id = v_store and u.acquisition_cost_cents is null and u.state in ('available','reserved','sold')
       order by (u.state = 'sold') desc, u.received_at desc
       limit greatest(p_limit,1) offset greatest(p_offset,0)) x), '[]'::jsonb));
end $$;

create or replace function public.portal_set_unit_cost(p_sku text, p_cost_cents int)
returns void language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id(); v_old int;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if p_cost_cents is not null and p_cost_cents < 0 then raise exception 'cost_must_not_be_negative' using errcode = '22023'; end if;
  select acquisition_cost_cents into v_old from public.units where store_id = v_store and sku = p_sku for update;
  if not found then raise exception 'unit_not_found' using errcode = 'P0001'; end if;
  update public.units set acquisition_cost_cents = p_cost_cents, updated_at = now() where store_id = v_store and sku = p_sku;
  insert into public.events (store_id, sku, kind, field, old_value, new_value, actor, actor_id)
  values (v_store, p_sku, 'edit', 'acquisition_cost_cents', v_old::text, p_cost_cents::text,
          coalesce((select email from auth.users where id = auth.uid()), 'admin'), auth.uid());
end $$;

-- Any staff member can enter the cost while receiving (only when none is recorded yet).
create or replace function public.set_unit_cost_if_missing(p_sku text, p_cost_cents int)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.current_store_id();
begin
  perform public.assert_staff_or_service();
  if v_store is null then raise exception 'no_store' using errcode = 'P0001'; end if;
  if p_cost_cents is null or p_cost_cents < 0 then raise exception 'cost_must_not_be_negative' using errcode = '22023'; end if;
  update public.units set acquisition_cost_cents = p_cost_cents, updated_at = now()
   where store_id = v_store and sku = p_sku and acquisition_cost_cents is null;
  if found then
    insert into public.events (store_id, sku, kind, field, old_value, new_value, actor, actor_id)
    values (v_store, p_sku, 'edit', 'acquisition_cost_cents', null, p_cost_cents::text,
            coalesce((select display_name from public.staff where user_id = auth.uid()), 'staff'), auth.uid());
  end if;
  return found;
end $$;

-- Cost for the unit edit screens: value only for managers; clerks just learn whether it is missing.
create or replace function public.unit_cost_info(p_sku text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.current_store_id(); u public.units;
begin
  perform public.assert_staff_or_service();
  select * into u from public.units where store_id = v_store and sku = p_sku;
  if not found then return null; end if;
  return jsonb_build_object('missing', u.acquisition_cost_cents is null,
    'cost_cents', case when public.is_manager() then u.acquisition_cost_cents end, 'manager', public.is_manager());
end $$;

-- Settings screen: adds the shipping switch and how many units are ready for it.
create or replace function public.portal_online_settings()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return jsonb_build_object(
    'shipping_enabled', public.store_setting(v_store,'shipping_enabled','false'::jsonb),
    'ship_excluded_categories', public.store_setting(v_store,'ship_excluded_categories','[]'::jsonb),
    'ship_excluded_keywords', public.store_setting(v_store,'ship_excluded_keywords','[]'::jsonb),
    'ship_max_weight_lb', public.store_setting(v_store,'ship_max_weight_lb','70'::jsonb),
    'ship_max_length_in', public.store_setting(v_store,'ship_max_length_in','108'::jsonb),
    'ship_max_length_girth_in', public.store_setting(v_store,'ship_max_length_girth_in','165'::jsonb),
    'pickup_hold_hours', public.store_setting(v_store,'pickup_hold_hours','48'::jsonb),
    'order_notify_emails', public.store_setting(v_store,'order_notify_emails','[]'::jsonb),
    'categories', public.store_setting(v_store,'categories','[]'::jsonb),
    'store_tax_bps', public.store_setting(v_store,'taxRateBps','0'::jsonb),
    'tax_origin_state', public.store_setting(v_store,'tax_origin_state','"CA"'::jsonb),
    'tax_out_of_state_bps', public.store_setting(v_store,'tax_out_of_state_bps','0'::jsonb),
    'tax_in_state_ship_bps', public.store_setting(v_store,'tax_in_state_ship_bps','null'::jsonb),
    'tax_shipping', public.store_setting(v_store,'tax_shipping','false'::jsonb),
    'counts', (select jsonb_build_object(
        'listed', count(*),
        'shippable', count(*) filter (where s.shippable),
        'pickup_only', count(*) filter (where not s.shippable),
        'ready_when_shipping_on', count(*) filter (where s.ship_note like 'Shipping is turned off%'),
        'missing_dims', count(*) filter (where s.ship_note = 'Missing package dimensions or weight'))
      from public.storefront_items s where s.store_id = v_store),
    'pickup_only_units', coalesce((select jsonb_agg(jsonb_build_object('sku',s.sku,'title',
        coalesce(nullif(btrim(s.title),''), concat_ws(' ', s.brand, s.model)),'category',s.category,'reason',s.ship_note) order by s.sku)
      from public.storefront_items s where s.store_id = v_store and not s.shippable), '[]'::jsonb));
end $$;

-- Monthly sales tax report (America/Los_Angeles months). Gross sales are everything sold in the month;
-- refunds are sales voided in the month; both grouped the same way so net = sales - refunds.
create or replace function public.portal_tax_report(p_month date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_from timestamptz; v_to timestamptz;
  v_origin text;
  v_channels text[];
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  v_from := (date_trunc('month', p_month)::timestamp) at time zone 'America/Los_Angeles';
  v_to := ((date_trunc('month', p_month) + interval '1 month')::timestamp) at time zone 'America/Los_Angeles';
  v_origin := upper(coalesce(nullif(btrim(public.store_setting(v_store,'tax_origin_state','"CA"'::jsonb) #>> '{}'),''),'CA'));
  v_channels := public.setting_text_array(v_store,'online_channels');
  return jsonb_build_object('month', to_char(date_trunc('month', p_month), 'YYYY-MM'), 'origin_state', v_origin,
    'rows', coalesce((select jsonb_agg(r order by r.sort) from (
      with cls as (
        select s.id, s.price_cents, s.tax_cents, coalesce(s.shipping_cents,0) as shipping_cents, s.sold_at, s.voided_at,
          case
            when o.id is null and lower(s.channel) = any (v_channels) then 'other_online'
            when o.id is null then 'in_store'
            when o.fulfillment = 'pickup' then 'pickup'
            when upper(coalesce(o.ship_region,'')) = v_origin then 'ship_in_state'
            else 'ship_out_of_state' end as cat
        from public.sales s left join public.web_orders o on o.sale_id = s.id
        where s.store_id = v_store
          and ((s.sold_at >= v_from and s.sold_at < v_to) or (s.voided_at >= v_from and s.voided_at < v_to)))
      select c.cat as category,
        case c.cat when 'in_store' then 1 when 'pickup' then 2 when 'ship_in_state' then 3 when 'ship_out_of_state' then 4 else 5 end as sort,
        count(*) filter (where c.sold_at >= v_from and c.sold_at < v_to) as sales_count,
        coalesce(sum(c.price_cents) filter (where c.sold_at >= v_from and c.sold_at < v_to), 0) as sales_cents,
        coalesce(sum(c.price_cents) filter (where c.sold_at >= v_from and c.sold_at < v_to and c.tax_cents > 0), 0) as taxable_cents,
        coalesce(sum(c.tax_cents) filter (where c.sold_at >= v_from and c.sold_at < v_to), 0) as tax_cents,
        coalesce(sum(c.shipping_cents) filter (where c.sold_at >= v_from and c.sold_at < v_to), 0) as shipping_cents,
        count(*) filter (where c.voided_at >= v_from and c.voided_at < v_to) as refund_count,
        coalesce(sum(c.price_cents) filter (where c.voided_at >= v_from and c.voided_at < v_to), 0) as refund_sales_cents,
        coalesce(sum(c.price_cents) filter (where c.voided_at >= v_from and c.voided_at < v_to and c.tax_cents > 0), 0) as refund_taxable_cents,
        coalesce(sum(c.tax_cents) filter (where c.voided_at >= v_from and c.voided_at < v_to), 0) as refund_tax_cents,
        coalesce(sum(c.shipping_cents) filter (where c.voided_at >= v_from and c.voided_at < v_to), 0) as refund_shipping_cents
      from cls c group by c.cat) r), '[]'::jsonb));
end $$;

revoke all on function public.portal_owner_employee(), public.portal_add_expense(date,text,text,int,boolean,uuid),
  public.portal_update_expense(uuid,date,text,text,int,boolean,uuid), public.portal_delete_expense(uuid),
  public.portal_payout_config(), public.portal_set_payout_config(jsonb,numeric,uuid),
  public.portal_units_missing_cost(int,int), public.portal_set_unit_cost(text,int),
  public.set_unit_cost_if_missing(text,int), public.unit_cost_info(text), public.portal_tax_report(date)
  from public, anon;
grant execute on function public.portal_owner_employee(), public.portal_add_expense(date,text,text,int,boolean,uuid),
  public.portal_update_expense(uuid,date,text,text,int,boolean,uuid), public.portal_delete_expense(uuid),
  public.portal_payout_config(), public.portal_set_payout_config(jsonb,numeric,uuid),
  public.portal_units_missing_cost(int,int), public.portal_set_unit_cost(text,int),
  public.set_unit_cost_if_missing(text,int), public.unit_cost_info(text), public.portal_tax_report(date)
  to authenticated, service_role;
commit;
