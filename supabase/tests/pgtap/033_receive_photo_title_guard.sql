begin;
select no_plan();

select ok(public.receive_title_is_complete(
  'ACHIM Buffalo Check Window Curtain Panel, 42 x 84 in, Sage/Cream','ACHIM','Window Curtain Panel'),
  'complete brand, type, size and color title is accepted');
select ok(not public.receive_title_is_complete('ACHIM Rustic','ACHIM','Window Curtain Panel'),
  'short partial AI title is rejected');
select ok(not public.receive_title_is_complete(
  'Threshold Linen Window Curtain Panel, 54 x 84 in, Cream','ACHIM','Window Curtain Panel'),
  'title missing confirmed brand is rejected');
select ok(not public.receive_title_is_complete(
  'ACHIM Rustic, Buffalo Check, 42 x 84 in, Sage/Cream','ACHIM','Window Curtain Panel'),
  'long style-only title without the item type is rejected');

select * from finish();
rollback;
