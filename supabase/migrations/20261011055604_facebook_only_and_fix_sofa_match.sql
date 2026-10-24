create or replace function public.unit_not_listable_reason(p_store uuid, p_sku text)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  u record;
  blob text;
  cat text;
begin
  select sku, title, brand, model, category, listing_body
    into u
  from public.units
  where store_id = p_store and sku = p_sku;
  if not found then return null; end if;

  if u.sku = '11284' then return 'Electric scooter — Facebook only'; end if;

  cat := lower(btrim(coalesce(u.category, '')));
  blob := lower(concat_ws(' ', u.category, u.title, u.brand, u.model, u.listing_body));

  -- Postgres word bounds are [[:<:]] / [[:>:]], not \\b.
  if cat in ('refrigerator', 'dishwasher', 'mattresses', 'washer', 'dryer', 'range') then
    return initcap(cat) || ' — Facebook only';
  end if;
  if blob ~ '[[:<:]](scooter|m365|segway|hoverboard)[[:>:]]' then
    return 'Electric scooter — Facebook only';
  end if;
  if blob ~ 'fridge|refrigerator|freezer' then
    return 'Refrigerator/freezer — Facebook only';
  end if;
  if blob ~ 'dishwasher' then
    return 'Dishwasher — Facebook only';
  end if;
  if blob ~ 'mattress|box[[:space:][:punct:]]*spring|[[:<:]]bed[[:space:]]+frame[[:>:]]' then
    return 'Bed/mattress — Facebook only';
  end if;
  if blob ~ 'deep[[:space:]]+fryer|commercial[[:space:]]+fryer' then
    return 'Commercial deep fryer — Facebook only';
  end if;
  if blob ~ '[[:<:]](sofa|couch|loveseat|sectional|recliner)[[:>:]]' then
    return 'Couch/sofa — Facebook only';
  end if;
  if blob ~ '[[:<:]]washer[[:>:]]|clothes[[:space:]]*dryer|[[:<:]](range|stove|oven|cooktop|armoire|dresser|wardrobe)[[:>:]]' then
    if blob !~ 'washer[[:space:]]+fluid' then
      return 'Oversized furniture/appliance — Facebook only';
    end if;
  end if;
  return null;
end $$;