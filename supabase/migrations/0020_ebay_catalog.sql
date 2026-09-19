-- Floor eBay categories and the aspect catalogs pulled from eBay.
-- Allowed values live here so listing and the unit screen do not depend on
-- eBay being reachable for everyday fills. Refresh replaces the rows.

create table if not exists public.ebay_floor_categories (
  slug text primary key,
  name text not null,
  ebay_category_id text not null,
  aliases text[] not null default '{}',
  defaults jsonb not null default '{}'::jsonb,
  standalone boolean not null default false
);

create table if not exists public.ebay_category_aspects (
  ebay_category_id text not null,
  aspect_name text not null,
  required boolean not null default false,
  recommended boolean not null default false,
  allowed_values jsonb not null default '[]'::jsonb,
  selection_only boolean not null default false,
  catalog_list boolean not null default false,
  sort_index int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (ebay_category_id, aspect_name)
);

alter table public.ebay_floor_categories enable row level security;
alter table public.ebay_category_aspects enable row level security;

create policy staff_read_ebay_floor_categories on public.ebay_floor_categories
  for select to authenticated
  using (public.is_staff());

create policy staff_read_ebay_category_aspects on public.ebay_category_aspects
  for select to authenticated
  using (public.is_staff());

grant select on public.ebay_floor_categories to authenticated;
grant select on public.ebay_category_aspects to authenticated;

insert into public.ebay_floor_categories (slug, name, ebay_category_id, aliases, defaults, standalone)
values
  ('refrigerators', 'Refrigerators', '20713',
    array['refrigerator','refrigerators','fridge','fridges','french door','side by side'],
    '{"Installation":"Freestanding"}'::jsonb, true),
  ('freezers', 'Freezers', '71260',
    array['freezer','freezers','chest freezer','upright freezer'],
    '{"Installation":"Freestanding"}'::jsonb, true),
  ('washers', 'Washers', '71256',
    array['washer','washers','washing machine','washing machines','laundry washer'],
    '{"Installation":"Freestanding"}'::jsonb, true),
  ('dryers', 'Dryers', '71254',
    array['dryer','dryers','clothes dryer'],
    '{"Installation":"Freestanding"}'::jsonb, true),
  ('ranges', 'Ranges / ovens', '71250',
    array['range','ranges','oven','ovens','stove','stoves','cooktop','wall oven'],
    '{"Installation":"Freestanding"}'::jsonb, true),
  ('dishwashers', 'Dishwashers', '116023',
    array['dishwasher','dishwashers'],
    '{"Installation":"Freestanding"}'::jsonb, true),
  ('microwaves', 'Microwaves', '150140',
    array['microwave','microwaves'],
    '{"Installation":"Freestanding"}'::jsonb, true),
  ('laptops', 'Laptops', '177',
    array['laptop','laptops','notebook','notebooks','computer','pc laptop'],
    '{}'::jsonb, false),
  ('tvs', 'TVs', '11071',
    array['tv','tvs','television','televisions'],
    '{}'::jsonb, false),
  ('small_kitchen', 'Small kitchen appliances', '20685',
    array['small kitchen','small appliance','blender','toaster','air fryer','coffee maker'],
    '{"Installation":"Freestanding"}'::jsonb, true),
  ('tools', 'Tools', '632',
    array['tool','tools','power tools','drill','saw'],
    '{}'::jsonb, false),
  ('vacuums', 'Vacuums', '20614',
    array['vacuum','vacuums','vacuum cleaner','shop vac'],
    '{"Installation":"Freestanding"}'::jsonb, true)
on conflict (slug) do update set
  name = excluded.name,
  ebay_category_id = excluded.ebay_category_id,
  aliases = excluded.aliases,
  defaults = excluded.defaults,
  standalone = excluded.standalone;
