-- "Listed" on Inventory is how many SKUs are live on the selling eBay account.
-- Stocked multi-qty rows used to inflate that card (one eBay listing × qty on hand).
-- Total inventory and Ready to list stay physical pieces. listed_pieces keeps the
-- old qty sum so the buckets still add up.

begin;

create or replace function public.inventory_totals()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  result jsonb;
begin
  if v_store is null or not (
    public.portal_is_admin()
    or exists (
      select 1 from public.staff s
      where s.user_id = auth.uid() and s.store_id = v_store and s.deactivated_at is null
    )
  ) then
    raise exception 'inventory_access_denied' using errcode = '42501';
  end if;

  with counts as materialized (
    select greatest(coalesce(u.qty_on_hand, 1), 0) qty,
           public.unit_inventory_bucket(u) bucket
      from public.units u
     where u.store_id = v_store
       and u.state in ('available', 'reserved', 'repair')
  )
  select jsonb_build_object(
    'total', coalesce(sum(qty), 0)::int,
    -- One count per in-stock SKU that is live on eBay (matches eBay's listing count).
    'listed', coalesce(count(*) filter (where bucket = 'listed'), 0)::int,
    'listed_pieces', coalesce(sum(qty) filter (where bucket = 'listed'), 0)::int,
    'not_listed', coalesce(sum(qty) filter (where bucket = 'not_listed'), 0)::int,
    'not_listed_skus', coalesce(count(*) filter (where bucket = 'not_listed'), 0)::int,
    'not_listed_pieces', coalesce(sum(qty) filter (where bucket = 'not_listed'), 0)::int,
    'not_ready', coalesce(sum(qty) filter (where bucket = 'not_ready'), 0)::int,
    'dns', coalesce(sum(qty) filter (where bucket = 'dns'), 0)::int,
    'never_list', coalesce(sum(qty) filter (where bucket = 'never_list'), 0)::int,
    'defective', coalesce(sum(qty) filter (where bucket = 'defective'), 0)::int
  ) into result
  from counts;

  return result;
end;
$$;

commit;
