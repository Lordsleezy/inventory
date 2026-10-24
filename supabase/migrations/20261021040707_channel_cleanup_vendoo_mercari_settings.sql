update public.store_settings
set value = (
  select coalesce(jsonb_agg(to_jsonb(lower(btrim(x)))), '[]'::jsonb)
  from jsonb_array_elements_text(value) x
  where lower(btrim(x)) not in ('vendoo', 'mercari')
)
where key in ('online_channels', 'online_payout_channels')
  and jsonb_typeof(value) = 'array';

update public.store_settings
set value = coalesce((
  select jsonb_agg(item order by ordinality)
  from jsonb_array_elements(value) with ordinality as t(item, ordinality)
  where item->>'key' not in ('vendoo', 'mercari')
), '[]'::jsonb)
where key = 'marketplace_channels'
  and jsonb_typeof(value) = 'array';

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
)
where key = 'return_settings'
  and jsonb_typeof(value) = 'object';