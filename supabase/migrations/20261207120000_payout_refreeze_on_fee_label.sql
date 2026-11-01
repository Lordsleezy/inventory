-- When eBay (or any channel) syncs the real marketplace fee or shipping label
-- onto channel_orders, re-freeze that sale's commission from the live ledger.
-- Otherwise sale_payout_lines stays stuck at the sale-time snapshot (often $0
-- label / estimated fee), and Payouts under-reports ship-spread profit.
--
-- Newest previous definitions:
--   channel_order_update (live baseline / 20261010045106)
--   portal_payout_refreeze (20261030150000)
--   payout_snapshot_sale (20261031010000)

begin;

-- Service-safe re-freeze: delete the ticket snapshot and rebuild from sale_ledger.
create or replace function public.payout_refreeze_ticket(p_store uuid, p_ticket text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
begin
  if p_store is null or nullif(btrim(coalesce(p_ticket, '')), '') is null then
    return;
  end if;
  delete from public.sale_payout_tickets where store_id = p_store and ticket_key = p_ticket;
  delete from public.sale_payout_lines where store_id = p_store and ticket_key = p_ticket;
  -- sale_commissions cascade from lines via sale_id FK on some installs; delete explicitly too.
  delete from public.sale_commissions where store_id = p_store and ticket_key = p_ticket;
  for v_id in
    select s.id
      from public.sales s
     where s.store_id = p_store
       and s.voided_at is null
       and coalesce(s.ticket_id::text, 'sale:' || s.id::text) = p_ticket
     order by s.id
  loop
    perform public.payout_snapshot_sale(v_id);
  end loop;
  update public.sale_payout_tickets
     set source = 'refreeze'
   where store_id = p_store and ticket_key = p_ticket;
end;
$$;

revoke all on function public.payout_refreeze_ticket(uuid, text) from public, anon, authenticated;
grant execute on function public.payout_refreeze_ticket(uuid, text) to service_role;

-- Admin portal helper: same behavior, scoped to the caller's store.
create or replace function public.portal_payout_refreeze(p_ticket_key text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.portal_store_id();
begin
  if v_store is null or not public.portal_is_admin() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  perform public.payout_refreeze_ticket(v_store, p_ticket_key);
end;
$$;

create or replace function public.channel_order_update(
  p_store uuid, p_provider text, p_order_id text,
  p_fee_cents int default null, p_fee_source text default null,
  p_ship_label_cents int default null, p_tax_cents int default null,
  p_tax_remitted boolean default null, p_payout_cents int default null,
  p_ship_label_source text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale bigint;
  v_sku text;
  v_item int;
  v_fee_source text;
  v_ship_source text;
  v_old_fee int;
  v_old_label int;
  v_fee_changed boolean := false;
  v_label_changed boolean := false;
  v_ticket text;
begin
  perform public.assert_service();
  select s.id, s.sku into v_sale, v_sku from public.sales s
   where s.store_id = p_store and s.payment_id = lower(p_provider) || ':' || p_order_id
   order by s.id desc limit 1;
  if v_sale is null then
    select o.sale_id, o.sku into v_sale, v_sku from public.web_orders o
     where o.store_id = p_store and o.payment_id = lower(p_provider) || ':' || p_order_id
     limit 1;
  end if;
  select coalesce(item_cents, 0), fee_source, ship_label_source, fee_cents, ship_label_cents
    into v_item, v_fee_source, v_ship_source, v_old_fee, v_old_label
  from public.channel_orders
   where store_id = p_store and provider = lower(p_provider) and order_id = p_order_id;
  if v_item is null or v_item = 0 then
    select coalesce(s.price_cents, 0) into v_item from public.sales s where s.id = v_sale;
    if v_item > 0 then
      update public.channel_orders set item_cents = v_item
       where store_id = p_store and provider = lower(p_provider) and order_id = p_order_id
         and coalesce(item_cents, 0) = 0;
    end if;
  end if;

  if v_fee_source = 'manual' and coalesce(p_fee_source, '') <> 'manual' then
    p_fee_cents := null;
    p_fee_source := null;
  end if;
  if v_ship_source = 'manual' and coalesce(p_ship_label_source, '') <> 'manual' then
    p_ship_label_cents := null;
    p_ship_label_source := null;
  end if;

  if p_ship_label_cents is not null
     and p_ship_label_cents > 50000
     and v_item > 0
     and p_ship_label_cents > (v_item * 3) then
    p_ship_label_cents := null;
    p_ship_label_source := null;
  end if;

  v_fee_changed := p_fee_cents is not null and p_fee_cents is distinct from v_old_fee;
  v_label_changed := p_ship_label_cents is not null and p_ship_label_cents is distinct from v_old_label;

  update public.channel_orders set
    sale_id = coalesce(sale_id, v_sale), sku = coalesce(sku, v_sku),
    fee_cents = coalesce(p_fee_cents, fee_cents),
    fee_source = coalesce(p_fee_source, fee_source),
    ship_label_cents = case when p_ship_label_cents is not null then p_ship_label_cents else ship_label_cents end,
    ship_label_source = case
      when p_ship_label_cents is not null then coalesce(p_ship_label_source, 'marketplace')
      else ship_label_source end,
    tax_cents = coalesce(p_tax_cents, tax_cents),
    tax_remitted = coalesce(p_tax_remitted, tax_remitted),
    payout_cents = coalesce(p_payout_cents, payout_cents)
  where store_id = p_store and provider = lower(p_provider) and order_id = p_order_id;
  if not found and v_sale is not null then
    insert into public.channel_orders(store_id, provider, order_id, sku, sale_id, fee_cents, fee_source,
      ship_label_cents, ship_label_source, tax_cents, tax_remitted, payout_cents, item_cents)
    values (p_store, lower(p_provider), p_order_id, v_sku, v_sale, p_fee_cents, coalesce(p_fee_source, 'actual'),
      p_ship_label_cents, coalesce(p_ship_label_source, case when p_ship_label_cents is not null then 'marketplace' end),
      p_tax_cents, p_tax_remitted, p_payout_cents, nullif(v_item, 0));
    v_fee_changed := p_fee_cents is not null;
    v_label_changed := p_ship_label_cents is not null;
  end if;

  if v_sale is not null and (v_fee_changed or v_label_changed) then
    select coalesce(s.ticket_id::text, 'sale:' || s.id::text) into v_ticket
      from public.sales s where s.id = v_sale;
    if v_ticket is not null then
      perform public.payout_refreeze_ticket(p_store, v_ticket);
    end if;
  end if;
end;
$$;

revoke all on function public.channel_order_update(uuid,text,text,int,text,int,int,boolean,int,text) from public, anon, authenticated;
grant execute on function public.channel_order_update(uuid,text,text,int,text,int,int,boolean,int,text) to service_role;

commit;
