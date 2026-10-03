-- Register errors with a formatted message (double sale, below floor, override reason...) raised
-- "RAISE option already specified" instead of the real reason. Same function, only RAISE syntax fixed.
CREATE OR REPLACE FUNCTION public.finalize_ticket(p_ticket_id uuid, p_lines jsonb, p_payment_method text, p_payment_id text DEFAULT NULL::text, p_amount_tendered_cents integer DEFAULT NULL::integer, p_channel text DEFAULT 'floor'::text, p_discount_bps integer DEFAULT 0, p_discount_approval_id uuid DEFAULT NULL::uuid, p_customer_id uuid DEFAULT NULL::uuid, p_redeem_points integer DEFAULT 0, p_cash_cents integer DEFAULT NULL::integer, p_card_cents integer DEFAULT NULL::integer, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_store uuid := public.current_store_id();
  v_bps int;
  v_existing jsonb;
  v_n int;
  v_skus text[] := '{}';
  v_unit_prices int[] := '{}';
  v_qtys int[] := '{}';
  v_raw_prices int[] := '{}';
  v_disc_shares int[];
  v_net_prices int[] := '{}';
  v_fee_shares int[] := '{}';
  v_taxes int[];
  v_line jsonb;
  v_sku text;
  v_unit_price int;
  v_qty int;
  v_price int;
  v_ask int;
  v_floor int;
  v_state text;
  v_qty_on_hand int;
  v_approval uuid;
  v_reason text;
  v_list int;
  v_tax int;
  v_receipt text;
  v_seq int;
  v_sale public.sales;
  v_actor text;
  v_channel text := coalesce(nullif(btrim(p_channel), ''), 'floor');
  v_pay text := lower(btrim(coalesce(p_payment_method, '')));
  i int;
  v_seen text[];
  v_raw_sub bigint := 0;
  v_discount_bps int := coalesce(p_discount_bps, 0);
  v_clerk_max int;
  v_discount_cents int := 0;
  v_signup_bps int;
  v_signup_cents int := 0;
  v_point_value int;
  v_points_per_dollar int;
  v_redeem_points int := coalesce(p_redeem_points, 0);
  v_redeem_cents int := 0;
  v_remaining int;
  v_total_disc int;
  v_net_sub int := 0;
  v_tax_total int := 0;
  v_prefee int;
  v_fee_bps int;
  v_card_base int := 0;
  v_card_fee int := 0;
  v_total int;
  v_cash int;
  v_card int;
  v_rewards_enabled boolean;
  v_rewards_channel boolean;
  v_cust public.customers;
  v_bal int;
  v_earn int := 0;
  v_new_bal int;
  v_receipt_snap jsonb;
  v_discount_by uuid := null;
  v_first_sku text;
begin
  perform public.assert_staff_or_service();
  if v_store is null then
    raise exception 'no_store' using errcode = 'P0001';
  end if;
  if p_ticket_id is null then
    raise exception 'ticket_required' using errcode = '22023';
  end if;
  if v_pay is null or v_pay = '' or v_pay not in ('cash', 'card', 'split', 'other') then
    raise exception 'invalid_payment' using errcode = '22023';
  end if;
  if v_discount_bps < 0 or v_discount_bps > 10000 then
    raise exception 'invalid_discount_bps' using errcode = '22023';
  end if;
  if v_redeem_points < 0 then
    raise exception 'invalid_redeem_points' using errcode = '22023';
  end if;

  -- Idempotent retry: already committed for this ticket.
  v_existing := public.ticket_summary(v_store, p_ticket_id);
  if v_existing is not null then
    return v_existing;
  end if;

  v_bps := public.store_tax_rate_bps();
  if v_bps is null then
    raise exception 'tax_rate_required' using errcode = 'P0001';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) < 1 then
    raise exception 'empty_ticket' using errcode = '22023';
  end if;

  v_n := jsonb_array_length(p_lines);
  v_seen := '{}';

  for i in 0..v_n - 1 loop
    v_line := p_lines->i;
    v_sku := btrim(coalesce(v_line->>'sku', ''));
    if v_sku = '' then
      raise exception 'invalid_sku' using errcode = '22023';
    end if;
    if v_sku = any (v_seen) then
      raise exception using errcode = 'P0001', message = format('duplicate_sku %s', v_sku);
    end if;
    v_seen := v_seen || v_sku;
    v_unit_price := (v_line->>'price_cents')::int;
    if v_unit_price is null or v_unit_price < 0 then
      raise exception using errcode = '22023', message = format('invalid_price %s', v_sku);
    end if;
    v_qty := coalesce(nullif(v_line->>'qty', '')::int, 1);
    if v_qty is null or v_qty < 1 then
      raise exception using errcode = '22023', message = format('invalid_qty %s', v_sku);
    end if;
    v_skus := v_skus || v_sku;
    v_unit_prices := v_unit_prices || v_unit_price;
    v_qtys := v_qtys || v_qty;
    v_price := v_unit_price * v_qty;
    v_raw_prices := v_raw_prices || v_price;
    v_raw_sub := v_raw_sub + v_price;
  end loop;

  v_first_sku := v_skus[1];

  perform public.release_expired_reservations();

  perform 1
    from public.units u
   where u.store_id = v_store
     and u.sku = any (v_skus)
   order by u.sku
     for update;

  for i in 1..v_n loop
    v_sku := v_skus[i];
    select u.ask_cents, u.floor_cents, u.state, u.qty_on_hand
      into v_ask, v_floor, v_state, v_qty_on_hand
      from public.units u
     where u.store_id = v_store and u.sku = v_sku;
    if not found then
      raise exception using errcode = 'P0001', message = format('sku_not_in_store %s', v_sku);
    end if;
    if v_state is distinct from 'available' and v_state is distinct from 'reserved' then
      insert into public.incidents (store_id, kind, sku, detail)
      values (v_store, 'double_sell', v_sku, jsonb_build_object('ticket_id', p_ticket_id, 'state', v_state));
      raise exception using errcode = 'P0001', message = format('unit_not_sellable %s', v_sku);
    end if;
    if v_qty_on_hand < v_qtys[i] then
      raise exception using errcode = 'P0001', message = format('insufficient_qty %s', v_sku);
    end if;
  end loop;

  -- Ticket % discount + approval
  v_clerk_max := public.store_setting_int(v_store, 'clerk_max_discount_bps', 1000);
  if v_discount_bps > v_clerk_max then
    if not public.is_manager() and auth.role() <> 'service_role' then
      if p_discount_approval_id is null or not exists (
        select 1 from public.approvals a
         where a.id = p_discount_approval_id
           and a.store_id = v_store
           and a.action = 'ticket_discount'
           and (a.sku = '*' or a.sku = v_first_sku)
           and a.consumed_at is null
           and a.created_at > now() - interval '10 minutes'
      ) then
        raise exception 'discount_approval_required' using errcode = 'P0001';
      end if;
      update public.approvals set consumed_at = now() where id = p_discount_approval_id;
    end if;
  end if;

  v_discount_cents := round((v_raw_sub::numeric * v_discount_bps::numeric) / 10000.0, 0)::int;
  if v_discount_bps > 0 then
    v_discount_by := auth.uid();
  end if;
  v_remaining := (v_raw_sub - v_discount_cents)::int;

  v_rewards_enabled := coalesce(
    (public.store_setting(v_store, 'rewards_enabled', 'true'::jsonb) #>> '{}')::boolean,
    true
  );
  v_rewards_channel := v_channel in ('floor', 'website');

  -- Customer + signup + redeem (floor/website only)
  if p_customer_id is not null and v_rewards_channel and v_rewards_enabled then
    select * into v_cust from public.customers
     where id = p_customer_id and store_id = v_store
     for update;
    if not found then
      raise exception 'customer_not_found' using errcode = 'P0001';
    end if;

    if not v_cust.first_purchase_discount_used then
      v_signup_bps := public.store_setting_int(v_store, 'rewards_signup_discount_bps', 500);
      v_signup_cents := round((v_remaining::numeric * v_signup_bps::numeric) / 10000.0, 0)::int;
      v_remaining := v_remaining - v_signup_cents;
      update public.customers
         set first_purchase_discount_used = true
       where id = v_cust.id;
    end if;

    if v_redeem_points > 0 then
      v_bal := public.customer_points_balance_internal(v_store, v_cust.id);
      if v_redeem_points > v_bal then
        raise exception 'insufficient_points' using errcode = 'P0001';
      end if;
      v_point_value := public.store_setting_int(v_store, 'rewards_point_value_cents', 1);
      v_redeem_cents := v_redeem_points * v_point_value;
      if v_redeem_cents > v_remaining then
        raise exception 'redeem_exceeds_subtotal' using errcode = 'P0001';
      end if;
      v_remaining := v_remaining - v_redeem_cents;
      v_new_bal := v_bal - v_redeem_points;
      insert into public.customer_points_ledger (
        store_id, customer_id, delta, balance_after, reason, ticket_id, actor_id
      ) values (
        v_store, v_cust.id, -v_redeem_points, v_new_bal, 'redeem_sale', p_ticket_id, auth.uid()
      );
    end if;
  elsif p_customer_id is not null and not v_rewards_channel then
    -- Ignore rewards on marketplace channels; still allow linking customer id? Spec: NEVER earn/redeem.
    null;
  elsif v_redeem_points > 0 then
    raise exception 'customer_required_for_redeem' using errcode = 'P0001';
  end if;

  v_total_disc := v_discount_cents + v_signup_cents + v_redeem_cents;
  v_disc_shares := public.prorate_cents(v_raw_prices, v_total_disc);
  for i in 1..v_n loop
    v_net_prices := v_net_prices || greatest(v_raw_prices[i] - v_disc_shares[i], 0);
    v_net_sub := v_net_sub + greatest(v_raw_prices[i] - v_disc_shares[i], 0);
  end loop;

  v_taxes := public.allocate_line_taxes(v_net_prices, v_bps);
  for i in 1..v_n loop
    v_tax_total := v_tax_total + v_taxes[i];
  end loop;

  -- Card fee: percentage of the card-paid portion only. Never part of tax.
  v_prefee := v_net_sub + v_tax_total;
  v_fee_bps := greatest(public.store_setting_int(v_store, 'card_fee_bps', 250), 0);

  if v_pay = 'split' then
    v_cash := coalesce(p_cash_cents, -1);
    v_card_base := coalesce(p_card_cents, -1);
    if v_cash < 0 or v_card_base < 0 then
      raise exception 'split_amounts_required' using errcode = '22023';
    end if;
    if v_cash + v_card_base is distinct from v_prefee then
      raise exception 'split_mismatch' using errcode = 'P0001';
    end if;
  elsif v_pay = 'card' then
    v_cash := coalesce(p_cash_cents, 0);
    v_card_base := v_prefee;
  elsif v_pay = 'cash' then
    v_cash := coalesce(p_cash_cents, v_prefee);
    v_card_base := coalesce(p_card_cents, 0);
  else
    v_cash := coalesce(p_cash_cents, 0);
    v_card_base := coalesce(p_card_cents, 0);
  end if;

  v_card_fee := round((v_card_base::numeric * v_fee_bps::numeric) / 10000.0, 0)::int;
  v_card := v_card_base + v_card_fee;
  v_total := v_prefee + v_card_fee;

  if v_pay in ('card', 'split') and v_card_base > 0
     and (p_payment_id is null or btrim(p_payment_id) = '') then
    raise exception 'payment_id_required' using errcode = '22023';
  end if;

  -- Earn points on post-discount pre-tax subtotal (floor/website only)
  if p_customer_id is not null and v_rewards_channel and v_rewards_enabled and v_net_sub > 0 then
    v_points_per_dollar := public.store_setting_int(v_store, 'rewards_points_per_dollar', 1);
    v_earn := floor((v_net_sub::numeric * v_points_per_dollar::numeric) / 100.0)::int;
    if v_earn > 0 then
      v_bal := public.customer_points_balance_internal(v_store, p_customer_id);
      v_new_bal := v_bal + v_earn;
      insert into public.customer_points_ledger (
        store_id, customer_id, delta, balance_after, reason, ticket_id, actor_id
      ) values (
        v_store, p_customer_id, v_earn, v_new_bal, 'earn_sale', p_ticket_id, auth.uid()
      );
    end if;
  end if;

  v_fee_shares := public.prorate_cents(v_net_prices, v_card_fee);

  v_receipt_snap := public.store_setting(v_store, 'receipt_branding', '{}'::jsonb);
  v_actor := coalesce((select display_name from public.staff where user_id = auth.uid()), 'service');

  insert into public.ticket_extras (
    ticket_id, store_id, discount_bps, discount_cents, discount_by, discount_approval_id,
    customer_id, points_redeemed, points_earned, signup_discount_cents,
    cash_cents, card_cents, amount_tendered_cents, note, receipt_settings,
    card_fee_bps, card_fee_cents
  ) values (
    p_ticket_id, v_store, v_discount_bps, v_discount_cents, v_discount_by, p_discount_approval_id,
    case when p_customer_id is not null and v_rewards_channel then p_customer_id else null end,
    case when v_redeem_cents > 0 then v_redeem_points else 0 end,
    v_earn, v_signup_cents,
    v_cash, v_card, p_amount_tendered_cents,
    nullif(btrim(coalesce(p_note, '')), ''),
    v_receipt_snap,
    v_fee_bps, v_card_fee
  );

  for i in 1..v_n loop
    v_sku := v_skus[i];
    v_price := v_net_prices[i];
    v_tax := v_taxes[i];
    v_qty := v_qtys[i];
    v_unit_price := v_unit_prices[i];
    v_line := p_lines->(i - 1);
    v_approval := nullif(v_line->>'approval_id', '')::uuid;
    v_reason := nullif(btrim(coalesce(v_line->>'override_reason', '')), '');

    select u.ask_cents, u.floor_cents into v_ask, v_floor
      from public.units u where u.store_id = v_store and u.sku = v_sku;
    v_list := v_ask;

    -- Floor check against unit price (not line total)
    if v_floor is not null and v_unit_price < v_floor then
      if v_approval is null or not exists (
        select 1 from public.approvals a
         where a.id = v_approval
           and a.store_id = v_store
           and a.action = 'below_floor'
           and a.sku = v_sku
           and a.consumed_at is null
           and a.created_at > now() - interval '10 minutes'
      ) then
        raise exception using errcode = 'P0001', message = format('below_floor %s', v_sku);
      end if;
      update public.approvals set consumed_at = now() where id = v_approval;
    end if;

    if v_list is not null and v_unit_price is distinct from v_list then
      if v_reason is null then
        raise exception using errcode = 'P0001', message = format('override_reason_required %s', v_sku);
      end if;
    else
      v_reason := null;
    end if;

    update public.units
       set qty_on_hand = qty_on_hand - v_qty,
           state = case when qty_on_hand - v_qty <= 0 then 'sold' else 'available' end,
           updated_at = now()
     where store_id = v_store and sku = v_sku and state in ('available', 'reserved')
       and qty_on_hand >= v_qty;
    if not found then
      raise exception using errcode = 'P0001', message = format('unit_not_sellable %s', v_sku);
    end if;

    insert into public.store_settings (store_id, key, value)
    values (v_store, 'receipt_seq', '0'::jsonb)
    on conflict (store_id, key) do nothing;
    update public.store_settings
       set value = to_jsonb(coalesce((value #>> '{}')::int, 0) + 1)
     where store_id = v_store and key = 'receipt_seq'
    returning (value #>> '{}')::int into v_seq;
    v_receipt := 'R-' || lpad(v_seq::text, greatest(5, public.sku_digits()), '0');

    insert into public.sales (
      store_id, sku, price_cents, tax_cents, card_fee_cents, channel, payment_method, payment_id,
      note, sold_at, receipt_no, actor_id, ticket_id, list_price_cents,
      override_reason, override_by, qty, override_price_cents
    ) values (
      v_store, v_sku, v_price, v_tax, coalesce(v_fee_shares[i], 0), v_channel, v_pay, p_payment_id,
      p_note,
      now(), v_receipt, auth.uid(), p_ticket_id,
      case when v_list is not null then v_list * v_qty else null end,
      v_reason,
      case when v_reason is not null then auth.uid() else null end,
      v_qty,
      case when v_reason is not null then v_unit_price * v_qty else null end
    )
    returning * into v_sale;

    if (select qty_on_hand from public.units where store_id = v_store and sku = v_sku) <= 0 then
      update public.sku_ledger set fate = 'sold'
       where sku = v_sku and store_id is not distinct from v_store;
    end if;

    update public.reservations
       set released_at = now()
     where store_id = v_store and sku = v_sku
       and released_at is null and finalized_at is null;

    insert into public.events (store_id, sku, kind, new_value, actor, actor_id, note)
    values (
      v_store, v_sku, 'sold', v_price::text, v_actor, auth.uid(),
      v_channel || ' ' || v_receipt || ' ticket=' || p_ticket_id::text
    );

    perform public.open_delist_tasks(v_sale);
    perform public.enqueue_sale_alerts(v_sale);
  end loop;

  return public.ticket_summary(v_store, p_ticket_id);
end;
$function$;
