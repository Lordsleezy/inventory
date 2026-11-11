-- Costco 4999 item numbers are not manufacturer GTINs.
-- They must never land in units.upc or a channel identifier.

begin;

create or replace function public.valid_gtin(p_code text)
returns boolean language plpgsql immutable as $$
declare v_code text := trim(coalesce(p_code,'')); v_sum int := 0; v_len int; v_i int;
begin
  if v_code = '' then return true; end if;
  if v_code ~ '^4999[0-9]{4,10}$' then return false; end if;
  v_len := length(v_code);
  if v_len not in (12,13,14) or v_code !~ '^[0-9]+$' then return false; end if;
  for v_i in 1..v_len-1 loop
    v_sum := v_sum + substr(v_code,v_i,1)::int *
      case when (v_len-v_i) % 2 = 1 then 3 else 1 end;
  end loop;
  return substr(v_code,v_len,1)::int = (10-v_sum%10)%10;
end $$;

update public.units
set listing_specs = coalesce(listing_specs, '{}'::jsonb) || jsonb_build_object('costco_item_number', upc),
    upc = null
where upc ~ '^4999[0-9]{4,10}$';

update public.ebay_drafts
set aspects = aspects - 'UPC'
where coalesce(aspects->>'UPC', '') ~ '^4999[0-9]{4,10}$';

commit;
