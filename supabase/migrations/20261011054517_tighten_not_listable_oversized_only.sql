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

  if u.sku = '11284' then return 'Electric scooter — do not list online'; end if;

  cat := lower(btrim(coalesce(u.category, '')));
  blob := lower(concat_ws(' ', u.category, u.title, u.brand, u.model, u.listing_body));

  -- Only oversized / pickup-only big items — never use the shippable flag here
  -- (almost all units are currently shippable=false).
  if cat in ('refrigerator', 'dishwasher', 'mattresses', 'washer', 'dryer', 'range') then
    return initcap(cat) || ' — not listable online';
  end if;
  if blob ~ '\bscooter\b|m365|segway|hoverboard' then
    return 'Electric scooter — not listable online';
  end if;
  if blob ~ 'fridge|refrigerator|freezer' then
    return 'Refrigerator/freezer — not listable online';
  end if;
  if blob ~ 'dishwasher' then
    return 'Dishwasher — not listable online';
  end if;
  if blob ~ 'mattress|box.?spring|\bbed frame\b' then
    return 'Bed/mattress — not listable online';
  end if;
  if blob ~ 'deep fryer|commercial fryer' then
    return 'Commercial deep fryer — not listable online';
  end if;
  if blob ~ '\bsofa\b|\bcouch\b|loveseat|sectional|recliner' then
    return 'Couch/sofa — not listable online';
  end if;
  if blob ~ 'washer(?!\s*fluid)|clothes.?dryer|\brange\b|\bstove\b|\boven\b|cooktop|armoire|dresser|wardrobe' then
    return 'Oversized furniture/appliance — not listable online';
  end if;
  return null;
end $$;