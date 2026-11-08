-- Fee cannot exceed sale on depop_sale_entries (guards against swapped fields).
begin;
select plan(2);

select has_function('public', 'depop_sale_entries_fee_guard', array[]::text[]);
select has_trigger('public', 'depop_sale_entries', 'depop_sale_entries_fee_guard', 'depop fee guard trigger exists');

select * from finish();
rollback;
