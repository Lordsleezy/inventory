-- Mercari tab sales store sale price, the Mercari fee, and the payout.
-- Buyer shipping is not recorded. A seller-paid label is a reimbursement, not a sale cost.
begin;

-- Re-apply the ledger wrap if a later view rewrite dropped it.
do $$
declare
  v_def text;
  v_new text;
  v_n int;
  v_pat constant text := 'case\s+when\s+\(\s*greatest\(\s*coalesce\(\s*wo\.label_cost_cents\s*,\s*0(?:\s*::integer)?\s*\)\s*,\s*coalesce\(\s*lbl\.cents\s*,\s*0(?:\s*::integer)?\s*\)\s*,\s*coalesce\(\s*man\.cents\s*,\s*0(?:\s*::integer)?\s*\)\s*,\s*coalesce\(\s*co\.ship_label_cents\s*,\s*0(?:\s*::integer)?\s*\)\s*\)\s*>\s*0\s*\)\s+then\s+greatest\(\s*coalesce\(\s*wo\.label_cost_cents\s*,\s*0(?:\s*::integer)?\s*\)\s*,\s*coalesce\(\s*lbl\.cents\s*,\s*0(?:\s*::integer)?\s*\)\s*,\s*coalesce\(\s*man\.cents\s*,\s*0(?:\s*::integer)?\s*\)\s*,\s*coalesce\(\s*co\.ship_label_cents\s*,\s*0(?:\s*::integer)?\s*\)\s*\)\s+else\s+coalesce\(\s*co\.baked_ship_cents\s*,\s*0(?:\s*::integer)?\s*\)\s+end';
begin
  v_def := pg_get_viewdef('public.sale_ledger'::regclass, true);
  if position('ledger_ship_cents' in v_def) > 0 then
    return;
  end if;
  select count(*) into v_n from regexp_matches(v_def, v_pat, 'gi');
  if v_n <> 2 then
    raise exception 'sale_ledger ship terms not found as expected (% matches)', v_n;
  end if;
  v_new := regexp_replace(regexp_replace(v_def, ';\s*$', ''), '(' || v_pat || ')', 'public.ledger_ship_cents(s.channel, \1)', 'gi');
  execute 'create or replace view public.sale_ledger as ' || v_new;
end $$;

create or replace function public.portal_mercari_record_sale(
  p_sku text,
  p_sale_cents int,
  p_fee_cents int,
  p_payout_cents int default null,
  p_sold_on date default null,
  p_note text default null,
  p_buyer_shipping_cents int default 0,
  p_label_cost_cents int default 0
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_admin text; v_id uuid := gen_random_uuid(); v_day date; v_payout int; v_sale public.sales;
  v_cost int; v_was_sold boolean := false;
  v_fee int;
  v_label int := greatest(coalesce(p_label_cost_cents, 0), 0);
begin
  -- Buyer shipping and the label are not sale fields. The label, if passed, is reimbursed below.
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if p_sale_cents is null or p_sale_cents <= 0 then raise exception 'invalid_sale_price' using errcode = '22023'; end if;
  v_fee := coalesce(p_fee_cents, public.mercari_default_fee_cents(p_sale_cents, 0));
  if v_fee < 0 or v_fee > p_sale_cents then raise exception 'invalid_fee' using errcode = '22023'; end if;
  v_payout := coalesce(p_payout_cents, p_sale_cents - v_fee);
  if v_payout < 0 or v_payout > p_sale_cents then raise exception 'invalid_payout' using errcode = '22023'; end if;
  v_day := coalesce(p_sold_on, (now() at time zone 'America/Los_Angeles')::date);
  if v_day > (now() at time zone 'America/Los_Angeles')::date then raise exception 'sale_date_in_future' using errcode = '22023'; end if;
  v_was_sold := exists (select 1 from public.units u where u.store_id = v_store and u.sku = p_sku and u.state = 'sold'
    and not exists (select 1 from public.sales s where s.store_id = u.store_id and s.sku = u.sku and s.voided_at is null));
  if not v_was_sold and not exists (select 1 from public.units where store_id = v_store and sku = p_sku and state in ('available', 'reserved')) then
    raise exception 'unit_not_sellable' using errcode = 'P0001';
  end if;
  v_admin := public.disposition_actor_name(auth.uid());
  perform set_config('floor.mercari_manual', 'on', true);
  if v_was_sold then update public.units set state = 'available' where store_id = v_store and sku = p_sku and state = 'sold'; end if;
  v_sale := public.finalize_sale(p_sku, 'mercari', p_sale_cents, 'mercari', 'mercari-manual:' || v_id::text,
    null, null, null, coalesce(nullif(btrim(p_note), ''), 'Mercari sale (entered by hand)'), null, 0, null);
  if v_was_sold then delete from public.delist_tasks where sale_id = v_sale.id; end if;
  update public.sales
    set sold_at = public.mercari_sold_at(v_day), shipping_cents = 0
  where id = v_sale.id;
  insert into public.channel_orders (
    store_id, provider, order_id, sku, sale_id, item_cents, fee_cents, fee_source,
    ship_label_cents, ship_label_source, baked_ship_cents, payout_cents
  ) values (
    v_store, 'mercari', 'manual:' || v_id::text, p_sku, v_sale.id, p_sale_cents, v_fee, 'actual',
    null, null, 0, v_payout
  );
  insert into public.web_orders (
    store_id, sku, sale_id, status, channel, fulfillment, order_no, paid_at, buyer_name,
    item_cents, shipping_cents, tax_cents, total_cents, payment_id, payment_env, match_status,
    marketplace_fee_cents, label_cost_cents, marketplace_title
  )
  select v_store, p_sku, v_sale.id, 'paid', 'mercari', 'ship', 'MERCARI-' || v_sale.receipt_no,
    public.mercari_sold_at(v_day), 'Mercari buyer',
    p_sale_cents, 0, 0, p_sale_cents, 'mercari-manual:' || v_id::text, 'production', 'matched',
    v_fee, null,
    left(coalesce(nullif(u.title, ''), concat_ws(' ', u.brand, u.model), 'Mercari sale'), 250)
  from public.units u where u.store_id = v_store and u.sku = p_sku;
  update public.web_order_emails set sent_at = now(), last_error = 'manual Mercari entry'
    where order_id in (select id from public.web_orders where sale_id = v_sale.id) and sent_at is null;
  perform public.floor_mercari_remove_listing(v_store, p_sku, 'Mercari sale recorded');
  insert into public.mercari_sale_entries (
    id, store_id, sale_id, sku, sale_cents, buyer_shipping_cents, label_cost_cents, fee_cents, payout_cents,
    sold_on, note, created_by, created_by_name, unit_was_sold
  ) values (
    v_id, v_store, v_sale.id, p_sku, p_sale_cents, 0, 0, v_fee, v_payout,
    v_day, nullif(btrim(p_note), ''), auth.uid(), v_admin, v_was_sold
  );
  if v_label > 0 then
    perform public.mercari_label_reimbursement(v_store, v_sale.id, p_sku, v_label);
  end if;
  perform public.portal_payout_refreeze(coalesce(v_sale.ticket_id::text, 'sale:' || v_sale.id::text));
  v_cost := public.disposition_unit_cost(v_store, p_sku);
  return jsonb_build_object('id', v_id, 'sale_id', v_sale.id, 'receipt_no', v_sale.receipt_no, 'payout_cents', v_payout,
    'fee_cents', v_fee, 'cost_cents', v_cost, 'cost_missing', v_cost is null);
end $$;

create or replace function public.portal_mercari_update_sale(
  p_id uuid, p_sale_cents int, p_fee_cents int, p_payout_cents int, p_sold_on date,
  p_note text default null, p_buyer_shipping_cents int default 0, p_label_cost_cents int default 0
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  e public.mercari_sale_entries; v_ticket text;
  v_label int := greatest(coalesce(p_label_cost_cents, 0), 0);
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  select * into e from public.mercari_sale_entries where id = p_id and store_id = v_store and deleted_at is null for update;
  if not found or e.sale_id is null then raise exception 'entry_not_found'; end if;
  if p_sale_cents is null or p_sale_cents <= 0 then raise exception 'invalid_sale_price' using errcode = '22023'; end if;
  if p_fee_cents is null or p_fee_cents < 0 or p_fee_cents > p_sale_cents then raise exception 'invalid_fee' using errcode = '22023'; end if;
  if p_payout_cents is null or p_payout_cents < 0 or p_payout_cents > p_sale_cents then raise exception 'invalid_payout' using errcode = '22023'; end if;
  if p_sold_on is null or p_sold_on > (now() at time zone 'America/Los_Angeles')::date then raise exception 'invalid_sale_date' using errcode = '22023'; end if;
  update public.sales
    set price_cents = p_sale_cents, shipping_cents = 0, sold_at = public.mercari_sold_at(p_sold_on),
        note = coalesce(nullif(btrim(p_note), ''), note)
  where id = e.sale_id;
  update public.channel_orders
    set item_cents = p_sale_cents, fee_cents = p_fee_cents, fee_source = 'actual',
        ship_label_cents = null, ship_label_source = null,
        payout_cents = p_payout_cents
  where sale_id = e.sale_id and provider = 'mercari';
  update public.web_orders
    set item_cents = p_sale_cents, shipping_cents = 0, total_cents = p_sale_cents,
        marketplace_fee_cents = p_fee_cents, label_cost_cents = null, paid_at = public.mercari_sold_at(p_sold_on)
  where sale_id = e.sale_id;
  update public.mercari_sale_entries
    set sale_cents = p_sale_cents, buyer_shipping_cents = 0, label_cost_cents = 0,
        fee_cents = p_fee_cents, payout_cents = p_payout_cents, sold_on = p_sold_on,
        note = nullif(btrim(p_note), ''), updated_at = now()
  where id = e.id;
  if v_label > 0 then
    perform public.mercari_label_reimbursement(v_store, e.sale_id, e.sku, v_label);
  end if;
  v_ticket := coalesce((select ticket_id::text from public.sales where id = e.sale_id), 'sale:' || e.sale_id::text);
  perform public.portal_payout_refreeze(v_ticket);
  return jsonb_build_object('id', e.id, 'sale_id', e.sale_id);
end $$;

create or replace function public.portal_mercari_entries(p_limit int default 50)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(x order by (x->>'sold_on') desc, (x->>'created_at') desc) from (
    select jsonb_build_object(
      'id', e.id, 'sku', e.sku,
      'item', coalesce(nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), nullif(u.title, ''), 'Item'),
      'sale_cents', e.sale_cents, 'buyer_shipping_cents', 0, 'label_cost_cents', 0,
      'fee_cents', e.fee_cents, 'payout_cents', e.payout_cents, 'sold_on', e.sold_on, 'note', e.note,
      'receipt_no', s.receipt_no, 'created_by_name', e.created_by_name, 'created_at', e.created_at,
      'cost_cents', public.disposition_unit_cost(e.store_id, e.sku),
      'cost_missing', public.disposition_unit_cost(e.store_id, e.sku) is null,
      'profit_cents', e.sale_cents - e.fee_cents - public.disposition_unit_cost(e.store_id, e.sku)
    ) x
    from public.mercari_sale_entries e
    left join public.units u on u.store_id = e.store_id and u.sku = e.sku
    left join public.sales s on s.id = e.sale_id
    where e.store_id = v_store and e.deleted_at is null
    order by e.sold_on desc, e.created_at desc limit greatest(1, least(coalesce(p_limit, 50), 200))
  ) t), '[]'::jsonb);
end $$;

revoke all on function public.portal_mercari_record_sale(text, int, int, int, date, text, int, int) from public, anon;
revoke all on function public.portal_mercari_update_sale(uuid, int, int, int, date, text, int, int) from public, anon;
revoke all on function public.portal_mercari_entries(int) from public, anon;
grant execute on function public.portal_mercari_record_sale(text, int, int, int, date, text, int, int) to authenticated, service_role;
grant execute on function public.portal_mercari_update_sale(uuid, int, int, int, date, text, int, int) to authenticated, service_role;
grant execute on function public.portal_mercari_entries(int) to authenticated, service_role;

-- Recompute frozen Mercari commissions after the label is out of the ledger.
do $$
declare r record;
begin
  for r in
    select id from public.sales where lower(channel) = 'mercari' and voided_at is null order by id
  loop
    delete from public.sale_commissions where sale_id = r.id;
    delete from public.sale_payout_lines where sale_id = r.id;
    perform public.payout_snapshot_sale(r.id);
  end loop;
end $$;

commit;
