-- New-receive photo and dimension rules. Defective and do-not-list waive both.
begin;
select plan(6);

select throws_ok(
  $$select public.receive_require_new_item('{}'::jsonb, '{}'::text[], '{}'::jsonb)$$,
  '22023',
  'Missing a photo taken or chosen for this item. A stock photo does not count.'
);

select throws_ok(
  $$select public.receive_require_new_item('{}'::jsonb, array['unit-photos/real.jpg'], '{}'::jsonb)$$,
  '22023',
  'Missing dimensions: length, width, height, and weight.'
);

select lives_ok(
  $$select public.receive_require_new_item(
      '{"p_length":1,"p_width":2,"p_height":3,"p_weight":4}'::jsonb,
      array['unit-photos/real.jpg','unit-photos/stock.jpg'],
      '{"stock_photo_paths":["unit-photos/stock.jpg"]}'::jsonb)$$,
  'a person photo plus dimensions is enough, and the stock photo is ignored'
);

select lives_ok(
  $$select public.receive_require_new_item(
      '{"p_condition":"Defective/non-sellable"}'::jsonb, '{}'::text[], '{}'::jsonb)$$,
  'defective condition waives the photo and the dimensions'
);

select lives_ok(
  $$select public.receive_require_new_item('{}'::jsonb, '{}'::text[], '{"defective":"true"}'::jsonb)$$,
  'the defective flag waives the photo and the dimensions'
);

select lives_ok(
  $$select public.receive_require_new_item('{}'::jsonb, '{}'::text[], '{"do_not_list":"true"}'::jsonb)$$,
  'do not list waives the photo and the dimensions'
);

select * from finish();
rollback;
