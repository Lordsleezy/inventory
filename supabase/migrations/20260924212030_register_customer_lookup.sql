-- Register customer typeahead (partial phone) + purchase history profile.
-- Staff may search/attach; list_customers remains admin-only for CRM.

-- ---------------------------------------------------------------------------
-- search_customers_by_phone: prefix match as clerk types (min 3 digits)
-- ---------------------------------------------------------------------------
create or replace function public.search_customers_by_phone(
  p_phone text,
  p_limit int default 8
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
  v_digits text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_lim int := greatest(1, least(coalesce(p_limit, 8), 20));
  v_rows jsonb;
begin
  perform public.assert_staff_or_service();
  if v_store is null then
    raise exception 'no_store' using errcode = 'P0001';
  end if;
  if length(v_digits) < 3 then
    return '[]'::jsonb;
  end if;

  select coalesce(jsonb_agg(public.customer_card(v_store, q) order by q.phone), '[]'::jsonb)
    into v_rows
    from (
      select c.*
        from public.customers c
       where c.store_id = v_store
         and c.phone like v_digits || '%'
       order by c.phone
       limit v_lim
    ) q;

  return v_rows;
end;
$$;

revoke all on function public.search_customers_by_phone(text, int) from public, anon;
grant execute on function public.search_customers_by_phone(text, int) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- customer_purchase_history: tickets (floor + website) with line items
-- ---------------------------------------------------------------------------
create or replace function public.customer_purchase_history(
  p_customer_id uuid,
  p_limit int default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
  v_lim int := greatest(1, least(coalesce(p_limit, 50), 200));
  v_rows jsonb;
begin
  perform public.assert_staff_or_service();
  if v_store is null then
    raise exception 'no_store' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.customers c
     where c.id = p_customer_id and c.store_id = v_store
  ) then
    raise exception 'customer_not_found' using errcode = 'P0001';
  end if;

  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.sold_at desc), '[]'::jsonb)
    into v_rows
    from (
      select
        te.ticket_id,
        min(s.sold_at) as sold_at,
        max(s.channel) as channel,
        max(s.payment_method) as payment_method,
        coalesce(sum(s.price_cents), 0)::int as subtotal_cents,
        coalesce(sum(s.tax_cents), 0)::int as tax_cents,
        coalesce(sum(s.price_cents + coalesce(s.tax_cents, 0)), 0)::int as total_cents,
        coalesce(max(te.discount_cents), 0)::int as discount_cents,
        coalesce(max(te.signup_discount_cents), 0)::int as signup_discount_cents,
        coalesce(max(te.points_earned), 0)::int as points_earned,
        coalesce(max(te.points_redeemed), 0)::int as points_redeemed,
        bool_or(s.voided_at is not null) as voided,
        (
          select coalesce(jsonb_agg(jsonb_build_object(
            'sku', s2.sku,
            'qty', coalesce(s2.qty, 1),
            'price_cents', s2.price_cents,
            'tax_cents', coalesce(s2.tax_cents, 0),
            'title', coalesce(
              nullif(btrim(concat_ws(' ', u.brand, u.model)), ''),
              u.title,
              s2.sku
            ),
            'receipt_no', s2.receipt_no
          ) order by s2.id), '[]'::jsonb)
            from public.sales s2
            left join public.units u
              on u.store_id = s2.store_id and u.sku = s2.sku
           where s2.store_id = v_store
             and s2.ticket_id = te.ticket_id
        ) as lines
      from public.ticket_extras te
      join public.sales s
        on s.ticket_id = te.ticket_id
       and s.store_id = te.store_id
      where te.store_id = v_store
        and te.customer_id = p_customer_id
        and s.channel in ('floor', 'website')
      group by te.ticket_id
      order by min(s.sold_at) desc
      limit v_lim
    ) t;

  return v_rows;
end;
$$;

revoke all on function public.customer_purchase_history(uuid, int) from public, anon;
grant execute on function public.customer_purchase_history(uuid, int) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- customer_profile: card + history + points ledger in one call for the POS modal
-- ---------------------------------------------------------------------------
create or replace function public.customer_profile(
  p_customer_id uuid,
  p_history_limit int default 50,
  p_points_limit int default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
  r public.customers;
begin
  perform public.assert_staff_or_service();
  if v_store is null then
    raise exception 'no_store' using errcode = 'P0001';
  end if;
  select * into r from public.customers
   where id = p_customer_id and store_id = v_store;
  if not found then
    raise exception 'customer_not_found' using errcode = 'P0001';
  end if;

  return jsonb_build_object(
    'customer', public.customer_card(v_store, r),
    'purchases', public.customer_purchase_history(p_customer_id, p_history_limit),
    'points', public.customer_points_history(p_customer_id, p_points_limit)
  );
end;
$$;

revoke all on function public.customer_profile(uuid, int, int) from public, anon;
grant execute on function public.customer_profile(uuid, int, int) to authenticated, service_role;
