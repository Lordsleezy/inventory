-- pgTAP: admin-only enforcement for reports + employee management.
-- "Admin" = owner or manager. Staff must be refused at the function level and
-- by RLS/column privileges on public.staff.
begin;
select plan(30);

-- Seed store, staff, settings, units, and two sales (costs 100 + 200).
do $$
declare
  v_store uuid;
  v_owner uuid := gen_random_uuid();
  v_mgr uuid := gen_random_uuid();
  v_staff uuid := gen_random_uuid();
  v_extra uuid := gen_random_uuid();
begin
  insert into auth.users (id) values (v_owner), (v_mgr), (v_staff), (v_extra);
  insert into public.stores default values returning id into v_store;
  insert into public.staff (user_id, store_id, display_name, role) values
    (v_owner, v_store, 'Owner', 'owner'),
    (v_mgr, v_store, 'Manager', 'manager'),
    (v_staff, v_store, 'Staff', 'staff');
  perform public.seed_store_settings(v_store, 'Report Store');

  insert into public.sku_ledger (sku, issued_at, store_id) values
    ('90001', now(), v_store),
    ('90002', now(), v_store);
  insert into public.units (
    sku, brand, title, ask_cents, acquisition_cost_cents, state, store_id,
    received_at, updated_at
  ) values
    ('90001', 'A', 'Sold A', 2000, 200, 'sold', v_store, now(), now()),
    ('90002', 'B', 'Sold B', 1000, 100, 'sold', v_store, now(), now());
  insert into public.sales (
    store_id, sku, price_cents, tax_cents, channel, payment_method,
    sold_at, receipt_no, actor_id, qty
  ) values
    (v_store, '90001', 2000, 200, 'ebay', 'card', now(), 'R-T0001', v_owner, 1),
    (v_store, '90002', 1000, 100, 'floor', 'cash', now(), 'R-T0002', v_staff, 1);

  perform set_config('test.store_id', v_store::text, true);
  perform set_config('test.owner_id', v_owner::text, true);
  perform set_config('test.mgr_id', v_mgr::text, true);
  perform set_config('test.staff_id', v_staff::text, true);
  perform set_config('test.extra_id', v_extra::text, true);
end;
$$;

-- Emulate Supabase's default table grants so RLS is what denies, not SQL privs.
grant select, insert, delete on public.staff to authenticated;

-- ---------------------------------------------------------------------------
-- Owner gets a real report.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', current_setting('test.owner_id'), true);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $$
declare
  v_report jsonb;
begin
  v_report := public.store_report(null, null);
  perform set_config('test.rep_sales', v_report #>> '{totals,sales}', true);
  perform set_config('test.rep_merch', v_report #>> '{totals,merchandise_cents}', true);
  perform set_config('test.rep_profit', v_report #>> '{totals,gross_profit_cents}', true);
  perform set_config(
    'test.rep_ebay',
    coalesce((
      select (row ->> 'revenue_cents')
        from jsonb_array_elements(v_report -> 'by_channel') row
       where row ->> 'channel' = 'ebay'
    ), '0'),
    true
  );
  perform set_config('test.rep_cost', v_report #>> '{inventory,cost_cents}', true);
end;
$$;

select is(current_setting('test.rep_sales'), '2', 'owner report counts both sales');
select is(current_setting('test.rep_merch'), '3000', 'owner report merchandise total');
select is(current_setting('test.rep_profit'), '2700', 'gross profit nets acquisition cost');
select is(current_setting('test.rep_ebay'), '2000', 'channel rollup has ebay revenue');
select is(current_setting('test.rep_cost'), '0', 'inventory at cost excludes sold units');

-- ---------------------------------------------------------------------------
-- Staff is refused on every admin surface.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', current_setting('test.staff_id'), true);

select throws_ok(
  $$ select public.store_report(null, null) $$,
  '42501', 'not_manager',
  'staff cannot read store_report'
);
select throws_ok(
  format(
    $$ select public.admin_add_staff(%L, 'Extra', 'staff') $$,
    current_setting('test.extra_id')
  ),
  '42501', 'not_manager',
  'staff cannot add employees'
);
select throws_ok(
  format(
    $$ select public.admin_set_staff_role(%L, 'manager') $$,
    current_setting('test.mgr_id')
  ),
  '42501', 'not_manager',
  'staff cannot change roles'
);
select throws_ok(
  format(
    $$ select public.admin_set_staff_active(%L, false) $$,
    current_setting('test.mgr_id')
  ),
  '42501', 'not_manager',
  'staff cannot deactivate employees'
);
select throws_ok(
  format(
    $$ select public.admin_remove_staff(%L) $$,
    current_setting('test.mgr_id')
  ),
  '42501', 'not_manager',
  'staff cannot remove employees'
);
select throws_ok(
  $$ select public.admin_list_staff() $$,
  '42501', 'not_manager',
  'staff cannot list the roster'
);

-- ---------------------------------------------------------------------------
-- Role rules for admins: manager cannot touch an owner; self is off limits.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', current_setting('test.mgr_id'), true);

select throws_ok(
  format(
    $$ select public.admin_set_staff_role(%L, 'staff') $$,
    current_setting('test.owner_id')
  ),
  '42501', 'owner_only',
  'manager cannot demote an owner'
);

select set_config('request.jwt.claim.sub', current_setting('test.owner_id'), true);

select lives_ok(
  format(
    $$ select public.admin_set_staff_role(%L, 'manager') $$,
    current_setting('test.staff_id')
  ),
  'owner promotes staff to manager'
);
select is(
  (select role from public.staff where user_id = current_setting('test.staff_id')::uuid),
  'manager',
  'role change persisted'
);
select throws_ok(
  format($$ select public.admin_set_staff_role(%L, 'staff') $$, current_setting('test.owner_id')),
  'P0001', 'cannot_change_self',
  'owner cannot change own role'
);
select throws_ok(
  format($$ select public.admin_remove_staff(%L) $$, current_setting('test.owner_id')),
  'P0001', 'cannot_remove_self',
  'owner cannot remove self'
);
select throws_ok(
  format($$ select public.admin_set_staff_active(%L, false) $$, current_setting('test.owner_id')),
  'P0001', 'cannot_deactivate_self',
  'owner cannot deactivate self'
);

select lives_ok(
  format(
    $$ select public.admin_add_staff(%L, 'Extra Clerk', 'staff') $$,
    current_setting('test.extra_id')
  ),
  'owner adds an employee'
);
select is(
  (select role from public.staff where user_id = current_setting('test.extra_id')::uuid),
  'staff',
  'new employee row exists as staff'
);

select lives_ok(
  format($$ select public.admin_set_staff_active(%L, false) $$, current_setting('test.mgr_id')),
  'owner deactivates the manager'
);

-- Deactivated account: helpers stop recognizing them immediately.
do $$
begin
  perform set_config('request.jwt.claim.sub', current_setting('test.mgr_id'), true);
  perform set_config('test.mgr_is_staff', public.is_staff()::text, true);
  perform set_config('test.mgr_role', coalesce(public.staff_role(), 'null'), true);
  perform set_config('test.mgr_store', coalesce(public.current_store_id()::text, 'null'), true);
end;
$$;
select is(current_setting('test.mgr_is_staff'), 'false', 'deactivated staff fails is_staff()');
select is(current_setting('test.mgr_role'), 'null', 'deactivated staff has no role');

-- Remove the only other active admin, then the service role cannot remove the last one.
select set_config('request.jwt.claim.sub', current_setting('test.owner_id'), true);
select lives_ok(
  format($$ select public.admin_set_staff_active(%L, false) $$, current_setting('test.staff_id')),
  'owner deactivates promoted staffer'
);

select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', 'service_role', true);
select throws_ok(
  format(
    $$ select public.admin_remove_staff(%L, %L::uuid) $$,
    current_setting('test.owner_id'), current_setting('test.store_id')
  ),
  'P0001', 'last_admin',
  'even service role cannot remove the last admin'
);

-- ---------------------------------------------------------------------------
-- RLS + column privileges, as a real authenticated (non-superuser) session.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', current_setting('test.extra_id'), true);
set role authenticated;

select throws_ok(
  format($$ insert into public.staff (user_id, store_id, display_name, role)
           values (%L::uuid, %L::uuid, 'Sneaky', 'owner') $$,
           gen_random_uuid(), current_setting('test.store_id')),
  '42501',
  null,
  'clerk cannot insert a staff row (no insert policy)'
);
select throws_ok(
  format($$ update public.staff set role = 'owner' where user_id = %L::uuid $$,
           current_setting('test.extra_id')),
  '42501',
  null,
  'clerk cannot update staff.role even on own row (column privilege)'
);
select lives_ok(
  format($$ update public.staff set display_name = 'Renamed' where user_id = %L::uuid $$,
           current_setting('test.extra_id')),
  'clerk can still edit own display name'
);
select lives_ok(
  format($$ delete from public.staff where user_id = %L::uuid $$,
           current_setting('test.owner_id')),
  'clerk delete attempt executes'
);

reset role;
select set_config('request.jwt.claim.sub', '', true);

select is(
  (select count(*)::text from public.staff where store_id = current_setting('test.store_id')::uuid),
  '4',
  'clerk delete removed nothing — RLS has no delete policy'
);
select is(
  (select display_name from public.staff where user_id = current_setting('test.extra_id')::uuid),
  'Renamed',
  'self display-name edit went through'
);

select * from finish();
rollback;
