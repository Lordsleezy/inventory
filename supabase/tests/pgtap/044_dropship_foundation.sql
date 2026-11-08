begin;
select plan(14);

select has_table('public', 'dropship_settings');
select has_table('public', 'dropship_supplier_credentials');
select has_table('public', 'supplier_catalog_items');
select has_table('public', 'supplier_catalog_runs');
select has_table('public', 'dropship_picks');
select has_table('public', 'dropship_products');
select has_table('public', 'dropship_orders');
select has_table('public', 'dropship_health');

select has_function('public', 'is_dropship_sku', array['text']);
select is(public.is_dropship_sku('DS-00012'), true, 'DS- sku recognized');
select is(public.is_dropship_sku('11871'), false, 'real inventory sku not dropship');

select has_function('public', 'next_dropship_sku', array[]::text[]);
select has_function('public', 'portal_dropship_desk', array[]::text[]);
select has_function('public', 'dropship_default_settings', array[]::text[]);

select finish();
rollback;
