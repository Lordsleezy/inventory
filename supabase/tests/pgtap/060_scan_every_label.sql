-- Every USPS label barcode becomes the tracking number printed under it.
begin;
select plan(5);

select is(
  public.floor_normalize_tracking('(420)347621423(93)34620845500057475261'),
  '9334620845500057475261',
  'a (93) barcode is the printed tracking number'
);
select is(
  public.floor_normalize_tracking('(420)347621423(93)34610793404041063832'),
  '9334610793404041063832',
  'the second (93) barcode stays distinct'
);
select is(
  public.floor_normalize_tracking(']C1(420)347621423(93)34620845500057475261'),
  '9334620845500057475261',
  'a scanner symbology prefix is not part of the number'
);
select is(
  public.floor_normalize_tracking('(420)347621423(93)34620845500057475261(420)347621423(93)34610793404041063832'),
  '9334620845500057475261',
  'two glued labels keep the first tracking number'
);
select is(
  public.floor_normalize_tracking('1111111111111111111111222222222222'),
  '222222222222',
  'a 34-digit FedEx barcode is still the last 12'
);

select finish();
rollback;
