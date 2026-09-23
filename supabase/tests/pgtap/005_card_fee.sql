-- pgTAP: card fee — server-side, separate from tax, card portion only.
begin;
select plan(17);

-- Seed store, owner, tax 10% for clean math, card fee 2.5%.
do $$
declare
  v_store uuid;
  v_owner uuid := gen_random_uuid();
  v_device uuid;
  v_cust uuid;
begin
  insert into auth.users (id) values (v_owner);
  insert into public.stores default values returning id into v_store;
  insert into public.staff (user_id, store_id, display_name, role) values
    (v_owner, v_store, 'Owner', 'owner');
  perform public.seed_store_settings(v_store, 'Fee Store');
  insert into public.store_settings (store_id, key, value)
  values (v_store, 'taxRateBps', '1000'::jsonb),
         (v_store, 'card_fee_bps', '250'::jsonb)
  on conflict (store_id, key) do update set value = excluded.value;

  insert into public.sku_ledger (sku, issued_at, store_id) values
    ('80001', now(), v_store),
    ('80002', now(), v_store),
    ('80003', now(), v_store),
    ('80004', now(), v_store),
    ('80005', now(), v_store);
  insert into public.units (
    sku, brand, model, title, ask_cents, floor_cents, state, store_id, received_at, updated_at
  ) values
    ('80001', 'A', '1', 'Card unit', 1000, 100, 'available', v_store, now(), now()),
    ('80002', 'B', '2', 'Cash unit', 1000, 100, 'available', v_store, now(), now()),
    ('80003', 'C', '3', 'Split unit', 2000, 100, 'available', v_store, now(), now()),
    ('80004', 'D', '4', 'Rewards unit', 2000, 100, 'available', v_store, now(), now()),
    ('80005', 'E', '5', 'Race unit', 500, 100, 'available', v_store, now(), now());

  insert into public.pos_devices (
    id, store_id, kind, label, pair_code, last_seen, square_authorized, square_location_id
  ) values (
    gen_random_uuid(), v_store, 'phone_reader', 'Test phone', 'FEE001', now(), true, 'LOC'
  )
  returning id into v_device;

  -- Customer with 200 pts balance, first-purchase discount still available.
  insert into public.customers (store_id, phone, name)
  values (v_store, '5551234567', 'Fee Customer')
  returning id into v_cust;
  insert into public.customer_points_ledger (store_id, customer_id, delta, balance_after, reason)
  values (v_store, v_cust, 200, 200, 'signup');

  perform set_config('test.store_id', v_store::text, true);
  perform set_config('test.owner_id', v_owner::text, true);
  perform set_config('test.device_id', v_device::text, true);
  perform set_config('test.cust_id', v_cust::text, true);
end;
$$;

select set_config('request.jwt.claim.sub', current_setting('test.owner_id'), true);
select set_config('request.jwt.claim.role', 'authenticated', true);

-- 1. Quote: card adds fee on top of pre-fee total (1000 + 100 tax = 1100 → fee 28 → 1128)
select is(
  (select (public.quote_ticket_totals(
    '[{"sku":"80001","price_cents":1000}]'::jsonb, 0, null, 0, 'floor', 'card', null
  )->>'card_fee_cents')::int),
  28,
  'quote: card fee 2.5% of card base'
);
select is(
  (select (public.quote_ticket_totals(
    '[{"sku":"80001","price_cents":1000}]'::jsonb, 0, null, 0, 'floor', 'card', null
  )->>'total_cents')::int),
  1128,
  'quote: card total includes fee'
);
select is(
  (select (public.quote_ticket_totals(
    '[{"sku":"80002","price_cents":1000}]'::jsonb, 0, null, 0, 'floor', 'cash', null
  )->>'card_fee_cents')::int),
  0,
  'quote: cash has no card fee'
);

-- 2. Card sale end-to-end: charge → capture → finalize
do $$
declare
  v_ticket uuid := gen_random_uuid();
  v_charge jsonb;
  v_summary jsonb;
begin
  perform set_config('request.jwt.claim.sub', current_setting('test.owner_id'), true);
  v_charge := public.create_register_charge(
    v_ticket, current_setting('test.device_id')::uuid,
    '[{"sku":"80001","price_cents":1000}]'::jsonb
  );
  if (v_charge->>'amount_cents')::int is distinct from 1128 then
    raise exception 'card charge amount % expected 1128', v_charge->>'amount_cents';
  end if;
  perform public.capture_register_charge((v_charge->>'id')::uuid, 'pay_fee_1', 'VISA', '4242');
  v_summary := public.finalize_register_charge((v_charge->>'id')::uuid);
  perform set_config('test.card_summary', v_summary::text, true);
end;
$$;

select is(
  (current_setting('test.card_summary')::jsonb->>'card_fee_cents')::int,
  28,
  'card sale records card_fee_cents'
);
select is(
  (current_setting('test.card_summary')::jsonb->>'tax_cents')::int,
  100,
  'card sale tax excludes the fee'
);
select is(
  (current_setting('test.card_summary')::jsonb->>'total_cents')::int,
  1128,
  'card sale total = subtotal + tax + fee'
);
select ok(
  exists (
    select 1 from public.sales s
    join public.card_charges c on c.ticket_id = s.ticket_id
    where s.sku = '80001'
      and s.store_id = current_setting('test.store_id')::uuid
      and s.card_fee_cents = 28
      and c.card_fee_cents = 28
  ),
  'sales + card_charges rows carry the fee'
);

-- 3. Cash sale: no fee
select is(
  (select (public.finalize_ticket(
    gen_random_uuid(),
    '[{"sku":"80002","price_cents":1000}]'::jsonb,
    'cash', null, 1200, 'floor'
  )->>'card_fee_cents')::int),
  0,
  'cash sale has zero card fee'
);

-- 4. Split: fee only on the card portion (2200 pre-fee; 500 cash → base 1700 → fee 43)
do $$
declare
  v_ticket uuid := gen_random_uuid();
  v_charge jsonb;
  v_summary jsonb;
begin
  perform set_config('request.jwt.claim.sub', current_setting('test.owner_id'), true);
  v_charge := public.create_register_charge(
    v_ticket, current_setting('test.device_id')::uuid,
    '[{"sku":"80003","price_cents":2000}]'::jsonb,
    null, 0, null, null, 0, 500, null, null, 'split'
  );
  if (v_charge->>'amount_cents')::int is distinct from 1743 then
    raise exception 'split charge % expected 1743', v_charge->>'amount_cents';
  end if;
  perform public.capture_register_charge((v_charge->>'id')::uuid, 'pay_split_1', 'MC', '5555');
  v_summary := public.finalize_register_charge((v_charge->>'id')::uuid);
  perform set_config('test.split_summary', v_summary::text, true);
end;
$$;

select is(
  (current_setting('test.split_summary')::jsonb->>'card_fee_cents')::int,
  43,
  'split: fee on card portion only'
);
select is(
  (current_setting('test.split_summary')::jsonb->>'card_cents')::int,
  1743,
  'split: card_cents is what Square charged'
);
select is(
  (current_setting('test.split_summary')::jsonb->>'total_cents')::int,
  2243,
  'split: total = cash + card base + fee'
);

-- 5. Charge amount mismatch is rejected (client math drift / setting changed)
select throws_ok(
  format(
    $sql$
      select public.create_register_charge(
        %L::uuid, %L::uuid,
        '[{"sku":"80005","price_cents":500}]'::jsonb,
        999
      )
    $sql$,
    gen_random_uuid()::text,
    current_setting('test.device_id')
  ),
  'P0001',
  null,
  'mismatched client charge amount rejected'
);

-- 6. Refund path: captured charge whose unit sold mid-payment → needs_refund,
--    and the recorded charge carries the fee for the full-amount refund.
do $$
declare
  v_ticket uuid := gen_random_uuid();
  v_charge jsonb;
  v_res jsonb;
begin
  perform set_config('request.jwt.claim.sub', current_setting('test.owner_id'), true);
  v_charge := public.create_register_charge(
    v_ticket, current_setting('test.device_id')::uuid,
    '[{"sku":"80005","price_cents":500}]'::jsonb
  );
  -- 500 + 50 tax = 550 → fee 14 → charge 564
  if (v_charge->>'amount_cents')::int is distinct from 564 then
    raise exception 'race charge % expected 564', v_charge->>'amount_cents';
  end if;
  perform public.capture_register_charge((v_charge->>'id')::uuid, 'pay_race_2', 'VISA', '0001');
  update public.units set state = 'sold'
   where sku = '80005' and store_id = current_setting('test.store_id')::uuid;
  v_res := public.finalize_register_charge((v_charge->>'id')::uuid);
  perform set_config('test.race_charge_id', v_charge->>'id', true);
  perform set_config('test.race_res', v_res::text, true);
end;
$$;

select is(
  (current_setting('test.race_res')::jsonb->>'needs_refund')::boolean,
  true,
  'mid-payment sell marks charge for refund'
);
select is(
  (select card_fee_cents from public.card_charges
    where id = current_setting('test.race_charge_id')::uuid),
  14,
  'refundable charge records its card fee'
);

-- 7. Fee combined with ticket discount + signup discount + points redeem.
--    2000 − 10% disc (200) − 5% signup (90) − 100pts ($1) = 1610 net
--    tax 161 → 1771 card base → fee round(44.275) = 44 → total 1815
do $$
declare
  v_ticket uuid := gen_random_uuid();
  v_charge jsonb;
  v_summary jsonb;
begin
  perform set_config('request.jwt.claim.sub', current_setting('test.owner_id'), true);
  v_charge := public.create_register_charge(
    v_ticket, current_setting('test.device_id')::uuid,
    '[{"sku":"80004","price_cents":2000}]'::jsonb,
    null, 1000, null, current_setting('test.cust_id')::uuid, 100
  );
  if (v_charge->>'amount_cents')::int is distinct from 1815 then
    raise exception 'rewards charge % expected 1815', v_charge->>'amount_cents';
  end if;
  perform public.capture_register_charge((v_charge->>'id')::uuid, 'pay_fee_rw', 'VISA', '9999');
  v_summary := public.finalize_register_charge((v_charge->>'id')::uuid);
  perform set_config('test.rw_summary', v_summary::text, true);
end;
$$;

select is(
  (current_setting('test.rw_summary')::jsonb->>'card_fee_cents')::int,
  44,
  'fee applies after discounts + redeem'
);
select is(
  (current_setting('test.rw_summary')::jsonb->>'total_cents')::int,
  1815,
  'discounted card total includes fee'
);
select is(
  ((current_setting('test.rw_summary')::jsonb->'customer'->>'points_balance')::int),
  116,
  'points balance = 200 − 100 + 16 earned'
);

select * from finish();
rollback;
