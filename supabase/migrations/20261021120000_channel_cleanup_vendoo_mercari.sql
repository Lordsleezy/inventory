-- Channel cleanup: remove Vendoo/Mercari from payout/online channel lists and return write-off defaults.
-- Historical Mercari sales remain; listing targets are eBay, Depop, Amazon, TikTok Shop (+ own website/register).

update public.store_settings
set value = (
  select coalesce(jsonb_agg(to_jsonb(lower(btrim(x)))), '[]'::jsonb)
  from jsonb_array_elements_text(value) x
  where lower(btrim(x)) not in ('vendoo', 'mercari')
),
updated_at = now()
where key in ('online_channels', 'online_payout_channels')
  and jsonb_typeof(value) = 'array';

-- Ensure marketplace_channels has the four marketplaces (plus website handled separately).
update public.store_settings
set value = coalesce((
  select jsonb_agg(item order by ordinality)
  from jsonb_array_elements(value) with ordinality as t(item, ordinality)
  where item->>'key' not in ('vendoo', 'mercari')
), '[]'::jsonb),
updated_at = now()
where key = 'marketplace_channels'
  and jsonb_typeof(value) = 'array';

-- Return settings: no mercari/vendoo in relist defaults or reserves.
update public.store_settings
set value = (
  (value #- '{reserve_pct,mercari}') #- '{reserve_pct,vendoo}'
) || jsonb_build_object(
  'relist_channels_default',
  coalesce(
    (select jsonb_agg(to_jsonb(c))
     from jsonb_array_elements_text(coalesce(value->'relist_channels_default', '["ebay","depop","website"]'::jsonb)) c
     where c not in ('mercari', 'vendoo')),
    '["ebay","depop","website"]'::jsonb
  )
),
updated_at = now()
where key = 'return_settings'
  and jsonb_typeof(value) = 'object';
