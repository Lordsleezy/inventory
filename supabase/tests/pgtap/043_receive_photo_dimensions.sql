-- New-receive photo, dimension, condition, and location rules.
-- Defective and do-not-list waive photo and dimensions; do-not-list skips all.
begin;
select plan(9);

select throws_ok(
  $$select public.receive_require_new_item('{}'::jsonb, '{}'::text[], '{"location":"4-1-3"}'::jsonb)$$,
  '22023',
  'Missing condition.'
);

select throws_ok(
  $$select public.receive_require_new_item('{"p_condition":"Used - Good"}'::jsonb, '{}'::text[], '{}'::jsonb)$$,
  '22023',
  'Missing a photo taken or chosen for this item. A stock photo does not count.'
);

select throws_ok(
  $$select public.receive_require_new_item(
      '{"p_condition":"Used - Good"}'::jsonb, '{}'::text[], '{"location":"4-1-3"}'::jsonb)$$,
  '22023',
  'Missing a photo taken or chosen for this item. A stock photo does not count.'
);

select throws_ok(
  $$select public.receive_require_new_item(
      '{"p_condition":"Used - Good"}'::jsonb,
      array['unit-photos/real.jpg'],
      '{"location":"4-1-3"}'::jsonb)$$,
  '22023',
  'Missing dimensions: length, width, height, and weight.'
);

select lives_ok(
  $$select public.receive_require_new_item(
      '{"p_condition":"Used - Good","p_length":1,"p_width":2,"p_height":3,"p_weight":4}'::jsonb,
      array['unit-photos/real.jpg','unit-photos/stock.jpg'],
      '{"location":"4-1-3","stock_photo_paths":["unit-photos/stock.jpg"]}'::jsonb)$$,
  'condition, location, person photo, and dimensions are enough'
);

select lives_ok(
  $$select public.receive_require_new_item(
      '{"p_condition":"Defective/non-sellable"}'::jsonb, '{}'::text[], '{"location":"4-1-3"}'::jsonb)$$,
  'defective condition waives the photo and the dimensions'
);

select lives_ok(
  $$select public.receive_require_new_item(
      '{"p_condition":"Used - Good"}'::jsonb, '{}'::text[], '{"defective":"true","location":"4-1-3"}'::jsonb)$$,
  'the defective flag waives the photo and the dimensions'
);

select lives_ok(
  $$select public.receive_require_new_item('{}'::jsonb, '{}'::text[], '{"do_not_list":"true"}'::jsonb)$$,
  'do not list waives condition, location, photo, and dimensions'
);

select lives_ok(
  $$select public.receive_require_new_item(
      '{"p_condition":"Used - Good"}'::jsonb, '{}'::text[], '{"defective":"true"}'::jsonb)$$,
  'a defective item can be saved with no location'
);

select * from finish();
rollback;
