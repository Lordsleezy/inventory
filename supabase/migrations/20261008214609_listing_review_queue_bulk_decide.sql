create or replace function public.portal_listing_queue_decide_bulk(
  p_action text,
  p_ids uuid[] default null,
  p_reason text default null,
  p_price_cents integer default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  sid uuid := public.portal_store_id();
  n integer := 0;
  r public.listing_review_queue;
  price integer;
begin
  if sid is null then
    raise exception 'not a portal admin';
  end if;
  if p_action not in ('keep_instore', 'dismiss', 'approve') then
    raise exception 'unknown action';
  end if;
  if (p_ids is null or cardinality(p_ids) = 0) and (p_reason is null or length(trim(p_reason)) = 0) then
    raise exception 'p_ids or p_reason required';
  end if;

  for r in
    select *
    from public.listing_review_queue q
    where q.store_id = sid
      and q.status = 'pending'
      and (
        (p_ids is not null and cardinality(p_ids) > 0 and q.id = any (p_ids))
        or (p_reason is not null and length(trim(p_reason)) > 0 and q.reason = p_reason)
      )
  loop
    if p_action = 'keep_instore' then
      update public.listing_review_queue
      set status = 'kept_instore', decided_at = now(), decided_by = auth.uid(), updated_at = now()
      where id = r.id;
      n := n + 1;
    elsif p_action = 'dismiss' then
      update public.listing_review_queue
      set status = 'dismissed', decided_at = now(), decided_by = auth.uid(), updated_at = now()
      where id = r.id;
      n := n + 1;
    elsif p_action = 'approve' then
      price := coalesce(p_price_cents, r.best_viable_price_cents);
      if price is null or price <= 0 then
        continue;
      end if;
      update public.listing_review_queue
      set status = 'approved',
          decided_price_cents = price,
          decided_at = now(),
          decided_by = auth.uid(),
          updated_at = now()
      where id = r.id;
      update public.units u
      set listing_specs = coalesce(u.listing_specs, '{}'::jsonb)
        || jsonb_build_object(
          'marketplace_pricing',
          coalesce(u.listing_specs->'marketplace_pricing', '{}'::jsonb)
            || jsonb_build_object(
              'ebay_list_usd', (price::numeric / 100),
              'approved_at', now(),
              'your_call', false
            )
        ),
        updated_at = now()
      where u.store_id = sid and u.sku = r.sku;
      n := n + 1;
    end if;
  end loop;

  return n;
end;
$$;

grant execute on function public.portal_listing_queue_decide_bulk(text, uuid[], text, integer) to authenticated;