-- Seed default rules for every store.
insert into public.marketplace_policy_rules(store_id, channel, enabled, rules, notes)
select s.id, v.channel, true, v.rules, v.notes
from public.stores s
cross join (values
  ('depop', '{
    "block_requires_power": true,
    "block_chargers_cables": true,
    "allow_cameras": true,
    "require_own_photos": true,
    "block_stock_photos": true,
    "block_ai_images": true,
    "block_manufacturer_photos": true,
    "review_if_power_unknown": true,
    "blocked_keywords": ["charger","charging cable","power cord","ac adapter","usb cable","extension cord","hdmi cable","rechargeable","battery powered"],
    "blocked_categories": ["Appliances","Electronics","Electric Toothbrushes","Power tools","Small appliances","Kitchen appliances","TVs","Vacuums","Computers","Gaming"]
  }'::jsonb, 'Depop Electronics Policy: no mains/battery/solar powered items, chargers, cables, or tech accessories. Cameras and phone cases allowed. Own photos only.'),
  ('ebay', '{
    "block_requires_power": false,
    "block_ai_images": true,
    "prohibited_keywords": ["alcohol","beer","wine","liquor","vodka","whiskey","tobacco","cigarette","vape","firearm","ammunition","ammo"],
    "blocked_keywords": [],
    "blocked_categories": []
  }'::jsonb, 'eBay: block prohibited goods and AI images. Size/shipping gates stay in ebay draft eligibility.'),
  ('whatnot', '{
    "block_requires_power": false,
    "block_ai_images": true,
    "prohibited_keywords": ["firearm","ammunition","ammo","alcohol","tobacco"]
  }'::jsonb, 'Whatnot: block clearly prohibited goods and AI images.'),
  ('mercari', '{
    "block_requires_power": false,
    "block_ai_images": true,
    "block_stock_photos": true,
    "prohibited_keywords": ["firearm","ammunition","ammo","alcohol","tobacco","vape"]
  }'::jsonb, 'Mercari: no stock/AI images; block prohibited goods.'),
  ('facebook', '{
    "block_requires_power": false,
    "block_ai_images": true,
    "block_stock_photos": true,
    "prohibited_keywords": ["firearm","ammunition","ammo","alcohol","tobacco"]
  }'::jsonb, 'Facebook/Instagram catalog: prefer own photos; no AI or stock.'),
  ('amazon', '{
    "block_requires_power": false,
    "block_ai_images": true,
    "prohibited_keywords": ["firearm","ammunition","ammo"]
  }'::jsonb, 'Amazon: gate AI images; add ungated/recall rules as needed.'),
  ('website', '{
    "block_requires_power": false,
    "block_ai_images": false,
    "block_stock_photos": false
  }'::jsonb, 'Own website  -  permissive; still honor strikes/overrides.'),
  ('tiktok', '{
    "block_requires_power": false,
    "block_ai_images": true,
    "block_stock_photos": true,
    "prohibited_keywords": ["firearm","ammunition","ammo","alcohol","tobacco","vape"]
  }'::jsonb, 'TikTok Shop: no stock/AI; block restricted goods.'),
  ('vendoo', '{
    "block_requires_power": false,
    "block_ai_images": true
  }'::jsonb, 'Vendoo crosslist hub. Export includes per-channel flags; items blocked on all Vendoo targets are excluded.')
) as v(channel, rules, notes)
on conflict (store_id, channel) do nothing;

-- Heuristic backfill for existing inventory.
update public.units u set
  requires_power = true,
  is_electrical = true,
  updated_at = now()
where requires_power is null
  and (
    lower(coalesce(category, '')) in (
      'appliances','electronics','electric toothbrushes','power tools','small appliances',
      'kitchen appliances','audio','computers','gaming','tvs','vacuums','lighting','smart home'
    )
    or lower(coalesce(category, '')) like '%electric%'
    or lower(coalesce(title, '') || ' ' || coalesce(brand, '') || ' ' || coalesce(model, ''))
       ~* '(rechargeable|sonicare|toothbrush|vacuum|blender|microwave|laptop|bluetooth|cordless|electric|electronic)'
  );

update public.units u set
  is_camera = true,
  updated_at = now()
where coalesce(is_camera, false) is not true
  and (
    lower(coalesce(category, '')) like '%camera%'
    or lower(coalesce(title, '')) ~* '(?:^|[^a-z0-9])(camera|dslr|mirrorless|camcorder|gopro|webcam)(?:$|[^a-z0-9])'
  );

-- Mark manufacturer-photo usage when official- paths exist on the unit.
update public.units u set has_manufacturer_photos = true, updated_at = now()
where exists (
  select 1 from public.photos p
  where p.store_id = u.store_id and p.sku = u.sku and p.path like '%/official-%'
);

-- Log the Depop Sonicare strike if that SKU still exists (best-effort; ignore if missing).
insert into public.marketplace_policy_strikes(store_id, channel, sku, struck_at, reason, email_body, created_by_name)
select u.store_id, 'depop', u.sku, current_date,
  'Depop Electronics Policy  -  Philips Sonicare rechargeable toothbrush',
  'Removed under Depop Electronics Policy. Repeat violations can suspend the account.',
  'system seed'
from public.units u
where lower(coalesce(u.title, '') || ' ' || coalesce(u.brand, '') || ' ' || coalesce(u.model, '')) like '%sonicare%'
   or lower(coalesce(u.title, '')) like '%philips%toothbrush%'
on conflict (store_id, sku, channel) do nothing;