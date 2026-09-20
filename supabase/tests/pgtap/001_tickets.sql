-- pgTAP: register tickets + helpers
begin;
select plan(12);

select is(
  public.allocate_line_taxes(array[200], 725),
  array[15],
  'half-up rounds 14.5 cents of tax up to 15'
);

select is(
  public.allocate_line_taxes(array[1000, 379], 725),
  array[72, 28],
  'line floor + remainder on last equals ticket tax'
);

select ok(
  pg_get_viewdef('public.units_pos'::regclass, true) like '%store_id = public.current_store_id()%',
  'units_pos scoped with = current_store_id()'
);

select ok(
  pg_get_viewdef('public.sale_receipts'::regclass, true) like '%ticket_id%',
  'sale_receipts exposes ticket_id'
);

select has_function('public', 'finalize_ticket', array['uuid', 'jsonb', 'text', 'text', 'int', 'text']);
select has_function('public', 'void_ticket', array['uuid', 'text', 'uuid']);
select has_function('public', 'store_tax_rate_bps', array[]::text[]);

select ok(
  not has_function_privilege('authenticated', 'public.store_tax_rate_bps()', 'execute'),
  'store_tax_rate_bps not executable by authenticated'
);

select has_column('public', 'sales', 'ticket_id');
select has_column('public', 'sales', 'list_price_cents');
select has_column('public', 'approvals', 'ticket_id');

select ok(
  exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    where t.relname = 'alert_outbox' and pg_get_constraintdef(c.oid) like '%sale_relist%'
  ),
  'alert_outbox allows sale_relist'
);

select * from finish();
rollback;
