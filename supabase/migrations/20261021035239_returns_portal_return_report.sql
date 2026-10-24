create or replace function public.portal_return_report(p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return jsonb_build_object(
    'by_channel', coalesce((
      select jsonb_agg(jsonb_build_object(
        'channel', channel,
        'returns', n,
        'sales', sales_n,
        'return_rate', case when sales_n > 0 then round((n::numeric / sales_n) * 100, 2) else 0 end,
        'refund_cents', refund_cents,
        'label_cents', label_cents,
        'fee_cents', fee_cents,
        'regrade_loss_cents', regrade_loss_cents,
        'total_cost_cents', label_cents + fee_cents + regrade_loss_cents,
        'note', 'total_cost excludes refund (counted via voided sale)'
      ) order by (label_cents + fee_cents + regrade_loss_cents) desc)
      from (
        select r.channel,
          count(*)::int as n,
          coalesce(sum(r.refund_cents),0)::int as refund_cents,
          coalesce(sum(case when r.label_paid_by = 'seller' then r.return_label_cents else 0 end),0)::int as label_cents,
          coalesce(sum(r.unrecovered_fees_cents),0)::int as fee_cents,
          coalesce(sum(r.regrade_loss_cents),0)::int as regrade_loss_cents,
          (
            select count(*)::int from public.sales s
             where s.store_id = v_store and lower(s.channel) = r.channel
               and s.sold_at >= p_from and s.sold_at < p_to
          ) as sales_n
        from public.returns r
        where r.store_id = v_store
          and r.created_at >= p_from and r.created_at < p_to
          and r.status not in ('canceled', 'denied')
        group by r.channel
      ) c
    ), '[]'::jsonb),
    'by_category', coalesce((
      select jsonb_agg(jsonb_build_object(
        'category', category, 'returns', n, 'total_cost_cents', total_cost_cents
      ) order by total_cost_cents desc)
      from (
        select coalesce(nullif(btrim(u.category), ''), '(uncategorized)') as category,
          count(*)::int as n,
          (
            coalesce(sum(case when r.label_paid_by = 'seller' then r.return_label_cents else 0 end),0)
            + coalesce(sum(r.unrecovered_fees_cents),0)
            + coalesce(sum(r.regrade_loss_cents),0)
          )::int as total_cost_cents
        from public.returns r
        left join public.units u on u.store_id = r.store_id and u.sku = r.sku
        where r.store_id = v_store
          and r.created_at >= p_from and r.created_at < p_to
          and r.status not in ('canceled', 'denied')
        group by 1
      ) x
    ), '[]'::jsonb),
    'by_month', coalesce((
      select jsonb_agg(jsonb_build_object(
        'month', month, 'returns', n, 'total_cost_cents', total_cost_cents
      ) order by month desc)
      from (
        select to_char(timezone('America/Los_Angeles', r.created_at), 'YYYY-MM') as month,
          count(*)::int as n,
          (
            coalesce(sum(case when r.label_paid_by = 'seller' then r.return_label_cents else 0 end),0)
            + coalesce(sum(r.unrecovered_fees_cents),0)
            + coalesce(sum(r.regrade_loss_cents),0)
          )::int as total_cost_cents
        from public.returns r
        where r.store_id = v_store
          and r.created_at >= p_from and r.created_at < p_to
          and r.status not in ('canceled', 'denied')
        group by 1
      ) m
    ), '[]'::jsonb)
  );
end $$;

revoke all on function public.portal_return_report(timestamptz, timestamptz) from public, anon;

grant execute on function public.portal_return_report(timestamptz, timestamptz) to authenticated;
