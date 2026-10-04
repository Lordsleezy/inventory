begin;

alter table public.ebay_drafts add column if not exists label_quoted_at timestamptz;
alter table public.ebay_drafts add column if not exists rejected_upc text;
alter table public.units add column if not exists upc_rejected text;

create or replace function public.valid_gtin(p_code text)
returns boolean language plpgsql immutable as $$
declare v_code text := trim(coalesce(p_code,'')); v_sum int := 0; v_len int; v_i int;
begin
  if v_code = '' then return true; end if;
  v_len := length(v_code);
  if v_len not in (12,13,14) or v_code !~ '^[0-9]+$' then return false; end if;
  for v_i in 1..v_len-1 loop
    v_sum := v_sum + substr(v_code,v_i,1)::int *
      case when (v_len-v_i) % 2 = 1 then 3 else 1 end;
  end loop;
  return substr(v_code,v_len,1)::int = (10-v_sum%10)%10;
end $$;

-- Preserve bad scan reads for review while removing them from sellable identifiers.
update public.units set upc_rejected=upc, upc=null
where nullif(trim(upc),'') is not null and not public.valid_gtin(upc);

update public.ebay_drafts
set rejected_upc=aspects->>'UPC', aspects=aspects-'UPC'
where nullif(trim(aspects->>'UPC'),'') is not null
  and lower(trim(aspects->>'UPC')) <> 'does not apply'
  and not public.valid_gtin(aspects->>'UPC');

do $$ begin
  if not exists(select 1 from pg_constraint where conname='units_upc_valid_gtin') then
    alter table public.units add constraint units_upc_valid_gtin
      check (public.valid_gtin(upc));
  end if;
end $$;

select (select count(*) from public.units where upc_rejected is not null) as rejected_unit_upcs,
       (select count(*) from public.units where not public.valid_gtin(upc)) as invalid_stored_upcs,
       (select count(*) from public.ebay_drafts where label_quoted_at is not null) as timestamped_quotes;

commit;
