-- Shipping label paper is a store choice. Default is the 4x6 label printer.
begin;
select plan(3);
set constraints all immediate;

do $$
declare
  v_store uuid; v_paul uuid := gen_random_uuid();
begin
  insert into auth.users (id) values (v_paul);
  insert into public.stores default values returning id into v_store;
  insert into public.staff (user_id, store_id, display_name, role) values
    (v_paul, v_store, 'Paul', 'owner');
  perform public.seed_store_settings(v_store, 'Label paper');
  perform set_config('test.paul', v_paul::text, true);
end $$;

select set_config('request.jwt.claim.sub', current_setting('test.paul'), true);
select set_config('request.jwt.claim.role', 'authenticated', true);

select is(public.portal_label_paper(), 'label', 'a store prints on a 4x6 label printer until someone changes it');
select is(public.portal_set_label_paper('letter'), 'letter', 'letter paper can be selected');
select is(public.portal_label_paper(), 'letter', 'the choice is saved for the store');

select * from finish();
rollback;
