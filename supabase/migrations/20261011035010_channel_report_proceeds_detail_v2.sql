-- Proceeds ≈ marketplace funds: sale + buyer shipping − channel fees (before item cost / labels).
-- Also improve detail titles (prefer unit title) and expose proceeds_cents on channel rollup.

create or replace function public.portal_channel_report(p_start date, p_end date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_from timestamptz; v_to timestamptz;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  v_from := p_start::timestamp at time zone 'America/Los_Angeles';
  v_to := p_end::timestamp at time zone 'America/Los_Angeles';
  return jsonb_build_object(
    'start', p_start, 'end', p_end,
    'channels', coalesce((select jsonb_agg(r order by r.profit_cents desc nulls last) from (
      select lower(l.channel) as channel,
        count(*) filter (where l.voided_at is null) as sales_count,
        coalesce(sum(l.price_cents + coalesce(l.shipping_cents, 0)) filter (where l.voided_at is null), 0)::int as gross_cents,
        coalesce(sum(l.channel_fee_cents) filter (where l.voided_at is null), 0)::int as fee_cents,
        coalesce(sum(l.channel_fee_cents) filter (where l.voided_at is null and l.fee_source = 'actual'), 0)::int as fee_actual_cents,
        coalesce(sum(l.channel_fee_cents) filter (where l.voided_at is null and l.fee_source = 'estimated'), 0)::int as fee_estimated_cents,
        coalesce(sum(l.ship_cost_cents) filter (
          where l.voided_at is null or coalesce(l.ship_cost_cents, 0) > 0
        ), 0)::int as ship_cost_cents,
        coalesce(sum(l.processing_fee_cents) filter (where l.voided_at is null), 0)::int as processing_fee_cents,
        coalesce(sum(l.tax_collected_cents) filter (where l.voided_at is null), 0)::int as tax_collected_cents,
        coalesce(sum(l.tax_owed_cents) filter (where l.voided_at is null), 0)::int as tax_owed_cents,
        coalesce(sum(l.cost_cents) filter (where l.voided_at is null), 0)::int as cost_cents,
        count(*) filter (where l.voided_at is null and l.cost_source <> 'unit') as cost_estimated_count,
        sum(l.variance_cents) filter (where l.voided_at is null)::int as variance_cents,
        coalesce(sum(l.profit_cents) filter (where l.voided_at is null), 0)::int as profit_cents,
        coalesce(sum(
          l.price_cents + coalesce(l.shipping_cents, 0) - coalesce(l.channel_fee_cents, 0)
        ) filter (where l.voided_at is null), 0)::int as proceeds_cents,
        coalesce(sum(l.price_cents + coalesce(l.tax_cents, 0) + coalesce(l.card_fee_cents, 0))
          filter (where l.voided_at is null and lower(coalesce(l.payment_method, '')) = 'card'), 0)::int as card_collected_cents,
        coalesce(sum(l.price_cents)
          filter (where l.voided_at is null and lower(coalesce(l.payment_method, '')) = 'cash'), 0)::int as cash_gross_cents
      from public.sale_ledger l
      where l.store_id = v_store
        and l.sold_at >= v_from and l.sold_at < v_to
        and (l.voided_at is null or coalesce(l.ship_cost_cents, 0) > 0)
      group by lower(l.channel)) r), '[]'::jsonb),
    'refunds', coalesce((select jsonb_agg(r) from (
      select lower(l.channel) as channel, count(*) as count,
        sum(l.price_cents + coalesce(l.shipping_cents, 0))::int as sales_cents, sum(l.profit_cents)::int as profit_reversed_cents
      from public.sale_ledger l
      where l.store_id = v_store and l.voided_at is not null and l.voided_at >= v_from and l.voided_at < v_to
      group by lower(l.channel)) r), '[]'::jsonb),
    'expenses', coalesce((select jsonb_agg(jsonb_build_object('category', e.category, 'cents', e.cents) order by e.cents desc) from (
      select e.category, sum(e.amount_cents)::int cents from public.portal_expenses e
      where e.store_id = v_store and e.voided_at is null and e.spent_on >= p_start and e.spent_on < p_end
        and coalesce(e.source, '') not in ('label', 'manual_label')
      group by e.category) e), '[]'::jsonb),
    'expense_cents', coalesce((select sum(e.amount_cents) from public.portal_expenses e
      where e.store_id = v_store and e.voided_at is null and e.spent_on >= p_start and e.spent_on < p_end
        and coalesce(e.source, '') not in ('label', 'manual_label')), 0)::int,
    'label_expense_cents', coalesce((select sum(e.amount_cents) from public.portal_expenses e
      where e.store_id = v_store and e.voided_at is null and e.source in ('label','manual_label')
        and e.spent_on >= p_start and e.spent_on < p_end), 0)::int
  );
end $$;