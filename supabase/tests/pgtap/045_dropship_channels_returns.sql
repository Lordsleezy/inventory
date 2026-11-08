begin;
select plan(6);

select has_table('public', 'dropship_amazon_readiness', 'dropship_amazon_readiness exists');
select has_table('public', 'dropship_supplier_claims', 'dropship_supplier_claims exists');
select has_table('public', 'dropship_return_links', 'dropship_return_links exists');
select has_column('public', 'dropship_products', 'sample_verified', 'sample_verified column');
select has_column('public', 'dropship_settings', 'sample_gate_required', 'sample_gate_required column');
select has_column('public', 'dropship_health', 'return_pct', 'return_pct column');

select finish();
rollback;
