-- pgTAP: which units the auto category / description sweep may touch, and the Unfinished / Needs check split used in the report.
begin;
select plan(7);
do $$
declare v_store uuid;
begin
  insert into public.stores default values returning id into v_store;
  perform public.seed_store_settings(v_store, 'Auto Store');
  insert into public.sku_ledger (sku, issued_at, store_id) select s, now(), v_store from unnest(array['90001','90002','90003','90004']) s;
  insert into public.units (sku, brand, title, category, state, store_id, received_at, updated_at, condition, listing_body, listing_specs) values
    ('90001', 'Acme', 'Acme lamp', 'Lamps', 'available', v_store, now(), now(), 'New', null, '{}'),
    ('90002', 'Acme', 'Acme fan', 'Fans', 'available', v_store, now(), now(), 'New', 'Own text', '{"auto_category_tried":"Acme fan"}'),
    ('90003', 'Acme', 'Acme broken', 'Fans', 'available', v_store, now(), now(), 'Defective', null, '{}'),
    ('90004', 'Acme', 'Acme sold', 'Fans', 'sold', v_store, now(), now(), 'New', null, '{}');
  perform set_config('test.store', v_store::text, true);
end $$;
select is((select count(*)::int from public.floor_auto_fill_snapshot(current_setting('test.store')::uuid)), 3, 'only in-stock units (sold excluded)');
select ok((select eligible from public.floor_auto_fill_snapshot(current_setting('test.store')::uuid, '90001')), 'a normal unit is eligible');
select ok(not (select eligible from public.floor_auto_fill_snapshot(current_setting('test.store')::uuid, '90003')), 'Defective units are skipped');
select ok((select not has_category and not has_description and has_name from public.floor_auto_fill_snapshot(current_setting('test.store')::uuid, '90001')), 'A1 has no category and no description');
select ok((select has_description and tried_title = 'Acme fan' from public.floor_auto_fill_snapshot(current_setting('test.store')::uuid, '90002')), 'A2 keeps its description and remembers the tried title');
select lives_ok($q$select public.floor_auto_fill_mark(current_setting('test.store')::uuid, '90001', 'Acme lamp')$q$, 'mark runs');
select is((select tried_title from public.floor_auto_fill_snapshot(current_setting('test.store')::uuid, '90001')), 'Acme lamp', 'the tried title is remembered');
select * from finish();
rollback;
