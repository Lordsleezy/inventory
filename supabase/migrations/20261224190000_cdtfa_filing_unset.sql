-- No filing schedule is assigned until someone saves one.
-- An empty setting stays blank. It does not become quarterly.

create or replace function public.portal_cdtfa_filing()
returns text language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := public.books_require_admin();
  v_value text;
begin
  v_value := nullif(public.store_setting(v_store, 'cdtfa_filing_frequency', 'null'::jsonb) #>> '{}', '');
  if v_value in ('monthly', 'quarterly', 'yearly') then
    return v_value;
  end if;
  return '';
end $$;
