-- Checkout rate counter, plus an unused Square event table.
-- Applied to production as version 20261022020521.
-- Refunds happen on Amazon and TikTok, not in the store or on the website,
-- so no Netlify function calls apply_square_webhook. The table stays empty.
-- Both tables are service-role only. Anon and authenticated have no policy and no grants.

create table if not exists public.public_rate_buckets (
  bucket_id text primary key,
  window_start timestamptz not null,
  hits integer not null check (hits >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.square_webhook_events (
  event_id text primary key,
  event_type text not null,
  merchant_id text,
  payment_id text,
  refund_id text,
  dispute_id text,
  status text,
  amount_cents integer,
  action text not null,
  detail text,
  received_at timestamptz not null default now()
);

alter table public.public_rate_buckets enable row level security;
alter table public.square_webhook_events enable row level security;
revoke all on public.public_rate_buckets from public, anon, authenticated;
revoke all on public.square_webhook_events from public, anon, authenticated;
grant select, insert, update, delete on public.public_rate_buckets to service_role;
grant select, insert, update, delete on public.square_webhook_events to service_role;

create or replace function public.consume_public_rate(p_id text, p_limit integer, p_window_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_start timestamptz;
  v_count integer;
  v_reset integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_only' using errcode = '42501';
  end if;
  if p_id is null or length(btrim(p_id)) < 1 or length(p_id) > 200 then
    raise exception 'bad_rate_id' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 10000 then
    raise exception 'bad_rate_limit' using errcode = '22023';
  end if;
  if p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'bad_rate_window' using errcode = '22023';
  end if;

  insert into public.public_rate_buckets as b (bucket_id, window_start, hits)
  values (p_id, clock_timestamp(), 1)
  on conflict (bucket_id) do update
    set hits = case
          when b.window_start + make_interval(secs => p_window_seconds) <= clock_timestamp() then 1
          else b.hits + 1
        end,
        window_start = case
          when b.window_start + make_interval(secs => p_window_seconds) <= clock_timestamp() then clock_timestamp()
          else b.window_start
        end,
        updated_at = clock_timestamp()
  returning window_start, hits into v_start, v_count;

  v_reset := greatest(1, ceil(extract(epoch from (v_start + make_interval(secs => p_window_seconds) - clock_timestamp())))::int);
  return jsonb_build_object(
    'ok', v_count <= p_limit,
    'limit', p_limit,
    'remaining', greatest(0, p_limit - v_count),
    'reset', v_reset
  );
end;
$$;

revoke all on function public.consume_public_rate(text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_public_rate(text, integer, integer) to service_role;

create or replace function public.apply_square_webhook(
  p_event_id text,
  p_event_type text,
  p_kind text,
  p_payment_id text,
  p_resource_id text,
  p_status text,
  p_amount_cents integer,
  p_merchant_id text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pay text := nullif(btrim(coalesce(p_payment_id, '')), '');
  v_kind text := lower(btrim(coalesce(p_kind, '')));
  v_status text := upper(btrim(coalesce(p_status, '')));
  v_inserted text;
  v_charge integer;
  v_card integer;
  v_web integer;
  v_sale_total integer;
  v_sale_count integer;
  v_action text := 'recorded';
  v_alert boolean := false;
  v_voided integer := 0;
  v_skus text[] := array[]::text[];
  v_sale record;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_only' using errcode = '42501';
  end if;
  if p_event_id is null or length(btrim(p_event_id)) < 1 or length(p_event_id) > 200 then
    raise exception 'bad_event_id' using errcode = '22023';
  end if;
  if v_kind not in ('refund', 'dispute') then
    raise exception 'bad_event_kind' using errcode = '22023';
  end if;
  if v_pay is not null and length(v_pay) > 200 then
    raise exception 'bad_payment_id' using errcode = '22023';
  end if;

  insert into public.square_webhook_events (
    event_id, event_type, merchant_id, payment_id, refund_id, dispute_id, status, amount_cents, action
  ) values (
    btrim(p_event_id),
    left(coalesce(p_event_type, v_kind), 80),
    nullif(left(coalesce(p_merchant_id, ''), 80), ''),
    v_pay,
    case when v_kind = 'refund' then nullif(left(coalesce(p_resource_id, ''), 80), '') else null end,
    case when v_kind = 'dispute' then nullif(left(coalesce(p_resource_id, ''), 80), '') else null end,
    nullif(left(v_status, 40), ''),
    p_amount_cents,
    'received'
  )
  on conflict (event_id) do nothing
  returning event_id into v_inserted;

  if v_inserted is null then
    return jsonb_build_object('ok', true, 'duplicate', true, 'alert', false, 'action', 'duplicate');
  end if;

  if v_pay is not null then
    select max(amount_cents) into v_card
      from public.card_charges
     where payment_id = v_pay or payment_id = 'square:' || v_pay;
    select max(total_cents) into v_web
      from public.web_orders
     where payment_id = v_pay or payment_id = 'square:' || v_pay;
    select coalesce(sum(price_cents + tax_cents + coalesce(shipping_cents, 0) + coalesce(card_fee_cents, 0)), 0),
           count(*)::integer
      into v_sale_total, v_sale_count
      from public.sales
     where payment_id = v_pay or payment_id = 'square:' || v_pay;
    select coalesce(array_agg(distinct sku), array[]::text[]) into v_skus
      from (
        select sku from public.sales where payment_id = v_pay or payment_id = 'square:' || v_pay
        union
        select sku from public.web_orders where payment_id = v_pay or payment_id = 'square:' || v_pay
        union
        select sku from public.card_charges where payment_id = v_pay or payment_id = 'square:' || v_pay
      ) found
     where sku is not null and btrim(sku) <> '';
  end if;

  v_charge := coalesce(v_card, v_web, case when coalesce(v_sale_count, 0) > 0 then v_sale_total else null end);

  if v_kind = 'dispute' then
    v_action := 'dispute';
    v_alert := true;
  elsif v_kind = 'refund' and v_status = 'COMPLETED' and v_charge is not null and p_amount_cents is not null and p_amount_cents > 0 and p_amount_cents >= v_charge then
    for v_sale in
      select id, store_id, sku
        from public.sales
       where voided_at is null
         and (payment_id = v_pay or payment_id = 'square:' || v_pay)
    loop
      begin
        perform set_config('floor.store_id', coalesce(v_sale.store_id::text, ''), true);
        perform public.void_sale(v_sale.id, left('Square refund ' || coalesce(p_resource_id, p_event_id), 200), null);
        v_voided := v_voided + 1;
      exception
        when others then
          if sqlerrm is distinct from 'sale_not_voidable' then
            raise;
          end if;
      end;
    end loop;
    update public.web_orders
       set status = 'refunded',
           refund_id = coalesce(nullif(left(coalesce(p_resource_id, ''), 80), ''), refund_id),
           cancel_source = coalesce(cancel_source, 'square'),
           cancel_reason = coalesce(cancel_reason, 'Square refund'),
           canceled_at = coalesce(canceled_at, now()),
           updated_at = now()
     where status = 'paid'
       and (payment_id = v_pay or payment_id = 'square:' || v_pay);
    update public.card_charges
       set status = 'canceled',
           error = left('square_refund:' || coalesce(p_resource_id, p_event_id), 500),
           updated_at = now()
     where status in ('pending', 'captured', 'finalized', 'finalize_failed')
       and (payment_id = v_pay or payment_id = 'square:' || v_pay);
    v_action := case when v_voided > 0 then 'voided' else 'refunded' end;
    v_alert := true;
  elsif v_kind = 'refund' and v_status = 'COMPLETED' then
    v_action := case when v_charge is null then 'unmatched' else 'partial' end;
    v_alert := true;
  else
    v_action := 'recorded';
    v_alert := false;
  end if;

  update public.square_webhook_events
     set action = v_action,
         detail = left(format('charge=%s voided=%s', coalesce(v_charge::text, 'none'), v_voided), 200)
   where event_id = btrim(p_event_id);

  return jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'alert', v_alert,
    'action', v_action,
    'payment_id', v_pay,
    'amount_cents', p_amount_cents,
    'charge_cents', v_charge,
    'voided_sales', v_voided,
    'skus', to_jsonb(v_skus)
  );
end;
$$;

revoke all on function public.apply_square_webhook(text, text, text, text, text, text, integer, text) from public, anon, authenticated;
grant execute on function public.apply_square_webhook(text, text, text, text, text, text, integer, text) to service_role;
