-- Loyalty: privacy (no staff table dump), admin list/adjust, email outbox,
-- public web lookup/signup, unsubscribe. Earn/redeem math is unchanged:
-- 1 point per $1, 1¢ per point (1% back), 5% first purchase, floor+website only.

alter table public.customers
  add column if not exists signup_code text,
  add column if not exists unsub_token uuid not null default gen_random_uuid(),
  add column if not exists unsubscribed_at timestamptz;

create unique index if not exists ux_customers_signup_code
  on public.customers (store_id, signup_code)
  where signup_code is not null;

create unique index if not exists ux_customers_unsub_token
  on public.customers (unsub_token);

update public.customers
   set signup_code = 'NEW5-' || upper(substr(replace(id::text, '-', ''), 1, 6))
 where signup_code is null;

create table if not exists public.email_outbox (
  id bigserial primary key,
  store_id uuid not null references public.stores (id),
  customer_id uuid references public.customers (id),
  campaign_id uuid,
  kind text not null check (kind in ('welcome', 'points', 'campaign')),
  to_email text not null,
  subject text,
  body_text text,
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'error', 'skipped')),
  error text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index if not exists ix_email_outbox_queued
  on public.email_outbox (status, created_at)
  where status = 'queued';

create table if not exists public.email_campaigns (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id),
  subject text not null,
  body_text text not null,
  filter jsonb not null default '{}'::jsonb,
  queued_count int not null default 0,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);

alter table public.email_outbox enable row level security;
alter table public.email_campaigns enable row level security;

revoke all on public.customers from anon, authenticated, public;
revoke all on public.customer_points_ledger from anon, authenticated, public;
revoke all on public.email_outbox from anon, authenticated, public;
revoke all on public.email_campaigns from anon, authenticated, public;

drop policy if exists staff_customers_select on public.customers;
drop policy if exists staff_customers_insert on public.customers;
drop policy if exists staff_customers_update on public.customers;
drop policy if exists staff_ledger_select on public.customer_points_ledger;

-- No authenticated table policies: phone/email only via security-definer RPCs.

create or replace function public.new_signup_code()
returns text
language sql
volatile
as $$
  select 'NEW5-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
$$;

create or replace function public.customer_credit_cents(p_store uuid, p_points int)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select greatest(coalesce(p_points, 0), 0)
       * greatest(public.store_setting_int(p_store, 'rewards_point_value_cents', 1), 0);
$$;

create or replace function public.customer_card(p_store uuid, r public.customers)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_bal int;
begin
  v_bal := public.customer_points_balance_internal(p_store, r.id);
  return jsonb_build_object(
    'id', r.id,
    'store_id', r.store_id,
    'phone', r.phone,
    'name', r.name,
    'email', r.email,
    'marketing_opt_in', r.marketing_opt_in,
    'first_purchase_discount_used', r.first_purchase_discount_used,
    'created_at', r.created_at,
    'signup_code', r.signup_code,
    'balance', v_bal,
    'credit_cents', public.customer_credit_cents(p_store, v_bal)
  );
end;
$$;

create or replace function public.lookup_customer_by_phone(p_phone text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
  v_phone text;
  r public.customers;
begin
  perform public.assert_staff_or_service();
  if v_store is null then
    raise exception 'no_store' using errcode = 'P0001';
  end if;
  v_phone := public.normalize_phone(p_phone);
  if v_phone is null then
    raise exception 'invalid_phone' using errcode = '22023';
  end if;
  select * into r from public.customers
   where store_id = v_store and phone = v_phone;
  if not found then
    return null;
  end if;
  return public.customer_card(v_store, r);
end;
$$;

create or replace function public.upsert_customer(
  p_phone text,
  p_name text default null,
  p_email text default null,
  p_marketing_opt_in boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
  v_phone text;
  r public.customers;
begin
  perform public.assert_staff_or_service();
  if v_store is null then
    raise exception 'no_store' using errcode = 'P0001';
  end if;
  v_phone := public.normalize_phone(p_phone);
  if v_phone is null then
    raise exception 'invalid_phone' using errcode = '22023';
  end if;

  insert into public.customers (
    store_id, phone, name, email, marketing_opt_in, signup_code
  ) values (
    v_store, v_phone,
    nullif(btrim(coalesce(p_name, '')), ''),
    nullif(btrim(coalesce(p_email, '')), ''),
    coalesce(p_marketing_opt_in, false),
    public.new_signup_code()
  )
  on conflict (store_id, phone) do update set
    name = coalesce(excluded.name, public.customers.name),
    email = coalesce(excluded.email, public.customers.email),
    marketing_opt_in = public.customers.marketing_opt_in or excluded.marketing_opt_in
  returning * into r;

  return public.customer_card(v_store, r);
end;
$$;

create or replace function public.web_upsert_customer(
  p_store uuid,
  p_phone text,
  p_name text default null,
  p_email text default null,
  p_marketing_opt_in boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_cust public.customers;
begin
  perform public.assert_service();
  if p_store is null or v_phone = '' then
    raise exception 'store_and_phone_required' using errcode = '22023';
  end if;
  perform set_config('floor.store_id', p_store::text, true);

  insert into public.customers (
    store_id, phone, name, email, marketing_opt_in, signup_code
  ) values (
    p_store, v_phone,
    nullif(btrim(coalesce(p_name, '')), ''),
    nullif(btrim(coalesce(p_email, '')), ''),
    coalesce(p_marketing_opt_in, false),
    public.new_signup_code()
  )
  on conflict (store_id, phone) do update
    set name = coalesce(excluded.name, public.customers.name),
        email = coalesce(excluded.email, public.customers.email),
        marketing_opt_in = public.customers.marketing_opt_in or excluded.marketing_opt_in
  returning * into v_cust;

  return public.customer_card(p_store, v_cust)
    || jsonb_build_object(
      'first_purchase_discount_used', v_cust.first_purchase_discount_used,
      'points_balance', public.customer_points_balance_internal(p_store, v_cust.id)
    );
end;
$$;

create or replace function public.web_lookup_customer(p_store uuid, p_phone text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_phone text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  r public.customers;
begin
  perform public.assert_service();
  if p_store is null or v_phone = '' then
    raise exception 'store_and_phone_required' using errcode = '22023';
  end if;
  select * into r from public.customers
   where store_id = p_store and phone = v_phone;
  if not found then
    return null;
  end if;
  return public.customer_card(p_store, r);
end;
$$;

create or replace function public.unsubscribe_loyalty(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.customers;
begin
  if p_token is null then
    raise exception 'token_required' using errcode = '22023';
  end if;
  update public.customers
     set unsubscribed_at = coalesce(unsubscribed_at, now()),
         marketing_opt_in = false
   where unsub_token = p_token
  returning * into r;
  if not found then
    raise exception 'unknown_token' using errcode = 'P0001';
  end if;
  return jsonb_build_object('ok', true, 'email', r.email);
end;
$$;

create or replace function public.list_customers(
  p_q text default null,
  p_limit int default 200
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
  v_lim int := greatest(1, least(coalesce(p_limit, 200), 500));
  v_q text := nullif(btrim(coalesce(p_q, '')), '');
  v_rows jsonb;
  v_point int;
begin
  perform public.assert_manager();
  if v_store is null then
    raise exception 'no_store' using errcode = 'P0001';
  end if;
  v_point := greatest(public.store_setting_int(v_store, 'rewards_point_value_cents', 1), 0);

  select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x.last_visit desc nulls last, x.created_at desc), '[]'::jsonb)
    into v_rows
    from (
      select
        c.id,
        c.phone,
        c.name,
        c.email,
        c.marketing_opt_in,
        (c.unsubscribed_at is not null) as unsubscribed,
        c.first_purchase_discount_used,
        c.signup_code,
        c.created_at,
        public.customer_points_balance_internal(v_store, c.id) as points,
        public.customer_points_balance_internal(v_store, c.id) * v_point as credit_cents,
        coalesce((
          select sum(s.price_cents)::bigint
            from public.ticket_extras te
            join public.sales s on s.ticket_id = te.ticket_id and s.store_id = v_store
           where te.customer_id = c.id
             and te.store_id = v_store
             and s.voided_at is null
             and s.channel in ('floor', 'website')
        ), 0) as spend_cents,
        (
          select max(s.sold_at)
            from public.ticket_extras te
            join public.sales s on s.ticket_id = te.ticket_id and s.store_id = v_store
           where te.customer_id = c.id
             and te.store_id = v_store
             and s.voided_at is null
             and s.channel in ('floor', 'website')
        ) as last_visit
      from public.customers c
      where c.store_id = v_store
        and (
          v_q is null
          or (
            regexp_replace(v_q, '\D', '', 'g') <> ''
            and c.phone like '%' || regexp_replace(v_q, '\D', '', 'g') || '%'
          )
          or c.name ilike '%' || v_q || '%'
          or c.email ilike '%' || v_q || '%'
        )
      order by last_visit desc nulls last, c.created_at desc
      limit v_lim
    ) x;

  return v_rows;
end;
$$;

create or replace function public.adjust_customer_points(
  p_customer_id uuid,
  p_delta int,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
  r public.customers;
  v_bal int;
  v_next int;
begin
  perform public.assert_manager();
  if v_store is null then
    raise exception 'no_store' using errcode = 'P0001';
  end if;
  if p_delta is null or p_delta = 0 then
    raise exception 'delta_required' using errcode = '22023';
  end if;
  select * into r from public.customers
   where id = p_customer_id and store_id = v_store;
  if not found then
    raise exception 'customer_not_found' using errcode = 'P0001';
  end if;
  v_bal := public.customer_points_balance_internal(v_store, r.id);
  v_next := v_bal + p_delta;
  if v_next < 0 then
    raise exception 'insufficient_points' using errcode = 'P0001';
  end if;
  insert into public.customer_points_ledger (
    store_id, customer_id, delta, balance_after, reason, actor_id
  ) values (
    v_store, r.id, p_delta, v_next, 'adjust', auth.uid()
  );
  return public.customer_card(v_store, r) || jsonb_build_object('note', nullif(btrim(coalesce(p_note, '')), ''));
end;
$$;

create or replace function public.queue_loyalty_campaign(
  p_subject text,
  p_body text,
  p_min_spend_cents int default 0,
  p_days int default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
  v_id uuid := gen_random_uuid();
  v_n int := 0;
  v_subject text := btrim(coalesce(p_subject, ''));
  v_body text := btrim(coalesce(p_body, ''));
begin
  perform public.assert_manager();
  if v_store is null then
    raise exception 'no_store' using errcode = 'P0001';
  end if;
  if v_subject = '' or v_body = '' then
    raise exception 'subject_and_body_required' using errcode = '22023';
  end if;

  insert into public.email_campaigns (id, store_id, subject, body_text, filter, created_by)
  values (
    v_id, v_store, v_subject, v_body,
    jsonb_build_object(
      'min_spend_cents', greatest(coalesce(p_min_spend_cents, 0), 0),
      'days', p_days
    ),
    auth.uid()
  );

  insert into public.email_outbox (
    store_id, customer_id, campaign_id, kind, to_email, subject, body_text
  )
  select
    v_store, c.id, v_id, 'campaign', c.email, v_subject, v_body
  from public.customers c
  where c.store_id = v_store
    and c.email is not null
    and c.marketing_opt_in
    and c.unsubscribed_at is null
    and (
      coalesce(p_min_spend_cents, 0) <= 0
      or coalesce((
        select sum(s.price_cents)
          from public.ticket_extras te
          join public.sales s on s.ticket_id = te.ticket_id and s.store_id = v_store
         where te.customer_id = c.id and s.voided_at is null
           and s.channel in ('floor', 'website')
      ), 0) >= p_min_spend_cents
    )
    and (
      p_days is null
      or exists (
        select 1
          from public.ticket_extras te
          join public.sales s on s.ticket_id = te.ticket_id and s.store_id = v_store
         where te.customer_id = c.id and s.voided_at is null
           and s.channel in ('floor', 'website')
           and s.sold_at >= now() - make_interval(days => p_days)
      )
    );

  get diagnostics v_n = row_count;
  update public.email_campaigns set queued_count = v_n where id = v_id;
  return jsonb_build_object('campaign_id', v_id, 'queued', v_n);
end;
$$;

create or replace function public.claim_email_outbox(p_limit int default 40)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n int := greatest(1, least(coalesce(p_limit, 40), 80));
  v_rows jsonb;
begin
  perform public.assert_service();
  with picked as (
    select id
      from public.email_outbox
     where status = 'queued'
     order by created_at
     limit v_n
     for update skip locked
  ), marked as (
    update public.email_outbox o
       set status = 'sending'
      from picked
     where o.id = picked.id
    returning o.id, o.store_id, o.customer_id, o.campaign_id, o.kind,
              o.to_email, o.subject, o.body_text, o.payload
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', m.id,
           'store_id', m.store_id,
           'customer_id', m.customer_id,
           'campaign_id', m.campaign_id,
           'kind', m.kind,
           'to_email', m.to_email,
           'subject', m.subject,
           'body_text', m.body_text,
           'payload', m.payload,
           'name', c.name,
           'signup_code', c.signup_code,
           'unsub_token', c.unsub_token,
           'points', public.customer_points_balance_internal(m.store_id, m.customer_id),
           'credit_cents', public.customer_credit_cents(
             m.store_id, public.customer_points_balance_internal(m.store_id, m.customer_id)
           )
         )), '[]'::jsonb)
    into v_rows
    from marked m
    left join public.customers c on c.id = m.customer_id;
  return coalesce(v_rows, '[]'::jsonb);
end;
$$;

-- claim_email_outbox above is racy if two drains overlap; mark by ids instead.
create or replace function public.finish_email_outbox(p_id bigint, p_ok boolean, p_error text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_service();
  if p_ok then
    update public.email_outbox
       set status = 'sent', sent_at = now(), error = null
     where id = p_id;
  else
    update public.email_outbox
       set status = 'error', error = left(coalesce(p_error, 'send_failed'), 500)
     where id = p_id;
  end if;
end;
$$;

create or replace function public.tg_customers_welcome()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.email is not null then
    insert into public.email_outbox (store_id, customer_id, kind, to_email)
    values (NEW.store_id, NEW.id, 'welcome', NEW.email);
  end if;
  return NEW;
end;
$$;

drop trigger if exists customers_welcome on public.customers;
create trigger customers_welcome
  after insert on public.customers
  for each row execute function public.tg_customers_welcome();

create or replace function public.tg_ledger_points_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
  v_unsub timestamptz;
begin
  if NEW.reason <> 'earn_sale' then
    return NEW;
  end if;
  select email, unsubscribed_at into v_email, v_unsub
    from public.customers where id = NEW.customer_id;
  if v_email is null or v_unsub is not null then
    return NEW;
  end if;
  insert into public.email_outbox (
    store_id, customer_id, kind, to_email, payload
  ) values (
    NEW.store_id, NEW.customer_id, 'points', v_email,
    jsonb_build_object(
      'earned', NEW.delta,
      'balance', NEW.balance_after,
      'ticket_id', NEW.ticket_id
    )
  );
  return NEW;
end;
$$;

drop trigger if exists ledger_points_email on public.customer_points_ledger;
create trigger ledger_points_email
  after insert on public.customer_points_ledger
  for each row execute function public.tg_ledger_points_email();

revoke all on function public.web_upsert_customer(uuid, text, text, text) from public, anon, authenticated;
drop function if exists public.web_upsert_customer(uuid, text, text, text);

revoke all on function public.lookup_customer_by_phone(text) from public, anon;
revoke all on function public.upsert_customer(text, text, text, boolean) from public, anon;
revoke all on function public.customer_points_balance(uuid) from public, anon;
revoke all on function public.customer_points_history(uuid, int) from public, anon;
revoke all on function public.list_customers(text, int) from public, anon;
revoke all on function public.adjust_customer_points(uuid, int, text) from public, anon;
revoke all on function public.queue_loyalty_campaign(text, text, int, int) from public, anon;
revoke all on function public.web_lookup_customer(uuid, text) from public, anon, authenticated;
revoke all on function public.web_upsert_customer(uuid, text, text, text, boolean) from public, anon, authenticated;
revoke all on function public.unsubscribe_loyalty(uuid) from public, anon, authenticated;
revoke all on function public.claim_email_outbox(int) from public, anon, authenticated;
revoke all on function public.finish_email_outbox(bigint, boolean, text) from public, anon, authenticated;

grant execute on function public.lookup_customer_by_phone(text) to authenticated, service_role;
grant execute on function public.upsert_customer(text, text, text, boolean) to authenticated, service_role;
grant execute on function public.customer_points_balance(uuid) to authenticated, service_role;
grant execute on function public.customer_points_history(uuid, int) to authenticated, service_role;
grant execute on function public.list_customers(text, int) to authenticated, service_role;
grant execute on function public.adjust_customer_points(uuid, int, text) to authenticated, service_role;
grant execute on function public.queue_loyalty_campaign(text, text, int, int) to authenticated, service_role;
grant execute on function public.web_lookup_customer(uuid, text) to service_role;
grant execute on function public.web_upsert_customer(uuid, text, text, text, boolean) to service_role;
grant execute on function public.unsubscribe_loyalty(uuid) to service_role;
grant execute on function public.claim_email_outbox(int) to service_role;
grant execute on function public.finish_email_outbox(bigint, boolean, text) to service_role;
grant usage, select on sequence public.email_outbox_id_seq to service_role;
