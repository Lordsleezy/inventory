-- Channel-agnostic returns system: RMA records, garage receiving, ledger costs,
-- return settings, pack-time proof, supplier return routing, Amazon/TikTok intake hooks.
-- Safe on live data: additive tables/columns only; no price or listing mutations.

begin;

-- ---------------------------------------------------------------------------
-- Suppliers (dropship bot coordination; safe if bot lands later)
-- ---------------------------------------------------------------------------
create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  name text not null,
  accepts_returns boolean not null default false,
  has_us_return_address boolean not null default false,
  return_address_line1 text,
  return_address_line2 text,
  return_address_city text,
  return_address_region text,
  return_address_postal text,
  return_address_country text not null default 'US',
  return_window_days int,
  restocking_fee_pct numeric(6,2) not null default 0,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint suppliers_name_nonempty check (btrim(name) <> ''),
  constraint suppliers_restocking_ok check (restocking_fee_pct >= 0 and restocking_fee_pct <= 100),
  constraint suppliers_window_ok check (return_window_days is null or return_window_days >= 0)
);

create unique index if not exists suppliers_store_name_uidx
  on public.suppliers (store_id, lower(btrim(name)));

alter table public.units
  add column if not exists supplier_id uuid references public.suppliers(id) on delete set null;

create index if not exists units_supplier_id_idx on public.units (store_id, supplier_id)
  where supplier_id is not null;

alter table public.suppliers enable row level security;
drop policy if exists staff_all_suppliers on public.suppliers;
create policy staff_all_suppliers on public.suppliers
  for all to authenticated
  using (store_id = coalesce(public.current_store_id(), public.portal_store_id()))
  with check (store_id = coalesce(public.current_store_id(), public.portal_store_id()));
grant select, insert, update, delete on public.suppliers to authenticated;
grant all on public.suppliers to service_role;

-- ---------------------------------------------------------------------------
-- Returns
-- ---------------------------------------------------------------------------
create table if not exists public.returns (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  sku text not null,
  sale_id bigint references public.sales(id) on delete set null,
  web_order_id uuid references public.web_orders(id) on delete set null,
  channel text not null,
  external_order_id text,
  external_return_id text,
  reason text not null default 'buyer_remorse'
    check (reason in (
      'buyer_remorse', 'defective', 'not_as_described', 'wrong_item', 'damaged_in_transit', 'other'
    )),
  fault text not null default 'unknown'
    check (fault in ('seller', 'buyer', 'unknown', 'carrier')),
  status text not null default 'requested'
    check (status in (
      'requested', 'approved', 'in_transit', 'received', 'inspected',
      'dispositioned', 'closed', 'refunded_no_return', 'denied', 'canceled'
    )),
  refund_cents int not null default 0 check (refund_cents >= 0),
  return_label_cents int not null default 0 check (return_label_cents >= 0),
  label_paid_by text not null default 'unknown'
    check (label_paid_by in ('seller', 'buyer', 'channel', 'unknown')),
  unrecovered_fees_cents int not null default 0 check (unrecovered_fees_cents >= 0),
  regrade_loss_cents int not null default 0 check (regrade_loss_cents >= 0),
  decision_deadline_at timestamptz,
  approved_at timestamptz,
  in_transit_at timestamptz,
  received_at timestamptz,
  inspected_at timestamptz,
  dispositioned_at timestamptz,
  closed_at timestamptz,
  refunded_at timestamptz,
  condition_before text,
  condition_after text,
  inspection_notes text,
  disposition text
    check (disposition is null or disposition in (
      'relist', 'downgrade_channel', 'bundle_lot', 'write_off', 'supplier_credit', 'keep_buyer'
    )),
  route_to text not null default 'garage'
    check (route_to in ('garage', 'supplier', 'buyer_keeps')),
  supplier_id uuid references public.suppliers(id) on delete set null,
  supplier_credit_cents int not null default 0 check (supplier_credit_cents >= 0),
  supplier_credit_received boolean not null default false,
  tracking_number text,
  carrier text,
  needs_decision boolean not null default false,
  ledger_posted_at timestamptz,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  closed_by uuid,
  constraint returns_channel_ok check (channel = lower(btrim(channel)))
);

create unique index if not exists returns_external_uidx
  on public.returns (store_id, channel, external_return_id)
  where external_return_id is not null;

create index if not exists returns_store_status_idx
  on public.returns (store_id, status, created_at desc);

create index if not exists returns_store_sku_idx
  on public.returns (store_id, sku);

create index if not exists returns_decision_idx
  on public.returns (store_id, needs_decision, decision_deadline_at)
  where needs_decision = true and status = 'requested';

create table if not exists public.return_photos (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  return_id uuid not null references public.returns(id) on delete cascade,
  path text not null,
  kind text not null default 'inspection'
    check (kind in ('inspection', 'damage', 'pack_proof', 'other')),
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid
);

create index if not exists return_photos_return_idx on public.return_photos (return_id, sort_order);

alter table public.returns enable row level security;
alter table public.return_photos enable row level security;

drop policy if exists staff_all_returns on public.returns;
create policy staff_all_returns on public.returns
  for all to authenticated
  using (store_id = coalesce(public.current_store_id(), public.portal_store_id()))
  with check (store_id = coalesce(public.current_store_id(), public.portal_store_id()));

drop policy if exists staff_all_return_photos on public.return_photos;
create policy staff_all_return_photos on public.return_photos
  for all to authenticated
  using (store_id = coalesce(public.current_store_id(), public.portal_store_id()))
  with check (store_id = coalesce(public.current_store_id(), public.portal_store_id()));

grant select, insert, update, delete on public.returns to authenticated;
grant select, insert, update, delete on public.return_photos to authenticated;
grant all on public.returns to service_role;
grant all on public.return_photos to service_role;

-- Pack-time proof on orders (Amazon / TikTok dispute protection)
alter table public.web_orders
  add column if not exists pack_proof_photo_path text,
  add column if not exists pack_proof_serial text,
  add column if not exists pack_proof_at timestamptz;

-- Alert kind for 48h decision clock
alter table public.alert_outbox drop constraint if exists alert_outbox_kind_check;
alter table public.alert_outbox add constraint alert_outbox_kind_check
  check (kind in (
    'sale_delist', 'delist_nag', 'double_sell', 'sale_relist',
    'web_order', 'web_shipped', 'web_apology', 'pack_condition', 'return_decision'
  ));

-- ---------------------------------------------------------------------------
-- Settings defaults (editable; never hardcodes channel behavior in app code)
-- ---------------------------------------------------------------------------
create or replace function public.default_return_settings()
returns jsonb language sql immutable as $$
  select '{
    "reserve_pct": {"amazon": 10, "tiktok": 10, "ebay": 0, "mercari": 0, "website": 0, "depop": 0, "whatnot": 0, "facebook": 0, "other": 0},
    "refund_no_return_max_item_cents": 1500,
    "refund_no_return_if_label_exceeds_item": true,
    "decision_hours": {"tiktok": 48, "amazon": 72, "ebay": 72, "default": 72},
    "gate_amazon_tiktok": {
      "block_conditions": ["fair", "defective", "for parts", "for_parts"],
      "require_real_photos": true
    },
    "relist_channels_default": ["ebay", "mercari", "website"],
    "downgrade_block_channels": ["amazon", "tiktok"]
  }'::jsonb;
$$;

insert into public.store_settings (store_id, key, value)
select s.id, 'return_settings', public.default_return_settings()
from public.stores s
on conflict (store_id, key) do nothing;

create or replace function public.return_settings(p_store uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  d jsonb := public.default_return_settings();
  v jsonb;
begin
  select value into v from public.store_settings
   where store_id = p_store and key = 'return_settings';
  v := coalesce(v, '{}'::jsonb);
  return d || v
    || jsonb_build_object(
      'reserve_pct', coalesce(d->'reserve_pct', '{}'::jsonb) || coalesce(v->'reserve_pct', '{}'::jsonb),
      'decision_hours', coalesce(d->'decision_hours', '{}'::jsonb) || coalesce(v->'decision_hours', '{}'::jsonb),
      'gate_amazon_tiktok', coalesce(d->'gate_amazon_tiktok', '{}'::jsonb) || coalesce(v->'gate_amazon_tiktok', '{}'::jsonb)
    );
end $$;

create or replace function public.channel_return_reserve_pct(p_store uuid, p_channel text)
returns numeric language plpgsql stable security definer set search_path = public as $$
declare
  v jsonb := public.return_settings(p_store);
  v_ch text := lower(btrim(coalesce(p_channel, '')));
  v_pct numeric;
begin
  v_pct := nullif(v #>> array['reserve_pct', v_ch], '')::numeric;
  if v_pct is null then
    v_pct := nullif(v #>> array['reserve_pct', 'other'], '')::numeric;
  end if;
  return coalesce(v_pct, 0);
end $$;

revoke all on function public.return_settings(uuid) from public, anon;
grant execute on function public.return_settings(uuid) to authenticated, service_role;
revoke all on function public.channel_return_reserve_pct(uuid, text) from public, anon;
grant execute on function public.channel_return_reserve_pct(uuid, text) to authenticated, service_role;

-- Apply reserve onto a candidate list price (does not mutate stored ask_cents).
create or replace function public.apply_return_reserve_cents(p_store uuid, p_channel text, p_price_cents int)
returns int language plpgsql stable security definer set search_path = public as $$
declare v_pct numeric := public.channel_return_reserve_pct(p_store, p_channel);
begin
  if p_price_cents is null or p_price_cents <= 0 then return coalesce(p_price_cents, 0); end if;
  if coalesce(v_pct, 0) <= 0 then return p_price_cents; end if;
  return greatest(p_price_cents, ceil((p_price_cents * (100 + v_pct)) / 100.0)::int);
end $$;

revoke all on function public.apply_return_reserve_cents(uuid, text, int) from public, anon;
grant execute on function public.apply_return_reserve_cents(uuid, text, int) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Amazon/TikTok return-risk gate (Fair/Defective / no real photos → block)
-- ---------------------------------------------------------------------------
create or replace function public.return_risk_channel_gate(p_store uuid, p_sku text, p_channel text)
returns table(status text, reason text, source text)
language plpgsql stable security definer set search_path = public as $$
declare
  u public.units;
  v_channel text := lower(btrim(coalesce(p_channel, '')));
  v_settings jsonb := public.return_settings(p_store);
  v_gate jsonb;
  v_cond text;
  v_blocked text;
  v_photo_count int;
  v_real_photos boolean;
begin
  if v_channel not in ('amazon', 'tiktok') then
    return query select 'allow'::text, 'n/a'::text, 'return_gate'::text;
    return;
  end if;

  select * into u from public.units where store_id = p_store and sku = p_sku;
  if not found then
    return query select 'block'::text, 'Unit not found'::text, 'return_gate'::text;
    return;
  end if;

  v_gate := coalesce(v_settings->'gate_amazon_tiktok', '{}'::jsonb);
  v_cond := lower(btrim(coalesce(u.condition, '')));

  for v_blocked in
    select lower(btrim(x)) from jsonb_array_elements_text(coalesce(v_gate->'block_conditions', '[]'::jsonb)) x
  loop
    if v_cond <> '' and (v_cond = v_blocked or v_cond like '%' || v_blocked || '%') then
      return query select 'block'::text,
        public.channel_display_name(v_channel) || ': blocked — condition "' || coalesce(u.condition, '') || '" not eligible for forced-return channels',
        'return_gate'::text;
      return;
    end if;
  end loop;

  if coalesce((v_gate->>'require_real_photos')::boolean, true) then
    select count(*)::int into v_photo_count
      from public.photos p where p.store_id = p_store and p.sku = p_sku;
    v_real_photos := v_photo_count > 0
      and coalesce(u.has_stock_photos, false) is not true
      and coalesce(u.has_ai_images, false) is not true;
    if not v_real_photos then
      return query select 'block'::text,
        public.channel_display_name(v_channel) || ': blocked — needs real unit photos before Amazon/TikTok listing',
        'return_gate'::text;
      return;
    end if;
  end if;

  return query select 'allow'::text, 'return risk ok'::text, 'return_gate'::text;
end $$;

revoke all on function public.return_risk_channel_gate(uuid, text, text) from public, anon;
grant execute on function public.return_risk_channel_gate(uuid, text, text) to authenticated, service_role;

do $$
begin
  if to_regprocedure('public.evaluate_marketplace_eligibility(uuid,text,text)') is not null
     and to_regprocedure('public.evaluate_marketplace_eligibility_core(uuid,text,text)') is null
  then
    alter function public.evaluate_marketplace_eligibility(uuid, text, text)
      rename to evaluate_marketplace_eligibility_core;
  end if;
end $$;

create or replace function public.evaluate_marketplace_eligibility(p_store uuid, p_sku text, p_channel text)
returns table(status text, reason text, source text)
language plpgsql stable security definer set search_path = public as $$
declare
  v_status text;
  v_reason text;
  v_source text;
  g_status text;
  g_reason text;
  g_source text;
begin
  select e.status, e.reason, e.source into v_status, v_reason, v_source
    from public.evaluate_marketplace_eligibility_core(p_store, p_sku, p_channel) e;

  if v_status = 'allow' then
    select g.status, g.reason, g.source into g_status, g_reason, g_source
      from public.return_risk_channel_gate(p_store, p_sku, p_channel) g;
    if g_status = 'block' then
      return query select g_status, g_reason, g_source;
      return;
    end if;
  end if;

  return query select v_status, v_reason, v_source;
end $$;

revoke all on function public.evaluate_marketplace_eligibility(uuid, text, text) from public, anon;
grant execute on function public.evaluate_marketplace_eligibility(uuid, text, text) to authenticated, service_role;
-- core stays callable for tests/debug
revoke all on function public.evaluate_marketplace_eligibility_core(uuid, text, text) from public, anon;
grant execute on function public.evaluate_marketplace_eligibility_core(uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.map_return_reason(p_raw text)
returns text language sql immutable as $$
  select case
    when lower(coalesce(p_raw,'')) ~ 'defect|broken|not.?working|malfunction' then 'defective'
    when lower(coalesce(p_raw,'')) ~ 'not.?as.?descri|misrepresent|condition' then 'not_as_described'
    when lower(coalesce(p_raw,'')) ~ 'wrong.?item|incorrect' then 'wrong_item'
    when lower(coalesce(p_raw,'')) ~ 'damag|transit|shipping|crush' then 'damaged_in_transit'
    when lower(coalesce(p_raw,'')) ~ 'remorse|changed.?mind|no.?longer' then 'buyer_remorse'
    else 'other'
  end;
$$;

create or replace function public.enqueue_return_decision_alert(p_return public.returns)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not coalesce(p_return.needs_decision, false) then return; end if;
  if exists (
    select 1 from public.alert_outbox a
     where a.store_id = p_return.store_id
       and a.kind = 'return_decision'
       and a.sku = p_return.sku
       and a.sent_at is null
       and a.payload->>'return_id' = p_return.id::text
  ) then return; end if;

  insert into public.alert_outbox (store_id, kind, sku, payload)
  values (
    p_return.store_id,
    'return_decision',
    p_return.sku,
    jsonb_build_object(
      'return_id', p_return.id,
      'channel', p_return.channel,
      'order_id', p_return.external_order_id,
      'deadline_at', p_return.decision_deadline_at,
      'reason', p_return.reason,
      'status', p_return.status
    )
  );
end $$;

create or replace function public.returns_should_refund_no_return(
  p_store uuid, p_item_cents int, p_label_cents int
) returns boolean language plpgsql stable security definer set search_path = public as $$
declare v jsonb := public.return_settings(p_store);
declare v_max int := coalesce((v->>'refund_no_return_max_item_cents')::int, 1500);
declare v_label_rule boolean := coalesce((v->>'refund_no_return_if_label_exceeds_item')::boolean, true);
begin
  if coalesce(p_item_cents, 0) > 0 and p_item_cents <= v_max then return true; end if;
  if v_label_rule and coalesce(p_label_cents, 0) > 0 and coalesce(p_item_cents, 0) > 0
     and p_label_cents >= p_item_cents then
    return true;
  end if;
  return false;
end $$;

-- Reverse sale money for returns. restock=true → unit available + relist alert;
-- restock=false → unit lost (buyer kept / write-off path) and no relist.
create or replace function public.return_reverse_sale(
  p_store uuid,
  p_sale_id bigint,
  p_reason text,
  p_restock boolean default true
) returns void language plpgsql security definer set search_path = public as $$
declare
  r public.sales;
begin
  perform set_config('floor.store_id', p_store::text, true);
  if p_sale_id is null then return; end if;

  select * into r from public.sales
   where id = p_sale_id and store_id = p_store and voided_at is null
   for update;
  if not found then return; end if;

  update public.sales
     set voided_at = now(), void_reason = btrim(coalesce(p_reason, 'return'))
   where id = r.id;

  update public.sku_ledger set fate = case when p_restock then 'issued' else 'retired' end
   where store_id = p_store and sku = r.sku;

  if p_restock then
    update public.units
       set state = 'available', updated_at = now()
     where store_id = p_store and sku = r.sku;
    perform public.enqueue_sale_relist_alerts(r);
  else
    update public.units
       set state = 'lost', updated_at = now()
     where store_id = p_store and sku = r.sku;
  end if;

  insert into public.events (store_id, sku, kind, actor, note)
  values (
    p_store, r.sku, 'sale_void',
    coalesce((select display_name from public.staff where user_id = auth.uid()), 'returns'),
    btrim(coalesce(p_reason, 'return')) || case when p_restock then ' (restock)' else ' (no restock)' end
  );
end $$;

revoke all on function public.return_reverse_sale(uuid, bigint, text, boolean) from public, anon;
grant execute on function public.return_reverse_sale(uuid, bigint, text, boolean) to service_role;

-- Expand expense sources used by returns + existing label/ebay writers.
alter table public.portal_expenses drop constraint if exists portal_expenses_source_check;
alter table public.portal_expenses add constraint portal_expenses_source_check
  check (source in ('manual', 'label', 'manual_label', 'ebay', 'return', 'amazon', 'channel'));

create or replace function public.return_post_ledger(p_return_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  r public.returns;
  v_total int;
  v_desc text;
begin
  select * into r from public.returns where id = p_return_id for update;
  if not found then return; end if;
  if r.ledger_posted_at is not null then return; end if;

  v_total := coalesce(r.refund_cents, 0)
    + case when r.label_paid_by = 'seller' then coalesce(r.return_label_cents, 0) else 0 end
    + coalesce(r.unrecovered_fees_cents, 0)
    + coalesce(r.regrade_loss_cents, 0);

  if v_total <= 0 then
    update public.returns set ledger_posted_at = now(), updated_at = now() where id = r.id;
    return;
  end if;

  v_desc := 'Return ' || upper(r.channel) || ' SKU ' || r.sku
    || coalesce(' order ' || r.external_order_id, '');

  insert into public.portal_expenses(
    store_id, spent_on, description, category, amount_cents,
    needs_reimbursement, source, order_id, external_id
  ) values (
    r.store_id,
    (timezone('America/Los_Angeles', now()))::date,
    v_desc,
    'Returns',
    v_total,
    false,
    'return',
    r.web_order_id,
    r.id::text
  );

  update public.returns set ledger_posted_at = now(), updated_at = now() where id = r.id;
end $$;

-- ---------------------------------------------------------------------------
-- Ingest (service_role / Netlify). Idempotent on (store, channel, external_return_id).
-- ---------------------------------------------------------------------------
create or replace function public.ingest_channel_return(
  p_store uuid,
  p_channel text,
  p_payload jsonb
) returns public.returns
language plpgsql security definer set search_path = public as $$
declare
  v_channel text := lower(btrim(coalesce(p_channel, '')));
  v_ext text := nullif(btrim(coalesce(p_payload->>'external_return_id', p_payload->>'amazon_rma_id', p_payload->>'return_id', '')), '');
  v_order text := nullif(btrim(coalesce(p_payload->>'external_order_id', p_payload->>'order_id', '')), '');
  v_sku text := nullif(btrim(coalesce(p_payload->>'sku', p_payload->>'merchant_sku', '')), '');
  v_wo public.web_orders;
  v_sale public.sales;
  v_settings jsonb;
  v_hours int;
  v_row public.returns;
  v_item int;
  v_label int := greatest(0, coalesce((p_payload->>'return_label_cents')::int, 0));
  v_refund int := greatest(0, coalesce((p_payload->>'refund_cents')::int, 0));
  v_status text := lower(btrim(coalesce(p_payload->>'status', 'requested')));
  v_needs boolean := coalesce((p_payload->>'needs_decision')::boolean, true);
  v_supplier public.suppliers;
  v_route text := 'garage';
begin
  perform public.assert_service();
  if p_store is null or v_channel = '' then
    raise exception 'store_and_channel_required' using errcode = '22023';
  end if;

  if v_ext is not null then
    select * into v_row from public.returns
     where store_id = p_store and channel = v_channel and external_return_id = v_ext;
    if found then
      update public.returns set
        raw = coalesce(raw, '{}'::jsonb) || coalesce(p_payload, '{}'::jsonb),
        refund_cents = case when v_refund > 0 then v_refund else refund_cents end,
        return_label_cents = case when v_label > 0 then v_label else return_label_cents end,
        tracking_number = coalesce(nullif(p_payload->>'tracking_number',''), tracking_number),
        carrier = coalesce(nullif(p_payload->>'carrier',''), carrier),
        updated_at = now()
      where id = v_row.id
      returning * into v_row;
      return v_row;
    end if;
  end if;

  if v_order is not null then
    select * into v_wo from public.web_orders
     where store_id = p_store and channel = v_channel and order_no = v_order
     order by created_at desc limit 1;
  end if;

  if v_sku is null and v_wo.id is not null then v_sku := v_wo.sku; end if;

  if v_wo.sale_id is not null then
    select * into v_sale from public.sales where id = v_wo.sale_id;
  elsif v_sku is not null then
    select * into v_sale from public.sales
     where store_id = p_store and sku = v_sku and voided_at is null
     order by sold_at desc limit 1;
  end if;

  if v_sku is null then v_sku := 'UNMATCHED'; end if;

  v_item := coalesce(v_wo.item_cents, v_sale.price_cents, (p_payload->>'order_amount_cents')::int, 0);
  if v_refund <= 0 then v_refund := v_item; end if;

  -- Dropship routing
  if v_sku <> 'UNMATCHED' then
    select s.* into v_supplier
      from public.units u
      join public.suppliers s on s.id = u.supplier_id
     where u.store_id = p_store and u.sku = v_sku;
    if found then
      if v_supplier.accepts_returns and v_supplier.has_us_return_address then
        v_route := 'supplier';
      elsif public.returns_should_refund_no_return(p_store, v_item, v_label) then
        v_route := 'buyer_keeps';
        v_status := 'refunded_no_return';
        v_needs := false;
      end if;
    end if;
  end if;

  if v_route = 'garage' and public.returns_should_refund_no_return(p_store, v_item, v_label)
     and coalesce((p_payload->>'force_physical_return')::boolean, false) is not true then
    v_route := 'buyer_keeps';
    v_status := 'refunded_no_return';
    v_needs := false;
  end if;

  if v_status not in (
    'requested','approved','in_transit','received','inspected','dispositioned',
    'closed','refunded_no_return','denied','canceled'
  ) then
    v_status := 'requested';
  end if;

  v_settings := public.return_settings(p_store);
  v_hours := coalesce(
    (v_settings #>> array['decision_hours', v_channel])::int,
    (v_settings #>> array['decision_hours', 'default'])::int,
    72
  );

  insert into public.returns (
    store_id, sku, sale_id, web_order_id, channel, external_order_id, external_return_id,
    reason, fault, status, refund_cents, return_label_cents, label_paid_by,
    unrecovered_fees_cents, decision_deadline_at, needs_decision, route_to, supplier_id,
    tracking_number, carrier, condition_before, raw
  ) values (
    p_store,
    v_sku,
    v_sale.id,
    v_wo.id,
    v_channel,
    v_order,
    v_ext,
    public.map_return_reason(coalesce(p_payload->>'reason', p_payload->>'return_reason', '')),
    case
      when lower(coalesce(p_payload->>'fault','')) in ('seller','buyer','carrier') then lower(p_payload->>'fault')
      when public.map_return_reason(coalesce(p_payload->>'reason','')) in ('defective','not_as_described','wrong_item') then 'seller'
      when public.map_return_reason(coalesce(p_payload->>'reason','')) = 'buyer_remorse' then 'buyer'
      else 'unknown'
    end,
    v_status,
    v_refund,
    v_label,
    case lower(coalesce(p_payload->>'label_paid_by', p_payload->>'label_to_be_paid_by', ''))
      when 'seller' then 'seller'
      when 'buyer' then 'buyer'
      when 'customer' then 'buyer'
      when 'amazon' then 'channel'
      when 'channel' then 'channel'
      else 'unknown'
    end,
    greatest(0, coalesce((p_payload->>'unrecovered_fees_cents')::int, 0)),
    case when v_needs then now() + make_interval(hours => greatest(v_hours, 1)) else null end,
    v_needs,
    v_route,
    v_supplier.id,
    nullif(p_payload->>'tracking_number',''),
    nullif(p_payload->>'carrier',''),
    (select condition from public.units where store_id = p_store and sku = v_sku),
    coalesce(p_payload, '{}'::jsonb)
  ) returning * into v_row;

  if v_row.needs_decision then
    perform public.enqueue_return_decision_alert(v_row);
  end if;

  if v_row.status = 'refunded_no_return' then
    perform public.return_reverse_sale(p_store, v_row.sale_id, 'Refund without return', false);
    if v_row.web_order_id is not null then
      update public.web_orders
         set status = case when status = 'paid' then 'refunded' else status end,
             canceled_at = coalesce(canceled_at, now()),
             cancel_source = coalesce(cancel_source, 'return'),
             cancel_reason = coalesce(cancel_reason, 'refunded_no_return'),
             updated_at = now()
       where id = v_row.web_order_id and store_id = p_store;
    end if;
    update public.returns set
      refunded_at = now(), closed_at = now(), disposition = 'keep_buyer', updated_at = now()
     where id = v_row.id
     returning * into v_row;
    perform public.return_post_ledger(v_row.id);
  end if;

  if exists (select 1 from public.sku_ledger where store_id = p_store and sku = v_row.sku) then
    insert into public.events (store_id, sku, kind, actor, note)
    values (p_store, v_row.sku, 'return_opened', 'channel:' || v_channel,
            coalesce(v_row.external_return_id, v_row.id::text) || ' ' || v_row.status);
  end if;

  return v_row;
end $$;

revoke all on function public.ingest_channel_return(uuid, text, jsonb) from public, anon;
grant execute on function public.ingest_channel_return(uuid, text, jsonb) to service_role;

-- Dropship bot pre-list check
create or replace function public.supplier_return_policy_check(p_store uuid, p_supplier uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  s public.suppliers;
  v_reserve numeric;
  v_flag text := 'ok';
  v_note text := '';
begin
  select * into s from public.suppliers where id = p_supplier and store_id = p_store;
  if not found then
    return jsonb_build_object('ok', false, 'flag', 'missing_supplier', 'suggested_reserve_pct', 15,
      'note', 'Supplier not found');
  end if;
  v_reserve := public.channel_return_reserve_pct(p_store, 'amazon');
  if not s.accepts_returns or not s.has_us_return_address then
    v_flag := 'no_return_policy';
    v_note := 'Supplier has no US return path — raise reserve or skip Amazon/TikTok';
    v_reserve := greatest(v_reserve, 15);
  elsif coalesce(s.return_window_days, 0) < 30 then
    v_flag := 'short_window';
    v_note := 'Return window under 30 days — marketplace windows may exceed supplier policy';
    v_reserve := greatest(v_reserve, 12);
  end if;
  return jsonb_build_object(
    'ok', v_flag = 'ok',
    'flag', v_flag,
    'note', v_note,
    'suggested_reserve_pct', v_reserve,
    'accepts_returns', s.accepts_returns,
    'has_us_return_address', s.has_us_return_address,
    'return_window_days', s.return_window_days,
    'restocking_fee_pct', s.restocking_fee_pct
  );
end $$;

revoke all on function public.supplier_return_policy_check(uuid, uuid) from public, anon;
grant execute on function public.supplier_return_policy_check(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Portal RPCs
-- ---------------------------------------------------------------------------
create or replace function public.portal_return_settings()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return public.return_settings(v_store);
end $$;

create or replace function public.portal_set_return_settings(p_value jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v jsonb;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if p_value is null or jsonb_typeof(p_value) <> 'object' then
    raise exception 'invalid_settings' using errcode = '22023';
  end if;
  v := public.default_return_settings() || p_value;
  insert into public.store_settings (store_id, key, value)
  values (v_store, 'return_settings', v)
  on conflict (store_id, key) do update set value = excluded.value;
  return v;
end $$;

revoke all on function public.portal_return_settings() from public, anon;
revoke all on function public.portal_set_return_settings(jsonb) from public, anon;
grant execute on function public.portal_return_settings() to authenticated;
grant execute on function public.portal_set_return_settings(jsonb) to authenticated;

create or replace function public.portal_returns(p_status text default null, p_limit int default 200)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_status text := nullif(lower(btrim(coalesce(p_status, ''))), '');
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(x order by
      case when x.needs_decision then 0 else 1 end,
      x.decision_deadline_at nulls last,
      x.created_at desc)
    from (
      select r.*,
        coalesce(nullif(btrim(u.title),''), nullif(btrim(concat_ws(' ', u.brand, u.model)),''), 'Item') as title,
        u.condition as unit_condition,
        u.ask_cents,
        u.state as unit_state,
        (select count(*)::int from public.return_photos p where p.return_id = r.id) as photo_count,
        s.name as supplier_name,
        extract(epoch from (r.decision_deadline_at - now())) as decision_seconds_left
      from public.returns r
      left join public.units u on u.store_id = r.store_id and u.sku = r.sku
      left join public.suppliers s on s.id = r.supplier_id
      where r.store_id = v_store
        and (v_status is null or r.status = v_status
             or (v_status = 'open' and r.status not in ('closed','canceled','denied','refunded_no_return'))
             or (v_status = 'needs_decision' and r.needs_decision and r.status = 'requested'))
      order by r.created_at desc
      limit greatest(1, least(coalesce(p_limit, 200), 500))
    ) x
  ), '[]'::jsonb);
end $$;

create or replace function public.portal_return_lookup(p_query text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_q text := btrim(coalesce(p_query, ''));
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if v_q = '' then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(x order by x.created_at desc)
    from (
      select r.*,
        coalesce(nullif(btrim(u.title),''), nullif(btrim(concat_ws(' ', u.brand, u.model)),''), 'Item') as title,
        u.condition as unit_condition,
        u.state as unit_state,
        (select count(*)::int from public.return_photos p where p.return_id = r.id) as photo_count,
        (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'path', p.path, 'kind', p.kind) order by p.sort_order, p.created_at), '[]'::jsonb)
           from public.return_photos p where p.return_id = r.id) as photos,
        extract(epoch from (r.decision_deadline_at - now())) as decision_seconds_left
      from public.returns r
      left join public.units u on u.store_id = r.store_id and u.sku = r.sku
      where r.store_id = v_store
        and (
          r.sku = v_q
          or r.external_order_id = v_q
          or r.external_return_id = v_q
          or r.id::text = v_q
          or exists (
            select 1 from public.web_orders o
             where o.id = r.web_order_id and (o.order_no = v_q or o.id::text = v_q)
          )
        )
      order by r.created_at desc
      limit 20
    ) x
  ), '[]'::jsonb);
end $$;

create or replace function public.portal_create_return(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_row public.returns;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  insert into public.returns (
    store_id, sku, sale_id, web_order_id, channel, external_order_id, external_return_id,
    reason, fault, status, refund_cents, return_label_cents, label_paid_by,
    unrecovered_fees_cents, decision_deadline_at, needs_decision, route_to,
    condition_before, inspection_notes, created_by, raw
  )
  select
    v_store,
    coalesce(nullif(btrim(p_payload->>'sku'), ''), 'UNMATCHED'),
    nullif(p_payload->>'sale_id', '')::bigint,
    nullif(p_payload->>'web_order_id', '')::uuid,
    lower(btrim(coalesce(p_payload->>'channel', 'other'))),
    nullif(btrim(p_payload->>'external_order_id'), ''),
    nullif(btrim(p_payload->>'external_return_id'), ''),
    coalesce(nullif(p_payload->>'reason', ''), 'other'),
    coalesce(nullif(p_payload->>'fault', ''), 'unknown'),
    coalesce(nullif(p_payload->>'status', ''), 'requested'),
    greatest(0, coalesce((p_payload->>'refund_cents')::int, 0)),
    greatest(0, coalesce((p_payload->>'return_label_cents')::int, 0)),
    coalesce(nullif(p_payload->>'label_paid_by', ''), 'unknown'),
    greatest(0, coalesce((p_payload->>'unrecovered_fees_cents')::int, 0)),
    case when coalesce((p_payload->>'needs_decision')::boolean, true)
      then now() + interval '48 hours' else null end,
    coalesce((p_payload->>'needs_decision')::boolean, true),
    coalesce(nullif(p_payload->>'route_to', ''), 'garage'),
    (select condition from public.units u where u.store_id = v_store and u.sku = nullif(btrim(p_payload->>'sku'), '')),
    nullif(p_payload->>'inspection_notes', ''),
    auth.uid(),
    coalesce(p_payload, '{}'::jsonb)
  returning * into v_row;

  if v_row.needs_decision then
    perform public.enqueue_return_decision_alert(v_row);
  end if;
  return to_jsonb(v_row);
end $$;

create or replace function public.portal_set_return_status(
  p_return uuid, p_status text, p_patch jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  r public.returns;
  v_status text := lower(btrim(coalesce(p_status, '')));
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  select * into r from public.returns where id = p_return and store_id = v_store for update;
  if not found then raise exception 'return_not_found' using errcode = 'P0001'; end if;
  if v_status not in (
    'requested','approved','in_transit','received','inspected','dispositioned',
    'closed','refunded_no_return','denied','canceled'
  ) then raise exception 'invalid_status' using errcode = '22023'; end if;

  update public.returns set
    status = v_status,
    needs_decision = case when v_status = 'requested' then needs_decision else false end,
    approved_at = case when v_status = 'approved' then coalesce(approved_at, now()) else approved_at end,
    in_transit_at = case when v_status = 'in_transit' then coalesce(in_transit_at, now()) else in_transit_at end,
    received_at = case when v_status = 'received' then coalesce(received_at, now()) else received_at end,
    inspected_at = case when v_status = 'inspected' then coalesce(inspected_at, now()) else inspected_at end,
    closed_at = case when v_status in ('closed','canceled','denied','refunded_no_return') then coalesce(closed_at, now()) else closed_at end,
    refund_cents = coalesce((p_patch->>'refund_cents')::int, refund_cents),
    return_label_cents = coalesce((p_patch->>'return_label_cents')::int, return_label_cents),
    label_paid_by = coalesce(nullif(p_patch->>'label_paid_by',''), label_paid_by),
    unrecovered_fees_cents = coalesce((p_patch->>'unrecovered_fees_cents')::int, unrecovered_fees_cents),
    tracking_number = coalesce(nullif(p_patch->>'tracking_number',''), tracking_number),
    carrier = coalesce(nullif(p_patch->>'carrier',''), carrier),
    inspection_notes = coalesce(nullif(p_patch->>'inspection_notes',''), inspection_notes),
    fault = coalesce(nullif(p_patch->>'fault',''), fault),
    reason = coalesce(nullif(p_patch->>'reason',''), reason),
    updated_at = now()
  where id = r.id
  returning * into r;

  if v_status = 'refunded_no_return' then
    perform public.return_reverse_sale(v_store, r.sale_id, 'Refund without return', false);
    update public.returns set disposition = 'keep_buyer', refunded_at = coalesce(refunded_at, now())
     where id = r.id returning * into r;
    perform public.return_post_ledger(r.id);
  end if;

  return to_jsonb(r);
end $$;

create or replace function public.portal_inspect_return(
  p_return uuid,
  p_condition text,
  p_notes text default null,
  p_regrade_loss_cents int default 0
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  r public.returns;
  v_cond text := btrim(coalesce(p_condition, ''));
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if v_cond = '' then raise exception 'condition_required' using errcode = '22023'; end if;
  select * into r from public.returns where id = p_return and store_id = v_store for update;
  if not found then raise exception 'return_not_found' using errcode = 'P0001'; end if;
  if r.status not in ('received', 'inspected', 'in_transit', 'approved') then
    raise exception 'return_not_inspectable' using errcode = 'P0001';
  end if;

  update public.units set condition = v_cond, updated_at = now()
   where store_id = v_store and sku = r.sku;

  update public.returns set
    status = 'inspected',
    condition_after = v_cond,
    inspection_notes = coalesce(nullif(btrim(p_notes), ''), inspection_notes),
    regrade_loss_cents = greatest(0, coalesce(p_regrade_loss_cents, regrade_loss_cents, 0)),
    inspected_at = coalesce(inspected_at, now()),
    received_at = coalesce(received_at, now()),
    updated_at = now()
  where id = r.id
  returning * into r;

  return to_jsonb(r);
end $$;

create or replace function public.portal_add_return_photo(p_return uuid, p_path text, p_kind text default 'inspection')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  r public.returns;
  v_path text := btrim(coalesce(p_path, ''));
  v_kind text := coalesce(nullif(btrim(p_kind), ''), 'inspection');
  v_photo public.return_photos;
  v_sort int;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if v_path = '' then raise exception 'path_required' using errcode = '22023'; end if;
  select * into r from public.returns where id = p_return and store_id = v_store;
  if not found then raise exception 'return_not_found' using errcode = 'P0001'; end if;

  select coalesce(max(sort_order), -1) + 1 into v_sort from public.return_photos where return_id = r.id;
  insert into public.return_photos (store_id, return_id, path, kind, sort_order, created_by)
  values (v_store, r.id, v_path, v_kind, v_sort, auth.uid())
  returning * into v_photo;

  -- Also attach to the unit so catalog/channels see the new condition photos.
  perform public.portal_add_unit_photo(r.sku, v_path);

  return to_jsonb(v_photo);
end $$;

create or replace function public.portal_disposition_return(
  p_return uuid,
  p_disposition text,
  p_patch jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  r public.returns;
  v_disp text := lower(btrim(coalesce(p_disposition, '')));
  v_settings jsonb;
  v_ch text;
  v_photos int;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if v_disp not in ('relist', 'downgrade_channel', 'bundle_lot', 'write_off') then
    raise exception 'invalid_disposition' using errcode = '22023';
  end if;

  select * into r from public.returns where id = p_return and store_id = v_store for update;
  if not found then raise exception 'return_not_found' using errcode = 'P0001'; end if;
  if r.status not in ('inspected', 'received', 'dispositioned') then
    raise exception 'inspect_before_disposition' using errcode = 'P0001';
  end if;

  select count(*)::int into v_photos from public.return_photos where return_id = r.id;
  if v_photos < 1 then
    raise exception 'inspection_photos_required' using errcode = 'P0001';
  end if;

  v_settings := public.return_settings(v_store);

  -- Money: refund already tracked; reverse sale + restock unless write-off without restock.
  if r.sale_id is not null then
    perform public.return_reverse_sale(
      v_store, r.sale_id,
      'Return disposition: ' || v_disp,
      v_disp <> 'write_off' or coalesce((p_patch->>'restock')::boolean, false)
    );
  else
    -- No sale link: still reopen SKU for relist paths.
    if v_disp in ('relist', 'downgrade_channel', 'bundle_lot') then
      update public.units set state = 'available', updated_at = now()
       where store_id = v_store and sku = r.sku and state in ('sold', 'reserved');
      update public.sku_ledger set fate = 'issued'
       where store_id = v_store and sku = r.sku;
    elsif v_disp = 'write_off' then
      update public.units set state = 'scrapped', updated_at = now()
       where store_id = v_store and sku = r.sku;
      update public.sku_ledger set fate = 'retired'
       where store_id = v_store and sku = r.sku;
    end if;
  end if;

  if v_disp = 'downgrade_channel' then
    for v_ch in
      select lower(btrim(x)) from jsonb_array_elements_text(
        coalesce(v_settings->'downgrade_block_channels', '["amazon","tiktok"]'::jsonb)
      ) x
    loop
      insert into public.unit_marketplace_overrides(store_id, sku, channel, decision, note, actor_id, actor_name)
      values (
        v_store, r.sku, v_ch, 'block',
        'Return downgrade — pulled from forced-return channels',
        auth.uid(),
        coalesce((select display_name from public.staff where user_id = auth.uid()), 'portal')
      )
      on conflict (store_id, sku, channel) do update set
        decision = 'block',
        note = excluded.note,
        updated_at = now(),
        actor_id = excluded.actor_id,
        actor_name = excluded.actor_name;
    end loop;
  end if;

  if v_disp = 'bundle_lot' then
    -- Soft-mark for lotting; live listing_lots table may exist outside migrations.
    update public.units set
      listing_body = trim(both from coalesce(listing_body, '') || E'\n[RETURN → bundle lot]'),
      updated_at = now()
     where store_id = v_store and sku = r.sku;
    insert into public.unit_marketplace_overrides(store_id, sku, channel, decision, note, actor_id, actor_name)
    select v_store, r.sku, c, 'block', 'Return → bundle lot only', auth.uid(), 'portal'
      from unnest(array['amazon','tiktok']) c
    on conflict (store_id, sku, channel) do update set
      decision = 'block', note = excluded.note, updated_at = now();
  end if;

  if v_disp = 'write_off' then
    insert into public.unit_marketplace_overrides(store_id, sku, channel, decision, note, actor_id, actor_name)
    select v_store, r.sku, c, 'block', 'Return write-off', auth.uid(), 'portal'
      from unnest(array['amazon','tiktok','ebay','mercari','website','depop','whatnot','facebook']) c
    on conflict (store_id, sku, channel) do update set
      decision = 'block', note = excluded.note, updated_at = now();
  end if;

  -- Relist: sale_relist alerts + unit available already handle normal sync/double-sale protection.
  -- Clear prior amazon/tiktok blocks only when explicitly relisting on same channels.
  if v_disp = 'relist' and coalesce((p_patch->>'clear_channel_blocks')::boolean, false) then
    delete from public.unit_marketplace_overrides
     where store_id = v_store and sku = r.sku
       and channel in ('amazon', 'tiktok')
       and note like 'Return%';
  end if;

  update public.returns set
    status = 'dispositioned',
    disposition = v_disp,
    dispositioned_at = coalesce(dispositioned_at, now()),
    refund_cents = coalesce((p_patch->>'refund_cents')::int, refund_cents),
    return_label_cents = coalesce((p_patch->>'return_label_cents')::int, return_label_cents),
    unrecovered_fees_cents = coalesce((p_patch->>'unrecovered_fees_cents')::int, unrecovered_fees_cents),
    regrade_loss_cents = coalesce((p_patch->>'regrade_loss_cents')::int, regrade_loss_cents),
    label_paid_by = coalesce(nullif(p_patch->>'label_paid_by',''), label_paid_by),
    refunded_at = coalesce(refunded_at, case when coalesce((p_patch->>'mark_refunded')::boolean, true) then now() else null end),
    updated_at = now()
  where id = r.id
  returning * into r;

  perform public.return_post_ledger(r.id);

  if coalesce((p_patch->>'close')::boolean, true) then
    update public.returns set status = 'closed', closed_at = coalesce(closed_at, now()), closed_by = auth.uid(), updated_at = now()
     where id = r.id returning * into r;
  end if;

  if exists (select 1 from public.sku_ledger where store_id = v_store and sku = r.sku) then
    insert into public.events (store_id, sku, kind, actor, note)
    values (v_store, r.sku, 'return_dispositioned',
            coalesce((select display_name from public.staff where user_id = auth.uid()), 'portal'),
            v_disp);
  end if;

  return to_jsonb(r);
end $$;

create or replace function public.portal_return_report(p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return jsonb_build_object(
    'by_channel', coalesce((
      select jsonb_agg(jsonb_build_object(
        'channel', channel,
        'returns', n,
        'sales', sales_n,
        'return_rate', case when sales_n > 0 then round((n::numeric / sales_n) * 100, 2) else 0 end,
        'refund_cents', refund_cents,
        'label_cents', label_cents,
        'fee_cents', fee_cents,
        'regrade_loss_cents', regrade_loss_cents,
        'total_cost_cents', refund_cents + label_cents + fee_cents + regrade_loss_cents
      ) order by total_cost_cents desc)
      from (
        select r.channel,
          count(*)::int as n,
          coalesce(sum(r.refund_cents),0)::int as refund_cents,
          coalesce(sum(case when r.label_paid_by = 'seller' then r.return_label_cents else 0 end),0)::int as label_cents,
          coalesce(sum(r.unrecovered_fees_cents),0)::int as fee_cents,
          coalesce(sum(r.regrade_loss_cents),0)::int as regrade_loss_cents,
          (
            select count(*)::int from public.sales s
             where s.store_id = v_store and lower(s.channel) = r.channel
               and s.sold_at >= p_from and s.sold_at < p_to
          ) as sales_n,
          coalesce(sum(r.refund_cents),0)
            + coalesce(sum(case when r.label_paid_by = 'seller' then r.return_label_cents else 0 end),0)
            + coalesce(sum(r.unrecovered_fees_cents),0)
            + coalesce(sum(r.regrade_loss_cents),0) as total_cost_cents
        from public.returns r
        where r.store_id = v_store
          and r.created_at >= p_from and r.created_at < p_to
          and r.status not in ('canceled', 'denied')
        group by r.channel
      ) c
    ), '[]'::jsonb),
    'by_category', coalesce((
      select jsonb_agg(jsonb_build_object(
        'category', category,
        'returns', n,
        'total_cost_cents', total_cost_cents
      ) order by total_cost_cents desc)
      from (
        select coalesce(nullif(btrim(u.category), ''), '(uncategorized)') as category,
          count(*)::int as n,
          (
            coalesce(sum(r.refund_cents),0)
            + coalesce(sum(case when r.label_paid_by = 'seller' then r.return_label_cents else 0 end),0)
            + coalesce(sum(r.unrecovered_fees_cents),0)
            + coalesce(sum(r.regrade_loss_cents),0)
          )::int as total_cost_cents
        from public.returns r
        left join public.units u on u.store_id = r.store_id and u.sku = r.sku
        where r.store_id = v_store
          and r.created_at >= p_from and r.created_at < p_to
          and r.status not in ('canceled', 'denied')
        group by 1
      ) x
    ), '[]'::jsonb),
    'by_month', coalesce((
      select jsonb_agg(jsonb_build_object(
        'month', month,
        'returns', n,
        'total_cost_cents', total_cost_cents
      ) order by month desc)
      from (
        select to_char(timezone('America/Los_Angeles', r.created_at), 'YYYY-MM') as month,
          count(*)::int as n,
          (
            coalesce(sum(r.refund_cents),0)
            + coalesce(sum(case when r.label_paid_by = 'seller' then r.return_label_cents else 0 end),0)
            + coalesce(sum(r.unrecovered_fees_cents),0)
            + coalesce(sum(r.regrade_loss_cents),0)
          )::int as total_cost_cents
        from public.returns r
        where r.store_id = v_store
          and r.created_at >= p_from and r.created_at < p_to
          and r.status not in ('canceled', 'denied')
        group by 1
      ) m
    ), '[]'::jsonb)
  );
end $$;

revoke all on function public.portal_returns(text, int) from public, anon;
revoke all on function public.portal_return_lookup(text) from public, anon;
revoke all on function public.portal_create_return(jsonb) from public, anon;
revoke all on function public.portal_set_return_status(uuid, text, jsonb) from public, anon;
revoke all on function public.portal_inspect_return(uuid, text, text, int) from public, anon;
revoke all on function public.portal_add_return_photo(uuid, text, text) from public, anon;
revoke all on function public.portal_disposition_return(uuid, text, jsonb) from public, anon;
revoke all on function public.portal_return_report(timestamptz, timestamptz) from public, anon;

grant execute on function public.portal_returns(text, int) to authenticated;
grant execute on function public.portal_return_lookup(text) to authenticated;
grant execute on function public.portal_create_return(jsonb) to authenticated;
grant execute on function public.portal_set_return_status(uuid, text, jsonb) to authenticated;
grant execute on function public.portal_inspect_return(uuid, text, text, int) to authenticated;
grant execute on function public.portal_add_return_photo(uuid, text, text) to authenticated;
grant execute on function public.portal_disposition_return(uuid, text, jsonb) to authenticated;
grant execute on function public.portal_return_report(timestamptz, timestamptz) to authenticated;

-- Pack proof
create or replace function public.portal_set_pack_proof(
  p_order uuid, p_photo_path text, p_serial text default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_path text := btrim(coalesce(p_photo_path, ''));
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if v_path = '' then raise exception 'photo_required' using errcode = '22023'; end if;
  update public.web_orders set
    pack_proof_photo_path = v_path,
    pack_proof_serial = nullif(btrim(coalesce(p_serial, '')), ''),
    pack_proof_at = now(),
    updated_at = now()
  where id = p_order and store_id = v_store and status = 'paid';
  if not found then raise exception 'order_not_found' using errcode = 'P0001'; end if;
end $$;

revoke all on function public.portal_set_pack_proof(uuid, text, text) from public, anon;
grant execute on function public.portal_set_pack_proof(uuid, text, text) to authenticated;

create or replace function public.portal_mark_order_shipped(p_order uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  o public.web_orders;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  select * into o from public.web_orders where id = p_order and store_id = v_store;
  if not found then raise exception 'order_not_shippable' using errcode = 'P0001'; end if;
  if o.status <> 'paid' or o.fulfillment <> 'ship' or o.refund_requested_at is not null then
    raise exception 'order_not_shippable' using errcode = 'P0001';
  end if;
  if lower(coalesce(o.channel, '')) in ('amazon', 'tiktok')
     and nullif(btrim(coalesce(o.pack_proof_photo_path, '')), '') is null then
    raise exception 'pack_proof_required' using errcode = 'P0001';
  end if;
  update public.web_orders
  set shipped_at = coalesce(shipped_at, now()), updated_at = now()
  where id = p_order and store_id = v_store;
end $$;

revoke all on function public.portal_mark_order_shipped(uuid) from public, anon;
grant execute on function public.portal_mark_order_shipped(uuid) to authenticated;

-- Expose pack proof on orders list (extend latest portal_web_orders shape)
create or replace function public.portal_web_orders(p_days integer default 90)
returns jsonb
language plpgsql
stable security definer
set search_path = public
as $$
declare
  v_store uuid := public.portal_store_id();
  v_income_pct numeric;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  v_income_pct := coalesce(
    (public.store_setting(v_store, 'income_tax_pct', '25'::jsonb) #>> '{}')::numeric,
    25
  );
  return coalesce((select jsonb_agg(x order by x.created_at desc) from (
    select o.id, o.order_no, o.sku, o.status, o.fulfillment, o.channel,
      o.buyer_name, o.buyer_email, o.buyer_phone,
      o.ship_line1, o.ship_line2, o.ship_city, o.ship_region, o.ship_postal,
      o.item_cents, o.shipping_cents, o.tax_cents, o.total_cents,
      o.payment_id, o.refund_id, o.payment_env, o.created_at, o.paid_at,
      o.pickup_deadline, o.picked_up_at, o.picked_up_by,
      o.boxed_at, o.shipped_at, o.delivered_at,
      o.tracking_number, o.tracking_url, o.carrier, o.service, o.shipping_rate, o.label_url,
      o.label_purchased_at, o.label_cost_cents, o.refund_requested_at,
      o.pack_condition, o.pack_condition_at,
      o.pack_proof_photo_path, o.pack_proof_serial, o.pack_proof_at,
      o.cancel_source, o.cancel_reason, o.canceled_at, o.ship_by,
      o.match_status, o.marketplace_fee_cents, o.marketplace_title,
      o.sale_id,
      case when o.sale_id is not null
        then coalesce(sl.ticket_id::text, 'sale:' || o.sale_id::text)
        else null end as ticket_key,
      case
        when o.match_status = 'matched' or (o.sku is not null and o.sku <> 'UNMATCHED' and o.sale_id is not null)
          then coalesce(
            nullif(btrim(u.title), ''),
            nullif(btrim(concat_ws(' ', u.brand, u.model)), ''),
            nullif(btrim(o.marketplace_title), ''),
            'Item'
          )
        else coalesce(
          nullif(btrim(o.marketplace_title), ''),
          nullif(btrim(u.title), ''),
          nullif(btrim(concat_ws(' ', u.brand, u.model)), ''),
          'Item'
        )
      end as title,
      coalesce(u.listed_on, '{}'::text[]) as listed_on,
      coalesce(co.fee_cents, o.marketplace_fee_cents, sl.channel_fee_cents) as fee_cents,
      coalesce(
        co.fee_source,
        case
          when co.fee_cents is null and o.marketplace_fee_cents is null and sl.fee_source is not null
            then sl.fee_source
          when co.fee_cents is null and o.marketplace_fee_cents is not null then 'estimated'
          else null
        end
      ) as fee_source,
      sl.cost_cents,
      sl.profit_cents,
      case when sl.profit_cents is null then null
        else greatest(0, round(sl.profit_cents * v_income_pct / 100.0))::int end as income_tax_cents,
      sl.tax_remitted_by,
      coalesce(sl.tax_collected_cents, o.tax_cents, 0) as tax_collected_cents,
      coalesce(sl.tax_owed_cents, 0) as tax_owed_cents,
      case
        when lower(o.channel) = 'ebay' and o.order_no is not null
          then 'https://www.ebay.com/mesh/ord/details?orderid=' || o.order_no
        when lower(o.channel) = 'amazon' and o.order_no is not null
          then 'https://sellercentral.amazon.com/orders-v3/order/' || o.order_no
        when lower(o.channel) = 'depop' and o.order_no is not null
          then 'https://www.depop.com/sellinghub/sold/'
        when lower(o.channel) = 'mercari' and o.order_no is not null
          then 'https://www.mercari.com/mypage/listings/completed/'
        when lower(o.channel) in ('website','web') and o.order_no is not null
          then 'https://openboxindustries.com/account/orders/' || o.order_no
        else null
      end as marketplace_url,
      jsonb_build_object(
        'length_in', u.package_length_in,
        'width_in', u.package_width_in,
        'height_in', u.package_height_in,
        'weight_lb', u.package_weight_lb
      ) as package
    from public.web_orders o
    left join public.units u on u.store_id = o.store_id and u.sku = o.sku
    left join public.channel_orders co
      on co.store_id = o.store_id and co.provider = o.channel and co.order_id = o.order_no
    left join public.sale_ledger sl on sl.id = o.sale_id
    where o.store_id = v_store
      and o.created_at > now() - make_interval(days => greatest(p_days, 1))
      and (o.status in ('paid', 'refunded', 'canceled') or o.paid_at is not null)
      and coalesce(o.payment_env, 'production') <> 'sandbox'
      and lower(coalesce(o.order_no, '')) not like 'sandbox%'
  ) x), '[]'::jsonb);
end $$;

revoke all on function public.portal_web_orders(int) from public, anon;
grant execute on function public.portal_web_orders(int) to authenticated;

-- Supplier CRUD for admin / dropship bot
create or replace function public.portal_suppliers()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(to_jsonb(s) order by s.name)
    from public.suppliers s where s.store_id = v_store and s.active
  ), '[]'::jsonb);
end $$;

create or replace function public.portal_upsert_supplier(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_id uuid := nullif(p_payload->>'id', '')::uuid;
  s public.suppliers;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if nullif(btrim(p_payload->>'name'), '') is null then
    raise exception 'name_required' using errcode = '22023';
  end if;
  if v_id is null then
    insert into public.suppliers (
      store_id, name, accepts_returns, has_us_return_address,
      return_address_line1, return_address_line2, return_address_city,
      return_address_region, return_address_postal, return_address_country,
      return_window_days, restocking_fee_pct, notes
    ) values (
      v_store,
      btrim(p_payload->>'name'),
      coalesce((p_payload->>'accepts_returns')::boolean, false),
      coalesce((p_payload->>'has_us_return_address')::boolean, false),
      nullif(p_payload->>'return_address_line1',''),
      nullif(p_payload->>'return_address_line2',''),
      nullif(p_payload->>'return_address_city',''),
      nullif(p_payload->>'return_address_region',''),
      nullif(p_payload->>'return_address_postal',''),
      coalesce(nullif(p_payload->>'return_address_country',''), 'US'),
      nullif(p_payload->>'return_window_days','')::int,
      coalesce((p_payload->>'restocking_fee_pct')::numeric, 0),
      nullif(p_payload->>'notes','')
    ) returning * into s;
  else
    update public.suppliers set
      name = btrim(p_payload->>'name'),
      accepts_returns = coalesce((p_payload->>'accepts_returns')::boolean, accepts_returns),
      has_us_return_address = coalesce((p_payload->>'has_us_return_address')::boolean, has_us_return_address),
      return_address_line1 = coalesce(nullif(p_payload->>'return_address_line1',''), return_address_line1),
      return_address_line2 = coalesce(nullif(p_payload->>'return_address_line2',''), return_address_line2),
      return_address_city = coalesce(nullif(p_payload->>'return_address_city',''), return_address_city),
      return_address_region = coalesce(nullif(p_payload->>'return_address_region',''), return_address_region),
      return_address_postal = coalesce(nullif(p_payload->>'return_address_postal',''), return_address_postal),
      return_address_country = coalesce(nullif(p_payload->>'return_address_country',''), return_address_country),
      return_window_days = coalesce(nullif(p_payload->>'return_window_days','')::int, return_window_days),
      restocking_fee_pct = coalesce((p_payload->>'restocking_fee_pct')::numeric, restocking_fee_pct),
      notes = coalesce(nullif(p_payload->>'notes',''), notes),
      updated_at = now()
    where id = v_id and store_id = v_store
    returning * into s;
    if not found then raise exception 'supplier_not_found' using errcode = 'P0001'; end if;
  end if;
  return to_jsonb(s);
end $$;

revoke all on function public.portal_suppliers() from public, anon;
revoke all on function public.portal_upsert_supplier(jsonb) from public, anon;
grant execute on function public.portal_suppliers() to authenticated;
grant execute on function public.portal_upsert_supplier(jsonb) to authenticated;

-- Attach payout-adjustment → returns FK now that public.returns exists
-- (20261021034552 creates the column without the FK for migrate order).
do $$ begin
  alter table public.portal_payout_adjustments
    add constraint portal_payout_adjustments_return_id_fkey
    foreign key (return_id) references public.returns(id) on delete set null;
exception
  when duplicate_object then null;
  when undefined_table then null;
end $$;

commit;
