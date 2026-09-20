-- pgTAP: multi-line card charges share finalize_ticket with cash.
begin;
select plan(14);

-- Seed store, staff, tax, two available units.
do $$
declare
  v_store uuid;
  v_owner uuid := gen_random_uuid();
  v_staff uuid := gen_random_uuid();
  v_mgr uuid := gen_random_uuid();
  v_device uuid;
begin
  insert into auth.users (id) values (v_owner), (v_staff), (v_mgr);
  insert into public.stores default values returning id into v_store;
  insert into public.staff (user_id, store_id, display_name, role) values
    (v_owner, v_store, 'Owner', 'owner'),
    (v_staff, v_store, 'Staff', 'staff'),
    (v_mgr, v_store, 'Manager', 'manager');
  perform public.seed_store_settings(v_store, 'Test Store');
  update public.store_settings set value = '725'::jsonb
   where store_id = v_store and key = 'taxRateBps';

  insert into public.sku_ledger (sku, issued_at, store_id) values
    ('90001', now(), v_store),
    ('90002', now(), v_store),
    ('90003', now(), v_store);
  insert into public.units (
    sku, brand, model, title, ask_cents, floor_cents, state, store_id, received_at, updated_at
  ) values
    ('90001', 'A', '1', 'Unit A', 1000, 500, 'available', v_store, now(), now()),
    ('90002', 'B', '2', 'Unit B', 379, 100, 'available', v_store, now(), now()),
    ('90003', 'C', '3', 'Unit C', 2000, 1000, 'available', v_store, now(), now());

  insert into public.pos_devices (id, store_id, kind, label, pair_code, last_seen)
  values (gen_random_uuid(), v_store, 'phone_reader', 'Test phone', 'TEST01', now())
  returning id into v_device;

  insert into public.square_connections (
    store_id, access_token_enc, refresh_token_enc, expires_at, sandbox
  ) values (
    v_store, 'ENC_ACCESS_SECRET', 'ENC_REFRESH_SECRET', now() + interval '20 days', true
  );

  perform set_config('test.store_id', v_store::text, true);
  perform set_config('test.owner_id', v_owner::text, true);
  perform set_config('test.staff_id', v_staff::text, true);
  perform set_config('test.mgr_id', v_mgr::text, true);
  perform set_config('test.device_id', v_device::text, true);
end;
$$;

-- Act as owner for RPCs that use auth.uid() / current_store_id().
select set_config('request.jwt.claim.sub', current_setting('test.owner_id'), true);
select set_config('request.jwt.claim.role', 'authenticated', true);

-- Cash and card tax allocation must match for the same prices.
select is(
  public.allocate_line_taxes(array[1000, 379], 725),
  array[72, 28],
  'shared tax allocation for multi-line ticket'
);

-- Happy path: create → capture → finalize
select lives_ok(
  format(
    $sql$
      select public.create_register_charge(
        %L::uuid,
        %L::uuid,
        '[{"sku":"90001","price_cents":1000},{"sku":"90002","price_cents":379}]'::jsonb
      )
    $sql$,
    gen_random_uuid()::text,
    current_setting('test.device_id')
  ),
  'create_register_charge accepts multi-line ticket'
);

-- Recreate with fixed ticket id for assertions
do $$
declare
  v_ticket uuid := gen_random_uuid();
  v_charge jsonb;
  v_cap jsonb;
  v_summary jsonb;
  v_cash jsonb;
  v_ticket_cash uuid := gen_random_uuid();
begin
  perform set_config('request.jwt.claim.sub', current_setting('test.owner_id'), true);
  -- Reset units if prior lives_ok consumed them (it shouldn't — create only).
  update public.units set state = 'available'
   where sku in ('90001', '90002') and store_id = current_setting('test.store_id')::uuid;

  v_charge := public.create_register_charge(
    v_ticket,
    current_setting('test.device_id')::uuid,
    '[{"sku":"90001","price_cents":1000},{"sku":"90002","price_cents":379}]'::jsonb
  );
  perform set_config('test.charge_id', v_charge->>'id', true);
  perform set_config('test.ticket_id', v_ticket::text, true);
  perform set_config('test.amount', v_charge->>'amount_cents', true);

  if (v_charge->>'amount_cents')::int is distinct from 1000 + 379 + 72 + 28 then
    raise exception 'amount_mismatch %', v_charge->>'amount_cents';
  end if;

  v_cap := public.capture_register_charge(
    (v_charge->>'id')::uuid,
    'pay_test_1',
    'VISA',
    '1111'
  );
  -- Duplicate capture same payment_id is ok
  v_cap := public.capture_register_charge(
    (v_charge->>'id')::uuid,
    'pay_test_1',
    'VISA',
    '1111'
  );
  if coalesce((v_cap->>'duplicate')::boolean, false) is not true then
    raise exception 'expected duplicate capture';
  end if;

  v_summary := public.finalize_register_charge((v_charge->>'id')::uuid);
  perform set_config('test.card_total', (v_summary->>'total_cents'), true);
  perform set_config('test.card_tax', (v_summary->>'tax_cents'), true);

  -- Cash path same lines → same tax/total
  insert into public.sku_ledger (sku, issued_at, store_id)
  values ('90011', now(), current_setting('test.store_id')::uuid),
         ('90012', now(), current_setting('test.store_id')::uuid)
  on conflict do nothing;
  insert into public.units (
    sku, brand, model, title, ask_cents, floor_cents, state, store_id, received_at, updated_at
  ) values
    ('90011', 'A', '1', 'Cash A', 1000, 500, 'available', current_setting('test.store_id')::uuid, now(), now()),
    ('90012', 'B', '2', 'Cash B', 379, 100, 'available', current_setting('test.store_id')::uuid, now(), now())
  on conflict (sku) do update set state = 'available', ask_cents = excluded.ask_cents;

  v_cash := public.finalize_ticket(
    v_ticket_cash,
    '[{"sku":"90011","price_cents":1000},{"sku":"90012","price_cents":379}]'::jsonb,
    'cash',
    null,
    2000,
    'floor'
  );
  perform set_config('test.cash_total', (v_cash->>'total_cents'), true);
  perform set_config('test.cash_tax', (v_cash->>'tax_cents'), true);
end;
$$;

select is(
  current_setting('test.card_tax'),
  current_setting('test.cash_tax'),
  'card multi-line tax matches cash path'
);

select is(
  current_setting('test.card_total'),
  current_setting('test.cash_total'),
  'card multi-line total matches cash path'
);

select ok(
  exists (
    select 1 from public.sales
     where ticket_id = current_setting('test.ticket_id')::uuid
       and card_brand = 'VISA' and card_last4 = '1111'
  ),
  'sales stamped with card brand/last4'
);

-- Duplicate finalize is idempotent
select lives_ok(
  format(
    $sql$ select public.finalize_register_charge(%L::uuid) $sql$,
    current_setting('test.charge_id')
  ),
  'duplicate finalize_register_charge is idempotent'
);

-- Decline path: pending → failed via direct update (phone marks failed)
do $$
declare
  v_ticket uuid := gen_random_uuid();
  v_charge jsonb;
begin
  perform set_config('request.jwt.claim.sub', current_setting('test.owner_id'), true);
  insert into public.sku_ledger (sku, issued_at, store_id)
  values ('90021', now(), current_setting('test.store_id')::uuid)
  on conflict do nothing;
  insert into public.units (
    sku, brand, model, title, ask_cents, state, store_id, received_at, updated_at
  ) values (
    '90021', 'D', '1', 'Decline unit', 500, 'available',
    current_setting('test.store_id')::uuid, now(), now()
  ) on conflict (sku) do update set state = 'available';

  v_charge := public.create_register_charge(
    v_ticket,
    current_setting('test.device_id')::uuid,
    '[{"sku":"90021","price_cents":500}]'::jsonb
  );
  update public.card_charges
     set status = 'failed', error = 'declined', updated_at = now()
   where id = (v_charge->>'id')::uuid;
  perform set_config('test.decline_charge', v_charge->>'id', true);
end;
$$;

select throws_ok(
  format(
    $sql$ select public.finalize_register_charge(%L::uuid) $sql$,
    current_setting('test.decline_charge')
  ),
  'P0001',
  null,
  'declined charge cannot finalize'
);

select ok(
  not exists (
    select 1 from public.sales s
    join public.card_charges c on c.ticket_id = s.ticket_id
    where c.id = current_setting('test.decline_charge')::uuid
  ),
  'declined charge creates no sales'
);

-- Unit sold mid-payment → finalize_failed
do $$
declare
  v_ticket uuid := gen_random_uuid();
  v_charge jsonb;
begin
  perform set_config('request.jwt.claim.sub', current_setting('test.owner_id'), true);
  insert into public.sku_ledger (sku, issued_at, store_id)
  values ('90031', now(), current_setting('test.store_id')::uuid)
  on conflict do nothing;
  insert into public.units (
    sku, brand, model, title, ask_cents, state, store_id, received_at, updated_at
  ) values (
    '90031', 'E', '1', 'Race unit', 800, 'available',
    current_setting('test.store_id')::uuid, now(), now()
  ) on conflict (sku) do update set state = 'available';

  v_charge := public.create_register_charge(
    v_ticket,
    current_setting('test.device_id')::uuid,
    '[{"sku":"90031","price_cents":800}]'::jsonb
  );
  perform public.capture_register_charge((v_charge->>'id')::uuid, 'pay_race', 'MC', '4444');
  update public.units set state = 'sold'
   where sku = '90031' and store_id = current_setting('test.store_id')::uuid;
  begin
    perform public.finalize_register_charge((v_charge->>'id')::uuid);
  exception when others then
    null;
  end;
  perform set_config('test.race_charge', v_charge->>'id', true);
end;
$$;

select is(
  (select status from public.card_charges where id = current_setting('test.race_charge')::uuid),
  'finalize_failed',
  'unit sold mid-payment marks finalize_failed'
);

-- Tokens still unreadable by staff/manager
select ok(
  not has_table_privilege('authenticated', 'public.square_connections', 'select'),
  'authenticated still has no SELECT on square_connections'
);

select set_config('request.jwt.claim.sub', current_setting('test.staff_id'), true);
set local role authenticated;
select throws_ok(
  'select access_token_enc from public.square_connections',
  '42501',
  null,
  'staff cannot read square tokens'
);
reset role;

select set_config('request.jwt.claim.sub', current_setting('test.mgr_id'), true);
set local role authenticated;
select throws_ok(
  'select refresh_token_enc from public.square_connections',
  '42501',
  null,
  'manager cannot read square tokens'
);
reset role;

select has_function('public', 'create_register_charge', array['uuid', 'uuid', 'jsonb']);
select has_function('public', 'capture_register_charge', array['uuid', 'text', 'text', 'text']);

select * from finish();
rollback;
