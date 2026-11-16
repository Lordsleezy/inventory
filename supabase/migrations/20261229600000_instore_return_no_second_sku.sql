begin;

-- An in-store return of one unit was cloning a second SKU, then the
-- write-off trigger also put the original back. A second tap then failed
-- with return_qty_exceeds_sale because the first tap had already counted.
-- One unit comes back as this SKU. A stocked parent with more on hand
-- still splits the bad pieces onto a new SKU.

create or replace function public.portal_return_partial(p_return_id uuid, p_qty integer, p_defective boolean default false)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  st uuid := public.portal_store_id();
  r public.returns; s public.sales; u public.units; already int; new_sku text; result jsonb;
begin
  if st is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode='42501'; end if;
  if p_qty is null or p_qty < 1 then raise exception 'invalid_qty' using errcode='22023'; end if;
  select * into r from public.returns where id = p_return_id and store_id = st for update;
  if not found or r.sale_id is null then raise exception 'return_sale_required' using errcode='P0001'; end if;
  select * into s from public.sales where id = r.sale_id and store_id = st for update;
  if not found or s.voided_at is not null then raise exception 'sale_not_open' using errcode='P0001'; end if;
  if r.status in ('dispositioned', 'closed', 'canceled', 'refunded_no_return') then
    return jsonb_build_object('sku', s.sku, 'qty', coalesce(r.return_qty, 0), 'already', true,
      'on_hand', (select qty_on_hand from public.units where store_id = st and sku = s.sku));
  end if;
  select coalesce(sum(x.return_qty), 0)::int into already from public.returns x
   where x.store_id = st and x.sale_id = s.id and x.id <> r.id;
  already := already + coalesce(r.return_qty, 0);
  if already + p_qty > greatest(coalesce(s.qty, 1), 1) then raise exception 'return_qty_exceeds_sale' using errcode='22023'; end if;
  select * into u from public.units where store_id = st and sku = s.sku for update;
  if not found then raise exception 'sku_not_found' using errcode='P0002'; end if;
  if coalesce(p_defective, false)
     and coalesce(u.is_stocked, false)
     and coalesce(u.qty_on_hand, 0) > coalesce(r.requested_qty, p_qty) then
    perform set_config('floor.stock_movement_type','received', true);
    perform set_config('floor.receive_not_for_sale','true', true);
    result := public.portal_receive_unit(1, u.brand, u.model, u.title, u.listing_body, 'Defective', u.test_status, u.ask_cents,
      u.acquisition_cost_cents, 'Partial return defective from SKU '||s.sku, u.upc,
      case when u.shippable then 'ship' else 'pickup' end,
      u.package_length_in, u.package_width_in, u.package_height_in, u.package_weight_lb, u.category);
    new_sku := result#>>'{skus,0}';
    update public.units set state='available', show_on_website=false, is_stocked=false,
      listing_specs=coalesce(listing_specs,'{}'::jsonb)||jsonb_build_object('do_not_list', true), updated_at=now()
     where store_id=st and sku=new_sku;
    perform set_config('floor.stock_movement_type','', true);
    perform set_config('floor.receive_not_for_sale','', true);
  elsif not coalesce(p_defective, false) and not coalesce(u.is_stocked, false) and greatest(coalesce(s.qty, 1), 1) = 1 then
    update public.units set state='available', qty_on_hand=1, updated_at=now() where store_id=st and sku=s.sku;
    perform public.enqueue_channel_qty(st, s.sku, public.channel_available_qty(st, s.sku));
  elsif not coalesce(p_defective, false) then
    perform set_config('floor.stock_movement_type','returned', true);
    perform set_config('floor.stock_movement_reason','Partial return '||p_qty||' of sale '||s.id, true);
    update public.units set qty_on_hand = qty_on_hand + p_qty,
      is_stocked = case when qty_on_hand + p_qty > 1 then true else is_stocked end,
      state='available', updated_at=now()
     where store_id=st and sku=s.sku;
    perform set_config('floor.stock_movement_type','', true);
    perform set_config('floor.stock_movement_reason','', true);
  end if;
  update public.returns set return_qty = coalesce(return_qty, 0) + p_qty,
    status = 'dispositioned', disposition = case when coalesce(p_defective, false) then 'write_off' else 'relist' end,
    updated_at = now()
   where id = r.id;
  if r.refund_cents > 0 and r.ledger_posted_at is null then
    perform public.return_post_ledger(r.id);
  end if;
  insert into public.events(store_id, sku, kind, actor, actor_id, note)
  values(st, s.sku, 'sale_void', public.disposition_actor_name(auth.uid()), auth.uid(),
    'Partial return '||p_qty||case when coalesce(p_defective, false) then ' defective' else ' restocked' end);
  return jsonb_build_object('sku', s.sku, 'qty', p_qty, 'defective_sku', new_sku,
    'on_hand', (select qty_on_hand from public.units where store_id=st and sku=s.sku));
end $$;
revoke all on function public.portal_return_partial(uuid, integer, boolean) from public, anon;
grant execute on function public.portal_return_partial(uuid, integer, boolean) to authenticated;

commit;
