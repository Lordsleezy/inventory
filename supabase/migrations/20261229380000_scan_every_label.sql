-- A label barcode is 420, a ZIP, then the tracking number.
-- Read that number even when a scanner adds ]C1, and do not turn it into a FedEx last-12.
-- The first complete label wins when two barcodes are still glued together.

create or replace function public.floor_normalize_tracking(p_raw text)
returns text
language plpgsql
immutable
as $$
declare
  v text := upper(regexp_replace(btrim(coalesce(p_raw, '')), '[^0-9A-Za-z]', '', 'g'));
  ups text;
  digits text;
  zip_len int;
  track_len int;
  candidate text;
begin
  if v = '' then return null; end if;
  if v ~ '^[A-Z][0-9]?(420|9[1-5]|1Z)' then
    v := regexp_replace(v, '^[A-Z][0-9]?', '');
  end if;
  ups := substring(v from '1Z[0-9A-Z]{16}');
  if ups is not null then return ups; end if;
  digits := regexp_replace(v, '[A-Z]', '', 'g');
  for zip_len, track_len in
    select z.zip_len, t.track_len
    from (values (1, 9), (2, 5), (3, 11)) as z(ord, zip_len)
    cross join (values (1, 22), (2, 20), (3, 26), (4, 30), (5, 34)) as t(ord, track_len)
    order by z.ord, t.ord
  loop
    candidate := substring(digits from ('420\d{' || zip_len || '}(9[1-5]\d{' || (track_len - 2) || '})'));
    if candidate is not null and char_length(candidate) = track_len then
      return candidate;
    end if;
  end loop;
  if digits ~ '^9[1-5]\d{17,32}$' then return digits; end if;
  if digits ~ '^\d{34}$' then return right(digits, 12); end if;
  return v;
end;
$$;

revoke all on function public.floor_normalize_tracking(text) from public, anon;
grant execute on function public.floor_normalize_tracking(text) to authenticated, service_role;
