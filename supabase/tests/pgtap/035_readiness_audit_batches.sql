begin;
select no_plan();
select ok(has_function_privilege('service_role','public.floor_inventory_readiness_recompute_batch(text,integer)','execute'),
  'service role can execute the read-only paged readiness audit');
select ok(not has_function_privilege('authenticated','public.floor_inventory_readiness_recompute_batch(text,integer)','execute'),
  'authenticated users cannot execute the audit');
select ok((public.floor_inventory_readiness_recompute_batch(null,1)->>'units_scanned')::int between 0 and 1,
  'audit batch is bounded to its requested row count');
select * from finish();
rollback;
