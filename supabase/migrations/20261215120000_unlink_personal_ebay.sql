-- Unlink the personal eBay account pgg124-5.
-- Finances rows dated 2026-11-01 or later (Pacific) are copied out of the books
-- ledger and kept here. Sales and orders dated before that stay Open Box records.
-- A November order is archived only when the personal ledger owns it, or when it
-- has no Open Box unit and the selling account ledger does not own it.

begin;

create table if not exists public.personal_ebay_archive (
  id bigserial primary key,
  kind text not null,
  source_key text not null,
  store_id uuid,
  archived_at timestamptz not null default now(),
  reason text not null,
  payload jsonb not null,
  unique (kind, source_key)
);
alter table public.personal_ebay_archive enable row level security;
revoke all on public.personal_ebay_archive from public, anon, authenticated;
grant all on public.personal_ebay_archive to service_role;

insert into public.personal_ebay_archive (kind, source_key, store_id, reason, payload)
select
  'books_ebay_transaction',
  t.store_id::text || ':' || t.account_id || ':' || t.transaction_id,
  t.store_id,
  'pgg124-5 finances dated on or after 2026-11-01 Pacific',
  to_jsonb(t)
from public.books_ebay_transactions t
where lower(t.account_username) = 'pgg124-5'
  and (t.transaction_date at time zone 'America/Los_Angeles')::date >= date '2026-11-01'
on conflict (kind, source_key) do nothing;

delete from public.books_ebay_transactions t
where lower(t.account_username) = 'pgg124-5'
  and (t.transaction_date at time zone 'America/Los_Angeles')::date >= date '2026-11-01';

do $$
declare
  r record;
  v_emp uuid;
  v_comm int;
  v_paid boolean;
begin
  for r in
    with personal_orders as (
      select distinct t.order_id
      from public.books_ebay_transactions t
      where lower(t.account_username) = 'pgg124-5' and t.order_id is not null
      union
      select distinct a.payload->>'order_id'
      from public.personal_ebay_archive a
      where a.kind = 'books_ebay_transaction' and nullif(a.payload->>'order_id', '') is not null
    ),
    selling_orders as (
      select distinct t.order_id
      from public.books_ebay_transactions t
      where lower(t.account_username) = 'ikonikdeals2026' and t.order_id is not null
    ),
    candidates as (
      select o.*
      from public.web_orders o
      where lower(o.channel) = 'ebay'
        and (coalesce(o.paid_at, o.created_at) at time zone 'America/Los_Angeles')::date >= date '2026-11-01'
        and (
          o.order_no in (select order_id from personal_orders)
          or (
            o.order_no not in (select order_id from selling_orders)
            and (
              coalesce(o.sku, '') in ('', 'UNMATCHED')
              or o.match_status = 'unmatched'
              or not exists (
                select 1 from public.units u
                where u.store_id = o.store_id and u.sku = o.sku
              )
            )
          )
        )
    )
    select * from candidates
  loop
    insert into public.personal_ebay_archive (kind, source_key, store_id, reason, payload)
    values (
      'web_order',
      r.id::text,
      r.store_id,
      'pgg124-5 order dated on or after 2026-11-01 Pacific',
      to_jsonb(r)
    )
    on conflict (kind, source_key) do nothing;

    if r.sale_id is not null then
      insert into public.personal_ebay_archive (kind, source_key, store_id, reason, payload)
      select
        'sale',
        s.id::text,
        s.store_id,
        'pgg124-5 sale dated on or after 2026-11-01 Pacific',
        to_jsonb(s)
      from public.sales s
      where s.id = r.sale_id and s.voided_at is null
      on conflict (kind, source_key) do nothing;

      for v_emp in
        select distinct x from unnest(
          array[
            'f17e6163-b10a-4fe1-a373-75c0094e5363'::uuid,
            'c851c8ee-2cc2-490f-935f-1e2d7e093d88'::uuid
          ] || array(select employee_id from public.portal_payout_rules where store_id = r.store_id)
        ) as t(x)
        where x is not null
      loop
        v_comm := public.sale_commission_cents(r.store_id, r.sale_id, v_emp);
        if v_comm is null or v_comm <= 0 then continue; end if;
        select exists (
          select 1 from public.portal_payout_payments p
          where p.store_id = r.store_id and p.employee_id = v_emp
            and p.paid_at >= (select sold_at from public.sales where id = r.sale_id)
        ) into v_paid;
        if v_paid then
          insert into public.portal_payout_adjustments (store_id, employee_id, amount_cents, reason, sale_id, sale_commission_cents)
          select r.store_id, v_emp, -v_comm,
            'Personal eBay pgg124-5 archived · sale ' || r.sale_id || ' (already paid)',
            r.sale_id, v_comm
          where not exists (
            select 1 from public.portal_payout_adjustments a
            where a.store_id = r.store_id and a.sale_id = r.sale_id and a.employee_id = v_emp
              and a.reason like 'Personal eBay pgg124-5 archived%'
          );
        end if;
      end loop;

      update public.sales
        set voided_at = coalesce(voided_at, now()),
            void_reason = coalesce(void_reason, 'Archived personal eBay pgg124-5 on or after 2026-11-01')
        where id = r.sale_id and voided_at is null;

      update public.units u
        set state = 'available', updated_at = now()
        where u.store_id = r.store_id and u.sku = r.sku and u.state = 'sold'
          and not exists (
            select 1 from public.sales s
            where s.store_id = r.store_id and s.sku = r.sku and s.voided_at is null
          );
    end if;

    update public.web_orders
      set status = 'canceled',
          canceled_at = coalesce(canceled_at, now()),
          cancel_source = coalesce(cancel_source, 'floor'),
          cancel_reason = 'Archived personal eBay pgg124-5 on or after 2026-11-01',
          updated_at = now()
      where id = r.id and status is distinct from 'canceled';
  end loop;
end $$;

update public.ebay_accounts
  set status = 'disconnected',
      token_ciphertext = null,
      refresh_ciphertext = null,
      scopes = null,
      expires_at = null,
      last_error = 'Unlinked. Personal account pgg124-5 is not an Open Box account.',
      updated_at = now()
  where lower(username) = 'pgg124-5';

update public.money_account_sync
  set status = 'not_connected',
      message = 'pgg124-5 is unlinked from Floor.',
      balance_cents = null,
      detail = '{"unlinked":true}'::jsonb,
      synced_at = now()
  where account = 'ebay_pgg124_5';

commit;
