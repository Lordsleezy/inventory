-- 20260922120000_card_fee.sql
--
-- Configurable card fee (default 2.5%, store_settings.card_fee_bps, 0 disables).
-- The fee applies only to the card-paid portion of a ticket and is stored
-- separately from sales tax so tax reports show only real sales tax.
--
--   - quote_ticket_totals gains p_payment_method + p_cash_cents and returns
--     card_fee_cents / card_charge_cents so every surface can show the fee
--     before money moves.
--   - create_register_charge always uses the server-computed card amount.
--   - finalize_ticket computes the fee itself; p_card_cents on split remains the
--     PRE-FEE card portion (cash + card_base = pre-fee total; card charged =
--     card_base + fee).
--   - finalize_register_charge verifies the Square-charged amount equals what
--     finalize_ticket computed; a mismatch (e.g. fee setting changed mid-charge)
--     fails finalization so the charge is auto-refunded instead of recording a
--     sale that disagrees with the card.

alter table public.ticket_extras
  add column if not exists card_fee_bps int not null default 0,
  add column if not exists card_fee_cents int not null default 0;

alter table public.sales
  add column if not exists card_fee_cents int not null default 0;

alter table public.card_charges
  add column if not exists card_fee_cents int not null default 0;

-- Seed the setting for new stores and backfill existing ones (default 2.5%).
create or replace function public.seed_store_settings(p_store uuid, p_display_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.store_settings (store_id, key, value) values
    (p_store, 'display_name', to_jsonb(coalesce(nullif(btrim(p_display_name), ''), 'Store'))),
    (p_store, 'skuStart', '10000'::jsonb),
    (p_store, 'skuDigits', '5'::jsonb),
    (p_store, 'taxPricing', '"added"'::jsonb),
    (p_store, 'currency', '"USD"'::jsonb),
    (p_store, 'reservationTtlSeconds', '180'::jsonb),
    (p_store, 'delistNagMinutes', '15'::jsonb),
    (p_store, 'card_payments_enabled', 'false'::jsonb),
    (p_store, 'pin_failed_count', '0'::jsonb),
    (p_store, 'receipt_seq', '0'::jsonb),
    (p_store, 'card_fee_bps', '250'::jsonb),
    (p_store, 'categories', '["Uncategorized"]'::jsonb),
    (p_store, 'conditions', '["New","Open box","Excellent","Good","Fair","For parts"]'::jsonb),
    (p_store, 'testStatuses', '["untested","passed","failed","partial"]'::jsonb),
    (p_store, 'locations', '["Floor","Back room","Repair bench"]'::jsonb),
    (p_store, 'channels', '["floor","ebay","facebook","offerup","amazon","tiktok","website","wholesale"]'::jsonb),
    (p_store, 'paymentMethods', '["cash","card","split","other"]'::jsonb),
    (p_store, 'clerk_max_discount_bps', '1000'::jsonb),
    (p_store, 'rewards_enabled', 'true'::jsonb),
    (p_store, 'rewards_points_per_dollar', '1'::jsonb),
    (p_store, 'rewards_point_value_cents', '1'::jsonb),
    (p_store, 'rewards_signup_discount_bps', '500'::jsonb),
    (p_store, 'receipt_branding', jsonb_build_object(
      'storeName', coalesce(nullif(btrim(p_display_name), ''), 'Store'),
      'address', '',
      'phone', '',
      'headerMessage', 'Thank you for shopping with us!',
      'footerMessage', 'Keep this receipt for your records.',
      'legal', '',
      'returnPolicy', 'Returns within 14 days with receipt.',
      'logoUrl', '',
      'showSku', true,
      'showCondition', true,
      'showClerk', true,
      'showPoints', true,
      'reviewUrl', '',
      'paperPreview', 'roll80'
    ))
  on conflict (store_id, key) do nothing;

  insert into public.channel_config (store_id, channel, mode) values
    (p_store, 'floor', 'manual'),
    (p_store, 'website', 'manual'),
    (p_store, 'ebay', 'off'),
    (p_store, 'amazon', 'off'),
    (p_store, 'facebook', 'off'),
    (p_store, 'tiktok', 'off')
  on conflict (store_id, channel) do nothing;
end;
$$;

insert into public.store_settings (store_id, key, value)
select s.id, 'card_fee_bps', '250'::jsonb
  from public.stores s
on conflict (store_id, key) do nothing;

-- Older stores seeded paymentMethods without "split".
update public.store_settings
   set value = value || '"split"'::jsonb
 where key = 'paymentMethods'
   and jsonb_typeof(value) = 'array'
   and not value @> '"split"'::jsonb;

-- ---------------------------------------------------------------------------
-- quote_ticket_totals: add payment method + cash so card fee can be quoted.
-- ---------------------------------------------------------------------------
drop function if exists public.quote_ticket_totals(jsonb, int, uuid, int, text);

create function public.quote_ticket_totals(
  p_lines jsonb,
  p_discount_bps int default 0,
  p_customer_id uuid default null,
  p_redeem_points int default 0,
  p_channel text default 'floor',
  p_payment_method text default 'cash',
  p_cash_cents int default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
  v_bps int;
  v_n int;
  v_i int;
  v_line jsonb;
  v_sku text;
  v_unit int;
  v_qty int;
  v_prices int[] := '{}';
  v_raw_sub bigint := 0;
  v_discount_bps int := coalesce(p_discount_bps, 0);
  v_discount_cents int := 0;
  v_signup_cents int := 0;
  v_redeem_cents int := 0;
  v_remaining int;
  v_total_disc int;
  v_shares int[];
  v_net int[] := '{}';
  v_net_sub int := 0;
  v_taxes int[];
  v_tax int := 0;
  v_channel text := coalesce(nullif(btrim(p_channel), ''), 'floor');
  v_rewards_enabled boolean;
  v_cust public.customers;
  v_signup_bps int;
  v_point_value int;
  v_bal int;
  v_redeem_points int := coalesce(p_redeem_points, 0);
  v_pay text := lower(btrim(coalesce(p_payment_method, 'cash')));
  v_prefee int;
  v_fee_bps int;
  v_card_base int := 0;
  v_fee int := 0;
begin
  perform public.assert_staff_or_service();
  if v_store is null then
    raise exception 'no_store' using errcode = 'P0001';
  end if;
  v_bps := public.store_tax_rate_bps();
  if v_bps is null then
    raise exception 'tax_rate_required' using errcode = 'P0001';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) < 1 then
    raise exception 'empty_ticket' using errcode = '22023';
  end if;
  if v_discount_bps < 0 or v_discount_bps > 10000 then
    raise exception 'invalid_discount_bps' using errcode = '22023';
  end if;

  v_n := jsonb_array_length(p_lines);
  for v_i in 0..v_n - 1 loop
    v_line := p_lines->v_i;
    v_sku := btrim(coalesce(v_line->>'sku', ''));
    v_unit := (v_line->>'price_cents')::int;
    v_qty := coalesce(nullif(v_line->>'qty', '')::int, 1);
    if v_sku = '' or v_unit is null or v_unit < 0 or v_qty is null or v_qty < 1 then
      raise exception 'invalid_line' using errcode = '22023';
    end if;
    v_prices := v_prices || (v_unit * v_qty);
    v_raw_sub := v_raw_sub + v_unit * v_qty;
  end loop;

  v_discount_cents := round((v_raw_sub::numeric * v_discount_bps::numeric) / 10000.0, 0)::int;
  v_remaining := (v_raw_sub - v_discount_cents)::int;

  v_rewards_enabled := coalesce(
    (public.store_setting(v_store, 'rewards_enabled', 'true'::jsonb) #>> '{}')::boolean,
    true
  );

  if p_customer_id is not null and v_channel in ('floor', 'website') and v_rewards_enabled then
    select * into v_cust from public.customers
     where id = p_customer_id and store_id = v_store;
    if found and not v_cust.first_purchase_discount_used then
      v_signup_bps := public.store_setting_int(v_store, 'rewards_signup_discount_bps', 500);
      v_signup_cents := round((v_remaining::numeric * v_signup_bps::numeric) / 10000.0, 0)::int;
      v_remaining := v_remaining - v_signup_cents;
    end if;
    if found and v_redeem_points > 0 then
      v_bal := public.customer_points_balance_internal(v_store, v_cust.id);
      v_point_value := public.store_setting_int(v_store, 'rewards_point_value_cents', 1);
      v_redeem_cents := least(v_redeem_points, v_bal) * v_point_value;
      v_redeem_cents := least(v_redeem_cents, v_remaining);
      v_remaining := v_remaining - v_redeem_cents;
    end if;
  end if;

  v_total_disc := v_discount_cents + v_signup_cents + v_redeem_cents;
  v_shares := public.prorate_cents(v_prices, v_total_disc);
  for v_i in 1..v_n loop
    v_net := v_net || greatest(v_prices[v_i] - v_shares[v_i], 0);
    v_net_sub := v_net_sub + greatest(v_prices[v_i] - v_shares[v_i], 0);
  end loop;
  v_taxes := public.allocate_line_taxes(v_net, v_bps);
  for v_i in 1..v_n loop
    v_tax := v_tax + v_taxes[v_i];
  end loop;

  v_prefee := v_net_sub + v_tax;
  v_fee_bps := greatest(public.store_setting_int(v_store, 'card_fee_bps', 250), 0);

  if v_pay = 'card' then
    v_card_base := v_prefee;
  elsif v_pay = 'split' then
    if p_cash_cents is null or p_cash_cents < 0 or p_cash_cents >= v_prefee then
      raise exception 'invalid_split' using errcode = '22023';
    end if;
    v_card_base := v_prefee - p_cash_cents;
  else
    v_card_base := 0;
  end if;
  v_fee := round((v_card_base::numeric * v_fee_bps::numeric) / 10000.0, 0)::int;

  return jsonb_build_object(
    'raw_subtotal_cents', v_raw_sub,
    'discount_bps', v_discount_bps,
    'discount_cents', v_discount_cents,
    'signup_discount_cents', v_signup_cents,
    'redeem_cents', v_redeem_cents,
    'subtotal_cents', v_net_sub,
    'tax_cents', v_tax,
    'pre_fee_total_cents', v_prefee,
    'card_fee_bps', v_fee_bps,
    'card_base_cents', v_card_base,
    'card_fee_cents', v_fee,
    'card_charge_cents', v_card_base + v_fee,
    'total_cents', v_prefee + v_fee
  );
end;
$$;

grant execute on function public.quote_ticket_totals(jsonb, int, uuid, int, text, text, int)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- finalize_ticket: server-side card fee on the card-paid portion.
-- Drop the stale pre-discount/rewards overload (0024) so RPC dispatch is
-- unambiguous.
-- ---------------------------------------------------------------------------
drop function if exists public.finalize_ticket(uuid, jsonb, text, text, int, text);

create or replace function public.finalize_ticket(
  p_ticket_id uuid,
  p_lines jsonb,
  p_payment_method text,
  p_payment_id text default null,
  p_amount_tendered_cents int default null,
  p_channel text default 'floor',
  p_discount_bps int default 0,
  p_discount_approval_id uuid default null,
  p_customer_id uuid default null,
  p_redeem_points int default 0,
  p_cash_cents int default null,
  p_card_cents int default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
      raise exception 'duplicate_sku' using errcode = 'P0001', message = format('duplicate_sku %s', v_sku);
    end if;
    v_seen := v_seen || v_sku;
    v_unit_price := (v_line->>'price_cents')::int;
    if v_unit_price is null or v_unit_price < 0 then
      raise exception 'invalid_price' using errcode = '22023', message = format('invalid_price %s', v_sku);
    end if;
    v_qty := coalesce(nullif(v_line->>'qty', '')::int, 1);
    if v_qty is null or v_qty < 1 then
      raise exception 'invalid_qty' using errcode = '22023', message = format('invalid_qty %s', v_sku);
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
      raise exception 'sku_not_in_store' using errcode = 'P0001', message = format('sku_not_in_store %s', v_sku);
    end if;
    if v_state is distinct from 'available' and v_state is distinct from 'reserved' then
      insert into public.incidents (store_id, kind, sku, detail)
      values (v_store, 'double_sell', v_sku, jsonb_build_object('ticket_id', p_ticket_id, 'state', v_state));
      raise exception 'unit_not_sellable' using errcode = 'P0001', message = format('unit_not_sellable %s', v_sku);
    end if;
    if v_qty_on_hand < v_qtys[i] then
      raise exception 'insufficient_qty' using errcode = 'P0001', message = format('insufficient_qty %s', v_sku);
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
        raise exception 'below_floor' using errcode = 'P0001', message = format('below_floor %s', v_sku);
      end if;
      update public.approvals set consumed_at = now() where id = v_approval;
    end if;

    if v_list is not null and v_unit_price is distinct from v_list then
      if v_reason is null then
        raise exception 'override_reason_required' using errcode = 'P0001', message = format('override_reason_required %s', v_sku);
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
      raise exception 'unit_not_sellable' using errcode = 'P0001', message = format('unit_not_sellable %s', v_sku);
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
      override_reason, override_by, qty
    ) values (
      v_store, v_sku, v_price, v_tax, coalesce(v_fee_shares[i], 0), v_channel, v_pay, p_payment_id,
      p_note,
      now(), v_receipt, auth.uid(), p_ticket_id,
      case when v_list is not null then v_list * v_qty else null end,
      v_reason,
      case when v_reason is not null then auth.uid() else null end,
      v_qty
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
$$;

grant execute on function public.finalize_ticket(
  uuid, jsonb, text, text, int, text, int, uuid, uuid, int, int, int, text
) to authenticated;

-- ---------------------------------------------------------------------------
-- ticket_summary: expose the fee, split tender, and rewards balance.
-- ---------------------------------------------------------------------------
create or replace function public.ticket_summary(p_store uuid, p_ticket uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_lines jsonb := '[]'::jsonb;
  v_sub int := 0;
  v_tax int := 0;
  v_fee int := 0;
  r record;
  x public.ticket_extras;
  v_cust jsonb := null;
begin
  for r in
    select id, sku, receipt_no, price_cents, tax_cents, card_fee_cents, list_price_cents,
           override_reason, payment_method, sold_at, card_brand, card_last4, qty
      from public.sales
     where store_id = p_store and ticket_id = p_ticket and voided_at is null
     order by id
  loop
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'sale_id', r.id,
      'sku', r.sku,
      'receipt_no', r.receipt_no,
      'price_cents', r.price_cents,
      'tax_cents', coalesce(r.tax_cents, 0),
      'card_fee_cents', coalesce(r.card_fee_cents, 0),
      'list_price_cents', r.list_price_cents,
      'override_reason', r.override_reason,
      'payment_method', r.payment_method,
      'card_brand', r.card_brand,
      'card_last4', r.card_last4,
      'qty', r.qty
    ));
    v_sub := v_sub + r.price_cents;
    v_tax := v_tax + coalesce(r.tax_cents, 0);
    v_fee := v_fee + coalesce(r.card_fee_cents, 0);
  end loop;
  if jsonb_array_length(v_lines) = 0 then
    return null;
  end if;

  select * into x from public.ticket_extras
   where ticket_id = p_ticket and store_id = p_store;

  if x.customer_id is not null then
    select jsonb_build_object(
      'id', c.id,
      'phone', c.phone,
      'name', c.name,
      'email', c.email,
      'points_balance', public.customer_points_balance_internal(p_store, c.id)
    ) into v_cust
      from public.customers c
     where c.id = x.customer_id;
  end if;

  return jsonb_build_object(
    'ticket_id', p_ticket,
    'lines', v_lines,
    'subtotal_cents', v_sub,
    'tax_cents', v_tax,
    'card_fee_bps', coalesce(x.card_fee_bps, 0),
    'card_fee_cents', coalesce(x.card_fee_cents, v_fee),
    'total_cents', v_sub + v_tax + coalesce(x.card_fee_cents, v_fee),
    'payment_method', v_lines->0->>'payment_method',
    'card_brand', v_lines->0->>'card_brand',
    'card_last4', v_lines->0->>'card_last4',
    'discount_bps', coalesce(x.discount_bps, 0),
    'discount_cents', coalesce(x.discount_cents, 0),
    'signup_discount_cents', coalesce(x.signup_discount_cents, 0),
    'points_redeemed', coalesce(x.points_redeemed, 0),
    'points_earned', coalesce(x.points_earned, 0),
    'points_balance', case when x.customer_id is not null then v_cust->'points_balance' else null end,
    'customer_id', x.customer_id,
    'customer', v_cust,
    'cash_cents', coalesce(x.cash_cents, 0),
    'card_cents', coalesce(x.card_cents, 0),
    'amount_tendered_cents', x.amount_tendered_cents,
    'note', x.note
  );
end;
$$;

revoke all on function public.ticket_summary(uuid, uuid) from public, anon;
grant execute on function public.ticket_summary(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- create_register_charge: server computes the card amount including the fee.
-- ---------------------------------------------------------------------------
create or replace function public.create_register_charge(
  p_ticket_id uuid,
  p_device_id uuid,
  p_lines jsonb,
  p_charge_cents int default null,
  p_discount_bps int default 0,
  p_discount_approval_id uuid default null,
  p_customer_id uuid default null,
  p_redeem_points int default 0,
  p_cash_cents int default null,
  p_card_cents int default null,
  p_note text default null,
  p_payment_method text default 'card'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
  v_quote jsonb;
  v_n int;
  v_i int;
  v_line jsonb;
  v_sku text;
  v_unit int;
  v_qty int;
  v_seen text[] := '{}';
  v_id uuid;
  v_existing public.card_charges;
  v_device public.pos_devices;
  v_amount int;
  v_card_base int;
  v_fee int;
  v_tax int;
  v_pay text := lower(btrim(coalesce(p_payment_method, 'card')));
begin
  perform public.assert_staff_or_service();
  if v_store is null then
    raise exception 'no_store' using errcode = 'P0001';
  end if;
  if p_ticket_id is null then
    raise exception 'ticket_required' using errcode = '22023';
  end if;
  if v_pay not in ('card', 'split') then
    v_pay := 'card';
  end if;

  select * into v_existing
    from public.card_charges
   where store_id = v_store and ticket_id = p_ticket_id
   order by created_at desc
   limit 1
   for update;
  if found then
    if v_existing.status = 'finalized' then
      return jsonb_build_object(
        'id', v_existing.id,
        'ticket_id', v_existing.ticket_id,
        'amount_cents', v_existing.amount_cents,
        'tax_cents', v_existing.tax_cents,
        'card_fee_cents', v_existing.card_fee_cents,
        'status', v_existing.status,
        'summary', public.ticket_summary(v_store, p_ticket_id)
      );
    end if;
    if v_existing.status in ('pending', 'captured') then
      return jsonb_build_object(
        'id', v_existing.id,
        'ticket_id', v_existing.ticket_id,
        'amount_cents', v_existing.amount_cents,
        'tax_cents', v_existing.tax_cents,
        'card_fee_cents', v_existing.card_fee_cents,
        'status', v_existing.status
      );
    end if;
  end if;

  select * into v_device
    from public.pos_devices
   where id = p_device_id and store_id = v_store and kind = 'phone_reader';
  if not found then
    raise exception 'reader_not_paired' using errcode = 'P0001';
  end if;
  if v_device.last_seen is null or v_device.last_seen < now() - interval '45 seconds' then
    raise exception 'reader_offline' using errcode = 'P0001';
  end if;
  if not coalesce(v_device.square_authorized, false) then
    raise exception 'reader_not_authorized' using errcode = 'P0001';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) < 1 then
    raise exception 'empty_ticket' using errcode = '22023';
  end if;

  v_n := jsonb_array_length(p_lines);
  for v_i in 0..v_n - 1 loop
    v_line := p_lines->v_i;
    v_sku := btrim(coalesce(v_line->>'sku', ''));
    if v_sku = '' then
      raise exception 'invalid_sku' using errcode = '22023';
    end if;
    if v_sku = any (v_seen) then
      raise exception 'duplicate_sku' using errcode = 'P0001', message = format('duplicate_sku %s', v_sku);
    end if;
    v_seen := v_seen || v_sku;
    v_unit := (v_line->>'price_cents')::int;
    v_qty := coalesce(nullif(v_line->>'qty', '')::int, 1);
    if v_unit is null or v_unit < 0 or v_qty is null or v_qty < 1 then
      raise exception 'invalid_price' using errcode = '22023', message = format('invalid_price %s', v_sku);
    end if;
    if not exists (
      select 1 from public.units u
       where u.store_id = v_store and u.sku = v_sku
         and u.state in ('available', 'reserved')
         and u.qty_on_hand >= v_qty
    ) then
      raise exception 'unit_not_sellable' using errcode = 'P0001', message = format('unit_not_sellable %s', v_sku);
    end if;
  end loop;

  v_quote := public.quote_ticket_totals(
    p_lines, coalesce(p_discount_bps, 0), p_customer_id, coalesce(p_redeem_points, 0),
    'floor', v_pay, case when v_pay = 'split' then p_cash_cents else null end
  );
  v_tax := (v_quote->>'tax_cents')::int;
  v_fee := coalesce((v_quote->>'card_fee_cents')::int, 0);
  v_card_base := coalesce((v_quote->>'card_base_cents')::int, 0);
  v_amount := (v_quote->>'card_charge_cents')::int;

  if p_charge_cents is not null then
    if p_charge_cents < 0 then
      raise exception 'invalid_charge_cents' using errcode = '22023';
    end if;
    if p_charge_cents is distinct from v_amount then
      raise exception 'charge_amount_mismatch'
        using errcode = 'P0001',
              message = format('charge_amount_mismatch expected %s got %s', v_amount, p_charge_cents);
    end if;
  end if;

  insert into public.card_charges (
    store_id, device_id, ticket_id, lines, sku, title,
    amount_cents, tax_cents, card_fee_cents, actor_id, status,
    discount_bps, discount_approval_id, customer_id, redeem_points,
    cash_cents, card_cents, note, charge_cents, payment_method
  ) values (
    v_store, p_device_id, p_ticket_id, p_lines,
    btrim(coalesce((p_lines->0)->>'sku', '')),
    format('%s item(s)', v_n),
    v_amount, v_tax, v_fee, auth.uid(), 'pending',
    coalesce(p_discount_bps, 0), p_discount_approval_id, p_customer_id, coalesce(p_redeem_points, 0),
    case when v_pay = 'split' then p_cash_cents else null end,
    case when v_pay = 'split' then v_card_base else null end,
    nullif(btrim(coalesce(p_note, '')), ''),
    p_charge_cents,
    v_pay
  )
  returning id into v_id;

  return jsonb_build_object(
    'id', v_id,
    'ticket_id', p_ticket_id,
    'amount_cents', v_amount,
    'tax_cents', v_tax,
    'card_fee_cents', v_fee,
    'card_base_cents', v_card_base,
    'status', 'pending',
    'quote', v_quote
  );
end;
$$;

grant execute on function public.create_register_charge(
  uuid, uuid, jsonb, int, int, uuid, uuid, int, int, int, text, text
) to authenticated;

-- ---------------------------------------------------------------------------
-- finalize_register_charge: verify the Square charge matches the finalized
-- card amount; a mismatch refunds instead of recording a wrong sale.
-- ---------------------------------------------------------------------------
create or replace function public.finalize_register_charge(p_charge_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
  v_charge public.card_charges;
  v_summary jsonb;
  v_ticket uuid;
  v_err text;
  v_failed boolean := false;
  v_pay text;
  v_expected int;
begin
  perform public.assert_staff_or_service();
  if v_store is null then
    raise exception 'no_store' using errcode = 'P0001';
  end if;

  select * into v_charge
    from public.card_charges
   where id = p_charge_id and store_id = v_store
   for update;
  if not found then
    raise exception 'charge_not_found' using errcode = 'P0001';
  end if;

  if v_charge.status = 'finalized' and v_charge.ticket_id is not null then
    return public.ticket_summary(v_store, v_charge.ticket_id);
  end if;

  if v_charge.status is distinct from 'captured' or v_charge.payment_id is null then
    raise exception 'charge_not_captured' using errcode = 'P0001';
  end if;
  if v_charge.lines is null or jsonb_typeof(v_charge.lines) <> 'array' then
    raise exception 'charge_missing_lines' using errcode = 'P0001';
  end if;

  v_ticket := coalesce(v_charge.ticket_id, gen_random_uuid());
  v_pay := lower(btrim(coalesce(v_charge.payment_method, 'card')));
  if v_pay not in ('cash', 'card', 'split', 'other') then
    v_pay := 'card';
  end if;

  begin
    v_summary := public.finalize_ticket(
      v_ticket,
      v_charge.lines,
      v_pay,
      v_charge.payment_id,
      null,
      'floor',
      coalesce(v_charge.discount_bps, 0),
      v_charge.discount_approval_id,
      v_charge.customer_id,
      coalesce(v_charge.redeem_points, 0),
      v_charge.cash_cents,
      v_charge.card_cents,
      v_charge.note
    );
    -- The card must have been charged exactly what finalize recorded.
    if v_pay = 'card' then
      v_expected := (v_summary->>'total_cents')::int;
    else
      v_expected := coalesce((v_summary->>'card_cents')::int, 0);
    end if;
    if v_expected is distinct from v_charge.amount_cents then
      raise exception 'charge_amount_mismatch expected % charged %', v_expected, v_charge.amount_cents
        using errcode = 'P0001';
    end if;
  exception
    when others then
      v_err := SQLERRM;
      v_failed := true;
  end;

  if v_failed then
    update public.card_charges
       set status = 'finalize_failed',
           error = left(v_err, 500),
           updated_at = now()
     where id = p_charge_id;
    return jsonb_build_object(
      'ok', false,
      'error', v_err,
      'charge_id', p_charge_id,
      'payment_id', v_charge.payment_id,
      'amount_cents', v_charge.amount_cents,
      'needs_refund', true
    );
  end if;

  update public.sales
     set card_brand = v_charge.card_brand,
         card_last4 = v_charge.card_last4
   where store_id = v_store
     and ticket_id = v_ticket
     and voided_at is null;

  update public.card_charges
     set status = 'finalized',
         ticket_id = v_ticket,
         error = null,
         updated_at = now()
   where id = p_charge_id;

  return coalesce(public.ticket_summary(v_store, v_ticket), v_summary);
end;
$$;

grant execute on function public.finalize_register_charge(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- finalize_sale (single-unit phone path): record the card fee server-side.
-- Drop the stale pre-approval overload (0002) so RPC dispatch is unambiguous.
-- ---------------------------------------------------------------------------
drop function if exists public.finalize_sale(text, text, int, text, text, text, text, text, text, uuid, int);

create or replace function public.finalize_sale(
  p_sku text,
  p_channel text,
  p_price_cents int,
  p_payment_method text default null,
  p_payment_id text default null,
  p_customer_name text default null,
  p_customer_phone text default null,
  p_customer_email text default null,
  p_note text default null,
  p_reservation_id uuid default null,
  p_tax_cents int default 0,
  p_approval_id uuid default null
)
returns public.sales
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale public.sales;
  v_receipt text;
  v_seq int;
  v_store uuid := public.current_store_id();
  v_floor int;
  v_fee int := 0;
begin
  perform public.assert_staff_or_service();
  perform public.release_expired_reservations();

  if v_store is null then
    select store_id into v_store from public.units where sku = p_sku limit 1;
  end if;
  if v_store is null then
    raise exception 'no_store' using errcode = 'P0001';
  end if;

  if p_price_cents is null or p_price_cents < 0 then
    raise exception 'invalid_price' using errcode = '22023';
  end if;
  if p_channel is null or btrim(p_channel) = '' then
    raise exception 'invalid_channel' using errcode = '22023';
  end if;

  if lower(btrim(coalesce(p_payment_method, ''))) = 'card' then
    v_fee := round(
      ((p_price_cents + coalesce(p_tax_cents, 0))::numeric
        * greatest(public.store_setting_int(v_store, 'card_fee_bps', 250), 0)::numeric)
      / 10000.0, 0
    )::int;
  end if;

  select floor_cents into v_floor
    from public.units
   where sku = p_sku and store_id = v_store;
  if v_floor is not null and p_price_cents < v_floor then
    if p_approval_id is null or not exists (
      select 1 from public.approvals a
       where a.id = p_approval_id
         and a.store_id = v_store
         and a.action = 'below_floor'
         and a.sku = p_sku
         and a.consumed_at is null
         and a.created_at > now() - interval '10 minutes'
    ) then
      raise exception 'below_floor' using errcode = 'P0001';
    end if;
    update public.approvals set consumed_at = now() where id = p_approval_id;
  end if;

  if p_reservation_id is not null then
    update public.reservations
       set payment_id = coalesce(p_payment_id, payment_id)
     where id = p_reservation_id
       and sku = p_sku
       and store_id = v_store
       and released_at is null
       and finalized_at is null
       and expires_at > now();
    if not found then
      raise exception 'reservation_expired' using errcode = 'P0001';
    end if;
  end if;

  update public.units
     set state = 'sold', updated_at = now()
   where sku = p_sku
     and store_id = v_store
     and state in ('available', 'reserved');
  if not found then
    insert into public.incidents (store_id, kind, sku, detail)
    values (
      v_store,
      'double_sell',
      p_sku,
      jsonb_build_object('channel', p_channel, 'payment_id', p_payment_id)
    );
    perform public.enqueue_double_sell_alert(
      v_store, p_sku, jsonb_build_object('channel', p_channel, 'payment_id', p_payment_id)
    );
    raise exception 'unit_not_sellable' using errcode = 'P0001';
  end if;

  insert into public.store_settings (store_id, key, value)
  values (v_store, 'receipt_seq', '0'::jsonb)
  on conflict (store_id, key) do nothing;

  update public.store_settings
     set value = to_jsonb(coalesce((value #>> '{}')::int, 0) + 1)
   where store_id = v_store and key = 'receipt_seq'
  returning (value #>> '{}')::int into v_seq;
  v_receipt := 'R-' || lpad(v_seq::text, greatest(5, public.sku_digits()), '0');

  begin
    insert into public.sales (
      store_id, sku, price_cents, tax_cents, card_fee_cents, channel, payment_method, payment_id,
      customer_name, customer_phone, customer_email, note, sold_at, receipt_no, actor_id
    ) values (
      v_store, p_sku, p_price_cents, coalesce(p_tax_cents, 0), v_fee, btrim(p_channel), p_payment_method, p_payment_id,
      p_customer_name, p_customer_phone, p_customer_email, p_note, now(), v_receipt, auth.uid()
    )
    returning * into v_sale;
  exception
    when unique_violation then
      insert into public.incidents (store_id, kind, sku, detail)
      values (
        v_store,
        'double_sell',
        p_sku,
        jsonb_build_object('channel', p_channel, 'payment_id', p_payment_id)
      );
      perform public.enqueue_double_sell_alert(
        v_store, p_sku, jsonb_build_object('channel', p_channel, 'payment_id', p_payment_id)
      );
      raise;
  end;

  update public.sku_ledger set fate = 'sold' where sku = p_sku and store_id is not distinct from v_store;

  if p_reservation_id is not null then
    update public.reservations
       set finalized_at = now(), sale_id = v_sale.id, payment_id = coalesce(p_payment_id, payment_id)
     where id = p_reservation_id;
  else
    update public.reservations
       set released_at = now()
     where store_id = v_store and sku = p_sku and released_at is null and finalized_at is null;
  end if;

  insert into public.events (store_id, sku, kind, new_value, actor, actor_id, note)
  values (
    v_store,
    p_sku,
    'sold',
    p_price_cents::text,
    coalesce((select display_name from public.staff where user_id = auth.uid()), 'service'),
    auth.uid(),
    btrim(p_channel) || ' ' || v_receipt
  );

  perform public.open_delist_tasks(v_sale);
  perform public.enqueue_sale_alerts(v_sale);
  return v_sale;
end;
$$;

-- ---------------------------------------------------------------------------
-- sale_receipts: expose card fee; total includes it.
-- ---------------------------------------------------------------------------
drop view if exists public.sale_receipts;
create view public.sale_receipts
with (security_invoker = false) as
select
  s.id,
  s.store_id,
  s.sku,
  s.receipt_no,
  s.ticket_id,
  s.sold_at,
  s.price_cents,
  coalesce(s.tax_cents, 0) as tax_cents,
  coalesce(s.card_fee_cents, 0) as card_fee_cents,
  s.price_cents + coalesce(s.tax_cents, 0) + coalesce(s.card_fee_cents, 0) as total_cents,
  s.list_price_cents,
  s.override_reason,
  s.override_by,
  s.payment_method,
  s.payment_id,
  s.card_brand,
  s.card_last4,
  s.qty,
  s.channel,
  s.voided_at,
  s.void_reason,
  s.actor_id,
  st.display_name as actor_name,
  coalesce(nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), u.title, 'Item') as title,
  u.condition
from public.sales s
left join public.staff st on st.user_id = s.actor_id and st.store_id = s.store_id
left join public.units_pos u on u.sku = s.sku and u.store_id = s.store_id
where s.store_id in (select store_id from public.staff where user_id = auth.uid());

grant select on public.sale_receipts to authenticated;
