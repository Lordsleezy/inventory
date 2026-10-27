-- pgTAP: a generated description saved from item edit is on the item the next time it is opened.
begin;
select plan(3);
do $$
declare v_store uuid; v_owner uuid := gen_random_uuid();
begin
  insert into auth.users (id) values (v_owner);
  insert into public.stores default values returning id into v_store;
  insert into public.staff (user_id, store_id, display_name, role) values (v_owner, v_store, 'Owner', 'owner');
  perform public.seed_store_settings(v_store, 'Description Store');
  insert into public.sku_ledger (sku, issued_at, store_id) values ('99844', now(), v_store);
  insert into public.units (sku, brand, title, state, store_id, received_at, updated_at) values ('99844', 'Acme', 'Steamer', 'available', v_store, now(), now());
  perform set_config('test.owner', v_owner::text, true);
end $$;
select set_config('request.jwt.claim.sub', current_setting('test.owner'), true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select is((public.portal_inventory_detail('99844') -> 'unit' ->> 'listing_body'), null, 'no description before');
select lives_ok($q$select public.portal_set_unit_text('99844', 'description', 'Acme Steamer.' || E'\n\n' || 'Condition: Open box.')$q$, 'generated description is saved');
select is((public.portal_inventory_detail('99844') -> 'unit' ->> 'listing_body'), 'Acme Steamer.' || E'\n\n' || 'Condition: Open box.', 'it is on the item when reopened');
select * from finish();
rollback;
