begin;
select plan(14);

select has_table('public', 'dropship_settings', 'dropship_settings exists');
select has_table('public', 'dropship_supplier_credentials', 'dropship_supplier_credentials exists');
select has_table('public', 'supplier_catalog_items', 'supplier_catalog_items exists');
select has_table('public', 'supplier_catalog_runs', 'supplier_catalog_runs exists');
select has_table('public', 'dropship_picks', 'dropship_picks exists');
select has_table('public', 'dropship_products', 'dropship_products exists');
select has_table('public', 'dropship_orders', 'dropship_orders exists');
select has_table('public', 'dropship_health', 'dropship_health exists');

select has_function('public', 'is_dropship_sku', array['text']);
select is(public.is_dropship_sku('DS-00012'), true, 'DS- sku recognized');
select is(public.is_dropship_sku('11871'), false, 'real inventory sku not dropship');

select has_function('public', 'next_dropship_sku', array[]::text[]);
select has_function('public', 'portal_dropship_desk', array[]::text[]);
select has_function('public', 'dropship_default_settings', array[]::text[]);

select finish();
rollback;
