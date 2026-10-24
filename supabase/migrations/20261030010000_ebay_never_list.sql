-- Durable per-unit eBay exclusion. Other marketplace eligibility is unchanged.
alter table public.units add column if not exists ebay_never_list boolean not null default false;

update public.units
set ebay_never_list = true
where listing_specs->>'ebay_never_list' = 'true'
  and ebay_never_list = false;

comment on column public.units.ebay_never_list is 'Never publish or republish this unit to eBay; unrelated channels remain eligible.';
