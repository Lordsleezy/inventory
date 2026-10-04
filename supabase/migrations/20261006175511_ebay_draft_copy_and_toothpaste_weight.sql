begin;

-- Keep the stored Floor draft copy aligned with the public eBay copy format.
-- This changes Floor drafts only; it does not revise any live eBay listing.
update public.ebay_drafts d
set description = concat(
  trim(regexp_replace(
    regexp_replace(coalesce(d.description,''), E'\n[[:space:]]*This unit \\(Floor\\):.*$', '', 'is'),
    E'\n[[:space:]]*(SKU[[:space:]]*)?[0-9]{5}[[:space:]]*$', '', 'i'
  )), E'\n\n', d.sku
)
where d.description is not null
  and (d.description like '%This unit (Floor):%' or d.description ~ E'\n[[:space:]]*SKU[[:space:]]*[0-9]{5}[[:space:]]*$');

-- This product is five 6.4 oz tubes (32 oz total), not 32 lb.
update public.ebay_drafts
set aspects = jsonb_set(coalesce(aspects,'{}'::jsonb), '{Item Weight}', '"32 oz"'::jsonb)
where sku = '99105' and aspects->>'Item Weight' = '32 lb' and status <> 'live';

select count(*) filter (where description like '%This unit (Floor):%') as drafts_with_floor_footer,
       count(*) filter (where sku='99105' and aspects->>'Item Weight'='32 oz') as toothpaste_weight_corrected
from public.ebay_drafts;

commit;
