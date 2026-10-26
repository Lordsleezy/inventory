-- Depop form: units the cleanup left Sold with no sale can take a new Depop sale (nothing is re-marked sold, delisted or relisted).
begin;
alter table public.depop_sale_entries add column if not exists unit_was_sold boolean not null default false;
create or replace function public.portal_depop_find_units(p_query text default '')
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id(); v_q text := btrim(coalesce(p_query, ''));
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(x) from (
    select jsonb_build_object('sku', u.sku, 'brand', u.brand, 'model', u.model, 'title', u.title, 'condition', u.condition,
      'ask_cents', u.ask_cents, 'acquisition_cost_cents', u.acquisition_cost_cents, 'state', u.state,
      'sold_no_sale', u.state = 'sold') x
    from public.units u
    where u.store_id = v_store
      and (u.state in ('available', 'reserved')
        or (u.state = 'sold' and not exists (select 1 from public.sales s where s.store_id = u.store_id and s.sku = u.sku and s.voided_at is null)))
      and (v_q = '' or u.sku ilike '%' || v_q || '%' or u.brand ilike '%' || v_q || '%' or u.model ilike '%' || v_q || '%' or u.title ilike '%' || v_q || '%')
    order by (u.state = 'sold') desc, u.sku desc limit 10
  ) t), '[]'::jsonb);
end $$;
revoke all on function public.portal_depop_find_units(text) from public, anon;
grant execute on function public.portal_depop_find_units(text) to authenticated, service_role;

create or replace function public.portal_depop_record_sale(
  p_sku text, p_sale_cents int, p_fee_cents int, p_payout_cents int default null, p_sold_on date default null, p_note text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_admin text; v_id uuid := gen_random_uuid(); v_day date; v_payout int; v_sale public.sales; v_deduct int; v_cost int; v_was_sold boolean := false;
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if p_sale_cents is null or p_sale_cents <= 0 then raise exception 'invalid_sale_price' using errcode = '22023'; end if;
  if p_fee_cents is null or p_fee_cents < 0 then raise exception 'invalid_fee' using errcode = '22023'; end if;
  v_payout := coalesce(p_payout_cents, p_sale_cents - p_fee_cents);
  if v_payout < 0 or v_payout > p_sale_cents then raise exception 'invalid_payout' using errcode = '22023'; end if;
  v_day := coalesce(p_sold_on, (now() at time zone 'America/Los_Angeles')::date);
  if v_day > (now() at time zone 'America/Los_Angeles')::date then raise exception 'sale_date_in_future' using errcode = '22023'; end if;
  -- A unit left Sold by the Depop cleanup (no live sale) can take a new Depop sale; a unit that already has a sale cannot.
  v_was_sold := exists (select 1 from public.units u where u.store_id = v_store and u.sku = p_sku and u.state = 'sold'
    and not exists (select 1 from public.sales s where s.store_id = u.store_id and s.sku = u.sku and s.voided_at is null));
  if not v_was_sold and not exists (select 1 from public.units where store_id = v_store and sku = p_sku and state in ('available', 'reserved')) then
    raise exception 'unit_not_sellable' using errcode = 'P0001';
  end if;
  v_admin := public.disposition_actor_name(auth.uid());
  perform set_config('floor.depop_manual', 'on', true);
  if v_was_sold then update public.units set state = 'available' where store_id = v_store and sku = p_sku and state = 'sold'; end if;
  v_sale := public.finalize_sale(p_sku, 'depop', p_sale_cents, 'depop', 'depop-manual:' || v_id::text,
    null, null, null, coalesce(nullif(btrim(p_note), ''), 'Depop sale (entered by hand)'), null, 0, null);
  if v_was_sold then delete from public.delist_tasks where sale_id = v_sale.id; end if; -- nothing is delisted or relisted for an already-sold unit
  v_deduct := p_sale_cents - v_payout;  -- everything Depop kept: fee, label, anything else
  update public.sales set sold_at = public.depop_sold_at(v_day) where id = v_sale.id;
  insert into public.channel_orders (store_id, provider, order_id, sku, sale_id, item_cents, fee_cents, fee_source, baked_ship_cents)
    values (v_store, 'depop', 'manual:' || v_id::text, p_sku, v_sale.id, p_sale_cents, v_deduct, 'actual', 0);
  insert into public.web_orders (store_id, sku, sale_id, status, channel, fulfillment, order_no, paid_at, buyer_name,
      item_cents, shipping_cents, tax_cents, total_cents, payment_id, payment_env, match_status, marketplace_fee_cents,
      marketplace_title, shipped_at, delivered_at)
    select v_store, p_sku, v_sale.id, 'paid', 'depop', 'ship', 'DEPOP-' || v_sale.receipt_no, public.depop_sold_at(v_day), 'Depop buyer',
      p_sale_cents, 0, 0, p_sale_cents, 'depop-manual:' || v_id::text, 'production', 'matched', v_deduct,
      left(coalesce(nullif(u.title, ''), concat_ws(' ', u.brand, u.model), 'Depop sale'), 250), public.depop_sold_at(v_day), public.depop_sold_at(v_day)
    from public.units u where u.store_id = v_store and u.sku = p_sku;
  update public.web_order_emails set sent_at = now(), last_error = 'manual Depop entry'
    where order_id in (select id from public.web_orders where sale_id = v_sale.id) and sent_at is null;
  update public.listings set status = 'delisted', delisted_at = now()
    where store_id is not distinct from v_store and sku = p_sku and channel = 'depop' and status <> 'delisted';
  insert into public.depop_sale_entries (id, store_id, sale_id, sku, sale_cents, fee_cents, payout_cents, sold_on, note, created_by, created_by_name, unit_was_sold)
    values (v_id, v_store, v_sale.id, p_sku, p_sale_cents, p_fee_cents, v_payout, v_day, nullif(btrim(p_note), ''), auth.uid(), v_admin, v_was_sold);
  -- finalize_sale already froze the commission before the Depop fee row existed (when the snapshot trigger runs immediately): freeze again with the fee.
  perform public.portal_payout_refreeze(coalesce(v_sale.ticket_id::text, 'sale:' || v_sale.id::text));
  v_cost := public.disposition_unit_cost(v_store, p_sku);
  return jsonb_build_object('id', v_id, 'sale_id', v_sale.id, 'receipt_no', v_sale.receipt_no, 'payout_cents', v_payout,
    'cost_cents', v_cost, 'cost_missing', v_cost is null);
end $$;
create or replace function public.portal_depop_delete_sale(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  e public.depop_sale_entries; v_out jsonb;
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  select * into e from public.depop_sale_entries where id = p_id and store_id = v_store and deleted_at is null for update;
  if not found then raise exception 'entry_not_found'; end if;
  -- A unit that was already Sold before this entry goes back to Sold with no sale; any other goes back in stock.
  if e.sale_id is not null then v_out := public.depop_purge_sale(e.sale_id, not e.unit_was_sold); end if;
  update public.depop_sale_entries set deleted_at = now(), updated_at = now() where id = e.id;
  return coalesce(v_out, '{}'::jsonb);
end $$;

commit;
