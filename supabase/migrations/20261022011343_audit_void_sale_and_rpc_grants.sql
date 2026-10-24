-- The original void_sale(bigint, text) skipped manager approval and store scope.
-- Callers that pass only sale id + reason now hit the 3-arg function (approval defaults to null).
drop function if exists public.void_sale(bigint, text);

do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig, p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'customer_card',
        'delete_unit',
        'void_sale',
        'void_ticket',
        'move_unit_photos_to_store_layout',
        'verify_unit_photos',
        'admin_list_staff'
      )
  loop
    if r.proname = 'customer_card' then
      -- Helper returns phone and email. Security-definer callers run as owner.
      execute format('revoke all on function %s from public, anon, authenticated', r.sig);
      execute format('grant execute on function %s to service_role', r.sig);
    else
      execute format('revoke all on function %s from public, anon', r.sig);
      execute format('grant execute on function %s to authenticated, service_role', r.sig);
    end if;
  end loop;
end $$;
