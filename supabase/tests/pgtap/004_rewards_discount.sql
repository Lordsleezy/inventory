-- pgTAP: rewards, ticket discount, tax-after-discount, void reverse.
begin;
select plan(18);

-- Seed store, staff, tax, units, manager PIN for approval tests.
do $$
declare
  v_store uuid;
  v_owner uuid := gen_random_uuid();
  v_staff uuid := gen_random_uuid();
  v_mgr uuid := gen_random_uuid();
  v_hash text;
begin
  insert into auth.users (id) values (v_owner), (v_staff), (v_mgr);
  insert into public.stores default values returning id into v_store;
  insert into public.staff (user_id, store_id, display_name, role) values
    (v_owner, v_store, 'Owner', 'owner'),
    (v_staff, v_store, 'Staff', 'staff'),
    (v_mgr, v_store, 'Manager', 'manager');
  perform public.seed_store_settings(v_store, 'Rewards Store');
  insert into public.store_settings (store_id, key, value)
  values (v_store, 'taxRateBps', '1000'::jsonb)  -- 10% for easy math
  on conflict (store_id, key) do update set value = excluded.value;

  -- Manager PIN = 1234
  v_hash := crypt('1234', gen_salt('bf'));
  insert into public.store_settings (store_id, key, value)
  values (v_store, 'manager_pin_hash', to_jsonb(v_hash))
  on conflict (store_id, key) do update set value = excluded.value;

  insert into public.sku_ledger (sku, issued_at, store_id) values
    ('80001', now(), v_store),
    ('80002', now(), v_store),
    ('80003', now(), v_store),
    ('80004', now(), v_store),
    ('80005', now(), v_store),
    ('80006', now(), v_store),
    ('80007', now(), v_store),
    ('80008', now(), v_store);
  insert into public.units (
    sku, brand, model, title, ask_cents, floor_cents, state, store_id,
    received_at, updated_at, qty_on_hand
  ) values
    ('80001', 'A', '1', 'Earn A', 1000, 100, 'available', v_store, now(), now(), 1),
    ('80002', 'B', '2', 'Redeem B', 2000, 100, 'available', v_store, now(), now(), 1),
    ('80003', 'C', '3', 'Signup C', 1000, 100, 'available', v_store, now(), now(), 1),
    ('80004', 'D', '4', 'Signup D2', 1000, 100, 'available', v_store, now(), now(), 1),
    ('80005', 'E', '5', 'Void E', 1000, 100, 'available', v_store, now(), now(), 1),
    ('80006', 'F', '6', 'Tax F', 1000, 100, 'available', v_store, now(), now(), 1),
    ('80007', 'G', '7', 'Disc G', 1000, 100, 'available', v_store, now(), now(), 1),
    ('80008', 'H', '8', 'Appr H', 1000, 100, 'available', v_store, now(), now(), 1);

  perform set_config('test.store_id', v_store::text, true);
  perform set_config('test.owner_id', v_owner::text, true);
  perform set_config('test.staff_id', v_staff::text, true);
  perform set_config('test.mgr_id', v_mgr::text, true);
end;
$$;

select set_config('request.jwt.claim.sub', current_setting('test.owner_id'), true);
select set_config('request.jwt.claim.role', 'authenticated', true);

-- ---------------------------------------------------------------------------
-- Earn points: $10 item, 10% tax, points_per_dollar=1 → floor(1000/100)=10
-- ---------------------------------------------------------------------------
do $$
declare
  v_cust jsonb;
  v_ticket uuid := gen_random_uuid();
  v_summary jsonb;
  v_bal int;
begin
  v_cust := public.upsert_customer('555-0100', 'Earn Customer', null, false);
  -- Skip signup discount so earn math is on full $10.
  update public.customers
     set first_purchase_discount_used = true
   where id = (v_cust->>'id')::uuid;
  perform set_config('test.earn_cust', v_cust->>'id', true);

  v_summary := public.finalize_ticket(
    v_ticket,
    '[{"sku":"80001","price_cents":1000}]'::jsonb,
    'cash',
    null,
    1100,
    'floor',
    0, null,
    (v_cust->>'id')::uuid,
    0, null, null, null
  );
  perform set_config('test.earn_ticket', v_ticket::text, true);
  perform set_config('test.earn_points', (v_summary->>'points_earned'), true);
  perform set_config('test.earn_sub', (v_summary->>'subtotal_cents'), true);

  v_bal := public.customer_points_balance((v_cust->>'id')::uuid);
  perform set_config('test.earn_bal', v_bal::text, true);
end;
$$;

select is(current_setting('test.earn_points'), '10', 'earn 10 points on $10 pre-tax');
select is(current_setting('test.earn_bal'), '10', 'balance reflects earned points');
select is(current_setting('test.earn_sub'), '1000', 'earn sale subtotal unchanged without discount');

-- ---------------------------------------------------------------------------
-- Redeem points: seed balance via prior earn; redeem 5 pts × 1¢ = 5¢
-- ---------------------------------------------------------------------------
do $$
declare
  v_cust jsonb;
  v_ticket uuid := gen_random_uuid();
  v_summary jsonb;
  v_bal int;
begin
  v_cust := public.upsert_customer('555-0200', 'Redeem Customer', null, false);
  update public.customers
     set first_purchase_discount_used = true
   where id = (v_cust->>'id')::uuid;
  -- Seed 100 points
  insert into public.customer_points_ledger (
    store_id, customer_id, delta, balance_after, reason, actor_id
  ) values (
    current_setting('test.store_id')::uuid,
    (v_cust->>'id')::uuid,
    100, 100, 'adjust', current_setting('test.owner_id')::uuid
  );

  v_summary := public.finalize_ticket(
    v_ticket,
    '[{"sku":"80002","price_cents":2000}]'::jsonb,
    'cash',
    null,
    2200,
    'floor',
    0, null,
    (v_cust->>'id')::uuid,
    5,  -- redeem 5 points = 5 cents
    null, null, null
  );
  perform set_config('test.redeem_points', (v_summary->>'points_redeemed'), true);
  perform set_config('test.redeem_sub', (v_summary->>'subtotal_cents'), true);
  -- 2000 - 5 = 1995 subtotal; earn floor(1995/100)=19; bal = 100-5+19=114
  v_bal := public.customer_points_balance((v_cust->>'id')::uuid);
  perform set_config('test.redeem_bal', v_bal::text, true);
  perform set_config('test.redeem_earned', (v_summary->>'points_earned'), true);
end;
$$;

select is(current_setting('test.redeem_points'), '5', 'redeemed 5 points');
select is(current_setting('test.redeem_sub'), '1995', 'redeem reduces pre-tax subtotal');
select is(current_setting('test.redeem_earned'), '19', 'earn on post-redeem subtotal');
select is(current_setting('test.redeem_bal'), '114', 'balance after redeem+earn');

-- ---------------------------------------------------------------------------
-- Signup discount once (5% on remaining after ticket % = 0)
-- ---------------------------------------------------------------------------
do $$
declare
  v_cust jsonb;
  v_t1 uuid := gen_random_uuid();
  v_t2 uuid := gen_random_uuid();
  v_s1 jsonb;
  v_s2 jsonb;
  v_err text;
begin
  v_cust := public.upsert_customer('555-0300', 'Signup Customer', null, true);

  v_s1 := public.finalize_ticket(
    v_t1,
    '[{"sku":"80003","price_cents":1000}]'::jsonb,
    'cash', null, 1100, 'floor',
    0, null, (v_cust->>'id')::uuid, 0, null, null, null
  );
  perform set_config('test.signup_cents', (v_s1->>'signup_discount_cents'), true);
  -- 5% of 1000 = 50; subtotal 950; tax 95; total 1045
  perform set_config('test.signup_sub', (v_s1->>'subtotal_cents'), true);

  begin
    v_s2 := public.finalize_ticket(
      v_t2,
      '[{"sku":"80004","price_cents":1000}]'::jsonb,
      'cash', null, 1100, 'floor',
      0, null, (v_cust->>'id')::uuid, 0, null, null, null
    );
    perform set_config('test.signup2', (v_s2->>'signup_discount_cents'), true);
  exception when others then
    v_err := SQLERRM;
    perform set_config('test.signup2_err', v_err, true);
  end;
end;
$$;

select is(current_setting('test.signup_cents'), '50', 'first purchase gets 5% signup discount');
select is(current_setting('test.signup_sub'), '950', 'signup discount applied to subtotal');
select is(current_setting('test.signup2'), '0', 'second purchase gets no signup discount');

-- ---------------------------------------------------------------------------
-- Void reverses earn + restores signup flag
-- ---------------------------------------------------------------------------
do $$
declare
  v_cust jsonb;
  v_ticket uuid := gen_random_uuid();
  v_summary jsonb;
  v_bal_before int;
  v_bal_after int;
  v_flag boolean;
begin
  v_cust := public.upsert_customer('555-0400', 'Void Customer', null, false);
  v_summary := public.finalize_ticket(
    v_ticket,
    '[{"sku":"80005","price_cents":1000}]'::jsonb,
    'cash', null, 1100, 'floor',
    0, null, (v_cust->>'id')::uuid, 0, null, null, null
  );
  v_bal_before := public.customer_points_balance((v_cust->>'id')::uuid);

  perform public.void_ticket(v_ticket, 'test void', null);

  v_bal_after := public.customer_points_balance((v_cust->>'id')::uuid);
  select first_purchase_discount_used into v_flag
    from public.customers where id = (v_cust->>'id')::uuid;

  perform set_config('test.void_bal_before', v_bal_before::text, true);
  perform set_config('test.void_bal_after', v_bal_after::text, true);
  perform set_config('test.void_flag', v_flag::text, true);
  perform set_config('test.void_signup', (v_summary->>'signup_discount_cents'), true);
end;
$$;

select is(current_setting('test.void_bal_before'), '9', 'void path earned points before void (950/100 floor=9)');
select is(current_setting('test.void_bal_after'), '0', 'void reverses earned points');
select is(current_setting('test.void_flag'), 'false', 'void resets signup discount flag');

-- ---------------------------------------------------------------------------
-- Tax after discount: 10% off $10 → sub 900, tax 90
-- ---------------------------------------------------------------------------
do $$
declare
  v_ticket uuid := gen_random_uuid();
  v_summary jsonb;
begin
  -- Owner can exceed clerk max without PIN; use 1000 bps = 10%
  v_summary := public.finalize_ticket(
    v_ticket,
    '[{"sku":"80006","price_cents":1000}]'::jsonb,
    'cash', null, 1000, 'floor',
    1000, null, null, 0, null, null, null
  );
  perform set_config('test.tax_disc_sub', (v_summary->>'subtotal_cents'), true);
  perform set_config('test.tax_disc_tax', (v_summary->>'tax_cents'), true);
  perform set_config('test.tax_disc_cents', (v_summary->>'discount_cents'), true);
end;
$$;

select is(current_setting('test.tax_disc_cents'), '100', '10% ticket discount = 100 cents');
select is(current_setting('test.tax_disc_sub'), '900', 'tax computed on after-discount subtotal');
select is(current_setting('test.tax_disc_tax'), '90', '10% tax on 900 = 90');

-- ---------------------------------------------------------------------------
-- Clerk max discount needs approval (staff role)
-- ---------------------------------------------------------------------------
do $$
declare
  v_ticket uuid := gen_random_uuid();
  v_approval uuid;
  v_ok boolean := false;
  v_err text;
  v_summary jsonb;
begin
  perform set_config('request.jwt.claim.sub', current_setting('test.staff_id'), true);

  begin
    perform public.finalize_ticket(
      v_ticket,
      '[{"sku":"80007","price_cents":1000}]'::jsonb,
      'cash', null, 1000, 'floor',
      2000, null, null, 0, null, null, null  -- 20% > clerk max 10%
    );
  exception when others then
    v_err := SQLERRM;
  end;
  perform set_config('test.clerk_err', coalesce(v_err, ''), true);

  -- Approve and retry
  v_approval := public.approve_with_pin('ticket_discount', '80008', '1234', null);
  v_ticket := gen_random_uuid();
  begin
    v_summary := public.finalize_ticket(
      v_ticket,
      '[{"sku":"80008","price_cents":1000}]'::jsonb,
      'cash', null, 1000, 'floor',
      2000, v_approval, null, 0, null, null, null
    );
    v_ok := (v_summary->>'discount_bps')::int = 2000;
  exception when others then
    v_ok := false;
    perform set_config('test.clerk_ok_err', SQLERRM, true);
  end;
  perform set_config('test.clerk_ok', v_ok::text, true);

  perform set_config('request.jwt.claim.sub', current_setting('test.owner_id'), true);
end;
$$;

select is(
  current_setting('test.clerk_err'),
  'discount_approval_required',
  'staff over clerk max without approval is rejected'
);
select ok(
  current_setting('test.clerk_ok')::boolean,
  'staff over clerk max succeeds with fresh ticket_discount approval'
);

select * from finish();
rollback;
