-- Expose buyer-paid shipping on portal_payout_sales so admin Payouts matches sale_ledger / Reports.

begin;

drop function if exists public.portal_payout_sales();
create function public.portal_payout_sales()
returns table (
  id bigint, ticket_key text, sku text, title text, qty int, sold_at timestamptz,
  price_cents int, tax_cents int, card_fee_cents int, cost_cents int,
  payment_method text, cash_cents int, card_cents int, actor_id uuid,
  actor_name text, channel text, receipt_no text,
  ebay_fee_cents int, baked_ship_cents int,
  cost_source text, channel_fee_cents int, fee_source text,
  ship_cost_cents int, ship_cost_source text,
  processing_fee_cents int, processing_fee_source text,
  tax_remitted_by text, tax_collected_cents int, tax_owed_cents int,
  ask_cents int, variance_cents int, profit_cents int,
  shipping_cents int
) language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return query
    select l.id, coalesce(l.ticket_id::text, 'sale:' || l.id::text), l.sku,
      coalesce(nullif(btrim(concat_ws(' ', l.brand, l.model)), ''), 'Item')::text,
      l.qty, l.sold_at, l.price_cents, l.tax_cents, l.card_fee_cents,
      l.cost_cents, l.payment_method, l.cash_cents, l.card_cents,
      l.actor_id, coalesce(l.actor_name, 'Unknown')::text, l.channel, l.receipt_no,
      case when lower(l.channel) = 'ebay' then l.channel_fee_cents else 0 end,
      case when lower(l.channel) = 'ebay' then l.ship_cost_cents else 0 end,
      l.cost_source, l.channel_fee_cents, l.fee_source,
      l.ship_cost_cents, l.ship_cost_source,
      l.processing_fee_cents, l.processing_fee_source,
      l.tax_remitted_by, l.tax_collected_cents, l.tax_owed_cents,
      l.ask_cents, l.variance_cents, l.profit_cents,
      coalesce(l.shipping_cents, 0)
    from public.sale_ledger l
    where l.store_id = v_store and l.voided_at is null
    order by l.id;
end $$;
revoke all on function public.portal_payout_sales() from public, anon;
grant execute on function public.portal_payout_sales() to authenticated;

commit;
