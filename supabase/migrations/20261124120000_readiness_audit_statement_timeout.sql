begin;

-- The all-inventory read-only readiness audit can exceed PostgREST's short
-- default timeout on the full production stock table. Raise it only while this
-- diagnostic function runs; it never writes inventory rows.
alter function public.floor_inventory_readiness_recompute()
  set statement_timeout = '60s';

commit;
