-- A ticket is checked as a whole. A line that absorbed leftover cents is not excess tax.
begin;
select plan(4);

select is(
  public.allocate_line_taxes(array[1000, 379], 725),
  array[73, 27],
  'largest remainder keeps the ticket tax'
);

select is(
  (select sum(x) from unnest(public.allocate_line_taxes(array[1000, 1000, 1000, 1000, 1000, 800], 725)) x)::int,
  round((5800::numeric * 725) / 10000.0)::int,
  'split lines still add up to the ticket tax'
);

select is(
  (public.cdtfa_rate_findings(jsonb_build_array(
    jsonb_build_object('bucket','taxable','ticket_key','t','id',1,'measure_cents',1000,'tax_cents',75),
    jsonb_build_object('bucket','taxable','ticket_key','t','id',2,'measure_cents',8000,'tax_cents',578)
  ))->>'count')::int,
  0,
  'a ticket that totals round(subtotal x 7.25%) is not flagged'
);

select is(
  (public.cdtfa_rate_findings(jsonb_build_array(
    jsonb_build_object('bucket','taxable','id',9,'measure_cents',1000,'tax_cents',90)
  ))->>'over_cents')::int,
  17,
  'a ticket that is really over contributes only its extra cents'
);

select * from finish();
rollback;
