WITH scored AS (
  SELECT
    u.sku,
    lower(concat_ws(' ',
      coalesce(u.title,''), coalesce(u.brand,''), coalesce(u.model,''),
      coalesce(u.category,''), coalesce(u.ebay_title,''),
      left(coalesce(u.listing_body,''), 500),
      coalesce(u.defect_notes,'')
    )) AS blob,
    lower(coalesce(u.category,'')) AS cat
  FROM units u
  WHERE u.store_id = '5487ca47-6147-4fe8-bc6d-46b6472726ba'
    AND u.state = 'available'
),
classified AS (
  SELECT
    sku,
    CASE
      WHEN blob ~ '(refrigerat|freezer|dishwasher|washer|dryer|range|stove|oven|microwave|air.?fry|coffee.?maker|espresso|toaster|blender|mixer|griddler|skillet.?electric|vacuum|humidifier|dehumidifier|heater|(\yfan\y)|air.?purifier|ice.?maker|printer|scanner|router|modem|monitor|television|(\ytv\y)|laptop|tablet|drone|robot|speaker|headphone|earbud|bluetooth|wi-?fi|smart.?home|cordless|rechargeable|battery.?powered|electric|electronic|motorized|plug-?in|110v|120v|240v|(\ywatt\y)|sonicare|toothbrush|massager|spin.?scrubber|sump.?pump|jet.?pump|power.?tool|drill|(\ysaw\y)|console|playstation|xbox|nintendo|gameboy|camera|camcorder|gopro|webcam|charger|charging|ac.?adapter|power.?adapter|power.?cord|power.?cable|extension.?cord|usb.?c|lightning.?cable|led.?bulb|light.?bulb|dimmable|batter(y|ies)|coppertop)'
        THEN true
      WHEN cat ~ '(appliance|electronic|electric toothbrush|power tool|audio|computer|gaming|tv|vacuum|lighting|smart home|household batter)'
        THEN true
      WHEN blob ~ '(storage.?bin|toothpaste|sunscreen|curtain|drape|air.?filter|furnace.?filter|comic|trading.?card|vinyl.?record|puzzle|action.?figure|hot.?wheels|star.?wars|lunch.?box|water.?bottle|flatware|cookware|towel|sheet|pillow|blanket|(\yrug\y)|(\ymat\y)|basket|organizer|soap|shampoo|lotion|cream|candle|hanger|hook|shelf|bin.?pack)'
        AND blob !~ '(electric|electronic|battery|rechargeable|cordless|charger|plug|motor|bluetooth|wi-?fi|led|bulb|pump|scrubber|toothbrush|speaker|vacuum|appliance)'
        THEN false
      ELSE NULL
    END AS power_flag
  FROM scored
)
UPDATE units u
SET
  requires_power = c.power_flag,
  is_electrical = c.power_flag
FROM classified c
WHERE u.store_id = '5487ca47-6147-4fe8-bc6d-46b6472726ba'
  AND u.sku = c.sku
  AND u.state = 'available';

UPDATE units u
SET has_manufacturer_photos = exists (
  SELECT 1 FROM photos p
  WHERE p.store_id = u.store_id AND p.sku = u.sku
    AND (p.path LIKE '%/official-%' OR p.path LIKE '%manufacturer%' OR coalesce(p.source,'') ILIKE '%manufacturer%' OR coalesce(p.source,'') ILIKE '%retail%')
)
WHERE u.store_id = '5487ca47-6147-4fe8-bc6d-46b6472726ba'
  AND u.state = 'available';

UPDATE marketplace_eligibility_review
SET status = 'dismissed',
    resolved_at = now(),
    resolution_note = 'Dismissed: Mercari rules no longer require power review; power reflag completed 2026-10-07'
WHERE store_id = '5487ca47-6147-4fe8-bc6d-46b6472726ba'
  AND channel = 'mercari'
  AND status = 'pending'
  AND reason ILIKE '%power/electrical status unknown%';

INSERT INTO marketplace_eligibility_review (store_id, sku, channel, reason, status)
SELECT
  '5487ca47-6147-4fe8-bc6d-46b6472726ba',
  u.sku,
  'depop',
  'Depop: needs review — power/electrical status unknown after full inventory reflag',
  'pending'
FROM units u
WHERE u.store_id = '5487ca47-6147-4fe8-bc6d-46b6472726ba'
  AND u.state = 'available'
  AND u.requires_power IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM marketplace_eligibility_review r
    WHERE r.store_id = u.store_id AND r.sku = u.sku AND r.channel = 'depop' AND r.status = 'pending'
  );