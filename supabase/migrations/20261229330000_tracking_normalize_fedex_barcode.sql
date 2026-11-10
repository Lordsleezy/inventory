-- FedEx door-tag barcodes often look like 9622…(00…)…NNNN with punctuation.
-- Strip non-alphanumerics before the 34→12 collapse so scan-out and display match.

create or replace function public.floor_normalize_tracking(p_raw text)
returns text
language plpgsql
immutable
as $$
declare
  v text := upper(regexp_replace(btrim(coalesce(p_raw, '')), '[^0-9A-Za-z]', '', 'g'));
  ups text;
  digits text;
begin
  if v = '' then return null; end if;
  if v ~ '^420\d{5}(9[2-5]\d{18,24})$' or v ~ '^420\d{9}(9[2-5]\d{18,24})$' then
    v := substring(v from '9[2-5]\d{18,24}$');
  end if;
  ups := substring(v from '1Z[0-9A-Z]{16}');
  if ups is not null then return ups; end if;
  digits := regexp_replace(v, '[A-Z]', '', 'g');
  if digits ~ '^\d{34}$' then return right(digits, 12); end if;
  return v;
end;
$$;

revoke all on function public.floor_normalize_tracking(text) from public, anon;
grant execute on function public.floor_normalize_tracking(text) to authenticated, service_role;

-- Collapse any saved raw FedEx door-tag strings to the real tracking number.
update public.web_orders
set
  tracking_number = public.floor_normalize_tracking(tracking_number),
  tracking_url = case
    when lower(coalesce(carrier, '')) like '%fedex%'
      then 'https://www.fedex.com/fedextrack/?trknbr=' || public.floor_normalize_tracking(tracking_number)
    when lower(coalesce(carrier, '')) like '%ups%'
      or public.floor_normalize_tracking(tracking_number) ~ '^1Z'
      then 'https://www.ups.com/track?tracknum=' || public.floor_normalize_tracking(tracking_number)
    when public.floor_normalize_tracking(tracking_number) ~ '^9[1-5]'
      then 'https://tools.usps.com/go/TrackConfirmAction?tLabels=' || public.floor_normalize_tracking(tracking_number)
    else tracking_url
  end,
  updated_at = now()
where tracking_number is not null
  and tracking_number <> ''
  and tracking_number is distinct from public.floor_normalize_tracking(tracking_number);
