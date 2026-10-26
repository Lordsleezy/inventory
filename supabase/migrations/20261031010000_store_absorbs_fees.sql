-- Store absorbs fees (commission profit ignores channel + card fees; labels still subtract,
-- buyer-paid shipping still adds) and card-surcharge netting.
--
-- 1. sale_ledger: the card processing fee is netted against the surcharge the customer paid
--    (only any leftover reaches profit). Applies to every past card sale because it is a view.
-- 2. sale_payout_lines.fees_cents: channel + net card fee embedded in each frozen base, so the
--    commission base can be computed either way without touching anything else.
-- 3. Setting commission_store_absorbs_fees (default ON). portal_set_absorb_fees() flips it,
--    recalculates every commission under the frozen rules, and writes paid-sale differences as
--    adjustment rows (paired with an add-back on the Payouts screen, like replacements).
--    Payments are never touched.
begin;

alter table public.sale_payout_lines add column if not exists fees_cents integer not null default 0;
alter table public.portal_payout_adjustments add column if not exists fee_rule_change boolean not null default false;

-- ---------- ledger view ----------
create or replace view public.sale_ledger as
SELECT s.id,
    s.store_id,
    s.sku,
    s.qty,
    s.sold_at,
    s.voided_at,
    s.ticket_id,
    s.receipt_no,
    s.channel,
    s.payment_method,
    s.payment_id,
    s.actor_id,
    st.display_name AS actor_name,
    s.price_cents,
    s.tax_cents,
    s.card_fee_cents,
    COALESCE(NULLIF(s.shipping_cents, 0), wo.shipping_cents, 0) AS shipping_cents,
    x.cash_cents,
    x.card_cents,
    u.brand,
    u.model,
    u.category,
    u.ask_cents,
    COALESCE(u.is_collectible, false) AS is_collectible,
    u.acquisition_cost_cents AS unit_cost_cents,
    ((cost.val ->> 'cost_cents'::text))::integer AS cost_unit_cents,
    sale_cost_with_replacements(s.id, (((cost.val ->> 'cost_cents'::text))::integer * GREATEST(s.qty, 1))) AS cost_cents,
    (cost.val ->> 'source'::text) AS cost_source,
    COALESCE(co.fee_cents, wo.marketplace_fee_cents, ((fe.val ->> 'fee_cents'::text))::integer, 0) AS channel_fee_cents,
        CASE
            WHEN (co.fee_cents IS NOT NULL) THEN co.fee_source
            WHEN (wo.marketplace_fee_cents IS NOT NULL) THEN 'estimated'::text
            WHEN (fe.val IS NOT NULL) THEN 'estimated'::text
            ELSE 'none'::text
        END AS fee_source,
        CASE
            WHEN (GREATEST(COALESCE(wo.label_cost_cents, 0), COALESCE(lbl.cents, 0), COALESCE(man.cents, 0), COALESCE(co.ship_label_cents, 0)) > 0) THEN GREATEST(COALESCE(wo.label_cost_cents, 0), COALESCE(lbl.cents, 0), COALESCE(man.cents, 0), COALESCE(co.ship_label_cents, 0))
            ELSE COALESCE(co.baked_ship_cents, 0)
        END AS ship_cost_cents,
        CASE
            WHEN (GREATEST(COALESCE(wo.label_cost_cents, 0), COALESCE(lbl.cents, 0), COALESCE(man.cents, 0), COALESCE(co.ship_label_cents, 0)) > 0) THEN
            CASE
                WHEN (COALESCE(co.ship_label_cents, 0) = GREATEST(COALESCE(wo.label_cost_cents, 0), COALESCE(lbl.cents, 0), COALESCE(man.cents, 0), COALESCE(co.ship_label_cents, 0))) THEN COALESCE(co.ship_label_source, 'marketplace'::text)
                WHEN (COALESCE(man.cents, 0) = GREATEST(COALESCE(wo.label_cost_cents, 0), COALESCE(lbl.cents, 0), COALESCE(man.cents, 0), COALESCE(co.ship_label_cents, 0))) THEN 'manual'::text
                ELSE 'shippo'::text
            END
            WHEN (COALESCE(co.ship_label_source, ''::text) = 'buyer_pays'::text) THEN 'buyer_pays'::text
            WHEN (COALESCE(co.baked_ship_cents, 0) > 0) THEN 'estimated'::text
            ELSE 'none'::text
        END AS ship_cost_source,
    GREATEST(0, COALESCE(s.processing_fee_cents,
        CASE
            WHEN (s.payment_method = ANY (ARRAY['card'::text, 'split'::text])) THEN ((cfe.val ->> 'fee_cents'::text))::integer
            ELSE NULL::integer
        END, 0) - COALESCE(s.card_fee_cents, 0)) AS processing_fee_cents,
        CASE
            WHEN (s.processing_fee_cents IS NOT NULL) THEN COALESCE(s.processing_fee_source, 'actual'::text)
            WHEN ((s.payment_method = ANY (ARRAY['card'::text, 'split'::text])) AND (cfe.val IS NOT NULL)) THEN 'estimated'::text
            ELSE 'none'::text
        END AS processing_fee_source,
        CASE
            WHEN (lower(s.channel) = ANY (taxch.val)) THEN 'marketplace'::text
            ELSE 'us'::text
        END AS tax_remitted_by,
    (s.tax_cents + COALESCE(co.tax_cents, 0)) AS tax_collected_cents,
        CASE
            WHEN (lower(s.channel) = ANY (taxch.val)) THEN 0
            ELSE s.tax_cents
        END AS tax_owed_cents,
        CASE
            WHEN (u.ask_cents IS NOT NULL) THEN (s.price_cents - (u.ask_cents * GREATEST(s.qty, 1)))
            ELSE NULL::integer
        END AS variance_cents,
    (s.price_cents - (u.ask_cents * GREATEST(s.qty, 1))) AS raw_variance_cents,
    (((((s.price_cents + COALESCE(NULLIF(s.shipping_cents, 0), wo.shipping_cents, 0)) - COALESCE(co.fee_cents, wo.marketplace_fee_cents, ((fe.val ->> 'fee_cents'::text))::integer, 0)) -
        CASE
            WHEN (GREATEST(COALESCE(wo.label_cost_cents, 0), COALESCE(lbl.cents, 0), COALESCE(man.cents, 0), COALESCE(co.ship_label_cents, 0)) > 0) THEN GREATEST(COALESCE(wo.label_cost_cents, 0), COALESCE(lbl.cents, 0), COALESCE(man.cents, 0), COALESCE(co.ship_label_cents, 0))
            ELSE COALESCE(co.baked_ship_cents, 0)
        END) - GREATEST(0, COALESCE(s.processing_fee_cents,
        CASE
            WHEN (s.payment_method = ANY (ARRAY['card'::text, 'split'::text])) THEN ((cfe.val ->> 'fee_cents'::text))::integer
            ELSE NULL::integer
        END, 0) - COALESCE(s.card_fee_cents, 0))) - sale_cost_with_replacements(s.id, (((cost.val ->> 'cost_cents'::text))::integer * GREATEST(s.qty, 1)))) AS profit_cents,
    wo.payment_env,
    wo.order_no AS web_order_no,
    COALESCE(s.processing_fee_cents,
        CASE
            WHEN (s.payment_method = ANY (ARRAY['card'::text, 'split'::text])) THEN ((cfe.val ->> 'fee_cents'::text))::integer
            ELSE NULL::integer
        END, 0) AS processing_fee_gross_cents,
    COALESCE(s.card_fee_cents, 0) AS card_surcharge_cents
   FROM (((((((((((sales s
     LEFT JOIN units u ON (((u.store_id = s.store_id) AND (u.sku = s.sku))))
     LEFT JOIN staff st ON (((st.store_id = s.store_id) AND (st.user_id = s.actor_id))))
     LEFT JOIN ticket_extras x ON (((x.store_id = s.store_id) AND (x.ticket_id = s.ticket_id))))
     LEFT JOIN LATERAL ( SELECT c.store_id,
            c.provider,
            c.order_id,
            c.sku,
            c.sale_id,
            c.created_at,
            c.item_cents,
            c.fee_cents,
            c.baked_ship_cents,
            c.buyer_user_id,
            c.buyer_username,
            c.buyer_eias_token,
            c.fee_source,
            c.ship_label_cents,
            c.ship_label_source,
            c.tax_cents,
            c.tax_remitted,
            c.payout_cents
           FROM channel_orders c
          WHERE (c.sale_id = s.id)
          ORDER BY c.created_at DESC
         LIMIT 1) co ON (true))
     LEFT JOIN LATERAL ( SELECT w.id,
            w.store_id,
            w.sku,
            w.reservation_id,
            w.sale_id,
            w.status,
            w.buyer_name,
            w.buyer_email,
            w.buyer_phone,
            w.ship_line1,
            w.ship_line2,
            w.ship_city,
            w.ship_region,
            w.ship_postal,
            w.ship_country,
            w.item_cents,
            w.shipping_cents,
            w.tax_cents,
            w.total_cents,
            w.payment_id,
            w.refund_id,
            w.boxed_at,
            w.shipped_at,
            w.tracking_number,
            w.apology_sent_at,
            w.created_at,
            w.updated_at,
            w.checkout_quote,
            w.customer_id,
            w.redeem_points,
            w.payment_source_id,
            w.payment_attempt_id,
            w.payment_started_at,
            w.fulfillment,
            w.order_no,
            w.paid_at,
            w.pickup_deadline,
            w.pickup_reminder_sent_at,
            w.picked_up_at,
            w.picked_up_by,
            w.shipping_rate,
            w.carrier,
            w.service,
            w.tracking_url,
            w.label_url,
            w.label_transaction_id,
            w.label_cost_cents,
            w.label_purchased_at,
            w.refund_requested_at,
            w.cancel_source,
            w.cancel_reason,
            w.canceled_at,
            w.payment_env,
            w.tax_bps,
            w.tax_rule,
            w.shipping_tax_cents,
            w.label_buying_at,
            w.channel,
            w.ship_by,
            w.match_status,
            w.marketplace_fee_cents,
            w.marketplace_title,
            w.tax_remitted_by,
            w.delivered_at
           FROM web_orders w
          WHERE (w.sale_id = s.id)
          ORDER BY w.created_at
         LIMIT 1) wo ON (true))
     LEFT JOIN LATERAL ( SELECT (sum(l.cost_cents))::integer AS cents
           FROM web_order_labels l
          WHERE ((l.order_id = wo.id) AND (l.voided_at IS NULL))) lbl ON (true))
     LEFT JOIN LATERAL ( SELECT (sum(e.amount_cents))::integer AS cents
           FROM portal_expenses e
          WHERE ((e.order_id = wo.id) AND (e.source = 'manual_label'::text) AND (e.voided_at IS NULL))) man ON (true))
     CROSS JOIN LATERAL ( SELECT unit_cost_json(s.store_id, u.category, u.is_collectible, u.acquisition_cost_cents) AS val) cost)
     CROSS JOIN LATERAL ( SELECT channel_fee_estimate(s.store_id, s.channel, s.price_cents) AS val) fe)
     CROSS JOIN LATERAL ( SELECT channel_fee_estimate(s.store_id,
                CASE
                    WHEN (s.channel = 'website'::text) THEN 'card_online'::text
                    ELSE 'card_in_store'::text
                END, ((s.price_cents + s.tax_cents) + COALESCE(s.card_fee_cents, 0))) AS val) cfe)
     CROSS JOIN LATERAL ( SELECT setting_text_array(s.store_id, 'tax_remitted_channels'::text) AS val) taxch)
  WHERE ((COALESCE(wo.payment_env, 'production'::text) <> 'sandbox'::text) AND (lower(COALESCE(wo.order_no, ''::text)) !~~ 'sandbox%'::text));

-- ---------- payout functions ----------
CREATE OR REPLACE FUNCTION public.payout_calc_ticket(p_store uuid, p_ticket text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  t public.sale_payout_tickets;
  v_ov public.portal_commission_overrides;
  v_has_ov boolean;
  v_sub bigint; v_cost_null boolean; v_base bigint;
  v_emp uuid; v_method text; v_rate numeric; v_amt int; v_touched boolean;
  v_emps uuid[];
  v_absorb boolean := coalesce((public.store_setting(p_store, 'commission_store_absorbs_fees', 'true'::jsonb) #>> '{}')::boolean, true);
begin
  select * into t from public.sale_payout_tickets where store_id = p_store and ticket_key = p_ticket;
  if not found then return; end if;
  delete from public.sale_commissions where store_id = p_store and ticket_key = p_ticket;
  select sum(price_cents), sum(commission_base_cents + case when v_absorb then coalesce(fees_cents, 0) else 0 end), bool_or(cost_cents is null)
    into v_sub, v_base, v_cost_null
  from public.sale_payout_lines where store_id = p_store and ticket_key = p_ticket;
  if v_sub is null then return; end if;
  if v_cost_null then v_base := null; end if;
  select * into v_ov from public.portal_commission_overrides where store_id = p_store and ticket_key = p_ticket;
  v_has_ov := found;

  select array_agg(distinct e) into v_emps from (
    select (r->>'employee_id')::uuid e from jsonb_array_elements(t.rules) r
    union select t.online_employee_id) x where e is not null;

  foreach v_emp in array coalesce(v_emps, '{}') loop
    select r->>'method', (r->>'rate')::numeric into v_method, v_rate
      from jsonb_array_elements(t.rules) r where (r->>'employee_id')::uuid = v_emp limit 1;
    if v_method is null then v_method := 'percent_sale'; v_rate := 0; end if; -- online recipient without a rule
    v_touched := false;
    if v_cost_null then
      v_amt := null;
    elsif v_has_ov then
      v_rate := case when v_emp = (t.slots->>'paul')::uuid then v_ov.paul_pct
                     when v_emp = (t.slots->>'jacob')::uuid then v_ov.jacob_pct else 0 end;
      v_amt := case when v_base is null then null
                    else public.payout_js_round(greatest(0, v_base)::float8 * v_rate::float8 / 100) end;
    elsif t.online then
      v_amt := case when v_emp is distinct from t.online_employee_id then 0
                    when v_base is null then null
                    else public.payout_js_round(greatest(0, v_base)::float8 * t.online_pct::float8 / 100) end;
    elsif v_method = 'flat_ticket' then
      v_amt := public.payout_js_round(v_rate::float8 * 100);
    elsif v_method = 'percent_profit' then
      select exists(select 1 from public.sale_payout_lines l where l.store_id = p_store and l.ticket_key = p_ticket
        and t.sku_rates->l.sku ? v_emp::text) into v_touched;
      if v_touched then
        if v_base is null then v_amt := null;
        else
          -- Per-line rates: each line gets its own amount (payouts.ts sums per-line rounded amounts).
          insert into public.sale_commissions (sale_id, store_id, ticket_key, employee_id, amount_cents)
          select l.sale_id, p_store, p_ticket, v_emp,
            public.payout_js_round(greatest(0, l.commission_base_cents + case when v_absorb then coalesce(l.fees_cents, 0) else 0 end)::float8
              * coalesce((t.sku_rates->l.sku->>v_emp::text)::numeric, v_rate)::float8 / 100)
          from public.sale_payout_lines l where l.store_id = p_store and l.ticket_key = p_ticket;
          continue;
        end if;
      else
        v_amt := case when v_base is null then null
                      else public.payout_js_round(greatest(0, v_base)::float8 * v_rate::float8 / 100) end;
      end if;
    else
      v_amt := public.payout_js_round(v_sub::float8 * v_rate::float8 / 100);
    end if;

    insert into public.sale_commissions (sale_id, store_id, ticket_key, employee_id, amount_cents)
    select w.sale_id, p_store, p_ticket, v_emp,
      case when v_amt is null then null
           when w.total = 0 then case when w.rn = 1 then v_amt else 0 end
           else (round(v_amt::numeric * w.cum / w.total) - round(v_amt::numeric * (w.cum - w.weight) / w.total))::int end
    from (
      select l.sale_id, x.weight,
        sum(x.weight) over (order by l.sale_id) cum,
        sum(x.weight) over () total,
        row_number() over (order by l.sale_id) rn
      from public.sale_payout_lines l
      cross join lateral (select case
        when v_has_ov or t.online or v_method = 'percent_profit' then greatest(0, coalesce(l.commission_base_cents + case when v_absorb then coalesce(l.fees_cents, 0) else 0 end, 0))
        when v_method = 'flat_ticket' then 1
        else greatest(0, l.price_cents) end::numeric weight) x
      where l.store_id = p_store and l.ticket_key = p_ticket
    ) w;
  end loop;
  update public.sale_payout_tickets set computed_at = now() where store_id = p_store and ticket_key = p_ticket;
end $function$;

CREATE OR REPLACE FUNCTION public.payout_snapshot_sale(p_sale_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare l record; v_ticket text; v_old text;
begin
  select s.id, s.store_id, s.sku, s.channel, s.price_cents, s.ticket_id, s.voided_at,
    led.cost_cents, led.cost_source,
    s.price_cents + coalesce(led.tax_collected_cents, 0) + coalesce(led.shipping_cents, 0) - coalesce(led.channel_fee_cents, 0)
      - coalesce(led.ship_cost_cents, 0) - coalesce(led.processing_fee_cents, 0)
      - coalesce(led.tax_collected_cents, 0) - led.cost_cents as commission_base_cents,
    coalesce(led.channel_fee_cents, 0) + coalesce(led.processing_fee_cents, 0) as fees_cents
    into l
  from public.sales s join public.sale_ledger led on led.id = s.id where s.id = p_sale_id;
  if not found then return; end if;
  v_ticket := coalesce(l.ticket_id::text, 'sale:' || l.id::text);
  select ticket_key into v_old from public.sale_payout_lines where sale_id = l.id;
  if v_old is not null and v_old = v_ticket then return; end if; -- already frozen
  perform public.payout_freeze_ticket_config(l.store_id, v_ticket, l.channel, 'sale');
  if v_old is not null then
    update public.sale_payout_lines set ticket_key = v_ticket where sale_id = l.id;
    update public.sale_commissions set ticket_key = v_ticket where sale_id = l.id;
    perform public.payout_calc_ticket(l.store_id, v_old);
    delete from public.sale_payout_tickets t where t.store_id = l.store_id and t.ticket_key = v_old
      and not exists(select 1 from public.sale_payout_lines x where x.store_id = t.store_id and x.ticket_key = t.ticket_key);
  else
    if l.voided_at is not null then return; end if;
    insert into public.sale_payout_cost_flags
      (sale_id, store_id, ticket_key, sku, qty, unit_cost_cents, cost_source)
    select led.id, led.store_id, coalesce(led.ticket_id::text, 'sale:' || led.id::text), led.sku,
      greatest(coalesce(led.qty, 1), 1), led.cost_unit_cents, led.cost_source
    from public.sale_ledger led where led.id = l.id and led.cost_unit_cents in (900, 25000, 30000)
    on conflict (sale_id) do nothing;
    insert into public.sale_payout_lines
      (sale_id, store_id, ticket_key, sku, price_cents, commission_base_cents, cost_cents, cost_source, fees_cents)
    values (l.id, l.store_id, v_ticket, l.sku, coalesce(l.price_cents, 0), l.commission_base_cents, l.cost_cents, l.cost_source, l.fees_cents);
  end if;
  update public.sale_payout_tickets t
     set sku_rates = t.sku_rates || coalesce((select jsonb_object_agg(r.sku, r.rates) from (
       select x.sku, jsonb_object_agg(x.employee_id, x.rate) rates from public.store_payout_sku_rates x
       where x.store_id = l.store_id and x.sku = l.sku group by x.sku) r), '{}'::jsonb)
   where t.store_id = l.store_id and t.ticket_key = v_ticket and not (t.sku_rates ? l.sku);
  perform public.payout_calc_ticket(l.store_id, v_ticket);
end $function$;

CREATE OR REPLACE FUNCTION public.payout_fill_pending_cost_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r record;
begin
  for r in
    update public.sale_payout_lines pl set cost_cents = led.cost_cents, cost_source = led.cost_source,
      commission_base_cents = s.price_cents + coalesce(led.tax_collected_cents, 0) + coalesce(led.shipping_cents, 0) - coalesce(led.channel_fee_cents, 0)
        - coalesce(led.ship_cost_cents, 0) - coalesce(led.processing_fee_cents, 0)
        - coalesce(led.tax_collected_cents, 0) - led.cost_cents,
      fees_cents = coalesce(led.channel_fee_cents, 0) + coalesce(led.processing_fee_cents, 0),
      frozen_at = now()
    from public.sale_ledger led
    join public.sales s on s.id = led.id
    where pl.store_id = new.store_id and pl.sku = new.sku
      and (pl.cost_cents is null or pl.cost_source = 'default')
      and led.id = pl.sale_id and led.cost_cents is not null
      and (pl.cost_cents is null or led.cost_source in ('unit', 'collectible'))
    returning pl.store_id, pl.ticket_key
  loop
    perform public.payout_calc_ticket(r.store_id, r.ticket_key);
  end loop;
  insert into public.sale_payout_cost_flags
    (sale_id, store_id, ticket_key, sku, qty, unit_cost_cents, cost_source)
  select led.id, led.store_id, coalesce(led.ticket_id::text, 'sale:' || led.id::text), led.sku,
    greatest(coalesce(led.qty, 1), 1), led.cost_unit_cents, led.cost_source
  from public.sale_ledger led
  where led.store_id = new.store_id and led.sku = new.sku and led.voided_at is null
    and led.cost_unit_cents in (900, 25000, 30000)
  on conflict (sale_id) do nothing;
  return null;
exception when others then
  insert into public.payout_snapshot_errors (store_id, error) values (new.store_id, 'fill cost ' || new.sku || ': ' || sqlerrm);
  return null;
end $function$;

CREATE OR REPLACE FUNCTION public.sale_commission_cents(p_store uuid, p_sale_id bigint, p_employee uuid)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  s public.sales;
  v_cost int;
  v_base int;
  v_ticket text;
  v_channel text;
  v_online_channels jsonb;
  v_online_pct numeric;
  v_online_emp uuid;
  v_is_online boolean := false;
  v_ov record;
  v_rule record;
  v_rate numeric;
  v_paul uuid := public.payout_slot_employee(p_store, 'paul');
  v_jacob uuid := public.payout_slot_employee(p_store, 'jacob');
  v_absorb boolean := coalesce((public.store_setting(p_store, 'commission_store_absorbs_fees', 'true'::jsonb) #>> '{}')::boolean, true);
begin
  if exists(select 1 from public.sale_payout_lines where sale_id = p_sale_id and store_id = p_store) then
    return coalesce((select amount_cents from public.sale_commissions
      where sale_id = p_sale_id and employee_id = p_employee), 0);
  end if;

  select * into s from public.sales where id = p_sale_id and store_id = p_store;
  if not found then return 0; end if;

  select cost_cents,
    greatest(0, price_cents + coalesce(tax_collected_cents, 0) + coalesce(shipping_cents, 0) - coalesce(channel_fee_cents, 0)
      - coalesce(ship_cost_cents, 0) - coalesce(processing_fee_cents, 0)
      - coalesce(tax_collected_cents, 0) - cost_cents
      + case when v_absorb then coalesce(channel_fee_cents, 0) + coalesce(processing_fee_cents, 0) else 0 end)
    into v_cost, v_base
  from public.sale_ledger where id = s.id;
  if v_cost is null then return null; end if;
  v_ticket := coalesce(s.ticket_id::text, 'sale:' || s.id::text);
  v_channel := lower(coalesce(s.channel, ''));

  select value into v_online_channels from public.store_settings
   where store_id = p_store and key = 'online_payout_channels';
  if v_online_channels is null then
    select value into v_online_channels from public.store_settings
     where store_id = p_store and key = 'online_channels';
  end if;
  v_online_pct := coalesce((public.store_setting(p_store, 'online_payout_pct', '0'::jsonb) #>> '{}')::numeric, 0);
  begin
    v_online_emp := nullif(public.store_setting(p_store, 'online_payout_employee_id', 'null'::jsonb) #>> '{}', '')::uuid;
  exception when others then v_online_emp := null;
  end;

  if v_online_channels is not null and jsonb_typeof(v_online_channels) = 'array' then
    select exists (
      select 1 from jsonb_array_elements_text(v_online_channels) x
      where lower(btrim(x)) = v_channel
    ) into v_is_online;
  end if;

  select * into v_ov from public.portal_commission_overrides
   where store_id = p_store and ticket_key = v_ticket;
  if found then
    if p_employee = v_paul then
      return round(v_base * coalesce(v_ov.paul_pct, 0) / 100.0)::int;
    elsif p_employee = v_jacob then
      return round(v_base * coalesce(v_ov.jacob_pct, 0) / 100.0)::int;
    else
      return 0;
    end if;
  end if;

  if v_is_online then
    if p_employee is distinct from v_online_emp then return 0; end if;
    return round(v_base * v_online_pct / 100.0)::int;
  end if;

  select * into v_rule from public.portal_payout_rules
   where store_id = p_store and employee_id = p_employee;
  if not found then return 0; end if;

  if v_rule.method = 'flat_ticket' then
    return round(v_rule.rate * 100)::int;
  end if;
  if v_rule.method = 'percent_profit' then
    v_rate := v_rule.rate;
    return round(v_base * v_rate / 100.0)::int;
  end if;
  return round(s.price_cents * v_rule.rate / 100.0)::int;
end $function$;

CREATE OR REPLACE FUNCTION public.portal_payout_config()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null or not public.portal_financial_access() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return jsonb_build_object(
    'online_channels', public.store_setting(v_store,'online_channels','["website"]'::jsonb),
    'online_payout_pct', public.store_setting(v_store,'online_payout_pct','30'::jsonb),
    'online_payout_employee_id', public.store_setting(v_store,'online_payout_employee_id','null'::jsonb),
    'absorb_fees', coalesce((public.store_setting(v_store,'commission_store_absorbs_fees','true'::jsonb) #>> '{}')::boolean, true));
end $function$;

-- ---------- applying the setting ----------
create or replace function public.payout_apply_absorb_setting(p_store uuid, p_on boolean, p_by uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_before jsonb; v_after jsonb; v_key text; v_t record; v_e record;
  v_applied bigint; v_cum bigint; v_b bigint; v_a bigint; v_delta bigint; v_n int := 0; v_paid_n int := 0;
  v_receipts text;
begin
  perform pg_advisory_xact_lock(hashtext('absorb_fees:' || p_store::text));
  select coalesce(jsonb_object_agg(k, amt), '{}'::jsonb) into v_before from (
    select c.ticket_key || '|' || c.employee_id::text k, coalesce(sum(c.amount_cents), 0) amt
    from public.sale_commissions c join public.sales s on s.id = c.sale_id and s.voided_at is null
    where c.store_id = p_store group by 1) x;

  insert into public.store_settings(store_id, key, value) values (p_store, 'commission_store_absorbs_fees', to_jsonb(p_on))
  on conflict (store_id, key) do update set value = excluded.value;

  for v_t in select ticket_key from public.sale_payout_tickets where store_id = p_store loop
    perform public.payout_calc_ticket(p_store, v_t.ticket_key);
  end loop;

  select coalesce(jsonb_object_agg(k, amt), '{}'::jsonb) into v_after from (
    select c.ticket_key || '|' || c.employee_id::text k, coalesce(sum(c.amount_cents), 0) amt
    from public.sale_commissions c join public.sales s on s.id = c.sale_id and s.voided_at is null
    where c.store_id = p_store group by 1) x;

  -- Paid = covered by payments, oldest sale first, after payments went to reimbursements (Payouts screen rule).
  for v_e in select distinct split_part(k, '|', 2)::uuid as emp from jsonb_object_keys(v_before || v_after) k loop
    v_applied := greatest(0,
      coalesce((select sum(amount_cents) from public.portal_payout_payments where store_id = p_store and employee_id = v_e.emp and voided_at is null), 0)
      - coalesce((select sum(amount_cents) from public.portal_expenses where store_id = p_store and employee_id = v_e.emp and needs_reimbursement and voided_at is null), 0));
    v_cum := 0;
    for v_t in
      select t.ticket_key, t.first_sale, t.sold_at from (
        select coalesce(s.ticket_id::text, 'sale:' || s.id::text) ticket_key, min(s.id) first_sale, min(s.sold_at) sold_at
        from public.sales s where s.store_id = p_store and s.voided_at is null group by 1) t
      order by t.sold_at, t.first_sale
    loop
      v_key := v_t.ticket_key || '|' || v_e.emp::text;
      v_b := coalesce((v_before ->> v_key)::bigint, 0); v_a := coalesce((v_after ->> v_key)::bigint, 0);
      v_cum := v_cum + v_b;
      v_delta := v_a - v_b; v_n := v_n + (case when v_delta <> 0 then 1 else 0 end);
      if v_delta <> 0 and v_cum <= v_applied then
        select string_agg(s.receipt_no, ', ' order by s.id) into v_receipts from public.sales s
          where s.store_id = p_store and coalesce(s.ticket_id::text, 'sale:' || s.id::text) = v_t.ticket_key and s.voided_at is null;
        insert into public.portal_payout_adjustments(store_id, employee_id, amount_cents, reason, sale_id, ticket_key, created_by, fee_rule_change)
        values (p_store, v_e.emp, v_delta::int,
          'Fee rule change · store ' || case when p_on then 'now absorbs' else 'no longer absorbs' end || ' fees · ' || coalesce(v_receipts, v_t.ticket_key) || ' (already paid)',
          v_t.first_sale, v_t.ticket_key, p_by, true);
        v_paid_n := v_paid_n + 1;
      end if;
    end loop;
  end loop;
  return jsonb_build_object('absorb_fees', p_on, 'changed_ticket_employee_pairs', v_n, 'adjustment_rows', v_paid_n);
end $$;
revoke all on function public.payout_apply_absorb_setting(uuid, boolean, uuid) from public, anon, authenticated;

create or replace function public.portal_set_absorb_fees(p_on boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id(); v_now boolean;
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if p_on is null then raise exception 'on_or_off_required' using errcode = '22023'; end if;
  v_now := coalesce((public.store_setting(v_store, 'commission_store_absorbs_fees', 'true'::jsonb) #>> '{}')::boolean, true);
  if v_now = p_on then return jsonb_build_object('absorb_fees', p_on, 'changed_ticket_employee_pairs', 0, 'adjustment_rows', 0); end if;
  return public.payout_apply_absorb_setting(v_store, p_on, auth.uid());
end $$;
revoke all on function public.portal_set_absorb_fees(boolean) from public, anon;
grant execute on function public.portal_set_absorb_fees(boolean) to authenticated;

-- ---------- existing stores: keep today's rule until an admin (or the rollout step) turns it on ----------
insert into public.store_settings(store_id, key, value)
select distinct t.store_id, 'commission_store_absorbs_fees', 'false'::jsonb from public.sale_payout_tickets t
on conflict (store_id, key) do nothing;

-- ---------- frozen lines: record the fees inside each base, refresh bases from ledger inputs ----------
-- (card sales pick up the surcharge netting; cost stays frozen; replaced sales keep their base.)
update public.sale_payout_lines pl
   set fees_cents = coalesce(led.channel_fee_cents, 0) + coalesce(led.processing_fee_cents, 0),
       commission_base_cents = case when pl.replacement_saved or pl.cost_cents is null then pl.commission_base_cents
         else led.price_cents + coalesce(led.shipping_cents, 0) - coalesce(led.channel_fee_cents, 0)
              - coalesce(led.ship_cost_cents, 0) - coalesce(led.processing_fee_cents, 0) - pl.cost_cents end
  from public.sale_ledger led
 where led.id = pl.sale_id;

do $$ declare r record; begin
  for r in select store_id, ticket_key from public.sale_payout_tickets loop
    perform public.payout_calc_ticket(r.store_id, r.ticket_key);
  end loop;
end $$;

commit;
