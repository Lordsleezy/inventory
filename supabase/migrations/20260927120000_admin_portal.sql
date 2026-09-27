-- Browser admin portal. Membership is deliberately separate from Floor staff roles.
create table public.portal_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.portal_admins enable row level security;
create policy portal_admin_self on public.portal_admins for select to authenticated
  using (user_id = auth.uid());
revoke all on public.portal_admins from public, anon, authenticated;
grant select on public.portal_admins to authenticated;

create function public.portal_store_id() returns uuid language sql stable security definer
set search_path = public as $$
  select store_id from public.portal_admins where user_id = auth.uid()
$$;
revoke all on function public.portal_store_id() from public, anon;
grant execute on function public.portal_store_id() to authenticated;

-- Realtime applies this SELECT policy before delivering sale changes.
create policy portal_admin_sales on public.sales for select to authenticated
  using (store_id = public.portal_store_id());
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
    and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'sales') then
    alter publication supabase_realtime add table public.sales;
  end if;
end $$;

-- Only the columns needed by the portal leave this function. All amounts are cents.
create function public.portal_sales(p_from timestamptz, p_to timestamptz)
returns table (
  id bigint, ticket_key text, sku text, title text, qty int, sold_at timestamptz,
  price_cents int, tax_cents int, card_fee_cents int, cost_cents int,
  payment_method text, cash_cents int, card_cents int, actor_id uuid,
  actor_name text, channel text, receipt_no text
) language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to > p_from + interval '93 days' then
    raise exception 'invalid_date_range' using errcode = '22023';
  end if;
  return query
    select s.id, coalesce(s.ticket_id::text, 'sale:' || s.id::text), s.sku,
      coalesce(nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), nullif(u.title, ''), 'Item')::text,
      s.qty, s.sold_at, s.price_cents, s.tax_cents, s.card_fee_cents,
      u.acquisition_cost_cents, s.payment_method, x.cash_cents, x.card_cents,
      s.actor_id, coalesce(st.display_name, 'Unknown')::text, s.channel, s.receipt_no
    from public.sales s
    left join public.units u on u.store_id = s.store_id and u.sku = s.sku
    left join public.staff st on st.store_id = s.store_id and st.user_id = s.actor_id
    left join public.ticket_extras x on x.store_id = s.store_id and x.ticket_id = s.ticket_id
    where s.store_id = v_store and s.voided_at is null and s.sold_at >= p_from and s.sold_at < p_to
    order by s.sold_at desc, s.id desc;
end $$;
revoke all on function public.portal_sales(timestamptz,timestamptz) from public, anon;
grant execute on function public.portal_sales(timestamptz,timestamptz) to authenticated;

create function public.portal_people()
returns table (user_id uuid, display_name text, kind text)
language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return query
    select s.user_id, s.display_name, 'employee'::text from public.staff s
    where s.store_id = v_store and s.deactivated_at is null
    union
    select a.user_id, coalesce(u.email, 'Admin')::text, 'admin'::text
    from public.portal_admins a join auth.users u on u.id = a.user_id
    where a.store_id = v_store;
end $$;
revoke all on function public.portal_people() from public, anon;
grant execute on function public.portal_people() to authenticated;

create table public.portal_payout_rules (
  store_id uuid not null references public.stores(id) on delete cascade,
  employee_id uuid not null references auth.users(id),
  method text not null check (method in ('percent_sale','flat_ticket','percent_profit')),
  rate numeric(10,2) not null check (rate >= 0 and (method = 'flat_ticket' or rate <= 100)),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  primary key (store_id, employee_id)
);
create table public.portal_paid_payouts (
  store_id uuid not null references public.stores(id) on delete cascade,
  ticket_key text not null,
  employee_id uuid not null references auth.users(id),
  amount_cents int not null check (amount_cents >= 0),
  paid_at timestamptz not null default now(),
  paid_by uuid not null references auth.users(id),
  primary key (store_id, ticket_key)
);
create table public.portal_reports (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  period_type text not null check (period_type in ('daily','weekly')),
  period_start date not null,
  period_end date not null,
  summary jsonb not null,
  expenses jsonb not null default '[]'::jsonb check (jsonb_typeof(expenses) = 'array'),
  notes text not null default '',
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  edited_at timestamptz not null default now(),
  edited_by uuid not null references auth.users(id),
  check (period_end > period_start),
  unique (store_id, period_type, period_start)
);

create function public.portal_stamp() returns trigger language plpgsql set search_path = public as $$
begin
  new.edited_at := now(); new.edited_by := auth.uid();
  if tg_op = 'INSERT' then new.created_by := auth.uid(); end if;
  if tg_op = 'UPDATE' then
    new.store_id := old.store_id; new.created_at := old.created_at;
    new.created_by := old.created_by; new.period_type := old.period_type;
    new.period_start := old.period_start; new.period_end := old.period_end;
    new.summary := old.summary;
  end if;
  return new;
end $$;
create trigger portal_reports_stamp before insert or update on public.portal_reports
  for each row execute function public.portal_stamp();

create function public.portal_paid_stamp() returns trigger language plpgsql set search_path = public as $$
declare v_lines int; v_matching int; v_sales numeric; v_cost numeric; v_missing int; v_rule public.portal_payout_rules;
begin
  select count(*), count(*) filter (where s.actor_id = new.employee_id),
    coalesce(sum(s.price_cents), 0), coalesce(sum(u.acquisition_cost_cents * s.qty), 0),
    count(*) filter (where u.acquisition_cost_cents is null)
  into v_lines, v_matching, v_sales, v_cost, v_missing
  from public.sales s left join public.units u on u.store_id = s.store_id and u.sku = s.sku
  where s.store_id = new.store_id and s.voided_at is null
    and coalesce(s.ticket_id::text, 'sale:' || s.id::text) = new.ticket_key;
  if v_lines = 0 or v_matching <> v_lines then
    raise exception 'invalid_payout_ticket' using errcode = '22023';
  end if;
  select * into v_rule from public.portal_payout_rules
  where store_id = new.store_id and employee_id = new.employee_id;
  if not found then raise exception 'payout_rule_required' using errcode = '22023'; end if;
  if v_rule.method = 'percent_profit' and v_missing > 0 then
    raise exception 'item_cost_required' using errcode = '22023';
  end if;
  new.amount_cents := case v_rule.method
    when 'flat_ticket' then round(v_rule.rate * 100)::int
    when 'percent_sale' then round(v_sales * v_rule.rate / 100)::int
    else round(greatest(0, v_sales - v_cost) * v_rule.rate / 100)::int end;
  new.paid_by := auth.uid(); new.paid_at := now();
  return new;
end $$;
create trigger portal_paid_stamp before insert on public.portal_paid_payouts
  for each row execute function public.portal_paid_stamp();

create function public.portal_rule_stamp() returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_by := auth.uid(); new.updated_at := now();
  if tg_op = 'UPDATE' then new.store_id := old.store_id; new.employee_id := old.employee_id; end if;
  return new;
end $$;
create trigger portal_rule_stamp before insert or update on public.portal_payout_rules
  for each row execute function public.portal_rule_stamp();

do $$ declare t text; begin
  foreach t in array array['portal_payout_rules','portal_paid_payouts','portal_reports'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('create policy portal_select on public.%I for select to authenticated using (store_id = public.portal_store_id())', t);
    execute format('create policy portal_insert on public.%I for insert to authenticated with check (store_id = public.portal_store_id())', t);
    execute format('grant select, insert on public.%I to authenticated', t);
    if t <> 'portal_paid_payouts' then
      execute format('create policy portal_update on public.%I for update to authenticated using (store_id = public.portal_store_id()) with check (store_id = public.portal_store_id())', t);
      execute format('grant update on public.%I to authenticated', t);
    end if;
  end loop;
end $$;
-- Paid entries are intentionally irreversible in the portal; correcting one is an admin SQL operation.
create index portal_reports_newest on public.portal_reports(store_id, created_at desc);
