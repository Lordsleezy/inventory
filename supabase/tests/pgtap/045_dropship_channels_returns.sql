begin;
select plan(6);

select has_table('public', 'dropship_amazon_readiness');
select has_table('public', 'dropship_supplier_claims');
select has_table('public', 'dropship_return_links');
select has_column('public', 'dropship_products', 'sample_verified');
select has_column('public', 'dropship_settings', 'sample_gate_required');
select has_column('public', 'dropship_health', 'return_pct');

select finish();
rollback;
