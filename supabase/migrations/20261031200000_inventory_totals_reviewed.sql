-- Inventory totals row + a real "Needs to be checked" rule.
--  * inventory_totals(): four UNIT counts (qty_on_hand) for the top of Inventory. Counts only, no money, so clerks may call it.
--      total = every unsold unit (available / reserved / repair), including Defective and do-not-list
--      defective = unit_is_defective() (includes do-not-list)
--      listed = not defective and live on website, eBay, Amazon, TikTok Shop or Depop
--      not_listed = not defective and not live anywhere     =>  listed + not_listed + defective = total, always.
--    Live = a listings row with status 'listed' (or the channel in units.listed_on); website = show_on_website with a
--    photo (the same test as public_items). Depop counts only where Floor has it marked listed.
--  * Needs to be checked used to mean "complete and no channel ticked", so the bulk eBay tick emptied it. It now means
--    "complete, sellable, in stock, and an admin has not reviewed it yet": units.reviewed_at is null.
--    reviewed_at is set when an admin saves the item or ticks a channel themself. Nothing here unticks a channel or ends a listing.
--    Backfill: only units with an admin-made channel selection are marked reviewed; bulk ('backfill') ticks are not.
-- Newest previous definitions: portal_inventory_list / portal_inventory_list_with_locations / staff_inventory_list (20261030190000).
begin;

alter table public.units add column if not exists reviewed_at timestamptz;
alter table public.units add column if not exists reviewed_by uuid;

-- Admin saved the item.
create or replace function public.units_mark_reviewed_on_admin_save()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and public.portal_is_admin() then
    new.reviewed_at := now();
    new.reviewed_by := auth.uid();
  end if;
  return new;
end $$;
drop trigger if exists units_mark_reviewed on public.units;
create trigger units_mark_reviewed
  before update of brand, model, title, category, condition, test_status, location, defect_notes, upc, mfr_serial,
    acquisition_cost_cents, msrp_cents, ask_cents, floor_cents, show_on_website, listing_body, listing_specs,
    package_length_in, package_width_in, package_height_in, package_weight_lb
  on public.units
  for each row execute function public.units_mark_reviewed_on_admin_save();

-- Admin ticked or unticked a channel (portal_set_unit_channel_selection writes source = 'admin').
create or replace function public.unit_selection_mark_reviewed()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.source = 'admin' then
    update public.units set reviewed_at = now(), reviewed_by = new.updated_by
     where store_id = new.store_id and sku = new.sku;
  end if;
  return null;
end $$;
drop trigger if exists unit_selection_reviewed on public.unit_channel_selections;
create trigger unit_selection_reviewed
  after insert or update on public.unit_channel_selections
  for each row execute function public.unit_selection_mark_reviewed();

-- Backfill: only admin-made selections count as reviewed.
update public.units u set reviewed_at = coalesce(s.at, now()), reviewed_by = s.by
from (select cs.store_id, cs.sku, max(cs.updated_at) at, (array_agg(cs.updated_by order by cs.updated_at desc))[1] by
      from public.unit_channel_selections cs where cs.source = 'admin' group by 1, 2) s
where u.store_id = s.store_id and u.sku = s.sku and u.reviewed_at is null;

-- Needs to be checked: replace the "no channel ticked" test in the three inventory list functions with "not reviewed yet".
do $$
declare
  r record;
  v_def text;
  v_new text;
  v_hits int := 0;
  v_pat constant text :=
    'not exists \(select 1 from public\.unit_channel_selections cs\s+where cs\.store_id = (\w+) and cs\.sku = b\.sku and cs\.selected\)';
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('portal_inventory_list', 'portal_inventory_list_with_locations', 'staff_inventory_list')
      and p.prosrc ~ v_pat loop
    v_def := pg_get_functiondef(r.oid);
    v_new := regexp_replace(v_def, v_pat,
      'not exists (select 1 from public.units ru where ru.store_id = \1 and ru.sku = b.sku and ru.reviewed_at is not null)', 'g');
    if v_new = v_def then raise exception 'needs_check rule not rewritten for %', r.oid::regprocedure; end if;
    execute v_new;
    v_hits := v_hits + 1;
  end loop;
  if v_hits < 3 then raise exception 'expected to rewrite 3 inventory list functions, rewrote %', v_hits; end if;
end $$;

-- Totals row.
create or replace function public.inventory_totals()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  v_result jsonb;
begin
  if v_store is null or not (public.portal_is_admin() or exists (
    select 1 from public.staff s where s.user_id = auth.uid() and s.store_id = v_store and s.deactivated_at is null
  )) then raise exception 'inventory_access_denied' using errcode = '42501'; end if;
  with u as (
    select greatest(coalesce(x.qty_on_hand, 1), 0) qty,
      public.unit_is_defective(x.listing_specs, x.condition) defective,
      (exists (select 1 from public.listings l where l.store_id = x.store_id and l.sku = x.sku and l.status = 'listed'
          and l.channel in ('ebay', 'amazon', 'tiktok', 'depop'))
        or x.listed_on && array['ebay', 'amazon', 'tiktok', 'depop']
        or (x.show_on_website and x.state in ('available', 'reserved')
          and exists (select 1 from public.photos p where p.store_id = x.store_id and p.sku = x.sku))) live
    from public.units x
    where x.store_id = v_store and x.state in ('available', 'reserved', 'repair')
  )
  select jsonb_build_object(
    'total', coalesce(sum(qty), 0)::int,
    'listed', coalesce(sum(qty) filter (where not defective and live), 0)::int,
    'not_listed', coalesce(sum(qty) filter (where not defective and not live), 0)::int,
    'defective', coalesce(sum(qty) filter (where defective), 0)::int
  ) into v_result from u;
  return v_result;
end $$;
revoke all on function public.inventory_totals() from public, anon;
grant execute on function public.inventory_totals() to authenticated, service_role;

commit;
