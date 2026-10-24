-- listing_specs on units + portal your call review queue

alter table public.units
  add column if not exists listing_body text,
  add column if not exists listing_specs jsonb;

comment on column public.units.listing_specs is
  'JSON: ebay aspects, market comps, marketplace_pricing (online prices). Never use ask_cents as marketplace price.';

create table if not exists public.listing_review_queue (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id) on delete cascade,
  sku text not null,
  reason text not null,
  detail jsonb not null default '{}'::jsonb,
  best_viable_price_cents integer,
  profit_cents integer,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'kept_instore', 'dismissed')),
  decided_price_cents integer,
  decided_at timestamptz,
  decided_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, sku, reason)
);

create index if not exists listing_review_queue_store_status_idx
  on public.listing_review_queue (store_id, status, created_at desc);

alter table public.listing_review_queue enable row level security;

create or replace function public.portal_listing_queue()
returns table (
  id uuid,
  sku text,
  reason text,
  detail jsonb,
  best_viable_price_cents integer,
  profit_cents integer,
  status text,
  title text,
  condition text,
  ask_cents integer,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  sid uuid := public.portal_store_id();
begin
  if sid is null then
    raise exception 'not a portal admin';
  end if;
  return query
  select
    q.id,
    q.sku,
    q.reason,
    q.detail,
    q.best_viable_price_cents,
    q.profit_cents,
    q.status,
    coalesce(u.title, trim(both from concat_ws(' ', u.brand, u.model)), q.sku) as title,
    u.condition,
    u.ask_cents,
    q.created_at
  from public.listing_review_queue q
  left join public.units u on u.store_id = q.store_id and u.sku = q.sku
  where q.store_id = sid
    and q.status = 'pending'
  order by q.created_at desc;
end;
$$;

create or replace function public.portal_listing_queue_decide(
  p_id uuid,
  p_action text,
  p_price_cents integer default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  sid uuid := public.portal_store_id();
  row public.listing_review_queue;
begin
  if sid is null then
    raise exception 'not a portal admin';
  end if;
  select * into row from public.listing_review_queue where id = p_id and store_id = sid;
  if not found then
    raise exception 'queue row not found';
  end if;
  if p_action = 'keep_instore' then
    update public.listing_review_queue
    set status = 'kept_instore', decided_at = now(), decided_by = auth.uid(), updated_at = now()
    where id = p_id;
  elsif p_action = 'dismiss' then
    update public.listing_review_queue
    set status = 'dismissed', decided_at = now(), decided_by = auth.uid(), updated_at = now()
    where id = p_id;
  elsif p_action = 'approve' then
    if p_price_cents is null or p_price_cents <= 0 then
      raise exception 'price required';
    end if;
    update public.listing_review_queue
    set status = 'approved',
        decided_price_cents = p_price_cents,
        decided_at = now(),
        decided_by = auth.uid(),
        updated_at = now()
    where id = p_id;
    update public.units u
    set listing_specs = coalesce(u.listing_specs, '{}'::jsonb)
      || jsonb_build_object(
        'marketplace_pricing',
        coalesce(u.listing_specs->'marketplace_pricing', '{}'::jsonb)
          || jsonb_build_object(
            'ebay_list_usd', (p_price_cents::numeric / 100),
            'approved_at', now(),
            'your_call', false
          )
      ),
      updated_at = now()
    where u.store_id = sid and u.sku = row.sku;
  else
    raise exception 'unknown action';
  end if;
end;
$$;

grant execute on function public.portal_listing_queue() to authenticated;
grant execute on function public.portal_listing_queue_decide(uuid, text, integer) to authenticated;