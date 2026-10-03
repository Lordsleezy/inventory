-- eBay drafts live in Floor until a person pushes them. Sale sync stores the fee and
-- baked-in shipping so payouts can use them, and eBay orders show up with website orders.
begin;

create table if not exists public.ebay_drafts (
  store_id uuid not null references public.stores (id) on delete cascade,
  sku text not null,
  status text not null default 'draft' check (status in ('draft', 'live')),
  title text,
  description text,
  category_id text,
  category_name text,
  suggestions jsonb not null default '[]'::jsonb,
  condition_id text,
  condition_enum text,
  condition_notes text,
  aspects jsonb not null default '{}'::jsonb,
  aspect_defs jsonb not null default '[]'::jsonb,
  conditions jsonb not null default '[]'::jsonb,
  photo_paths jsonb not null default '[]'::jsonb,
  shipping_mode text check (shipping_mode is null or shipping_mode in ('free', 'calculated')),
  price_cents int,
  label_cents int,
  label_source text,
  label_key text,
  ebay_error text,
  listing_id text,
  offer_id text,
  view_url text,
  locks jsonb not null default '[]'::jsonb,
  checklist jsonb not null default '[]'::jsonb,
  ready boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (store_id, sku)
);
alter table public.ebay_drafts enable row level security;
revoke all on public.ebay_drafts from public, anon, authenticated;
grant all on public.ebay_drafts to service_role;

alter table public.channel_orders
  add column if not exists item_cents int,
  add column if not exists fee_cents int,
  add column if not exists baked_ship_cents int;

alter table public.web_orders
  add column if not exists channel text not null default 'website';

alter table public.delist_tasks
  add column if not exists attempts int not null default 0,
  add column if not exists last_error text,
  add column if not exists alerted_at timestamptz;

alter table public.oauth_states
  add column if not exists return_to text;

insert into public.store_settings (store_id, key, value)
select s.id, d.key, d.value
  from public.stores s
 cross join (values
   ('ebay_fee_pct', '13.25'::jsonb),
   ('ebay_per_order_cents', '40'::jsonb),
   ('ebay_free_ship_cutoff_cents', '1500'::jsonb),
   ('ebay_price_ending', '99'::jsonb),
   ('ebay_far_zip', '"10001"'::jsonb)
 ) as d(key, value)
on conflict (store_id, key) do nothing;

update public.store_settings s
   set value = (
     select coalesce(jsonb_agg(x order by x), '[]'::jsonb)
       from (
         select jsonb_array_elements_text(s.value) as x
         union
         select 'ebay'
       ) q
   )
 where s.key = 'online_channels'
   and jsonb_typeof(s.value) = 'array'
   and not exists (
     select 1 from jsonb_array_elements_text(s.value) x where lower(x) = 'ebay'
   );

-- Payout history needs the eBay fee and any shipping that was baked into the item price.
drop function if exists public.portal_payout_sales();
create function public.portal_payout_sales()
returns table (
  id bigint, ticket_key text, sku text, title text, qty int, sold_at timestamptz,
  price_cents int, tax_cents int, card_fee_cents int, cost_cents int,
  payment_method text, cash_cents int, card_cents int, actor_id uuid,
  actor_name text, channel text, receipt_no text,
  ebay_fee_cents int, baked_ship_cents int
) language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return query
    select s.id, coalesce(s.ticket_id::text, 'sale:' || s.id::text), s.sku,
      coalesce(nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), nullif(u.title, ''), 'Item')::text,
      s.qty, s.sold_at, s.price_cents, s.tax_cents, s.card_fee_cents,
      u.acquisition_cost_cents, s.payment_method, x.cash_cents, x.card_cents,
      s.actor_id, coalesce(st.display_name, 'Unknown')::text, s.channel, s.receipt_no,
      coalesce(co.fee_cents, 0), coalesce(co.baked_ship_cents, 0)
    from public.sales s
    left join public.units u on u.store_id = s.store_id and u.sku = s.sku
    left join public.staff st on st.store_id = s.store_id and st.user_id = s.actor_id
    left join public.ticket_extras x on x.store_id = s.store_id and x.ticket_id = s.ticket_id
    left join public.channel_orders co on co.sale_id = s.id and co.provider = 'ebay'
    where s.store_id = v_store and s.voided_at is null
    order by s.id;
end $$;
revoke all on function public.portal_payout_sales() from public, anon;
grant execute on function public.portal_payout_sales() to authenticated;

create or replace function public.portal_web_orders(p_days int default 90)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(x order by x.created_at desc) from (
    select o.id, o.order_no, o.sku, o.status, o.fulfillment, o.channel, o.buyer_name, o.buyer_email, o.buyer_phone,
      o.ship_line1, o.ship_line2, o.ship_city, o.ship_region, o.ship_postal,
      o.item_cents, o.shipping_cents, o.tax_cents, o.total_cents, o.payment_id, o.refund_id, o.payment_env,
      o.created_at, o.paid_at, o.pickup_deadline, o.picked_up_at, o.picked_up_by,
      o.boxed_at, o.shipped_at, o.tracking_number, o.tracking_url, o.carrier, o.service, o.shipping_rate,
      o.label_url, o.label_purchased_at, o.label_cost_cents, o.refund_requested_at, o.cancel_source,
      o.cancel_reason, o.canceled_at,
      coalesce(nullif(btrim(u.title),''), nullif(btrim(concat_ws(' ', u.brand, u.model)),''), 'Item') as title,
      jsonb_build_object('length_in',u.package_length_in,'width_in',u.package_width_in,
        'height_in',u.package_height_in,'weight_lb',u.package_weight_lb) as package
    from public.web_orders o
    left join public.units u on u.store_id = o.store_id and u.sku = o.sku
    where o.store_id = v_store and o.created_at > now() - make_interval(days => greatest(p_days,1))
      and (o.status in ('paid','refunded') or o.paid_at is not null)
  ) x), '[]'::jsonb);
end $$;

commit;
