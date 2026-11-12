-- Lot purchase cost on a saved manifest: divide by item_count and set unit costs.
-- Used from the Manifests tab for already-entered loads.

begin;

alter table public.store_manifests
  add column if not exists total_cost_cents integer;

alter table public.store_manifests
  drop constraint if exists store_manifests_total_cost_cents_check;
alter table public.store_manifests
  add constraint store_manifests_total_cost_cents_check
  check (total_cost_cents is null or total_cost_cents >= 0);

comment on column public.store_manifests.total_cost_cents is
  'What we paid for the whole manifest. Unit cost = round(total / item_count).';

-- Apply (or re-apply) the stored lot cost to units tagged to this manifest.
create or replace function public.portal_apply_manifest_lot_cost(
  p_id uuid,
  p_overwrite boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.portal_store_id();
  m public.store_manifests;
  v_each int;
  v_updated int := 0;
  v_skipped int := 0;
  v_actor text;
  u record;
begin
  if v_store is null or not public.portal_is_admin() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;

  select * into m from public.store_manifests where id = p_id and store_id = v_store for update;
  if m.id is null then raise exception 'manifest_not_found' using errcode = 'P0002'; end if;
  if m.total_cost_cents is null then raise exception 'manifest_cost_missing' using errcode = 'P0001'; end if;
  if coalesce(m.item_count, 0) <= 0 then raise exception 'manifest_count_required' using errcode = 'P0001'; end if;

  v_each := round(m.total_cost_cents::numeric / m.item_count)::int;
  v_actor := coalesce(public.disposition_actor_name(auth.uid()), 'admin');

  for u in
    select sku, acquisition_cost_cents
    from public.units
    where store_id = v_store and manifest_id = p_id
    for update
  loop
    if not p_overwrite and u.acquisition_cost_cents is not null then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    if u.acquisition_cost_cents is not distinct from v_each then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    update public.units
    set acquisition_cost_cents = v_each, updated_at = now()
    where store_id = v_store and sku = u.sku;
    insert into public.events (store_id, sku, kind, field, old_value, new_value, actor, actor_id, note)
    values (
      v_store, u.sku, 'edit', 'acquisition_cost_cents',
      u.acquisition_cost_cents::text, v_each::text,
      v_actor, auth.uid(),
      format('Manifest lot cost %s ÷ %s items', m.total_cost_cents, m.item_count)
    );
    v_updated := v_updated + 1;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'id', m.id,
    'total_cost_cents', m.total_cost_cents,
    'unit_cost_cents', v_each,
    'item_count', m.item_count,
    'updated', v_updated,
    'skipped', v_skipped
  );
end $$;

-- Save the lot total, then apply divided cost to tagged units (missing-only unless overwrite).
create or replace function public.portal_set_manifest_lot_cost(
  p_id uuid,
  p_total_cents int,
  p_overwrite boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.portal_store_id();
  m public.store_manifests;
  v_each int;
  v_result jsonb;
begin
  if v_store is null or not public.portal_is_admin() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  if p_total_cents is null or p_total_cents < 0 then
    raise exception 'cost_must_not_be_negative' using errcode = '22023';
  end if;

  select * into m from public.store_manifests where id = p_id and store_id = v_store for update;
  if m.id is null then raise exception 'manifest_not_found' using errcode = 'P0002'; end if;
  if coalesce(m.item_count, 0) <= 0 then raise exception 'manifest_count_required' using errcode = 'P0001'; end if;

  v_each := round(p_total_cents::numeric / m.item_count)::int;

  update public.store_manifests
  set total_cost_cents = p_total_cents, updated_at = now()
  where id = m.id and store_id = v_store;

  insert into public.events (store_id, sku, kind, field, old_value, new_value, actor, actor_id, note)
  values (
    v_store, null, 'edit', 'manifest_total_cost_cents',
    m.total_cost_cents::text, p_total_cents::text,
    coalesce(public.disposition_actor_name(auth.uid()), 'admin'), auth.uid(),
    format('Manifest %s lot cost → %s¢ each (%s items)', m.name, v_each, m.item_count)
  );

  v_result := public.portal_apply_manifest_lot_cost(p_id, p_overwrite);
  return v_result || jsonb_build_object('saved', true);
end $$;

-- When tagging SKUs onto a manifest that already has a lot cost, fill missing unit costs.
create or replace function public.portal_tag_manifest(p_id uuid, p_skus text[])
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  v_count int;
  m public.store_manifests;
  v_each int;
  v_actor text;
  u record;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if p_id is not null and not exists (
    select 1 from public.store_manifests where id = p_id and store_id = v_store
  ) then raise exception 'manifest_not_found' using errcode = 'P0002'; end if;
  if coalesce(array_length(p_skus, 1), 0) > 1000 then
    raise exception 'too_many_skus' using errcode = '22023';
  end if;

  update public.units set manifest_id = p_id
  where store_id = v_store and sku = any (p_skus);
  get diagnostics v_count = row_count;

  if p_id is not null then
    select * into m from public.store_manifests where id = p_id and store_id = v_store;
    if m.total_cost_cents is not null and coalesce(m.item_count, 0) > 0 then
      v_each := round(m.total_cost_cents::numeric / m.item_count)::int;
      v_actor := coalesce(public.disposition_actor_name(auth.uid()), 'admin');
      for u in
        select sku, acquisition_cost_cents
        from public.units
        where store_id = v_store and sku = any (p_skus) and manifest_id = p_id
          and acquisition_cost_cents is null
        for update
      loop
        update public.units
        set acquisition_cost_cents = v_each, updated_at = now()
        where store_id = v_store and sku = u.sku;
        insert into public.events (store_id, sku, kind, field, old_value, new_value, actor, actor_id, note)
        values (
          v_store, u.sku, 'edit', 'acquisition_cost_cents',
          null, v_each::text,
          v_actor, auth.uid(),
          format('Manifest lot cost %s ÷ %s items', m.total_cost_cents, m.item_count)
        );
      end loop;
    end if;
  end if;

  return v_count;
end $$;

-- Expose derived unit_cost_cents on the Manifests list.
create or replace function public.portal_manifest_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_store uuid := public.portal_store_id();
begin
  if v_store is null or not public.portal_is_admin() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(to_jsonb(m) || jsonb_build_object(
    'line_count', (select count(*) from public.manifest_lines ml where ml.manifest_id = m.id),
    'unit_cost_cents', case
      when m.total_cost_cents is null or coalesce(m.item_count, 0) <= 0 then null
      else round(m.total_cost_cents::numeric / m.item_count)::int
    end,
    'received_count', coalesce(stats.received_count, 0),
    'sold_count', coalesce(stats.sold_count, 0),
    'stock_count', coalesce(stats.stock_count, 0),
    'revenue_cents', coalesce(stats.revenue_cents, 0),
    'profit_cents', coalesce(stats.profit_cents, 0)
  ) order by m.manifest_on desc, m.created_at desc)
  from public.store_manifests m
  left join lateral (
    select coalesce(sum(u.qty_on_hand + coalesce(sold.qty, 0)), 0)::int received_count,
      coalesce(sum(sold.qty), 0)::int sold_count,
      coalesce(sum(u.qty_on_hand) filter (where u.state in ('available', 'reserved')), 0)::int stock_count,
      coalesce(sum(sold.revenue_cents), 0)::bigint revenue_cents,
      coalesce(sum(sold.profit_cents), 0)::bigint profit_cents
    from public.units u
    left join lateral (
      select s.sku, sum(s.qty)::int qty, sum(s.price_cents)::bigint revenue_cents,
        coalesce(sum(l.profit_cents), 0)::bigint profit_cents
      from public.sales s
      left join public.sale_ledger l
        on l.store_id = s.store_id and l.id = s.id and l.voided_at is null
      where s.store_id = u.store_id and s.sku = u.sku and s.voided_at is null
      group by s.sku
    ) sold on true
    where u.store_id = v_store and u.manifest_id = m.id
  ) stats on true
  where m.store_id = v_store), '[]'::jsonb);
end $$;

revoke all on function public.portal_apply_manifest_lot_cost(uuid, boolean) from public, anon;
revoke all on function public.portal_set_manifest_lot_cost(uuid, int, boolean) from public, anon;
revoke all on function public.portal_tag_manifest(uuid, text[]) from public, anon;
revoke all on function public.portal_manifest_list() from public, anon;

grant execute on function public.portal_apply_manifest_lot_cost(uuid, boolean) to authenticated, service_role;
grant execute on function public.portal_set_manifest_lot_cost(uuid, int, boolean) to authenticated, service_role;
grant execute on function public.portal_tag_manifest(uuid, text[]) to authenticated, service_role;
grant execute on function public.portal_manifest_list() to authenticated, service_role;

commit;
