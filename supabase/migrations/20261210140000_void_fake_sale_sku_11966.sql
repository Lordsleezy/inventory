-- Void fake sale for TV SKU 11966 across sales, payouts, and unit state.
begin;

do $$
declare
  v_result jsonb;
  v_owner uuid := '68b0d022-b9e4-427e-ab25-5399bc4cfd41';
begin
  if not exists (select 1 from public.stores where id = '5487ca47-6147-4fe8-bc6d-46b6472726ba') then
    return;
  end if;

  if not exists (
    select 1 from public.sales s
     where s.store_id = '5487ca47-6147-4fe8-bc6d-46b6472726ba'
       and s.sku = '11966'
       and s.voided_at is null
  )
  and not exists (
    select 1 from public.mercari_sale_entries e
     where e.store_id = '5487ca47-6147-4fe8-bc6d-46b6472726ba'
       and e.sku = '11966'
       and e.deleted_at is null
  )
  and not exists (
    select 1 from public.depop_sale_entries e
     where e.store_id = '5487ca47-6147-4fe8-bc6d-46b6472726ba'
       and e.sku = '11966'
       and e.deleted_at is null
  ) then
    raise notice 'SKU 11966: no open sales to void';
    return;
  end if;

  perform set_config('request.jwt.claim.sub', v_owner::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  v_result := public.portal_void_sku_sales(
    '11966',
    'Fake sale — voided across Floor (SKU 11966 TV)'
  );

  if coalesce((v_result->>'remaining_open_sales')::int, 0) > 0 then
    raise exception 'SKU 11966 still has % open sales after void', v_result->>'remaining_open_sales';
  end if;
end $$;

commit;
