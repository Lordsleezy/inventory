-- Scan-out barcode match: UPS 1Z and a 34-digit FedEx barcode collapse to the tracking number.
-- USPS 420+ZIP stripping stays. Lookup still falls back to the last 12 digits.

create or replace function public.floor_normalize_tracking(p_raw text)
returns text language plpgsql immutable as $$
declare
  v text := upper(regexp_replace(btrim(coalesce(p_raw, '')), '\s+', '', 'g'));
  ups text;
begin
  if v = '' then return null; end if;
  if v ~ '^420\d{5}(9[2-5]\d{18,24})$' or v ~ '^420\d{9}(9[2-5]\d{18,24})$' then
    v := substring(v from '9[2-5]\d{18,24}$');
  end if;
  ups := substring(v from '1Z[0-9A-Z]{16}');
  if ups is not null then return ups; end if;
  if v ~ '^\d{34}$' then return right(v, 12); end if;
  return v;
end $$;

revoke all on function public.floor_normalize_tracking(text) from public, anon;
grant execute on function public.floor_normalize_tracking(text) to authenticated, service_role;
